/** Link for an advisory id, used when a record has no references of its own. */
export function advisoryUrl(id: string): string {
  if (id.startsWith('CVE-')) return `https://nvd.nist.gov/vuln/detail/${id}`;
  if (id.startsWith('GHSA-')) return `https://github.com/advisories/${id}`;
  return `https://osv.dev/vulnerability/${id}`;
}
