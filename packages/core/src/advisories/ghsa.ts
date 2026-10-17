import pLimit from 'p-limit';
import { DEFAULT_TTL_SECONDS } from '../cache/types.js';
import { getMany } from '../cache/memory.js';
import { fetchJson } from '../net/http.js';
import type { NetContext } from '../net/context.js';
import type { AffectedRangeEvent, Ecosystem } from '../model/types.js';
import type { OsvRecord } from './osv.js';

export const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

const ECOSYSTEM_ENUM: Record<Ecosystem, string> = {
  npm: 'NPM',
  PyPI: 'PIP',
  Packagist: 'COMPOSER',
  Maven: 'MAVEN',
  Go: 'GO',
  NuGet: 'NUGET',
  RubyGems: 'RUBYGEMS',
  'crates.io': 'RUST',
  Hex: 'ERLANG',
  Pub: 'PUB',
  SwiftURL: 'SWIFT',
};

interface GhsaNode {
  vulnerableVersionRange: string;
  firstPatchedVersion: { identifier: string } | null;
  package: { name: string; ecosystem: string };
  advisory: {
    ghsaId: string;
    summary: string;
    description: string | null;
    severity: string;
    publishedAt: string;
    updatedAt: string;
    withdrawnAt: string | null;
    permalink: string;
    identifiers: { type: string; value: string }[];
    references: { url: string }[];
    cvssSeverities?: {
      cvssV3?: { vectorString: string | null } | null;
      cvssV4?: { vectorString: string | null } | null;
    } | null;
    cwes?: { nodes: { cweId: string }[] };
  };
}

interface Connection {
  nodes: GhsaNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface GraphQLResponse {
  data?: Record<string, Connection | null>;
  errors?: { message: string }[];
}

const NODE_FIELDS = `nodes {
  vulnerableVersionRange
  firstPatchedVersion { identifier }
  package { name ecosystem }
  advisory {
    ghsaId summary description severity publishedAt updatedAt withdrawnAt permalink
    identifiers { type value }
    references { url }
    cvssSeverities { cvssV3 { vectorString } cvssV4 { vectorString } }
    cwes(first: 10) { nodes { cweId } }
  }
}
pageInfo { hasNextPage endCursor }`;

/**
 * GHSA ranges (`>= 1.0, < 1.2.3`, `<= 2.0`, `= 1.5`) as OSV events. `firstPatchedVersion`
 * becomes the `fixed` event when the range itself has no exclusive upper bound.
 */
export function ghsaRangeToEvents(
  range: string,
  firstPatched?: string,
): { events: AffectedRangeEvent[]; versions: string[] } {
  const events: AffectedRangeEvent[] = [];
  const versions: string[] = [];
  let introduced: string | undefined;
  let fixed: string | undefined;
  let lastAffected: string | undefined;
  for (const part of range
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(>=|>|<=|<|=)\s*(.+)$/.exec(part);
    if (!m) continue;
    const [, op, v] = m as unknown as [string, string, string];
    if (op === '>=' || op === '>') introduced = v;
    else if (op === '<') fixed = v;
    else if (op === '<=') lastAffected = v;
    else versions.push(v);
  }
  if (versions.length && !introduced && !fixed && !lastAffected) return { events, versions };
  events.push({ introduced: introduced ?? '0' });
  if (lastAffected) events.push({ last_affected: lastAffected });
  if (fixed ?? firstPatched) events.push({ fixed: (fixed ?? firstPatched)! });
  return { events, versions };
}

/** One OSV-shaped record per advisory and package (several ranges merged). */
export function ghsaNodesToRecords(nodes: GhsaNode[], ecosystem: Ecosystem): OsvRecord[] {
  const byId = new Map<string, OsvRecord>();
  for (const node of nodes) {
    const a = node.advisory;
    let record = byId.get(a.ghsaId);
    if (!record) {
      const vectors: { type: string; score: string }[] = [];
      const v3 = a.cvssSeverities?.cvssV3?.vectorString;
      const v4 = a.cvssSeverities?.cvssV4?.vectorString;
      if (v3) vectors.push({ type: 'CVSS_V3', score: v3 });
      if (v4) vectors.push({ type: 'CVSS_V4', score: v4 });
      record = {
        id: a.ghsaId,
        aliases: a.identifiers.filter((i) => i.type !== 'GHSA').map((i) => i.value),
        summary: a.summary,
        ...(a.description ? { details: a.description } : {}),
        published: a.publishedAt,
        modified: a.updatedAt,
        ...(a.withdrawnAt ? { withdrawn: a.withdrawnAt } : {}),
        severity: vectors,
        affected: [],
        references: [
          { type: 'ADVISORY', url: a.permalink },
          ...a.references.map((r) => ({ type: 'WEB', url: r.url })),
        ],
        database_specific: {
          severity: a.severity,
          cwe_ids: (a.cwes?.nodes ?? []).map((c) => c.cweId),
        },
      };
      byId.set(a.ghsaId, record);
    }
    const { events, versions } = ghsaRangeToEvents(
      node.vulnerableVersionRange,
      node.firstPatchedVersion?.identifier,
    );
    record.affected!.push({
      package: { ecosystem, name: node.package.name },
      ranges: events.length ? [{ type: 'ECOSYSTEM', events }] : [],
      versions,
    });
  }
  return [...byId.values()];
}

export interface GhsaPackage {
  ecosystem: Ecosystem;
  name: string;
}

const BATCH = 25;
const CONCURRENCY = 3;
const MAX_PAGES = 10;

export const ghsaCacheKey = (p: GhsaPackage) => `ghsa:${p.ecosystem}:${p.name}`;

/** GitHub Advisory Database over GraphQL. Needs a token (no scopes required). */
export class GhsaClient {
  constructor(
    private readonly net: NetContext,
    private readonly token: string,
    private readonly endpoint = GITHUB_GRAPHQL,
    private readonly ttl = DEFAULT_TTL_SECONDS,
  ) {}

  private async graphql(query: string): Promise<GraphQLResponse> {
    const res = await fetchJson<GraphQLResponse>(
      this.net.fetch,
      this.endpoint,
      {
        method: 'POST',
        headers: {
          authorization: `bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': this.net.userAgent,
        },
        body: JSON.stringify({ query }),
      },
      this.net.signal ? { signal: this.net.signal } : {},
    );
    if (res.errors?.length && !res.data)
      throw new Error(`GitHub GraphQL: ${res.errors.map((e) => e.message).join('; ')}`);
    return res;
  }

  /** All advisories per package (every version); callers filter by installed version. */
  async query(packages: GhsaPackage[]): Promise<Map<string, OsvRecord[]>> {
    const unique = [...new Map(packages.map((p) => [ghsaCacheKey(p), p])).values()];
    const result = await getMany<OsvRecord[]>(this.net.cache, unique.map(ghsaCacheKey));
    const missing = unique.filter((p) => !result.has(ghsaCacheKey(p)));
    const limit = pLimit(CONCURRENCY);
    const batches: GhsaPackage[][] = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));

    await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          const nodes = new Map<number, GhsaNode[]>(batch.map((_, i) => [i, []]));
          let pending = batch.map((pkg, i) => ({ i, pkg, after: null as string | null }));
          for (let page = 0; pending.length && page < MAX_PAGES; page++) {
            const fields = pending
              .map(({ i, pkg, after }) => {
                const args = `ecosystem: ${ECOSYSTEM_ENUM[pkg.ecosystem]}, package: ${JSON.stringify(pkg.name)}, first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}`;
                return `p${i}: securityVulnerabilities(${args}) { ${NODE_FIELDS} }`;
              })
              .join('\n');
            const res = await this.graphql(`query {\n${fields}\n}`);
            const next: typeof pending = [];
            for (const item of pending) {
              const conn = res.data?.[`p${item.i}`];
              nodes.get(item.i)!.push(...(conn?.nodes ?? []));
              if (conn?.pageInfo.hasNextPage)
                next.push({ ...item, after: conn.pageInfo.endCursor });
            }
            pending = next;
          }
          for (const [i, list] of nodes) {
            const pkg = batch[i]!;
            const records = ghsaNodesToRecords(list, pkg.ecosystem).filter((r) => !r.withdrawn);
            result.set(ghsaCacheKey(pkg), records);
            await this.net.cache.set(ghsaCacheKey(pkg), records, this.ttl);
          }
        }),
      ),
    );
    return result;
  }
}
