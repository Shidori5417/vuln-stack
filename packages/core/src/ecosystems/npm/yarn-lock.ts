import { parse as parseYaml } from 'yaml';
import {
  addEdge,
  addNode,
  assignScopesByReachability,
  createGraph,
  ROOT_ID,
} from '../../model/graph.js';
import type { Warning } from '../../model/types.js';
import type { LockParseResult } from './package-lock.js';
import { npmVersioning } from './versioning.js';

export interface WorkspaceManifest {
  /** Folder relative to the lock ('' for the root). */
  path: string;
  name?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface YarnEntry {
  version: string;
  resolution?: string;
  resolved?: string;
  linkType?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

/** `name@range` → name, handling scoped packages. */
export function specName(spec: string): string {
  const at = spec.indexOf('@', 1);
  return at === -1 ? spec : spec.slice(0, at);
}

/** Parses the classic (v1) yarn.lock format into `spec → entry`. */
export function parseYarnV1(content: string): Map<string, YarnEntry> {
  const map = new Map<string, YarnEntry>();
  let current: YarnEntry | undefined;
  let section: 'dependencies' | 'optionalDependencies' | undefined;

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      current = { version: '' };
      section = undefined;
      for (const spec of line.replace(/:$/, '').split(/,\s*/)) map.set(unquote(spec), current);
    } else if (current && indent === 2) {
      section = undefined;
      if (line === 'dependencies:' || line === 'optionalDependencies:') {
        const name = line === 'dependencies:' ? 'dependencies' : 'optionalDependencies';
        section = name;
        current[name] = {};
      } else {
        const m = /^("?[^\s"]+"?)\s+(.*)$/.exec(line);
        if (m) {
          const key = unquote(m[1]!);
          const value = unquote(m[2]!);
          if (key === 'version') current.version = value;
          else if (key === 'resolved') current.resolved = value;
        }
      }
    } else if (current && section && indent >= 4) {
      const m = /^("[^"]+"|\S+)\s+(.*)$/.exec(line);
      if (m) current[section]![unquote(m[1]!)] = unquote(m[2]!);
    }
  }
  return map;
}

/** Berry (v2+) lock files are YAML with `__metadata`; specs carry protocols (`npm:`). */
function parseBerry(content: string): Map<string, YarnEntry> {
  const doc = (parseYaml(content) ?? {}) as Record<string, YarnEntry>;
  const map = new Map<string, YarnEntry>();
  for (const [keys, entry] of Object.entries(doc)) {
    if (keys === '__metadata') continue;
    for (const spec of keys.split(/,\s*/)) map.set(spec.trim(), entry);
  }
  return map;
}

export function isBerryLock(content: string): boolean {
  return /^__metadata:/m.test(content);
}

/** Real package name and version of an entry, or undefined for non-registry entries. */
function identify(
  spec: string,
  entry: YarnEntry,
  berry: boolean,
): { name: string; version: string } | undefined {
  if (!npmVersioning.isValid(entry.version)) return undefined;
  if (berry) {
    const res = entry.resolution ?? '';
    if (entry.linkType === 'soft' || res.includes('@workspace:')) return undefined;
    // `name@npm:1.2.3` or a patched npm package `name@patch:name@npm%3A1.2.3#…`
    if (!/@npm:|@patch:.*npm%3A/.test(res)) return undefined;
    return { name: specName(res), version: entry.version };
  }
  if (
    entry.resolved &&
    /^(git|file:|link:|https?:\/\/(?!registry\.))/.test(entry.resolved) &&
    !entry.resolved.includes('/-/')
  ) {
    return undefined;
  }
  const range = spec.slice(specName(spec).length + 1);
  // Alias: "foo@npm:bar@^1.0.0" installs bar.
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(range);
  return { name: alias ? alias[1]! : specName(spec), version: entry.version };
}

/**
 * Builds the graph from a yarn.lock (v1 or berry). The lock doesn't say which
 * packages are direct, so workspace manifests (root first) provide the roots.
 */
export function parseYarnLock(
  content: string,
  sourceFile: string,
  rootName: string,
  workspaces: WorkspaceManifest[],
): LockParseResult {
  const berry = isBerryLock(content);
  const specs = berry ? parseBerry(content) : parseYarnV1(content);
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];

  const idsByEntry = new Map<YarnEntry, string>();
  for (const [spec, entry] of specs) {
    if (idsByEntry.has(entry)) continue;
    const ident = identify(spec, entry, berry);
    if (!ident) {
      if (!(berry && (entry.resolution ?? '').includes('@workspace:'))) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${spec}: not a registry release`,
          file: sourceFile,
        });
      }
      continue;
    }
    idsByEntry.set(
      entry,
      addNode(graph, {
        ecosystem: 'npm',
        ...ident,
        isDirect: false,
        sourceFile,
        confidence: 'high',
      }),
    );
  }

  /** Finds the entry for `name` + `range` as written in a manifest or another entry. */
  const lookup = (name: string, range: string): string | undefined => {
    const candidates = [`${name}@${range}`];
    if (berry && !/^[a-z]+:/.test(range)) candidates.push(`${name}@npm:${range}`);
    for (const c of candidates) {
      const entry = specs.get(c);
      if (entry) return idsByEntry.get(entry);
    }
    return undefined;
  };

  for (const entry of new Set(specs.values())) {
    const from = idsByEntry.get(entry);
    if (!from) continue;
    for (const [dep, range] of Object.entries({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      const to = lookup(dep, range);
      if (to) addEdge(graph, from, to);
    }
  }

  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  for (const ws of workspaces) {
    let parent = ROOT_ID;
    if (ws.path) {
      parent = addNode(graph, {
        ecosystem: 'npm',
        name: ws.name ?? ws.path,
        version: '0.0.0',
        isDirect: true,
        sourceFile,
        confidence: 'high',
        internal: true,
      });
      addEdge(graph, ROOT_ID, parent);
    }
    const add = (deps: Record<string, string>, dev: boolean) => {
      for (const [name, range] of Object.entries(deps)) {
        const id = lookup(name, range);
        if (!id) continue;
        graph.nodes.get(id)!.isDirect = true;
        addEdge(graph, parent, id);
        (dev ? devRoots : prodRoots).push(id);
      }
    };
    add(ws.dependencies, false);
    add(ws.devDependencies, true);
  }
  if (workspaces.length === 0) {
    warnings.push({
      code: 'yarn-no-manifest',
      message: 'yarn.lock without package.json: direct dependencies are unknown',
      file: sourceFile,
    });
  }
  assignScopesByReachability(graph, prodRoots, devRoots);
  return { graph, warnings };
}
