import type { Dependency, DependencyGraph } from './types.js';

export const ROOT_ID = '<root>';

export function nodeId(dep: Pick<Dependency, 'name' | 'version'>): string {
  return `${dep.name}@${dep.version}`;
}

export function createGraph(root: string): DependencyGraph {
  return { root, nodes: new Map(), edges: new Map() };
}

/** Adds a node, keeping the "strongest" flags if it was already present. */
export function addNode(graph: DependencyGraph, dep: Dependency): string {
  const id = nodeId(dep);
  const existing = graph.nodes.get(id);
  if (!existing) {
    graph.nodes.set(id, dep);
  } else {
    if (dep.isDirect) existing.isDirect = true;
    if (existing.scope && dep.scope === 'prod') existing.scope = 'prod';
  }
  return id;
}

export function addEdge(graph: DependencyGraph, from: string, to: string): void {
  if (from === to) return;
  let children = graph.edges.get(from);
  if (!children) {
    children = new Set();
    graph.edges.set(from, children);
  }
  children.add(to);
}

export interface PathInfo {
  /** Node ids from a direct dependency down to the node itself. */
  path: string[];
  pathCount: number;
}

const PATH_COUNT_CAP = 1000;

/**
 * Breadth-first walk from the root. Gives each node its shortest path and an
 * (approximate, capped) number of distinct paths that reach it.
 */
export function computePaths(graph: DependencyGraph): Map<string, PathInfo> {
  const result = new Map<string, PathInfo>();
  const queue: string[] = [];

  for (const child of graph.edges.get(ROOT_ID) ?? []) {
    if (!result.has(child)) {
      result.set(child, { path: [child], pathCount: 1 });
      queue.push(child);
    }
  }

  // Shortest paths first; path counts are accumulated over the BFS DAG, which
  // is what `npm ls`-style tooling reports and avoids cycles blowing up.
  const depth = new Map<string, number>();
  for (const id of queue) depth.set(id, 0);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const info = result.get(current)!;
    const d = depth.get(current)!;
    for (const child of graph.edges.get(current) ?? []) {
      const existing = result.get(child);
      if (!existing) {
        result.set(child, { path: [...info.path, child], pathCount: info.pathCount });
        depth.set(child, d + 1);
        queue.push(child);
      } else if (depth.get(child) === d + 1) {
        existing.pathCount = Math.min(PATH_COUNT_CAP, existing.pathCount + info.pathCount);
      }
    }
  }

  // Nodes not reachable from the root (e.g. incomplete lock data) still get a path.
  for (const id of graph.nodes.keys()) {
    if (!result.has(id)) result.set(id, { path: [id], pathCount: 1 });
  }
  return result;
}

/** Turns node ids into a human chain: `my-app > express > body-parser`. */
export function chainNames(graph: DependencyGraph, path: string[]): string[] {
  return [graph.root, ...path.map((id) => graph.nodes.get(id)?.name ?? id)];
}

/**
 * For lock files without per-package dev flags (pnpm v9, yarn): everything
 * reachable from a prod root is `prod`, what is only reachable from dev roots is `dev`.
 */
export function assignScopesByReachability(
  graph: DependencyGraph,
  prodRoots: Iterable<string>,
  devRoots: Iterable<string>,
): void {
  const walk = (roots: Iterable<string>) => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of graph.edges.get(id) ?? []) stack.push(child);
    }
    return seen;
  };
  const prod = walk(prodRoots);
  const dev = walk(devRoots);
  for (const [id, dep] of graph.nodes) {
    if (dep.internal) continue;
    if (prod.has(id)) dep.scope = dep.scope === 'optional' ? 'optional' : 'prod';
    else if (dev.has(id)) dep.scope = 'dev';
  }
}
