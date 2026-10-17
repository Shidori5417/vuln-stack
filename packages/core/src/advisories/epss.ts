import { getMany } from '../cache/memory.js';
import { fetchJson } from '../net/http.js';
import type { NetContext } from '../net/context.js';
import { requestSignal } from './kev.js';

export const EPSS_API = 'https://api.first.org/data/v1/epss';
const EPSS_TTL = 24 * 60 * 60;
const BATCH_SIZE = 100;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export interface EpssEntry {
  epss: number;
  percentile: number;
}

export const epssCacheKey = (cve: string) => `epss:${cve}`;

const unit = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
};

/** Parses the FIRST EPSS API response body (`data[].cve/epss/percentile`, numbers as strings). */
export function parseEpssResponse(body: unknown): Map<string, EpssEntry> {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('unexpected EPSS response format');
  const map = new Map<string, EpssEntry>();
  for (const row of data as Record<string, unknown>[]) {
    const epss = unit(row?.epss);
    const percentile = unit(row?.percentile);
    if (typeof row?.cve !== 'string' || epss === undefined || percentile === undefined) continue;
    map.set(row.cve.toUpperCase(), { epss, percentile });
  }
  return map;
}

/** Parses the daily `epss_scores-current.csv` (a `#model_version` comment line, then `cve,epss,percentile`). */
export function parseEpssCsv(text: string): Map<string, EpssEntry> {
  const map = new Map<string, EpssEntry>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('CVE-') && !line.startsWith('cve-')) continue;
    const [cve, epss, percentile] = line.trim().split(',');
    const e = unit(epss);
    const p = unit(percentile);
    if (cve && e !== undefined && p !== undefined)
      map.set(cve.toUpperCase(), { epss: e, percentile: p });
  }
  return map;
}

export interface EpssOptions {
  endpoint?: string;
  ttlSeconds?: number;
  batchSize?: number;
  timeoutMs?: number;
}

export interface EpssResult {
  entries: Map<string, EpssEntry>;
  /** CVEs whose batch request failed. */
  failed: string[];
  error?: Error;
}

/** Looks up EPSS scores in batches of ~100 CVEs; per-CVE results are cached for 24 h. */
export async function lookupEpss(
  net: NetContext,
  cves: string[],
  options: EpssOptions = {},
): Promise<EpssResult> {
  const unique = [...new Set(cves.map((c) => c.toUpperCase()))];
  const result: EpssResult = { entries: new Map(), failed: [] };
  const cached = await getMany<EpssEntry>(net.cache, unique.map(epssCacheKey));
  for (const cve of unique) {
    const hit = cached.get(epssCacheKey(cve));
    if (hit) result.entries.set(cve, hit);
  }
  const missing = unique.filter((c) => !result.entries.has(c));
  const size = options.batchSize ?? BATCH_SIZE;
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        const body = await fetchJson<unknown>(
          net.fetch,
          `${options.endpoint ?? EPSS_API}?cve=${batch.join(',')}`,
          { headers: { 'user-agent': net.userAgent } },
          { retries: 1, signal: requestSignal(net, options.timeoutMs ?? REQUEST_TIMEOUT_MS) },
        );
        const parsed = parseEpssResponse(body);
        for (const [cve, entry] of parsed) {
          result.entries.set(cve, entry);
          await net.cache.set(epssCacheKey(cve), entry, options.ttlSeconds ?? EPSS_TTL);
        }
      } catch (error) {
        result.failed.push(...batch);
        result.error ??= error as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return result;
}
