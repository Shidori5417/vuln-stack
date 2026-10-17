import { lookup } from 'node:dns/promises';

/**
 * Resolver for `assertPublicUrl` / `scanWebsite`: all A and AAAA addresses of a
 * host via the system resolver. Pass it as `resolve`.
 */
export async function nodeResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}
