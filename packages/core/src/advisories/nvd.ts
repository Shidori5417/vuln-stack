import { getMany } from '../cache/memory.js';
import { fetchJson, HttpError } from '../net/http.js';
import type { NetContext } from '../net/context.js';
import { realClock, SlidingWindowLimiter, type Clock } from '../net/rate-limit.js';
import type { Cvss } from '../model/types.js';
import { parseCvss } from './cvss.js';

export const NVD_API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

interface NvdMetric {
  source?: string;
  type?: string;
  cvssData?: { vectorString?: string; baseScore?: number };
}

interface NvdResponse {
  vulnerabilities?: {
    cve: {
      id: string;
      descriptions?: { lang: string; value: string }[];
      metrics?: Record<string, NvdMetric[] | undefined>;
    };
  }[];
}

export interface NvdEntry {
  cvss?: Cvss;
  description?: string;
}

/** v3.1 > v3.0 > v4.0, Primary (NVD's own) scores before secondary ones. */
export function pickNvdCvss(
  metrics: Record<string, NvdMetric[] | undefined> | undefined,
): Cvss | undefined {
  for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV40']) {
    const list = [...(metrics?.[key] ?? [])].sort(
      (a, b) => Number(b.type === 'Primary') - Number(a.type === 'Primary'),
    );
    for (const m of list) {
      const parsed = m.cvssData?.vectorString
        ? parseCvss(m.cvssData.vectorString, 'nvd')
        : undefined;
      if (parsed) return parsed;
    }
  }
  return undefined;
}

export interface NvdOptions {
  apiKey?: string;
  /** Stop enriching after this long (ms); remaining CVEs keep their GHSA/OSV scores. */
  maxWaitMs?: number;
  clock?: Clock;
  endpoint?: string;
  ttlSeconds?: number;
}

export interface NvdResult {
  entries: Map<string, NvdEntry>;
  /** CVE ids that were not looked up because the time budget ran out or NVD refused. */
  skipped: string[];
}

const NVD_TTL = 7 * 24 * 60 * 60;
export const nvdCacheKey = (cve: string) => `nvd:${cve}`;

/**
 * NVD API 2.0 enrichment. One request per CVE, throttled to NVD's public
 * limits (5 / 30 s without a key, 50 / 30 s with one) and bounded by `maxWaitMs`.
 */
export class NvdClient {
  private readonly limiter: SlidingWindowLimiter;
  private readonly clock: Clock;

  constructor(
    private readonly net: NetContext,
    private readonly options: NvdOptions = {},
  ) {
    this.clock = options.clock ?? realClock;
    this.limiter = new SlidingWindowLimiter(options.apiKey ? 50 : 5, 30_000, this.clock);
  }

  async lookup(cves: string[]): Promise<NvdResult> {
    const unique = [...new Set(cves.filter((c) => c.startsWith('CVE-')))];
    const entries = await getMany<NvdEntry>(this.net.cache, unique.map(nvdCacheKey));
    const result: NvdResult = { entries: new Map(), skipped: [] };
    for (const cve of unique) {
      const hit = entries.get(nvdCacheKey(cve));
      if (hit) result.entries.set(cve, hit);
    }
    const missing = unique.filter((c) => !result.entries.has(c));
    const deadline = this.clock.now() + (this.options.maxWaitMs ?? 10_000);

    // Sequential on purpose: the limiter is the bottleneck, and order keeps the
    // most severe CVEs (callers sort them first) inside the time budget.
    for (let i = 0; i < missing.length; i++) {
      const cve = missing[i]!;
      if (!(await this.limiter.acquire(deadline))) {
        result.skipped.push(...missing.slice(i));
        break;
      }
      try {
        const entry = await this.fetchOne(cve);
        result.entries.set(cve, entry);
        await this.net.cache.set(nvdCacheKey(cve), entry, this.options.ttlSeconds ?? NVD_TTL);
      } catch (error) {
        // 403 is how NVD signals rate limiting; stop instead of hammering it.
        if (error instanceof HttpError && (error.status === 403 || error.status === 429)) {
          result.skipped.push(...missing.slice(i));
          break;
        }
        throw error;
      }
    }
    return result;
  }

  private async fetchOne(cve: string): Promise<NvdEntry> {
    const headers: Record<string, string> = { 'user-agent': this.net.userAgent };
    if (this.options.apiKey) headers.apiKey = this.options.apiKey;
    const data = await fetchJson<NvdResponse>(
      this.net.fetch,
      `${this.options.endpoint ?? NVD_API}?cveId=${encodeURIComponent(cve)}`,
      { headers },
      { retries: 1, ...(this.net.signal ? { signal: this.net.signal } : {}) },
    );
    const item = data.vulnerabilities?.[0]?.cve;
    const entry: NvdEntry = {};
    const cvss = pickNvdCvss(item?.metrics);
    if (cvss) entry.cvss = cvss;
    const description = item?.descriptions?.find((d) => d.lang === 'en')?.value;
    if (description) entry.description = description;
    return entry;
  }
}
