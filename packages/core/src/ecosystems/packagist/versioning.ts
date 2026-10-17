import type { Versioning } from '../types.js';
import { caretBreaking, compareNumeric, compareWithInvalid } from '../shared.js';

export interface ComposerVersion {
  release: number[];
  /** dev < alpha < beta < RC < stable < patch */
  stability: number;
  stabilityNumber: number;
}

const STABILITY: Record<string, number> = {
  dev: 0,
  a: 1,
  alpha: 1,
  b: 2,
  beta: 2,
  rc: 3,
  stable: 4,
  p: 5,
  pl: 5,
  patch: 5,
};

const VERSION_RE =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-._]?(stable|beta|b|rc|alpha|a|patch|pl|p|dev)(?:[.-]?(\d+))?)?$/i;

export function parseComposerVersion(version: string): ComposerVersion | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  const release = [m[1], m[2], m[3], m[4]].filter((x) => x !== undefined).map(Number);
  return {
    release,
    stability: m[5] ? STABILITY[m[5].toLowerCase()]! : STABILITY.stable!,
    stabilityNumber: m[6] ? Number(m[6]) : 0,
  };
}

export function compareComposer(a: ComposerVersion, b: ComposerVersion): number {
  return (
    compareNumeric(a.release, b.release) ||
    a.stability - b.stability ||
    a.stabilityNumber - b.stabilityNumber
  );
}

export const packagistVersioning: Versioning = {
  compare: (a, b) => compareWithInvalid(a, b, parseComposerVersion, compareComposer),
  isValid: (v) => parseComposerVersion(v) !== null,
  isMajorBump(from, to) {
    const a = parseComposerVersion(from);
    const b = parseComposerVersion(to);
    if (!a || !b) return true;
    return caretBreaking(a.release, b.release);
  },
};
