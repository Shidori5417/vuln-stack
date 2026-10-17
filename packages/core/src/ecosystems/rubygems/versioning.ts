import type { Versioning } from '../types.js';

type Segment = number | string;

/** Mirrors Gem::Version: dots and letter/digit boundaries split segments; `-` means `.pre.`. */
function parse(v: string): Segment[] | null {
  const text = v.trim().replace(/-/g, '.pre.');
  if (!/^[0-9]+(?:\.[0-9a-zA-Z]+)*$/.test(text)) return null;
  const segments = text.match(/[0-9]+|[a-zA-Z]+/g);
  return segments ? segments.map((s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase())) : null;
}

function compareSegments(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // A letter segment marks a pre-release, so it sorts before any number.
    if (typeof x === 'string' && typeof y === 'number') return -1;
    if (typeof x === 'number' && typeof y === 'string') return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export const rubygemsVersioning: Versioning = {
  compare(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    if (pa && pb) return compareSegments(pa, pb);
    if (pa) return 1;
    if (pb) return -1;
    return a.localeCompare(b);
  },
  isValid: (v) => parse(v) !== null,
  isMajorBump(from, to) {
    const a = parse(from);
    const b = parse(to);
    if (!a || !b) return true;
    return a[0] !== b[0];
  },
};
