import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/cache/memory.js';
import { OsvClient, queryCacheKey } from '../src/advisories/osv.js';
import type { FetchFn, NetContext } from '../src/net/context.js';
import { fakeOsv, ghsa, json } from './helpers.js';

const net = (fetch: FetchFn, cache = new MemoryCache()): NetContext => ({
  fetch,
  cache,
  userAgent: 'test',
});

describe('OsvClient.queryIds', () => {
  it('splits into batches of 1000 and keeps input order', async () => {
    const queries = Array.from({ length: 1500 }, (_, i) => ({
      ecosystem: 'npm' as const,
      name: `p${i}`,
      version: '1.0.0',
    }));
    const { fetch, calls } = fakeOsv({
      affected: { 'npm:p3@1.0.0': ['GHSA-3'], 'npm:p1200@1.0.0': ['GHSA-1200'] },
      records: [],
    });
    const ids = await new OsvClient(net(fetch)).queryIds(queries);
    expect(calls.map((c) => (c.body as { queries: unknown[] }).queries.length)).toEqual([
      1000, 500,
    ]);
    expect(ids[3]).toEqual(['GHSA-3']);
    expect(ids[1200]).toEqual(['GHSA-1200']);
    expect(ids[0]).toEqual([]);
  });

  it('serves repeated queries from cache', async () => {
    const cache = new MemoryCache();
    const { fetch, calls } = fakeOsv({ affected: { 'npm:a@1.0.0': ['GHSA-a'] }, records: [] });
    const client = new OsvClient(net(fetch, cache), { ttlSeconds: 60 });
    const q = { ecosystem: 'npm' as const, name: 'a', version: '1.0.0' };
    await client.queryIds([q]);
    expect(await client.queryIds([q, { ...q, name: 'b' }])).toEqual([['GHSA-a'], []]);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { queries: unknown[] }).queries).toHaveLength(1);
    expect(await cache.get(queryCacheKey(q))).toEqual(['GHSA-a']);
  });

  it('follows next_page_token only for paginated queries', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(
        json({
          results: [{ vulns: [{ id: 'A1' }], next_page_token: 't1' }, { vulns: [{ id: 'B1' }] }],
        }),
      )
      .mockResolvedValueOnce(json({ results: [{ vulns: [{ id: 'A2' }] }] }));
    const ids = await new OsvClient(net(fetch)).queryIds([
      { ecosystem: 'npm', name: 'a', version: '1' },
      { ecosystem: 'npm', name: 'b', version: '1' },
    ]);
    expect(ids).toEqual([['A1', 'A2'], ['B1']]);
    const second = JSON.parse(String(fetch.mock.calls[1]![1]!.body));
    expect(second.queries).toEqual([
      { package: { ecosystem: 'npm', name: 'a' }, version: '1', page_token: 't1' },
    ]);
  });
});

describe('OsvClient.getVulns', () => {
  it('fetches unique ids once, caches them and drops withdrawn records', async () => {
    const withdrawn = { ...ghsa('GHSA-w', 'x', {}), withdrawn: '2025-01-01T00:00:00Z' };
    const { fetch, calls } = fakeOsv({
      affected: {},
      records: [ghsa('GHSA-1', 'x', {}), withdrawn],
    });
    const client = new OsvClient(net(fetch), { baseUrl: 'https://osv.test' });
    const first = await client.getVulns(['GHSA-1', 'GHSA-1', 'GHSA-w']);
    expect([...first.keys()]).toEqual(['GHSA-1']);
    await client.getVulns(['GHSA-1']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://osv.test/v1/vulns/GHSA-1',
      'https://osv.test/v1/vulns/GHSA-w',
    ]);
  });

  it('propagates API errors', async () => {
    const { fetch } = fakeOsv({ affected: {}, records: [] });
    await expect(new OsvClient(net(fetch)).getVulns(['NOPE'])).rejects.toThrow(/HTTP 404/);
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchFn>(async () => json({ results: [{}] }));
    await new OsvClient({ ...net(fetch), signal: controller.signal }).queryIds([
      { ecosystem: 'npm', name: 'a', version: '1' },
    ]);
    expect(fetch.mock.calls[0]![1]!.signal).toBe(controller.signal);
  });
});
