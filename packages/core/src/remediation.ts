import type { Versioning } from './ecosystems/types.js';
import type { AffectedRange, Dependency, Remediation, Vulnerability } from './model/types.js';

const baseEcosystem = (eco: string) => eco.split(':')[0]!;

interface RangeVerdict {
  affected: boolean;
  /** Smallest `fixed` event above the version, if any. */
  nextFix?: string;
}

/**
 * Evaluates one OSV range for `version` following the OSV spec: sort events,
 * `introduced` opens, `fixed` / `last_affected` close.
 */
export function evaluateRange(range: AffectedRange, version: string, v: Versioning): RangeVerdict {
  const cmp = (a: string, b: string) =>
    a === '0' ? (b === '0' ? 0 : -1) : b === '0' ? 1 : v.compare(a, b);
  const events = range.events
    .map((e) => {
      const [kind, value] = Object.entries(e)[0] ?? [];
      return kind && value !== undefined ? { kind, value: String(value) } : undefined;
    })
    .filter((e): e is { kind: string; value: string } => e !== undefined && e.kind !== 'limit')
    .sort((a, b) => cmp(a.value, b.value));

  let affected = false;
  for (const e of events) {
    const c = cmp(version, e.value);
    if (e.kind === 'introduced' && c >= 0) affected = true;
    else if (e.kind === 'fixed' && c >= 0) affected = false;
    else if (e.kind === 'last_affected' && c > 0) affected = false;
  }

  const nextFix = events.find((e) => e.kind === 'fixed' && cmp(e.value, version) > 0)?.value;
  return nextFix ? { affected, nextFix } : { affected };
}

/**
 * Lowest version that closes every affected range of `vuln` for this dependency,
 * and whether reaching it needs a major (breaking) upgrade.
 */
export function computeRemediation(
  dep: Dependency,
  vuln: Vulnerability,
  v: Versioning,
  normalizeName: (name: string) => string = (n) => n,
): Remediation {
  const name = normalizeName(dep.name);
  const ranges = vuln.affected
    .filter((a) => baseEcosystem(a.ecosystem) === dep.ecosystem && normalizeName(a.name) === name)
    .flatMap((a) => a.ranges.filter((r) => r.type !== 'GIT'));

  const verdicts = ranges.map((r) => evaluateRange(r, dep.version, v));
  const hits = verdicts.filter((r) => r.affected);

  let fixedVersion: string | undefined;
  if (hits.length > 0) {
    if (hits.some((h) => !h.nextFix)) return { type: 'no-fix' };
    fixedVersion = hits
      .map((h) => h.nextFix!)
      .sort(v.compare)
      .at(-1);
  } else {
    // Affected via an explicit `versions` list or GIT range: best effort.
    fixedVersion = verdicts
      .map((r) => r.nextFix)
      .filter((f): f is string => !!f)
      .sort(v.compare)[0];
  }

  if (!fixedVersion) return { type: 'no-fix' };
  return {
    type: v.isMajorBump(dep.version, fixedVersion) ? 'breaking-update' : 'safe-patch',
    fixedVersion: v.displayVersion ? v.displayVersion(fixedVersion, dep.version) : fixedVersion,
  };
}

/** Whether an advisory record lists `version` of `name` as affected. */
export function recordAffects(
  affected: {
    package?: { ecosystem: string; name: string };
    ranges?: AffectedRange[];
    versions?: string[];
  }[],
  ecosystem: string,
  name: string,
  version: string,
  v: Versioning,
  normalizeName: (name: string) => string = (n) => n,
): boolean {
  const target = normalizeName(name);
  return affected.some((a) => {
    if (
      !a.package ||
      baseEcosystem(a.package.ecosystem) !== ecosystem ||
      normalizeName(a.package.name) !== target
    ) {
      return false;
    }
    if (a.versions?.some((x) => v.compare(x, version) === 0)) return true;
    return (a.ranges ?? []).some((r) => r.type !== 'GIT' && evaluateRange(r, version, v).affected);
  });
}
