import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainNames, computePaths } from '../src/model/graph.js';
import { parsePnpmKey, parsePnpmLock } from '../src/ecosystems/npm/pnpm-lock.js';
import { parseYarnLock, parseYarnV1, specName } from '../src/ecosystems/npm/yarn-lock.js';
import {
  workspaceDirs,
  workspaceGlobToRegExp,
  workspacePatterns,
} from '../src/ecosystems/npm/workspaces.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import type { DependencyGraph } from '../src/model/types.js';
import { FIXTURES } from './helpers.js';

const chainOf = (graph: DependencyGraph, id: string) =>
  chainNames(graph, computePaths(graph).get(id)!.path);
const find = (graph: DependencyGraph, name: string) =>
  [...graph.nodes.entries()].find(([, d]) => d.name === name)!;

async function parseFixture(folder: string) {
  const { subprojects, warnings } = await collectSubprojects(
    new FsFileProvider(join(FIXTURES, 'npm', folder)),
  );
  expect(subprojects).toHaveLength(1);
  return { ...subprojects[0]!, warnings: [...warnings, ...subprojects[0]!.warnings] };
}

describe('pnpm-lock.yaml', () => {
  it('parses keys from every lockfile generation', () => {
    expect(parsePnpmKey('react-dom@16.0.0(react@16.0.0)')).toEqual({
      name: 'react-dom',
      version: '16.0.0',
    });
    expect(parsePnpmKey('/@babel/core@7.0.0')).toEqual({ name: '@babel/core', version: '7.0.0' });
    expect(parsePnpmKey('/lodash/4.17.15')).toEqual({ name: 'lodash', version: '4.17.15' });
    expect(parsePnpmKey('/@types/node/20.1.0_typescript@5.0.0')).toEqual({
      name: '@types/node',
      version: '20.1.0',
    });
    expect(parsePnpmKey('/string_decoder/1.3.0')).toEqual({
      name: 'string_decoder',
      version: '1.3.0',
    });
    expect(parsePnpmKey('nope')).toBeUndefined();
  });

  it('reads a real v9 lock with workspace importers and peers', async () => {
    const { graph } = await parseFixture('pnpm-v9');
    expect(graph.root).toBe('pnpm-app');
    const [expressId, express] = find(graph, 'express');
    expect(express).toMatchObject({ version: '4.17.1', isDirect: true, scope: 'prod' });
    expect(find(graph, 'minimist')[1]).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(chainOf(graph, find(graph, 'body-parser')[0])).toEqual([
      'pnpm-app',
      'express',
      'body-parser',
    ]);
    expect(chainOf(graph, find(graph, 'lodash')[0])).toEqual([
      'pnpm-app',
      'packages/web',
      'lodash',
    ]);
    expect(graph.nodes.get('react-dom@16.0.0')!.isDirect).toBe(true);
    expect(graph.edges.get('react-dom@16.0.0')).toContain('react@16.0.0');
    expect(graph.edges.get(expressId)!.size).toBeGreaterThan(10);
  });

  it('handles v6 dev flags, aliases, links and non-registry packages', () => {
    const v6 = `
lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      foo:
        specifier: npm:lodash@4.17.20
        version: /lodash@4.17.20
      local:
        specifier: link:../local
        version: link:../local
    devDependencies:
      tool:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  /lodash@4.17.20:
    dev: false
  /tool@1.0.0:
    dev: true
    dependencies:
      helper: 2.0.0
  /helper@2.0.0:
    dev: true
  /gitdep@github.com/a/b/abc:
    dev: false
`;
    const { graph, warnings } = parsePnpmLock(v6, 'pnpm-lock.yaml', 'app');
    expect([...graph.nodes.keys()].sort()).toEqual([
      'helper@2.0.0',
      'lodash@4.17.20',
      'tool@1.0.0',
    ]);
    expect(graph.nodes.get('lodash@4.17.20')).toMatchObject({ isDirect: true, scope: 'prod' });
    expect(graph.nodes.get('helper@2.0.0')).toMatchObject({ isDirect: false, scope: 'dev' });
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('supports v5 locks without importers', () => {
    const v5 = `
lockfileVersion: 5.4
dependencies:
  lodash: 4.17.15
packages:
  /lodash/4.17.15:
    dev: false
`;
    const { graph } = parsePnpmLock(v5, 'pnpm-lock.yaml', 'app');
    expect(graph.nodes.get('lodash@4.17.15')!.isDirect).toBe(true);
    expect(parsePnpmLock('', 'pnpm-lock.yaml', 'empty').graph.nodes.size).toBe(0);
  });
});

describe('yarn.lock v1', () => {
  it('parses multi-spec entries and nested dependencies', () => {
    const specs = parseYarnV1(
      'lodash@4.17.15, lodash@^4.17.15:\n  version "4.17.15"\n  dependencies:\n    "@scope/x" "^1"\n',
    );
    expect(specs.get('lodash@^4.17.15')).toBe(specs.get('lodash@4.17.15'));
    expect(specs.get('lodash@4.17.15')!.dependencies).toEqual({ '@scope/x': '^1' });
    expect(specName('@scope/pkg@^1.0.0')).toBe('@scope/pkg');
    expect(specName('plain')).toBe('plain');
  });

  it('builds the graph from workspace manifests', async () => {
    const { graph, warnings } = await parseFixture('yarn-v1');
    expect(graph.root).toBe('yarn-classic-app');
    expect(graph.nodes.get('lodash@4.17.15')).toMatchObject({ isDirect: true, scope: 'prod' });
    expect(graph.nodes.get('minimist@1.2.0')).toMatchObject({ isDirect: true, scope: 'prod' }); // npm: alias
    expect(graph.nodes.get('minimist@0.0.8')).toMatchObject({ isDirect: false, scope: 'dev' });
    expect(chainOf(graph, 'minimist@0.0.8')).toEqual(['yarn-classic-app', 'mkdirp', 'minimist']);
    expect(graph.edges.get('<root>')).toContain('@app/api@0.0.0');
    expect(graph.edges.get('@app/api@0.0.0')).toContain('lodash@4.17.15');
    expect(warnings.map((w) => w.code)).toContain('non-registry-version');
  });

  it('warns when there is no package.json', () => {
    const { warnings, graph } = parseYarnLock(
      'a@1.0.0:\n  version "1.0.0"\n',
      'yarn.lock',
      'x',
      [],
    );
    expect(graph.nodes.size).toBe(1);
    expect(warnings.map((w) => w.code)).toEqual(['yarn-no-manifest']);
  });
});

describe('yarn.lock berry', () => {
  it('handles protocols, patches and workspaces', async () => {
    const { graph, warnings } = await parseFixture('yarn-berry');
    expect(
      [...graph.nodes.values()]
        .filter((d) => !d.internal)
        .map((d) => `${d.name}@${d.version}`)
        .sort(),
    ).toEqual(['express@4.17.1', 'minimist@1.2.0', 'qs@6.7.0', 'resolve@1.22.1']);
    expect(graph.nodes.get('minimist@1.2.0')!.scope).toBe('dev');
    expect(graph.nodes.get('qs@6.7.0')).toMatchObject({ isDirect: true, scope: 'prod' });
    expect(chainOf(graph, 'qs@6.7.0')).toEqual(['yarn-berry-app', 'express', 'qs']);
    expect(warnings).toEqual([]);
  });
});

describe('workspace helpers', () => {
  it('expands globs', () => {
    expect(workspaceGlobToRegExp('packages/*').test('packages/a')).toBe(true);
    expect(workspaceGlobToRegExp('packages/*').test('packages/a/b')).toBe(false);
    expect(workspaceGlobToRegExp('./apps/**').test('apps/x/y')).toBe(true);
    expect(workspacePatterns({ workspaces: { packages: ['a/*', 1] } } as never)).toEqual(['a/*']);
    expect(workspacePatterns({})).toEqual([]);
    expect(
      workspaceDirs(
        'repo',
        ['packages/*', '!packages/skip'],
        ['repo/packages/a/package.json', 'repo/other/package.json'],
      ),
    ).toEqual(['packages/a']);
    expect(workspaceDirs('', [], ['a/package.json'])).toEqual([]);
  });

  it('skips members covered by pnpm and yarn workspace locks', async () => {
    const pnpm = await collectSubprojects(
      new MemoryFileProvider({
        'package.json': '{}',
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/a: {}\n",
        'packages/a/package.json': '{}',
        'tools/x/package.json': '{}',
      }),
    );
    expect(pnpm.subprojects.map((s) => s.path)).toEqual(['', 'tools/x']);

    const yarn = await collectSubprojects(
      new MemoryFileProvider({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'yarn.lock': '',
        'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { x: '1.0.0' } }),
        'tools/x/package.json': '{}',
      }),
    );
    expect(yarn.subprojects.map((s) => s.path)).toEqual(['', 'tools/x']);
  });

  it('warns about multiple lock files', async () => {
    const { warnings } = await collectSubprojects(
      new MemoryFileProvider({
        'package.json': '{}',
        'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
        'yarn.lock': '',
      }),
    );
    expect(warnings[0]).toMatchObject({ code: 'multiple-lockfiles' });
  });
});
