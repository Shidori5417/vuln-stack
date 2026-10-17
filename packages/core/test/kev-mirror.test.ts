import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KEV_MIRROR_URL, KEV_URL, loadKev } from '../src/advisories/kev.js';
import { MemoryCache } from '../src/cache/memory.js';
import type { FetchFn, NetContext } from '../src/net/context.js';
import { updateExploitData } from '../src/node/offline.js';
import { json } from './helpers.js';

const FEED = { vulnerabilities: [{ cveID: 'CVE-2021-44906', dateAdded: '2022-03-25' }] };
const CUSTOM = 'https://example.test/kev.json';

function make(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    return handler(url);
  };
  const net: NetContext = { fetch, cache: new MemoryCache(), userAgent: 'test' };
  return { fetch, calls, net };
}

describe('KEV mirror fallback (online)', () => {
  it('falls back to the mirror when cisa.gov returns 403', async () => {
    const { net, calls } = make((url) =>
      url === KEV_URL ? new Response('forbidden', { status: 403 }) : json(FEED),
    );
    const map = await loadKev(net);
    expect(map.get('CVE-2021-44906')?.dateAdded).toBe('2022-03-25');
    expect(calls[0]).toBe(KEV_URL);
    expect(calls.at(-1)).toBe(KEV_MIRROR_URL);
  });

  it('does not use the mirror when endpoint is overridden', async () => {
    const { net, calls } = make(() => new Response('forbidden', { status: 403 }));
    await expect(loadKev(net, { endpoint: CUSTOM })).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set([CUSTOM]));
  });

  it('throws when both sources fail', async () => {
    const { net, calls } = make(() => new Response('forbidden', { status: 403 }));
    await expect(loadKev(net)).rejects.toThrow();
    expect(calls).toContain(KEV_URL);
    expect(calls).toContain(KEV_MIRROR_URL);
  });

  it('treats an invalid first payload as failure and tries the mirror', async () => {
    const { net } = make((url) => (url === KEV_URL ? json({ nope: true }) : json(FEED)));
    expect((await loadKev(net)).size).toBe(1);
  });
});

describe('KEV mirror fallback (offline)', () => {
  const csv = 'cve,epss,percentile\nCVE-2021-44906,0.97,0.999\n';
  const base = (url: string, kevStatus: number) =>
    url.includes('epss')
      ? new Response(gzipSync(csv))
      : url === KEV_URL
        ? new Response('forbidden', { status: kevStatus })
        : new Response(JSON.stringify(FEED));

  it('falls back to the mirror and writes kev.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-kev-mirror-'));
    const { fetch, calls } = make((url) => base(url, 403));
    const res = await updateExploitData({ dir, fetch });
    expect(res.updated.kev?.records).toBe(1);
    expect(calls).toContain(KEV_MIRROR_URL);
    expect(JSON.parse(readFileSync(join(dir, 'kev.json'), 'utf8'))).toEqual(FEED);
  });

  it('does not fall back when kevUrl is overridden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-kev-mirror-'));
    const { fetch, calls } = make((url) =>
      url === CUSTOM ? new Response('x', { status: 403 }) : base(url, 200),
    );
    await expect(updateExploitData({ dir, fetch, kevUrl: CUSTOM })).rejects.toThrow(/403/);
    expect(calls).not.toContain(KEV_MIRROR_URL);
  });

  it('throws when both sources fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-kev-mirror-'));
    const { fetch } = make(() => new Response('no', { status: 403 }));
    await expect(updateExploitData({ dir, fetch })).rejects.toThrow(/403/);
  });
});
