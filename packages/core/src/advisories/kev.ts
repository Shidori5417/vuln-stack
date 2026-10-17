import { fetchJson } from '../net/http.js';
import type { NetContext } from '../net/context.js';
import type { ExploitInfo } from '../model/types.js';

export const KEV_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
/** CISA's own feed rejects some networks (HTTP 403); this mirror carries the same catalog. */
export const KEV_MIRROR_URL =
  'https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json';
export const KEV_CACHE_KEY = 'kev:catalog';
const KEV_TTL = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 20_000;

export interface KevEntry {
  dateAdded?: string;
  dueDate?: string;
  ransomware?: boolean;
}

interface KevFeed {
  vulnerabilities?: {
    cveID?: string;
    dateAdded?: string;
    dueDate?: string;
    knownRansomwareCampaignUse?: string;
  }[];
}

export function parseKev(feed: unknown): Map<string, KevEntry> {
  const map = new Map<string, KevEntry>();
  const list = (feed as KevFeed | null)?.vulnerabilities;
  if (!Array.isArray(list)) throw new Error('unexpected KEV catalog format');
  for (const v of list) {
    if (typeof v?.cveID !== 'string') continue;
    const entry: KevEntry = {};
    if (v.dateAdded) entry.dateAdded = v.dateAdded;
    if (v.dueDate) entry.dueDate = v.dueDate;
    if (v.knownRansomwareCampaignUse) entry.ransomware = v.knownRansomwareCampaignUse === 'Known';
    map.set(v.cveID.toUpperCase(), entry);
  }
  return map;
}

export interface KevOptions {
  endpoint?: string;
  ttlSeconds?: number;
  timeoutMs?: number;
}

export function requestSignal(net: NetContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return net.signal ? AbortSignal.any([net.signal, timeout]) : timeout;
}

/** Downloads the KEV catalog (one request, cached under a single key for 24 h). */
export async function loadKev(
  net: NetContext,
  options: KevOptions = {},
): Promise<Map<string, KevEntry>> {
  const cached = await net.cache.get<Record<string, KevEntry>>(KEV_CACHE_KEY);
  if (cached) return new Map(Object.entries(cached));
  const urls = options.endpoint ? [options.endpoint] : [KEV_URL, KEV_MIRROR_URL];
  let feed: unknown;
  let lastError: unknown;
  for (const url of urls) {
    try {
      feed = await fetchJson<unknown>(
        net.fetch,
        url,
        { headers: { 'user-agent': net.userAgent } },
        { retries: 1, signal: requestSignal(net, options.timeoutMs ?? REQUEST_TIMEOUT_MS) },
      );
      parseKev(feed);
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError !== undefined) throw lastError;
  const map = parseKev(feed);
  await net.cache.set(KEV_CACHE_KEY, Object.fromEntries(map), options.ttlSeconds ?? KEV_TTL);
  return map;
}

export function kevToExploit(entry: KevEntry): Pick<ExploitInfo, 'kev'> & Partial<ExploitInfo> {
  return {
    kev: true,
    ...(entry.dateAdded ? { kevDateAdded: entry.dateAdded } : {}),
    ...(entry.dueDate ? { kevDueDate: entry.dueDate } : {}),
    ...(entry.ransomware !== undefined ? { kevRansomware: entry.ransomware } : {}),
  };
}
