import pLimit from 'p-limit';
import { DEFAULT_TTL_SECONDS } from '../cache/types.js';
import { getMany } from '../cache/memory.js';
import { fetchJson } from '../net/http.js';
import type { NetContext } from '../net/context.js';
import type { AffectedPackage, Ecosystem } from '../model/types.js';

export const OSV_API = 'https://api.osv.dev';

/** The subset of the OSV schema we use. https://ossf.github.io/osv-schema/ */
export interface OsvRecord {
  id: string;
  aliases?: string[];
  related?: string[];
  summary?: string;
  details?: string;
  published?: string;
  modified?: string;
  withdrawn?: string;
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { ecosystem: string; name: string };
    ranges?: AffectedPackage['ranges'];
    versions?: string[];
    severity?: { type: string; score: string }[];
    database_specific?: Record<string, unknown>;
  }[];
  references?: { type: string; url: string }[];
  database_specific?: { severity?: string; cwe_ids?: string[]; [k: string]: unknown };
}

export interface PackageQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

interface QueryBatchResponse {
  results: { vulns?: { id: string; modified: string }[]; next_page_token?: string }[];
}

/** OSV accepts at most 1000 queries per batch. */
const BATCH_SIZE = 1000;
const DETAIL_CONCURRENCY = 16;

export const queryCacheKey = (q: PackageQuery) => `osv:q:${q.ecosystem}:${q.name}@${q.version}`;
export const vulnCacheKey = (id: string) => `osv:v:${id}`;

export interface OsvClientOptions {
  baseUrl?: string;
  ttlSeconds?: number;
}

export class OsvClient {
  private readonly baseUrl: string;
  private readonly ttl: number;

  constructor(
    private readonly net: NetContext,
    options: OsvClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? OSV_API;
    this.ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private retry() {
    return this.net.signal ? { signal: this.net.signal } : {};
  }

  /** Returns vuln ids per query (same order as input). Cached per package@version. */
  async queryIds(queries: PackageQuery[]): Promise<string[][]> {
    const keys = queries.map(queryCacheKey);
    const cached = await getMany<string[]>(this.net.cache, keys);
    const result: string[][] = queries.map((_, i) => cached.get(keys[i]!) ?? []);
    const missing = queries.map((q, i) => ({ q, i })).filter(({ i }) => !cached.has(keys[i]!));

    for (let start = 0; start < missing.length; start += BATCH_SIZE) {
      const chunk = missing.slice(start, start + BATCH_SIZE);
      const ids = await this.runBatch(chunk.map(({ q }) => q));
      await Promise.all(
        chunk.map(async ({ i }, j) => {
          result[i] = ids[j]!;
          await this.net.cache.set(keys[i]!, ids[j]!, this.ttl);
        }),
      );
    }
    return result;
  }

  private async runBatch(queries: PackageQuery[]): Promise<string[][]> {
    const ids: string[][] = queries.map(() => []);
    let pending = queries.map((q, i) => ({ i, body: this.toQuery(q) as Record<string, unknown> }));

    // Queries with many vulns are paginated; re-send only those with their page token.
    while (pending.length > 0) {
      const response = await fetchJson<QueryBatchResponse>(
        this.net.fetch,
        `${this.baseUrl}/v1/querybatch`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': this.net.userAgent },
          body: JSON.stringify({ queries: pending.map((p) => p.body) }),
        },
        this.retry(),
      );
      const next: typeof pending = [];
      pending.forEach((p, j) => {
        const r = response.results[j];
        for (const v of r?.vulns ?? []) ids[p.i]!.push(v.id);
        if (r?.next_page_token)
          next.push({ i: p.i, body: { ...p.body, page_token: r.next_page_token } });
      });
      pending = next;
    }
    return ids;
  }

  private toQuery(q: PackageQuery) {
    return { package: { ecosystem: q.ecosystem, name: q.name }, version: q.version };
  }

  /** Full records for the given ids. Cached per id; withdrawn records are dropped. */
  async getVulns(ids: string[]): Promise<Map<string, OsvRecord>> {
    const unique = [...new Set(ids)];
    const cached = await getMany<OsvRecord>(this.net.cache, unique.map(vulnCacheKey));
    const result = new Map<string, OsvRecord>();
    const limit = pLimit(DETAIL_CONCURRENCY);

    await Promise.all(
      unique.map((id) =>
        limit(async () => {
          let record = cached.get(vulnCacheKey(id));
          if (!record) {
            record = await fetchJson<OsvRecord>(
              this.net.fetch,
              `${this.baseUrl}/v1/vulns/${encodeURIComponent(id)}`,
              { headers: { 'user-agent': this.net.userAgent } },
              this.retry(),
            );
            await this.net.cache.set(vulnCacheKey(id), record, this.ttl);
          }
          if (!record.withdrawn) result.set(id, record);
        }),
      ),
    );
    return result;
  }
}
