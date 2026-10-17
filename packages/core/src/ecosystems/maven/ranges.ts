import { compareMaven } from './versioning.js';

/**
 * Maven version ranges (`[1.0,2.0)`, `(,1.0]`, `[1.5]`, unions `[1,2),[3,)`)
 * and Gradle forms (`1.+`, `latest.release`). Returns undefined for plain versions.
 */
export function parseMavenRange(spec: string): ((v: string) => boolean) | undefined {
  const s = spec.trim().replace(/!!$/, '');
  if (s === '+' || /^latest\.(release|integration)$/.test(s)) return () => true;
  if (s.endsWith('+')) {
    const prefix = s.slice(0, -1);
    return (v) => v.startsWith(prefix);
  }
  if (!/^[[(]/.test(s)) return undefined;

  const sets = s.match(/[[(][^\])]*[\])]/g) ?? [];
  const preds = sets.map((set) => {
    const lowerInc = set.startsWith('[');
    const upperInc = set.endsWith(']');
    const inner = set.slice(1, -1);
    if (!inner.includes(',')) return (v: string) => compareMaven(v, inner.trim()) === 0;
    const [lo = '', hi = ''] = inner.split(',').map((x) => x.trim());
    return (v: string) =>
      (!lo || (lowerInc ? compareMaven(v, lo) >= 0 : compareMaven(v, lo) > 0)) &&
      (!hi || (upperInc ? compareMaven(v, hi) <= 0 : compareMaven(v, hi) < 0));
  });
  return preds.length ? (v) => preds.some((p) => p(v)) : undefined;
}

export const isPrerelease = (v: string) =>
  /(alpha|beta|milestone|rc|cr|snapshot|-m\d|\.m\d|-a\d|-b\d)/i.test(v);
