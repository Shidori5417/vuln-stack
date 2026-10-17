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
