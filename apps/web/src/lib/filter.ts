import {
  exploitRank,
  isKnownExploited,
  SEVERITY_ORDER,
  type Ecosystem,
  type Finding,
  type Severity,
} from '@vulnstack/core/meta';

export interface FindingFilters {
  query: string;
  severities: Severity[];
  ecosystem: Ecosystem | 'all';
  relation: 'all' | 'direct' | 'transitive';
  fixableOnly: boolean;
  knownExploitedOnly: boolean;
  /** Minimum EPSS probability (0..1); 0 = any. */
  minEpss: number;
}

export const DEFAULT_FILTERS: FindingFilters = {
  query: '',
  severities: [],
  ecosystem: 'all',
  relation: 'all',
  fixableOnly: false,
  knownExploitedOnly: false,
  minEpss: 0,
};

export function filtersEqual(a: FindingFilters, b: FindingFilters): boolean {
  return (
    a.query === b.query &&
    a.ecosystem === b.ecosystem &&
    a.relation === b.relation &&
    a.fixableOnly === b.fixableOnly &&
    a.knownExploitedOnly === b.knownExploitedOnly &&
    a.minEpss === b.minEpss &&
    a.severities.length === b.severities.length &&
    a.severities.every((s, i) => s === b.severities[i])
  );
}

export type SortKey = 'severity' | 'package' | 'id' | 'exploit';

export function filterFindings(findings: Finding[], f: FindingFilters): Finding[] {
  const q = f.query.trim().toLowerCase();
  return findings.filter((x) => {
    if (f.severities.length && !f.severities.includes(x.vulnerability.severity)) return false;
    if (f.ecosystem !== 'all' && x.dependency.ecosystem !== f.ecosystem) return false;
    if (f.relation === 'direct' && !x.dependency.isDirect) return false;
    if (f.relation === 'transitive' && x.dependency.isDirect) return false;
    if (f.fixableOnly && x.remediation.type === 'no-fix') return false;
    if (f.knownExploitedOnly && !isKnownExploited(x.vulnerability)) return false;
    if (f.minEpss > 0 && (x.vulnerability.exploit?.epss ?? 0) < f.minEpss) return false;
    if (q) {
      const haystack = [
        x.dependency.name,
        x.vulnerability.summary,
        ...x.vulnerability.aliases,
        ...x.chain,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

const sevRank = (f: Finding) => SEVERITY_ORDER.indexOf(f.vulnerability.severity);

export function sortFindings(findings: Finding[], key: SortKey, descending = false): Finding[] {
  const cmp: Record<SortKey, (a: Finding, b: Finding) => number> = {
    severity: (a, b) =>
      sevRank(a) - sevRank(b) ||
      (b.vulnerability.cvss?.score ?? 0) - (a.vulnerability.cvss?.score ?? 0),
    package: (a, b) =>
      a.dependency.name.localeCompare(b.dependency.name) || sevRank(a) - sevRank(b),
    // Most urgent first (KEV, then EPSS); ties fall back to severity.
    exploit: (a, b) =>
      exploitRank(b.vulnerability) - exploitRank(a.vulnerability) || sevRank(a) - sevRank(b),
    id: (a, b) => a.vulnerability.id.localeCompare(b.vulnerability.id),
  };
  const sorted = [...findings].sort(cmp[key]);
  return descending ? sorted.reverse() : sorted;
}

export function ecosystemsIn(findings: Finding[]): Ecosystem[] {
  return [...new Set(findings.map((f) => f.dependency.ecosystem))].sort();
}

/** Link for an id: NVD for CVEs, GitHub for GHSA, OSV for the rest. */
export function idUrl(id: string): string {
  const upper = id.toUpperCase();
  if (upper.startsWith('CVE-'))
    return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(upper)}`;
  if (upper.startsWith('GHSA-'))
    return `https://github.com/advisories/${encodeURIComponent(upper)}`;
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

export const MIN_EPSS_OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 0.01, label: '1% or more' },
  { value: 0.1, label: '10% or more' },
  { value: 0.5, label: '50% or more' },
] as const;

export function countKnownExploited(findings: Finding[]): number {
  return findings.filter((f) => isKnownExploited(f.vulnerability)).length;
}
