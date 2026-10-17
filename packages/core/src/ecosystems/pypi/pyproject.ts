import { parse as parseToml } from 'smol-toml';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import { exactVersion, parseRequirement, poetryToPep440 } from './pep508.js';
import { normalizePypiName } from './versioning.js';

export interface DirectDeps {
  prod: Set<string>;
  dev: Set<string>;
}

interface ManifestDep {
  name: string;
  spec: string;
  scope: DependencyScope;
}

interface Manifest {
  name?: string;
  deps: ManifestDep[];
  skipped: string[];
}

type PoetryDeps = Record<
  string,
  | string
  | { version?: string; git?: string; path?: string; url?: string }[]
  | { version?: string; git?: string; path?: string; url?: string }
>;

interface PyProject {
  project?: {
    name?: string;
    dependencies?: string[];
    'optional-dependencies'?: Record<string, string[]>;
  };
  'dependency-groups'?: Record<string, (string | { 'include-group': string })[]>;
  tool?: {
    poetry?: {
      name?: string;
      dependencies?: PoetryDeps;
      'dev-dependencies'?: PoetryDeps;
      group?: Record<string, { dependencies?: PoetryDeps }>;
    };
    uv?: { 'dev-dependencies'?: string[] };
  };
}

function readToml<T>(content: string, file: string): T {
  try {
    return parseToml(content) as T;
  } catch (e) {
    throw new Error(`${file}: invalid TOML (${(e as Error).message})`, { cause: e });
  }
}

function addPep508(out: Manifest, list: readonly unknown[] | undefined, scope: DependencyScope) {
  for (const item of list ?? []) {
    if (typeof item !== 'string') continue;
    const req = parseRequirement(item);
    if (!req || req.url) {
      out.skipped.push(item);
      continue;
    }
    out.deps.push({ name: req.name, spec: req.spec, scope });
  }
}

function addPoetry(out: Manifest, deps: PoetryDeps | undefined, scope: DependencyScope) {
  for (const [rawName, value] of Object.entries(deps ?? {})) {
    if (rawName.toLowerCase() === 'python') continue;
    // Multiple-constraint dependencies: take the first entry with a version.
    const entry = Array.isArray(value) ? (value.find((v) => v.version) ?? value[0]) : value;
    if (typeof entry === 'object' && entry && (entry.git || entry.path || entry.url)) {
      out.skipped.push(rawName);
      continue;
    }
    const constraint = typeof entry === 'string' ? entry : (entry?.version ?? '*');
    out.deps.push({ name: normalizePypiName(rawName), spec: poetryToPep440(constraint), scope });
  }
}

/** Direct dependencies from pyproject.toml: PEP 621, PEP 735 groups, Poetry and uv. */
export function readPyproject(content: string, file: string): Manifest {
  const doc = readToml<PyProject>(content, file);
  const out: Manifest = { deps: [], skipped: [] };
  const name = doc.project?.name ?? doc.tool?.poetry?.name;
  if (name) out.name = name;

  addPep508(out, doc.project?.dependencies, 'prod');
  for (const list of Object.values(doc.project?.['optional-dependencies'] ?? {}))
    addPep508(out, list, 'optional');
  for (const list of Object.values(doc['dependency-groups'] ?? {})) addPep508(out, list, 'dev');
  addPep508(out, doc.tool?.uv?.['dev-dependencies'], 'dev');

  const poetry = doc.tool?.poetry;
  addPoetry(out, poetry?.dependencies, 'prod');
  addPoetry(out, poetry?.['dev-dependencies'], 'dev');
  for (const [group, def] of Object.entries(poetry?.group ?? {})) {
    addPoetry(out, def.dependencies, group === 'main' ? 'prod' : 'dev');
  }
  return out;
}

type PipfileDeps = Record<
  string,
  string | { version?: string; git?: string; path?: string; file?: string }
>;

/** Pipfile: `[packages]` and `[dev-packages]`, values are `"*"`, a spec or a table. */
export function readPipfile(content: string, file: string): Manifest {
  const doc = readToml<{ packages?: PipfileDeps; 'dev-packages'?: PipfileDeps }>(content, file);
  const out: Manifest = { deps: [], skipped: [] };
  for (const [section, scope] of [
    ['packages', 'prod'],
    ['dev-packages', 'dev'],
  ] as const) {
    for (const [rawName, value] of Object.entries(doc[section] ?? {})) {
      if (typeof value === 'object' && (value.git || value.path || value.file)) {
        out.skipped.push(rawName);
        continue;
      }
      const spec = typeof value === 'string' ? value : (value.version ?? '*');
      out.deps.push({
        name: normalizePypiName(rawName),
        spec: spec === '*' ? '' : spec.replace(/\s+/g, ''),
        scope,
      });
    }
  }
  return out;
}

export function directDepsOf(manifest: Manifest): DirectDeps {
  const prod = new Set<string>();
  const dev = new Set<string>();
  for (const d of manifest.deps) (d.scope === 'dev' ? dev : prod).add(d.name);
  return { prod, dev };
}

/** Manifest-only graph: versions are resolved later from the ranges. */
export function manifestGraph(
  manifest: Manifest,
  sourceFile: string,
  rootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(manifest.name ?? rootName);
  const warnings: Warning[] = manifest.skipped.map((s) => ({
    code: 'non-registry-version',
    message: `Skipping ${s}: not installed from a package index`,
    file: sourceFile,
  }));
  for (const dep of manifest.deps) {
    const version = exactVersion(dep.spec);
    const id = addNode(graph, {
      ecosystem: 'PyPI',
      name: dep.name,
      version: version ?? '',
      ...(version ? {} : { declaredRange: dep.spec || '*' }),
      isDirect: true,
      sourceFile,
      confidence: version ? 'high' : 'medium',
      scope: dep.scope,
    });
    addEdge(graph, ROOT_ID, id);
  }
  warnings.push({
    code: 'no-lockfile',
    message:
      'No lock file found; versions are resolved from declared ranges and may differ from what is installed. Transitive dependencies are not scanned.',
    file: sourceFile,
  });
  return { graph, warnings };
}
