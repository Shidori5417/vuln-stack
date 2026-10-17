import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import { propagateScopes, rootIds } from '../shared.js';
import type { EcosystemPlugin } from '../types.js';
import { isAtom, isMap, isTuple, parseTerms, type Term } from './terms.js';
import { hexVersioning } from './versioning.js';

const atomName = (t: Term | undefined) => (isAtom(t) ? t.atom : undefined);

/** `only: :dev` / `only: [:dev, :test]` in a mix.exs dependency tuple. */
const isDevOnly = (options: string) => {
  const only = /only:\s*(\[[^\]]*\]|:\w+)/.exec(options)?.[1];
  return only !== undefined && !/:prod\b/.test(only);
};

/** Dependencies declared in mix.exs: name → dev-only flag. Heuristic, regex based. */
export function parseMixExs(content: string): Map<string, boolean> {
  const deps = new Map<string, boolean>();
  for (const m of content.matchAll(/\{\s*:([a-z_]\w*)\s*,([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    const options = m[2]!;
    // Real dependency tuples carry a requirement string or git/path/github options.
    if (!/"|git:|github:|path:|hex:/.test(options)) continue;
    deps.set(m[1]!, isDevOnly(options));
  }
  return deps;
}

/**
 * mix.lock: `%{"app": {:hex, :pkg, "1.2.3", "hash", [:mix], [{:dep, "~> 1.0", [hex: :dep, ...]}], "hexpm", "hash"}}`.
 * The lock has no direct/transitive info; mix.exs (when given) provides it, otherwise
 * packages nobody depends on are treated as direct.
 */
export function parseMixLock(
  content: string,
  sourceFile: string,
  rootName: string,
  mixExs?: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  let root: Term;
  try {
    root = parseTerms(content);
  } catch (e) {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: ${(e as Error).message}`,
      file: sourceFile,
    });
    return { graph, warnings };
  }
  if (!isMap(root)) {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: expected a map`,
      file: sourceFile,
    });
    return { graph, warnings };
  }

  const ids = new Map<string, string>(); // app name → node id
  const deps: [string, Term[]][] = [];
  for (const [app, value] of root.map) {
    if (!isTuple(value)) continue;
    const [kind, pkg, version, , , requirements, repo] = value.tuple;
    if (atomName(kind) !== 'hex') {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${app}: ${atomName(kind) ?? 'unknown'} dependency, not a Hex release`,
        file: sourceFile,
      });
      continue;
    }
    if (typeof repo === 'string' && repo !== 'hexpm') {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${app}: private Hex repository "${repo}"`,
        file: sourceFile,
      });
      continue;
    }
    const name = atomName(pkg);
    if (!name || typeof version !== 'string') continue;
    ids.set(
      app,
      addNode(graph, {
        ecosystem: 'Hex',
        name,
        version,
        isDirect: false,
        sourceFile,
        confidence: 'high',
        scope: 'prod',
      }),
    );
    deps.push([app, Array.isArray(requirements) ? requirements : []]);
  }

  for (const [app, requirements] of deps) {
    for (const req of requirements) {
      const dep = isTuple(req) ? atomName(req.tuple[0]) : undefined;
      const to = dep ? ids.get(dep) : undefined;
      if (to) addEdge(graph, ids.get(app)!, to);
    }
  }

  const declared = mixExs ? parseMixExs(mixExs) : undefined;
  const direct = declared ? [...declared.keys()].filter((n) => ids.has(n)) : [];
  const directApps = direct.length
    ? direct
    : [...ids.keys()].filter((app) => rootIds(graph, [ids.get(app)!]).length);
  for (const app of directApps) {
    const node = graph.nodes.get(ids.get(app)!)!;
    node.isDirect = true;
    if (declared?.get(app)) node.scope = 'dev';
    addEdge(graph, ROOT_ID, ids.get(app)!);
  }
  if ([...graph.nodes.values()].some((n) => n.scope === 'dev')) propagateScopes(graph);
  return { graph, warnings };
}

export const hexPlugin: EcosystemPlugin = {
  id: 'Hex',
  displayName: 'Mix (Hex)',
  files: SUPPORTED_FILES.Hex,
  versioning: hexVersioning,

  async parse({ dir, files, provider, allFiles }) {
    if (!files.some((f) => basename(f) === 'mix.lock')) return { subprojects: [], warnings: [] };
    const lockPath = joinPath(dir, 'mix.lock');
    const mixPath = joinPath(dir, 'mix.exs');
    const mixExs = allFiles.includes(mixPath)
      ? await provider.read(mixPath).catch(() => undefined)
      : undefined;
    const { graph, warnings } = parseMixLock(
      await provider.read(lockPath),
      lockPath,
      dir ? basename(dir) : 'root',
      mixExs,
    );
    const sub: Subproject = { path: dir, ecosystem: 'Hex', graph, warnings };
    return { subprojects: [sub], warnings: [] };
  },
};
