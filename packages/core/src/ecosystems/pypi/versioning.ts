import * as pep440 from '@renovatebot/pep440';
import type { Versioning } from '../types.js';
import { caretBreaking, compareWithInvalid } from '../shared.js';

const parse = (v: string) => (pep440.valid(v) ? v : null);

export const pypiVersioning: Versioning = {
  compare: (a, b) => compareWithInvalid(a, b, parse, (x, y) => pep440.compare(x, y)),
  isValid: (v) => pep440.valid(v) !== null,
  isMajorBump(from, to) {
    const a = pep440.explain(from);
    const b = pep440.explain(to);
    if (!a || !b) return true;
    if (a.epoch !== b.epoch) return true;
    return caretBreaking(a.release, b.release);
  },
};

/** PEP 503 normalisation: case-insensitive, runs of `-_.` are equivalent. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}
