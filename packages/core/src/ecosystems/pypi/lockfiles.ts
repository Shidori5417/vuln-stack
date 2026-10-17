import { parse as parseToml } from 'smol-toml';
import {
  addEdge,
  addNode,
  assignScopesByReachability,
  createGraph,
  ROOT_ID,
} from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import type { DirectDeps } from './pyproject.js';
import { normalizePypiName, pypiVersioning } from './versioning.js';

interface Result {
  graph: DependencyGraph;
  warnings: Warning[];
}

function invalidToml(file: string, error: unknown): never {
  throw new Error(`${file}: invalid TOML (${(error as Error).message})`, { cause: error });
}

/** Marks direct deps and links them to the root; scopes come from reachability. */
function linkDirect(
  graph: DependencyGraph,
  ids: Map<string, string>,
  direct: DirectDeps | undefined,
): void {
  if (!direct) {
    // No manifest: anything nothing else depends on is treated as direct.
    const reached = new Set<string>();
    for (const children of graph.edges.values()) for (const c of children) reached.add(c);
    for (const id of graph.nodes.keys()) {
      if (!reached.has(id)) {
        graph.nodes.get(id)!.isDirect = true;
        addEdge(graph, ROOT_ID, id);
      }
    }
    return;
  }
  const roots = { prod: [] as string[], dev: [] as string[] };
  for (const [names, kind] of [
    [direct.prod, 'prod'],
    [direct.dev, 'dev'],
  ] as const) {
    for (const name of names) {
      const id = ids.get(name);
      if (!id) continue;
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, ROOT_ID, id);
      roots[kind].push(id);
    }
  }
  assignScopesByReachability(graph, roots.prod, roots.dev);
}

interface PoetryPackage {
  name: string;
  version: string;
  category?: string;
  groups?: string[];
  dependencies?: Record<string, unknown>;
  source?: { type?: string };
}

/** poetry.lock: `[[package]]` with `[package.dependencies]` keyed by name. */
export function parsePoetryLock(
  content: string,
  sourceFile: string,
  rootName: string,
  direct?: DirectDeps,
): Result {
  let doc: { package?: PoetryPackage[] };
  try {
    doc = parseToml(content) as typeof doc;
  } catch (e) {
    invalidToml(sourceFile, e);
  }
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const ids = new Map<string, string>();

  for (const pkg of doc.package ?? []) {
    const name = normalizePypiName(pkg.name);
    if (
      ['git', 'directory', 'file', 'url'].includes(pkg.source?.type ?? '') ||
      !pypiVersioning.isValid(pkg.version)
    ) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${pkg.name}: not installed from a package index`,
        file: sourceFile,
      });
      continue;
    }
    const groups = pkg.groups ?? (pkg.category ? [pkg.category] : []);
    const scope: DependencyScope | undefined =
      groups.length === 0 ? undefined : groups.includes('main') ? 'prod' : 'dev';
    ids.set(
      name,
      addNode(graph, {
        ecosystem: 'PyPI',
        name,
        version: pkg.version,
        isDirect: false,
        sourceFile,
        confidence: 'high',
        ...(scope ? { scope } : {}),
      }),
    );
  }
  for (const pkg of doc.package ?? []) {
    const from = ids.get(normalizePypiName(pkg.name));
    if (!from) continue;
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const to = ids.get(normalizePypiName(dep));
      if (to) addEdge(graph, from, to);
    }
  }
  const hadGroups = (doc.package ?? []).some((p) => p.groups || p.category);
  linkDirect(graph, ids, direct);
  // Poetry's own group data is authoritative when present.
  if (hadGroups) {
    for (const pkg of doc.package ?? []) {
      const dep = graph.nodes.get(ids.get(normalizePypiName(pkg.name)) ?? '');
      const groups = pkg.groups ?? (pkg.category ? [pkg.category] : []);
      if (dep && groups.length) dep.scope = groups.includes('main') ? 'prod' : 'dev';
    }
  }
  return { graph, warnings };
}

interface UvPackage {
  name: string;
  version?: string;
  source?: {
    registry?: string;
    virtual?: string;
    editable?: string;
    directory?: string;
    git?: string;
    path?: string;
    url?: string;
  };
  dependencies?: { name: string }[];
  'optional-dependencies'?: Record<string, { name: string }[]>;
  'dev-dependencies'?: Record<string, { name: string }[]>;
}

/** uv.lock: workspace members are `virtual`/`editable` sources and become internal roots. */
export function parseUvLock(content: string, sourceFile: string, rootName: string): Result {
  let doc: { package?: UvPackage[] };
  try {
    doc = parseToml(content) as typeof doc;
  } catch (e) {
    invalidToml(sourceFile, e);
  }
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const ids = new Map<string, string>();
  const members: UvPackage[] = [];

  for (const pkg of doc.package ?? []) {
    const name = normalizePypiName(pkg.name);
    const src = pkg.source ?? {};
    if (src.virtual !== undefined || src.editable !== undefined) {
      members.push(pkg);
      continue;
    }
    if (src.registry === undefined || !pkg.version || !pypiVersioning.isValid(pkg.version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${pkg.name}: not installed from a package index`,
        file: sourceFile,
      });
      continue;
    }
    ids.set(
      name,
      addNode(graph, {
        ecosystem: 'PyPI',
        name,
        version: pkg.version,
        isDirect: false,
        sourceFile,
        confidence: 'high',
      }),
    );
  }
  for (const pkg of doc.package ?? []) {
    const from = ids.get(normalizePypiName(pkg.name));
    if (!from) continue;
    const deps = [
      ...(pkg.dependencies ?? []),
      ...Object.values(pkg['optional-dependencies'] ?? {}).flat(),
    ];
    for (const d of deps) {
      const to = ids.get(normalizePypiName(d.name));
      if (to) addEdge(graph, from, to);
    }
  }

  const prod: string[] = [];
  const dev: string[] = [];
  for (const member of members) {
    const isRoot = member.source?.virtual === '.' || member.source?.editable === '.';
    let parent = ROOT_ID;
    if (!isRoot) {
      parent = addNode(graph, {
        ecosystem: 'PyPI',
        name: normalizePypiName(member.name),
        version: member.version ?? '0.0.0',
        isDirect: true,
        sourceFile,
        confidence: 'high',
        internal: true,
      });
      addEdge(graph, ROOT_ID, parent);
    }
    const link = (list: { name: string }[], into: string[]) => {
      for (const d of list) {
        const id = ids.get(normalizePypiName(d.name));
        if (!id) continue;
        graph.nodes.get(id)!.isDirect = true;
        addEdge(graph, parent, id);
        into.push(id);
      }
    };
    link(
      [
        ...(member.dependencies ?? []),
        ...Object.values(member['optional-dependencies'] ?? {}).flat(),
      ],
      prod,
    );
    link(Object.values(member['dev-dependencies'] ?? {}).flat(), dev);
  }
  if (members.length === 0) linkDirect(graph, ids, undefined);
  else assignScopesByReachability(graph, prod, dev);
  return { graph, warnings };
}

interface PipfileLockEntry {
  version?: string;
  git?: string;
  path?: string;
  file?: string;
}

/** Pipfile.lock: flat `default`/`develop` sections; Pipfile (if any) gives direct names. */
export function parsePipfileLock(
  content: string,
  sourceFile: string,
  rootName: string,
  direct?: DirectDeps,
): Result {
  let doc: {
    default?: Record<string, PipfileLockEntry>;
    develop?: Record<string, PipfileLockEntry>;
  };
  try {
    doc = JSON.parse(content) as typeof doc;
  } catch (e) {
    throw new Error(`${sourceFile}: invalid JSON (${(e as Error).message})`, { cause: e });
  }
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const directNames = direct ? new Set([...direct.prod, ...direct.dev]) : undefined;

  for (const [section, scope] of [
    ['default', 'prod'],
    ['develop', 'dev'],
  ] as const) {
    for (const [rawName, entry] of Object.entries(doc[section] ?? {})) {
      const name = normalizePypiName(rawName);
      const version = entry.version?.replace(/^===?/, '');
      if (!version || !pypiVersioning.isValid(version)) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${rawName}: not installed from a package index`,
          file: sourceFile,
        });
        continue;
      }
      const isDirect = directNames ? directNames.has(name) : true;
      const id = addNode(graph, {
        ecosystem: 'PyPI',
        name,
        version,
        isDirect,
        sourceFile,
        confidence: 'high',
        scope,
      });
      // Pipfile.lock has no dependency edges: everything hangs off the root.
      addEdge(graph, ROOT_ID, id);
    }
  }
  return { graph, warnings };
}
