import type { Versioning } from '../types.js';
import { caretBreaking } from '../shared.js';

/**
 * Maven's ComparableVersion ordering (flattened): numbers compare numerically,
 * qualifiers use alpha < beta < milestone < rc < snapshot < (release) < sp,
 * unknown qualifiers sort after those, lexically. Numbers rank above qualifiers.
 */
type Item = { kind: 'int'; value: number } | { kind: 'str'; value: string };

const QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };
const RELEASE_RANK = QUALIFIERS.indexOf('');

function qualifierRank(q: string): string {
  const i = QUALIFIERS.indexOf(q);
  return i === -1 ? `${QUALIFIERS.length}-${q}` : String(i);
}

export function tokenizeMaven(version: string): Item[] {
  const items: Item[] = [];
  const raw = version.trim().toLowerCase();
  const tokens = raw.match(/\d+|[a-z]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d/.test(t)) {
      items.push({ kind: 'int', value: Number(t) });
      continue;
    }
    // Single letters a/b/m are short for alpha/beta/milestone when a number follows.
    let q = t;
    const nextIsNumber = /^\d/.test(tokens[i + 1] ?? '');
    if (nextIsNumber && (q === 'a' || q === 'b' || q === 'm')) {
      q = { a: 'alpha', b: 'beta', m: 'milestone' }[q]!;
    }
    items.push({ kind: 'str', value: ALIASES[q] ?? q });
  }
  // Trailing zeros and release qualifiers carry no meaning: 1.0.0.Final == 1.
  while (items.length > 1) {
    const last = items.at(-1)!;
    if ((last.kind === 'int' && last.value === 0) || (last.kind === 'str' && last.value === ''))
      items.pop();
    else break;
  }
  return items;
}

function compareItem(a: Item | undefined, b: Item | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -compareItem(b, a);
  if (!b) {
    // Compare against "nothing": a number > 0 is greater, a qualifier is ranked against release.
    if (a.kind === 'int') return a.value === 0 ? 0 : 1;
    return qualifierRank(a.value).localeCompare(String(RELEASE_RANK));
  }
  if (a.kind === 'int' && b.kind === 'int') return a.value - b.value;
  if (a.kind === 'int') return 1;
  if (b.kind === 'int') return -1;
  return qualifierRank(a.value).localeCompare(qualifierRank(b.value));
}

export function compareMaven(a: string, b: string): number {
  const x = tokenizeMaven(a);
  const y = tokenizeMaven(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = compareItem(x[i], y[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const numericPrefix = (v: string) =>
  (v.match(/^\d+(?:\.\d+)*/)?.[0] ?? '').split('.').filter(Boolean).map(Number);

export const mavenVersioning: Versioning = {
  compare: compareMaven,
  isValid: (v) => /^\d/.test(v.trim()) && !/[[\](),]/.test(v),
  isMajorBump(from, to) {
    const a = numericPrefix(from);
    const b = numericPrefix(to);
    if (a.length === 0 || b.length === 0) return true;
    return caretBreaking(a, b);
  },
};
