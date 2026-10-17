import type { CacheStore } from '../cache/types.js';
import type { FetchFn } from '../net/context.js';
import { fetchJson } from '../net/http.js';
import { compileExtractor, type Signature } from './signatures.js';

/** retire.js signature repository (Apache-2.0). Only fetched on request, never in tests. */
export const RETIRE_REPOSITORY_URL =
  'https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v4.json';

const CACHE_KEY = 'fingerprint:retire:v4';
const TTL_SECONDS = 24 * 60 * 60;

interface RetireEntry {
  npmname?: unknown;
  extractors?: { uri?: unknown; filename?: unknown; filecontent?: unknown };
}

const patterns = (value: unknown, flags: string): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const ok = value.filter(
    (p): p is string => typeof p === 'string' && p.length <= 500 && !!compileExtractor(p, flags),
  );
  return ok.length ? ok : undefined;
};

/** Converts the retire.js repository JSON into signatures (entries without `npmname` are skipped). */
export function parseRetireRepository(data: unknown): Signature[] {
  if (typeof data !== 'object' || data === null) return [];
  const out: Signature[] = [];
  for (const [component, raw] of Object.entries(data as Record<string, RetireEntry>)) {
    if (typeof raw?.npmname !== 'string' || !raw.extractors) continue;
    const uri = patterns(raw.extractors.uri, 'i');
    const filename = patterns(raw.extractors.filename, 'i');
    const filecontent = patterns(raw.extractors.filecontent, '');
    if (!uri && !filename && !filecontent) continue;
    out.push({
      component,
      npm: raw.npmname,
      origin: 'retire',
      ...(uri ? { uri } : {}),
      ...(filename ? { filename } : {}),
      ...(filecontent ? { filecontent } : {}),
    });
  }
  return out;
}

/** Loads retire.js signatures, cached for 24 hours. */
export async function loadRetireSignatures(
  fetch: FetchFn,
  cache?: CacheStore,
): Promise<Signature[]> {
  const cached = await cache?.get<Signature[]>(CACHE_KEY);
  if (cached) return cached;
  const data = await fetchJson<unknown>(fetch, RETIRE_REPOSITORY_URL, {
    headers: { accept: 'application/json' },
  });
  const signatures = parseRetireRepository(data);
  await cache?.set(CACHE_KEY, signatures, TTL_SECONDS);
  return signatures;
}
