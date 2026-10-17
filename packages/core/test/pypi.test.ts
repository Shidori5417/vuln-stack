import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computePaths, chainNames } from '../src/model/graph.js';
import type { DependencyGraph } from '../src/model/types.js';
import { exactVersion, parseRequirement, poetryToPep440 } from '../src/ecosystems/pypi/pep508.js';
import {
  parsePipfileLock,
  parsePoetryLock,
  parseUvLock,
} from '../src/ecosystems/pypi/lockfiles.js';
import { readPipfile, readPyproject } from '../src/ecosystems/pypi/pyproject.js';
import { pypiPlugin } from '../src/ecosystems/pypi/index.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { MemoryCache } from '../src/cache/memory.js';
import { FIXTURES, json } from './helpers.js';

const chain = (g: DependencyGraph, id: string) => chainNames(g, computePaths(g).get(id)!.path);
const names = (g: DependencyGraph) =>
  [...g.nodes.values()]
    .filter((d) => !d.internal)
    .map((d) => `${d.name}@${d.version}`)
    .sort();

async function fixture(folder: string) {
  const { subprojects, warnings } = await collectSubprojects(
    new FsFileProvider(join(FIXTURES, 'pypi', folder)),
  );
  expect(subprojects).toHaveLength(1);
  return { ...subprojects[0]!, allWarnings: [...warnings, ...subprojects[0]!.warnings] };
}

describe('PEP 508 and constraints', () => {
  it('parses requirement strings', () => {
    expect(parseRequirement('requests[socks]>=2.19,<3; python_version>"3"')).toEqual({
      name: 'requests',
      spec: '>=2.19,<3',
      marker: 'python_version>"3"',
    });
    expect(parseRequirement('Django (>=4.0)')).toEqual({ name: 'django', spec: '>=4.0' });
    expect(parseRequirement('pkg @ https://x/y.whl')).toMatchObject({
      name: 'pkg',
      url: 'https://x/y.whl',
    });
    expect(parseRequirement('zope.interface')).toEqual({ name: 'zope-interface', spec: '' });
    expect(parseRequirement('!!!')).toBeUndefined();
  });

  it('detects exact pins', () => {
    expect(exactVersion('==4.1')).toBe('4.1');
    expect(exactVersion('===4.1')).toBe('4.1');
    expect(exactVersion('==4.*')).toBeUndefined();
    expect(exactVersion('>=4')).toBeUndefined();
  });

  it('converts Poetry constraints', () => {
    expect(poetryToPep440('^1.2.3')).toBe('>=1.2.3,<2.0.0');
    expect(poetryToPep440('^0.2.3')).toBe('>=0.2.3,<0.3.0');
    expect(poetryToPep440('^0.0.3')).toBe('>=0.0.3,<0.0.4');
    expect(poetryToPep440('^0')).toBe('>=0,<1.0.0');
    expect(poetryToPep440('^0.0')).toBe('>=0.0,<0.1.0');
    expect(poetryToPep440('~1.2.3')).toBe('>=1.2.3,<1.3.0');
    expect(poetryToPep440('~1')).toBe('>=1,<2.0.0');
    expect(poetryToPep440('~=1.2')).toBe('~=1.2');
    expect(poetryToPep440('4.1')).toBe('==4.1');
    expect(poetryToPep440('>=2.0, <3.0')).toBe('>=2.0,<3.0');
    expect(poetryToPep440('*')).toBe('');
    expect(poetryToPep440('^1.0 || ^2.0')).toBe('');
  });
});

describe('uv.lock (real)', () => {
  it('uses the project as root, dependency groups as dev and builds chains', async () => {
    const { graph } = await fixture('uv-lock');
    expect(graph.root).toBe('uv-app');
    expect(graph.nodes.get('django@4.1')).toMatchObject({
      isDirect: true,
      scope: 'prod',
      confidence: 'high',
    });
    expect(graph.nodes.get('pyyaml@5.3')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(chain(graph, 'urllib3@1.23')).toEqual(['uv-app', 'requests', 'urllib3']);
    expect([...graph.nodes.values()].some((d) => d.name === 'uv-app')).toBe(false);
  });

  it('models workspace members and skips non-index sources', () => {
    const lock = `
version = 1
[[package]]
name = "root"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "lib" }]
[[package]]
name = "lib"
version = "0.2.0"
source = { editable = "packages/lib" }
dependencies = [{ name = "attrs" }]
[package.dev-dependencies]
dev = [{ name = "pytest" }]
[[package]]
name = "attrs"
version = "23.1.0"
source = { registry = "https://pypi.org/simple" }
[[package]]
name = "pytest"
version = "8.0.0"
source = { registry = "https://pypi.org/simple" }
[[package]]
name = "fork"
version = "1.0"
source = { git = "https://github.com/a/b" }
`;
    const { graph, warnings } = parseUvLock(lock, 'uv.lock', 'x');
    expect(chain(graph, 'attrs@23.1.0')).toEqual(['x', 'lib', 'attrs']);
    expect(graph.nodes.get('pytest@8.0.0')!.scope).toBe('dev');
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
    expect(() => parseUvLock('= broken', 'uv.lock', 'x')).toThrow(/invalid TOML/);
  });

  it('treats roots as direct without workspace members', () => {
    const lock = `
[[package]]
name = "a"
version = "1.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "b" }]
[[package]]
name = "b"
version = "2.0"
source = { registry = "https://pypi.org/simple" }
`;
    const { graph } = parseUvLock(lock, 'uv.lock', 'x');
    expect(graph.nodes.get('a@1.0')!.isDirect).toBe(true);
    expect(graph.nodes.get('b@2.0')!.isDirect).toBe(false);
  });
});

describe('requirements.txt', () => {
  it('rebuilds the tree from pip-compile annotations (real)', async () => {
    const { graph } = await fixture('pip-compile');
    expect(graph.nodes.get('django@4.1')!.isDirect).toBe(true);
    expect(graph.nodes.get('urllib3@1.23')!.isDirect).toBe(false);
    expect(chain(graph, 'urllib3@1.23')).toEqual(['root', 'requests', 'urllib3']);
    const te = [...graph.nodes.keys()].find((k) => k.startsWith('typing-extensions@'))!;
    expect(chain(graph, te)).toEqual(['root', 'django', 'asgiref', 'typing-extensions']);
  });

  it('handles ranges, includes, hashes, editable and URL requirements', async () => {
    const { graph, allWarnings } = await fixture('requirements-ranges');
    expect(graph.nodes.get('urllib3@1.23')).toMatchObject({
      isDirect: true,
      confidence: 'high',
      scope: 'prod',
      sourceFile: 'requirements-base.txt',
    });
    expect(graph.nodes.get('django@')).toMatchObject({
      declaredRange: '>=4.0,<4.2',
      confidence: 'medium',
    });
    expect(graph.nodes.get('requests@')).toMatchObject({ declaredRange: '~=2.19' });
    expect(graph.nodes.get('pytest@')).toMatchObject({ declaredRange: '*', scope: 'dev' });
    expect(allWarnings.map((w) => w.code).sort()).toEqual([
      'non-registry-version',
      'non-registry-version',
      'unpinned-requirements',
    ]);
  });

  it('parses multi-line via blocks and warns on missing includes', async () => {
    const provider = new MemoryFileProvider({
      'requirements.txt':
        'a==1.0\n    # via -r requirements.in\nb==2.0\n    # via\n    #   a\n    #   c\nc==3.0\n    # via unknown-pkg\n-r missing.txt\n-c constraints.txt\n',
    });
    const { subprojects, warnings } = await collectSubprojects(provider);
    const graph = subprojects[0]!.graph;
    expect(chain(graph, 'b@2.0')).toEqual(['root', 'a', 'b']);
    expect(graph.nodes.get('c@3.0')!.isDirect).toBe(true); // nothing known pulls it in
    expect([...subprojects[0]!.warnings, ...warnings].map((w) => w.code)).toContain(
      'missing-include',
    );
  });
});

describe('poetry.lock', () => {
  it('reads groups, direct deps from pyproject and skips path deps', async () => {
    const { graph, allWarnings } = await fixture('poetry');
    expect(graph.root).toBe('poetry-app');
    expect(names(graph)).toEqual([
      'asgiref@3.12.1',
      'django@4.1',
      'pyyaml@5.3',
      'requests@2.19.0',
      'sqlparse@0.4.1',
      'typing-extensions@4.12.2',
      'urllib3@1.23',
    ]);
    expect(graph.nodes.get('django@4.1')).toMatchObject({ isDirect: true, scope: 'prod' });
    expect(graph.nodes.get('pyyaml@5.3')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(chain(graph, 'typing-extensions@4.12.2')).toEqual([
      'poetry-app',
      'django',
      'asgiref',
      'typing-extensions',
    ]);
    expect(allWarnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('supports old category fields and missing pyproject', () => {
    const lock = `
[[package]]
name = "a"
version = "1.0"
category = "main"
[package.dependencies]
b = "*"
[[package]]
name = "b"
version = "2.0"
category = "dev"
`;
    const { graph } = parsePoetryLock(lock, 'poetry.lock', 'x');
    expect(graph.nodes.get('a@1.0')).toMatchObject({ isDirect: true, scope: 'prod' });
    expect(graph.nodes.get('b@2.0')).toMatchObject({ isDirect: false, scope: 'dev' });
    expect(() => parsePoetryLock('[[', 'poetry.lock', 'x')).toThrow(/poetry.lock: invalid TOML/);
  });
});

describe('Pipfile / Pipfile.lock', () => {
  it('uses Pipfile for direct deps', async () => {
    const { graph, allWarnings } = await fixture('pipenv');
    expect(graph.nodes.get('flask@1.0')!.isDirect).toBe(true);
    expect(graph.nodes.get('jinja2@2.10')!.isDirect).toBe(false);
    expect(graph.nodes.get('pytest@8.0.0')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(allWarnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('works without Pipfile and rejects bad JSON', () => {
    const { graph } = parsePipfileLock(
      '{"default":{"a":{"version":"==1.0"}}}',
      'Pipfile.lock',
      'x',
    );
    expect(graph.nodes.get('a@1.0')!.isDirect).toBe(true);
    expect(() => parsePipfileLock('{', 'Pipfile.lock', 'x')).toThrow(/invalid JSON/);
  });

  it('reads Pipfile specs', () => {
    const m = readPipfile(
      '[packages]\nA = "*"\nb = {version = ">=1"}\n[dev-packages]\nc = "==2"\n',
      'Pipfile',
    );
    expect(m.deps).toEqual([
      { name: 'a', spec: '', scope: 'prod' },
      { name: 'b', spec: '>=1', scope: 'prod' },
      { name: 'c', spec: '==2', scope: 'dev' },
    ]);
  });
});

describe('pyproject.toml without a lock', () => {
  it('reads PEP 621, optional deps, PEP 735 groups, uv dev deps and poetry groups', () => {
    const m = readPyproject(
      `
[project]
name = "app"
dependencies = ["Django>=4.0", "local @ file:///x"]
[project.optional-dependencies]
extra = ["redis==4.0"]
[dependency-groups]
test = ["pytest", {include-group = "other"}]
[tool.uv]
dev-dependencies = ["ruff"]
[tool.poetry.dependencies]
python = "^3.10"
flask = [{version = "^2.0", python = "<3.12"}, {version = "^3.0", python = ">=3.12"}]
[tool.poetry.dev-dependencies]
black = "*"
[tool.poetry.group.main.dependencies]
attrs = "^23"
`,
      'pyproject.toml',
    );
    expect(m.name).toBe('app');
    expect(m.deps.map((d) => `${d.name}:${d.spec}:${d.scope}`)).toEqual([
      'django:>=4.0:prod',
      'redis:==4.0:optional',
      'pytest::dev',
      'ruff::dev',
      'flask:>=2.0,<3.0.0:prod',
      'black::dev',
      'attrs:>=23,<24.0.0:prod',
    ]);
    expect(m.skipped).toEqual(['local @ file:///x']);
    expect(() => readPyproject('[', 'pyproject.toml')).toThrow(/invalid TOML/);
  });

  it('builds a manifest graph with ranges to resolve', async () => {
    const { subprojects } = await collectSubprojects(
      new MemoryFileProvider({
        'svc/pyproject.toml': '[project]\ndependencies = ["requests>=2", "six==1.16.0"]\n',
      }),
    );
    const g = subprojects[0]!.graph;
    expect(g.root).toBe('svc');
    expect(g.nodes.get('six@1.16.0')!.confidence).toBe('high');
    expect(g.nodes.get('requests@')!.declaredRange).toBe('>=2');
    expect(subprojects[0]!.warnings.at(-1)!.code).toBe('no-lockfile');
  });

  it('prefers a lock over requirements files and ignores empty pyprojects', async () => {
    const both = await collectSubprojects(
      new MemoryFileProvider({ 'poetry.lock': '', 'requirements.txt': 'a==1.0\n' }),
    );
    expect(both.warnings.map((w) => w.code)).toContain('multiple-lockfiles');
    const empty = await collectSubprojects(
      new MemoryFileProvider({ 'pyproject.toml': '[tool.black]\n' }),
    );
    expect(empty.subprojects).toEqual([]);
    const pipfileOnly = await collectSubprojects(
      new MemoryFileProvider({ Pipfile: '[packages]\na = "==1"\n' }),
    );
    expect(pipfileOnly.subprojects[0]!.graph.nodes.has('a@1')).toBe(true);
  });
});

describe('PyPI plugin', () => {
  const net = (versions: string[]) => {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        cache: new MemoryCache(),
        userAgent: 't',
        fetch: async (url: string) => {
          calls.push(url);
          return json({ versions });
        },
      },
    };
  };

  it('resolves ranges from the simple API, skipping prereleases', async () => {
    const { ctx, calls } = net(['2.0', '2.19.0', '2.31.0', '3.0.0a1', 'bogus']);
    expect(await pypiPlugin.resolveRange!('requests', '~=2.19', ctx)).toBe('2.31.0');
    expect(await pypiPlugin.resolveRange!('requests', '*', ctx)).toBe('2.31.0');
    expect(await pypiPlugin.resolveRange!('requests', '>=3.0.0a1', ctx)).toBe('3.0.0a1');
    expect(await pypiPlugin.resolveRange!('requests', '>=9', ctx)).toBeNull();
    expect(calls).toEqual(['https://pypi.org/simple/requests/']);
  });

  it('detects uv workspace members', async () => {
    const provider = new MemoryFileProvider({
      'uv.lock': 'source = { editable = "packages/lib" }',
    });
    expect(await pypiPlugin.isCoveredByLock!('', 'packages/lib', provider)).toBe(true);
    expect(await pypiPlugin.isCoveredByLock!('', 'other', provider)).toBe(false);
    expect(await pypiPlugin.isCoveredByLock!('', 'x', new MemoryFileProvider({}))).toBe(false);
  });
});
