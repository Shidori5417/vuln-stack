import type { Versioning } from '../types.js';
import { caretBreaking, compareNumeric, compareWithInvalid } from '../shared.js';

interface NuGetVersion {
  release: number[];
  pre: string[];
}

const RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/;

export function parseNuGetVersion(version: string): NuGetVersion | null {
  const m = RE.exec(version.trim());
  if (!m) return null;
  return {
    release: [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x))),
    pre: m[5] ? m[5].split('.') : [],
  };
}

/** SemVer 2.0 prerelease ordering, case-insensitive as NuGet does it. */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else {
      const d = x.toLowerCase().localeCompare(y.toLowerCase());
      if (d) return d;
    }
  }
  return 0;
}

export const nugetVersioning: Versioning = {
  compare: (a, b) =>
    compareWithInvalid(
      a,
      b,
      parseNuGetVersion,
      (x, y) => compareNumeric(x.release, y.release) || comparePre(x.pre, y.pre),
    ),
  isValid: (v) => parseNuGetVersion(v) !== null,
  isMajorBump(from, to) {
    const a = parseNuGetVersion(from);
    const b = parseNuGetVersion(to);
    if (!a || !b) return true;
    return caretBreaking(a.release, b.release);
  },
};
