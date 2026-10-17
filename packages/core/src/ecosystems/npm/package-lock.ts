import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { Dependency, DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import { npmVersioning } from './versioning.js';

interface LockDepsFields {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LockPackageEntry extends LockDepsFields {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
}

interface LockV1Entry {
  version: string;
  resolved?: string;
  dev?: boolean;
  optional?: boolean;
  requires?: Record<string, string>;
  dependencies?: Record<string, LockV1Entry>;
}

interface PackageLock {
  name?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockPackageEntry>;
  dependencies?: Record<string, LockV1Entry>;
}

export interface LockParseResult {
  graph: DependencyGraph;
  warnings: Warning[];
}

const NM = 'node_modules/';

function scopeOf(entry: {
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
}): DependencyScope {
  if (entry.dev || entry.devOptional) return 'dev';
  if (entry.peer) return 'peer';
  if (entry.optional) return 'optional';
  return 'prod';
}

/** Versions that do not come from the registry (git, file:, link:) cannot be matched in OSV. */
function isRegistryVersion(
  version: string | undefined,
  resolved: string | undefined,
): version is string {
  if (!version || !npmVersioning.isValid(version)) return false;
  if (resolved && /^(git\+|git:|file:|link:|github:)/.test(resolved)) return false;
  return true;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function packageNameFromPath(path: string): string {
  const i = path.lastIndexOf(NM);
  return i === -1 ? path : path.slice(i + NM.length);
}

function allDeps(entry: LockDepsFields): string[] {
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.devDependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ];
}

/**
 * Node's resolution algorithm on lock paths: look in `<from>/node_modules/<name>`,
 * then walk up through each ancestor `node_modules`, ending at the top level.
 */
function resolveFrom(
  packages: Record<string, LockPackageEntry>,
  from: string,
  name: string,
): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/${NM}${name}` : `${NM}${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    const i = base.lastIndexOf(`/${NM}`);
    // `node_modules/a/node_modules/b` → `node_modules/a`; `node_modules/a` or `packages/x` → root
    base = i === -1 ? '' : base.slice(0, i);
  }
}

function parseV2(lock: PackageLock, sourceFile: string, rootName: string): LockParseResult {
  const packages = lock.packages ?? {};
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];

  /** Resolves link entries (workspace symlinks) to the folder they point to. */
  const target = (path: string): string => {
    const entry = packages[path];
    return entry?.link && entry.resolved ? entry.resolved : path;
  };

  // Workspace folders (root + every non-node_modules key) are "first party":
  // their dependencies are direct, and they are never matched against advisories.
  const workspaces = Object.keys(packages).filter((p) => !p.includes(NM) || p === '');
  if (!workspaces.includes('')) workspaces.unshift('');

  const ids = new Map<string, string>();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.includes(NM) || entry.link) continue;
    const name = entry.name ?? packageNameFromPath(path);
    if (!isRegistryVersion(entry.version, entry.resolved)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${name}: version "${entry.version ?? '?'}" is not a registry release`,
        file: sourceFile,
      });
      continue;
    }
    const dep: Dependency = {
      ecosystem: 'npm',
      name,
      version: entry.version,
      isDirect: false,
      sourceFile,
      confidence: 'high',
      scope: scopeOf(entry),
    };
    ids.set(path, addNode(graph, dep));
  }

  // Workspace members become internal nodes so chains read `root > @ws/web > minimist`.
  for (const ws of workspaces) {
    if (ws === '') continue;
    const entry = packages[ws]!;
    const id = addNode(graph, {
      ecosystem: 'npm',
      name: entry.name ?? basenameOf(ws),
      version: entry.version ?? '0.0.0',
      isDirect: true,
      sourceFile,
      confidence: 'high',
      internal: true,
    });
    ids.set(ws, id);
  }

  for (const ws of workspaces) {
    const entry = packages[ws] ?? {};
    const parentId = ws === '' ? ROOT_ID : ids.get(ws)!;
    for (const depName of allDeps(entry)) {
      const resolvedPath = resolveFrom(packages, ws, depName);
      if (!resolvedPath) continue;
      const id = ids.get(target(resolvedPath));
      if (!id) continue;
      const dep = graph.nodes.get(id)!;
      if (!dep.internal) dep.isDirect = true;
      addEdge(graph, parentId, id);
    }
    if (ws !== '') addEdge(graph, ROOT_ID, parentId);
  }

  for (const [path, entry] of Object.entries(packages)) {
    const parentId = ids.get(path);
    if (!parentId || !path.includes(NM)) continue;
    for (const depName of allDeps(entry)) {
      const resolvedPath = resolveFrom(packages, path, depName);
      const childId = resolvedPath ? ids.get(target(resolvedPath)) : undefined;
      if (childId) addEdge(graph, parentId, childId);
    }
  }

  return { graph, warnings };
}

function parseV1(
  lock: PackageLock,
  sourceFile: string,
  rootName: string,
  directNames: Set<string> | undefined,
): LockParseResult {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];

  interface Scope {
    deps: Record<string, LockV1Entry>;
    parent: Scope | undefined;
    ids: Map<string, string>;
  }

  const lookup = (scope: Scope | undefined, name: string): string | undefined => {
    for (let s = scope; s; s = s.parent) {
      const id = s.ids.get(name);
      if (id) return id;
    }
    return undefined;
  };

  const visit = (scope: Scope) => {
    for (const [name, entry] of Object.entries(scope.deps)) {
      if (!isRegistryVersion(entry.version, entry.resolved)) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${name}: version "${entry.version}" is not a registry release`,
          file: sourceFile,
        });
        continue;
      }
      const id = addNode(graph, {
        ecosystem: 'npm',
        name,
        version: entry.version,
        isDirect: false,
        sourceFile,
        confidence: 'high',
        scope: scopeOf(entry),
      });
      scope.ids.set(name, id);
    }
    for (const [name, entry] of Object.entries(scope.deps)) {
      const selfId = scope.ids.get(name);
      // Nested `dependencies` shadow outer ones when resolving this entry's requires.
      let resolveScope = scope;
      if (entry.dependencies) {
        resolveScope = { deps: entry.dependencies, parent: scope, ids: new Map() };
        visit(resolveScope);
      }
      if (!selfId) continue;
      for (const req of Object.keys(entry.requires ?? {})) {
        const childId = lookup(resolveScope, req);
        if (childId) addEdge(graph, selfId, childId);
      }
    }
  };

  const top: Scope = { deps: lock.dependencies ?? {}, parent: undefined, ids: new Map() };
  visit(top);

  // v1 locks don't say which packages are direct; use package.json when we have it,
  // otherwise treat every top-level package that nothing else requires as direct.
  const required = new Set<string>();
  for (const children of graph.edges.values()) for (const c of children) required.add(c);
  for (const [name, id] of top.ids) {
    const direct = directNames ? directNames.has(name) : !required.has(id);
    if (direct) {
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, ROOT_ID, id);
    }
  }
  if (!directNames) {
    warnings.push({
      code: 'lockfile-v1-direct-guess',
      message: 'package-lock v1 without package.json: direct dependencies were inferred',
      file: sourceFile,
    });
  }
  return { graph, warnings };
}

export function parsePackageLock(
  content: string,
  sourceFile: string,
  fallbackRootName: string,
  directNames?: Set<string>,
): LockParseResult {
  let lock: PackageLock;
  try {
    lock = JSON.parse(content) as PackageLock;
  } catch (error) {
    throw new Error(`${sourceFile}: invalid JSON (${(error as Error).message})`, { cause: error });
  }
  const rootName = lock.name || fallbackRootName;
  if (lock.packages && (lock.lockfileVersion ?? 1) >= 2) return parseV2(lock, sourceFile, rootName);
  if (lock.dependencies) return parseV1(lock, sourceFile, rootName, directNames);
  return { graph: createGraph(rootName), warnings: [] };
}
