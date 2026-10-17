import { parse as parseYaml } from 'yaml';
import {
  addEdge,
  addNode,
  assignScopesByReachability,
  createGraph,
  ROOT_ID,
} from '../../model/graph.js';
import type { Dependency, Warning } from '../../model/types.js';
import type { LockParseResult } from './package-lock.js';
import { npmVersioning } from './versioning.js';

type DepMap = Record<string, string | { specifier?: string; version: string }>;

interface Importer {
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

interface SnapshotEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
  name?: string;
  version?: string;
}

interface PnpmLock {
  lockfileVersion?: string | number;
  importers?: Record<string, Importer>;
  /** Lockfiles before v6 without importers keep the root's deps at the top level. */
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
  packages?: Record<string, SnapshotEntry>;
  snapshots?: Record<string, SnapshotEntry>;
}

/** Strips peer suffixes: `16.0.0(react@16.0.0)` → `16.0.0`, v5 `1.0.0_react@16` → `1.0.0`. */
const stripPeers = (v: string) => v.replace(/\(.*$/, '').replace(/_.*$/, '');

/**
 * Parses snapshot keys from every lock version:
 * v9 `name@1.0.0(peer@1)`, v6 `/name@1.0.0`, v5 `/name/1.0.0_peer@1`, plus scoped names.
 */
export function parsePnpmKey(key: string): { name: string; version: string } | undefined {
  // v5 `/name/1.0.0_peer@1`: matched first, since the peer suffix itself contains '@'
  // and `_` may legitimately appear in names (string_decoder).
  const v5 = /^\/?((?:@[^/]+\/)?[^/@]+)\/(\d[^/]*)$/.exec(key);
  if (v5) return { name: v5[1]!, version: stripPeers(v5[2]!) };
  const k = key.startsWith('/') ? key.slice(1) : key;
  const base = k.replace(/\(.*$/, '');
  const at = base.lastIndexOf('@');
  if (at > 0) return { name: base.slice(0, at), version: stripPeers(base.slice(at + 1)) };
  return undefined;
}

/**
 * A dependency reference inside importers/snapshots. Plain versions refer to the
 * same name; aliases (`npm:x@1`, v9 `x@1.0.0`) name the real package; links are skipped.
 */
function resolveRef(depName: string, ref: string): { name: string; version: string } | undefined {
  if (/^(link:|file:|workspace:)/.test(ref)) return undefined;
  if (ref.startsWith('/')) return parsePnpmKey(ref); // v5/v6 alias `/real-name/1.0.0`
  const plain = stripPeers(ref);
  if (npmVersioning.isValid(plain) && !plain.includes('@'))
    return { name: depName, version: plain };
  return parsePnpmKey(ref.replace(/^npm:/, ''));
}

function importerDeps(imp: Importer): { name: string; ref: string; dev: boolean }[] {
  const out: { name: string; ref: string; dev: boolean }[] = [];
  const add = (deps: DepMap | undefined, dev: boolean) => {
    for (const [name, value] of Object.entries(deps ?? {})) {
      out.push({ name, ref: typeof value === 'string' ? value : value.version, dev });
    }
  };
  add(imp.dependencies, false);
  add(imp.optionalDependencies, false);
  add(imp.devDependencies, true);
  return out;
}

export function parsePnpmLock(
  content: string,
  sourceFile: string,
  rootName: string,
): LockParseResult {
  const lock = (parseYaml(content) ?? {}) as PnpmLock;
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const entries = lock.snapshots ?? lock.packages ?? {};
  const meta = lock.packages ?? {};

  const ids = new Map<string, string>(); // name@version → node id
  const idFor = (name: string, version: string) => ids.get(`${name}@${version}`);

  for (const [key, entry] of Object.entries(entries)) {
    const parsed = parsePnpmKey(key);
    const name = entry.name ?? parsed?.name;
    const version = entry.version ?? parsed?.version;
    if (!name || !version || !npmVersioning.isValid(version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${key}: not a registry release`,
        file: sourceFile,
      });
      continue;
    }
    const dep: Dependency = {
      ecosystem: 'npm',
      name,
      version,
      isDirect: false,
      sourceFile,
      confidence: 'high',
    };
    // v6 marks dev/optional per package; v9 doesn't, scopes are computed below.
    const flags = meta[key] ?? entry;
    if (flags.dev === true) dep.scope = 'dev';
    else if (flags.optional) dep.scope = 'optional';
    else if (flags.dev === false) dep.scope = 'prod';
    ids.set(`${name}@${version}`, addNode(graph, dep));
  }

  for (const [key, entry] of Object.entries(entries)) {
    const parsed = parsePnpmKey(key);
    const from = parsed && idFor(entry.name ?? parsed.name, entry.version ?? parsed.version);
    if (!from) continue;
    for (const [depName, ref] of Object.entries({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      const target = resolveRef(depName, ref);
      const to = target && idFor(target.name, target.version);
      if (to) addEdge(graph, from, to);
    }
  }

  const importers: Record<string, Importer> = lock.importers ?? {
    '.': {
      dependencies: lock.dependencies,
      devDependencies: lock.devDependencies,
      optionalDependencies: lock.optionalDependencies,
    } as Importer,
  };
  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  for (const [path, imp] of Object.entries(importers)) {
    let parent = ROOT_ID;
    if (path !== '.') {
      // Workspace members show up in chains: `root > packages/web > lodash`.
      parent = addNode(graph, {
        ecosystem: 'npm',
        name: path,
        version: '0.0.0',
        isDirect: true,
        sourceFile,
        confidence: 'high',
        internal: true,
      });
      addEdge(graph, ROOT_ID, parent);
    }
    for (const { name, ref, dev } of importerDeps(imp)) {
      const target = resolveRef(name, ref);
      const id = target && idFor(target.name, target.version);
      if (!id) continue;
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, parent, id);
      (dev ? devRoots : prodRoots).push(id);
    }
  }

  const hasDevFlags = Object.values(meta).some((e) => typeof e.dev === 'boolean');
  if (!hasDevFlags) assignScopesByReachability(graph, prodRoots, devRoots);
  return { graph, warnings };
}

/** True when `rel` (path relative to the lock's folder) is one of the lock's importers. */
export function pnpmHasImporter(content: string, rel: string): boolean {
  const lock = (parseYaml(content) ?? {}) as PnpmLock;
  return Boolean(lock.importers?.[rel]);
}
