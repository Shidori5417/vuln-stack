import type { AffectedPackage, Cvss, Reference, Severity, Vulnerability } from '../model/types.js';
import { pickCvss, severityFromLabel, severityFromScore } from './cvss.js';
import type { OsvRecord } from './osv.js';

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const idRank = (id: string) => (id.startsWith('CVE-') ? 0 : id.startsWith('GHSA-') ? 1 : 2);

/** CVE first, then GHSA, then others; ties broken alphabetically for stability. */
export function canonicalId(ids: Iterable<string>): string {
  return [...ids].sort((a, b) => idRank(a) - idRank(b) || a.localeCompare(b))[0]!;
}

const isGhsa = (record: OsvRecord) => record.id.startsWith('GHSA-');

/**
 * Collapses records that describe the same issue (linked through `aliases`)
 * into one Vulnerability carrying every id.
 */
export function mergeRecords(records: OsvRecord[]): Vulnerability[] {
  const uf = new UnionFind();
  for (const r of records) for (const alias of r.aliases ?? []) uf.union(r.id, alias);

  const groups = new Map<string, OsvRecord[]>();
  for (const r of records) {
    const root = uf.find(r.id);
    const group = groups.get(root) ?? [];
    group.push(r);
    groups.set(root, group);
  }

  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(group: OsvRecord[]): Vulnerability {
  // GHSA records are curated and usually have the best summary and severity data.
  const ordered = [...group].sort((a, b) => Number(isGhsa(b)) - Number(isGhsa(a)));
  const ids = new Set<string>();
  for (const r of ordered) {
    ids.add(r.id);
    for (const a of r.aliases ?? []) ids.add(a);
  }

  let cvss: Cvss | undefined;
  for (const r of ordered) {
    const vectors = [...(r.severity ?? []), ...(r.affected ?? []).flatMap((a) => a.severity ?? [])];
    cvss = pickCvss(vectors, isGhsa(r) ? 'ghsa' : 'osv');
    if (cvss) break;
  }

  let severity: Severity = cvss ? severityFromScore(cvss.score) : 'unknown';
  if (severity === 'unknown') {
    for (const r of ordered) {
      severity = severityFromLabel(r.database_specific?.severity);
      if (severity !== 'unknown') break;
    }
  }

  const references = new Map<string, Reference>();
  const affected: AffectedPackage[] = [];
  const cwes = new Set<string>();
  for (const r of ordered) {
    for (const ref of r.references ?? [])
      if (!references.has(ref.url)) references.set(ref.url, ref);
    for (const a of r.affected ?? []) {
      if (!a.package) continue;
      affected.push({
        ecosystem: a.package.ecosystem,
        name: a.package.name,
        ranges: a.ranges ?? [],
        versions: a.versions ?? [],
      });
    }
    for (const cwe of r.database_specific?.cwe_ids ?? []) cwes.add(cwe);
  }

  const first = ordered[0]!;
  const summary =
    ordered.map((r) => r.summary).find(Boolean) ??
    ordered.map((r) => r.details?.split('\n')[0]).find(Boolean) ??
    '';
  const details = ordered.map((r) => r.details).find(Boolean);
  const published = ordered
    .map((r) => r.published)
    .filter(Boolean)
    .sort()[0];

  const vuln: Vulnerability = {
    id: canonicalId(ids),
    aliases: [...ids].sort((a, b) => idRank(a) - idRank(b) || a.localeCompare(b)),
    summary,
    severity,
    references: [...references.values()],
    affected,
    cwes: [...cwes],
  };
  if (details) vuln.details = details;
  if (cvss) vuln.cvss = cvss;
  if (published) vuln.published = published;
  if (first.modified) vuln.modified = first.modified;
  return vuln;
}

export { advisoryUrl } from './urls.js';
