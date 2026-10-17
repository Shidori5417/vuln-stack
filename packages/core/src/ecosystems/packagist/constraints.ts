import { compareComposer, parseComposerVersion, type ComposerVersion } from './versioning.js';

type Predicate = (v: ComposerVersion) => boolean;

const cmp = (a: ComposerVersion, b: string): number => {
  const pb = parseComposerVersion(b);
  return pb ? compareComposer(a, pb) : NaN;
};

/** Upper bound for a partial version: bump the part at `index`, drop the rest. */
function bump(parts: number[], index: number): string {
  const out = parts.slice(0, index + 1);
  out[index] = (out[index] ?? 0) + 1;
  return `${out.join('.')}-dev`; // -dev is the lowest version of that release
}

function single(c: string): Predicate | undefined {
  const raw = c.replace(/@(dev|alpha|beta|rc|stable)$/i, '').trim();
  if (raw === '' || raw === '*') return () => true;
  if (/^dev-/.test(raw)) return undefined; // branch names can't be resolved

  const op = /^(>=|<=|>|<|!=|==|=|\^|~)?\s*v?(.+)$/.exec(raw);
  if (!op) return undefined;
  const [, operator = '', ver] = op as unknown as [string, string | undefined, string];
  const numeric = (ver.match(/^\d+(?:\.\d+)*/)?.[0] ?? '').split('.').filter(Boolean).map(Number);

  if (ver.includes('*') || /\.x$/i.test(ver)) {
    const fixed = ver
      .split('.')
      .filter((p) => p !== '*' && p.toLowerCase() !== 'x')
      .map(Number);
    if (fixed.length === 0) return () => true;
    const lower = `${fixed.join('.')}-dev`;
    const upper = bump(fixed, fixed.length - 1);
    return (v) => cmp(v, lower) >= 0 && cmp(v, upper) < 0;
  }
  if (!parseComposerVersion(ver)) return undefined;

  switch (operator) {
    case '>=':
      return (v) => cmp(v, ver) >= 0;
    case '>':
      return (v) => cmp(v, ver) > 0;
    case '<=':
      return (v) => cmp(v, ver) <= 0;
    case '<':
      return (v) => cmp(v, ver) < 0;
    case '!=':
      return (v) => cmp(v, ver) !== 0;
    case '^': {
      // ^1.2.3 → <2.0; ^0.3 → <0.4; ^0.0.3 → <0.0.4
      const idx =
        numeric[0] !== 0
          ? 0
          : numeric[1] !== 0 && numeric.length > 1
            ? 1
            : Math.min(2, numeric.length - 1);
      const upper = bump(numeric, Math.max(0, idx));
      return (v) => cmp(v, ver) >= 0 && cmp(v, upper) < 0;
    }
    case '~': {
      // ~1.2 → <2.0, ~1.2.3 → <1.3: the second-to-last given part is bumped.
      const upper = bump(numeric, Math.max(0, numeric.length - 2));
      return (v) => cmp(v, ver) >= 0 && cmp(v, upper) < 0;
    }
    default:
      return (v) => cmp(v, ver) === 0;
  }
}

/** Parses a Composer constraint into a predicate; undefined when unsupported (branches). */
export function parseComposerConstraint(
  constraint: string,
): ((version: string) => boolean) | undefined {
  const alternatives = constraint.trim().split(/\s*\|\|?\s*/);
  const ors: Predicate[][] = [];
  for (const alt of alternatives) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    if (hyphen) {
      const lower = hyphen[1]!;
      const upperParts = hyphen[2]!.split('.');
      // A partial upper bound is exclusive of the next release: 1.0 - 2.0 → <2.1
      const upperPred: Predicate =
        upperParts.length < 3
          ? (v) => cmp(v, bump(upperParts.map(Number), upperParts.length - 1)) < 0
          : (v) => cmp(v, hyphen[2]!) <= 0;
      ors.push([(v) => cmp(v, lower) >= 0, upperPred]);
      continue;
    }
    const parts = alt.split(/\s*,\s*|\s+/).filter(Boolean);
    const preds: Predicate[] = [];
    for (const p of parts) {
      const pred = single(p);
      if (!pred) return undefined;
      preds.push(pred);
    }
    ors.push(preds);
  }
  return (version: string) => {
    const v = parseComposerVersion(version);
    if (!v) return false;
    return ors.some((and) => and.every((p) => p(v)));
  };
}
