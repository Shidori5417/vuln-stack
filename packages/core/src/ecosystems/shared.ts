import semver, { type SemVer } from 'semver';
import { ROOT_ID } from '../model/graph.js';
import type { DependencyGraph } from '../model/types.js';
import type { Versioning } from './types.js';

/**
 * Caret-style "is this a breaking upgrade" on numeric release parts:
 * the first part changing is breaking, and while it is 0 the second part is too.
 */
export function caretBreaking(from: readonly number[], to: readonly number[]): boolean {
  const [a0 = 0, a1 = 0] = from;
  const [b0 = 0, b1 = 0] = to;
  if (a0 !== b0) return true;
  return a0 === 0 && a1 !== b1;
}

/** Compares two numeric arrays, treating missing parts as 0. */
export function compareNumeric(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Fallback ordering for strings that are not valid versions: invalid sorts first. */
export function compareWithInvalid<T>(
  a: string,
  b: string,
  parse: (v: string) => T | null,
  compare: (x: T, y: T) => number,
): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) return compare(pa, pb);
  if (pa) return 1;
  if (pb) return -1;
  return a.localeCompare(b);
}

/** Parses a version with an optional `v` prefix; null when it is not valid semver. */
export function parseSemver(v: string): SemVer | null {
  return semver.parse(v.trim().replace(/^v(?=\d)/, ''));
}

/** Semver ordering for Cargo, Pub, Hex and SwiftPM. Never throws; invalid versions sort first. */
export const semverVersioning: Versioning = {
  compare: (a, b) => compareWithInvalid(a, b, parseSemver, (x, y) => semver.compare(x, y)),
  isValid: (v) => parseSemver(v) !== null,
  isMajorBump(from, to) {
    const a = parseSemver(from);
    const b = parseSemver(to);
    if (!a || !b) return true;
    return caretBreaking([a.major, a.minor], [b.major, b.minor]);
  },
};

/**
 * Lock files without scope data: a dependency only reachable through `dev` direct
 * dependencies becomes `dev`, everything reachable from a non-dev one is `prod`.
 */
export function propagateScopes(graph: DependencyGraph): void {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const id of graph.edges.get(ROOT_ID) ?? []) {
    if (graph.nodes.get(id)?.scope !== 'dev') {
      seen.add(id);
      queue.push(id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const child of graph.edges.get(queue[i]!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  for (const [id, node] of graph.nodes) {
    if (node.internal) continue;
    node.scope = seen.has(id) ? 'prod' : 'dev';
  }
}

/** Ids nobody depends on: the best guess for direct dependencies when the lock does not say. */
export function rootIds(graph: DependencyGraph, ids: Iterable<string>): string[] {
  const reached = new Set<string>();
  for (const children of graph.edges.values()) for (const c of children) reached.add(c);
  return [...ids].filter((id) => !reached.has(id));
}
