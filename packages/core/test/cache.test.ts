import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getMany, MemoryCache } from '../src/cache/memory.js';
import type { CacheStore } from '../src/cache/types.js';
import { defaultCacheDir, FileCache } from '../src/node/file-cache.js';

describe('MemoryCache', () => {
  it('expires entries after their TTL', async () => {
    let now = 0;
    const cache = new MemoryCache(10, () => now);
    await cache.set('a', { x: 1 }, 10);
    expect(await cache.get('a')).toEqual({ x: 1 });
    now = 10_001;
    expect(await cache.get('a')).toBeUndefined();
  });

  it('evicts the oldest entry when full', async () => {
    const cache = new MemoryCache(2);
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.set('b', 3, 60); // update does not evict
    await cache.set('c', 4, 60);
    expect(await cache.get('a')).toBeUndefined();
    expect(await getMany(cache, ['b', 'c', 'zzz'])).toEqual(
      new Map([
        ['b', 3],
        ['c', 4],
      ]),
    );
  });

  it('uses a native getMany when present', async () => {
    const native: CacheStore = {
      get: async () => undefined,
      set: async () => {},
      getMany: async <T>() => new Map([['k', 1 as T]]),
    };
    expect(await getMany(native, ['k'])).toEqual(new Map([['k', 1]]));
  });
});

describe('FileCache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vulnstack-cache-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips values and honours TTL', async () => {
    let now = 1000;
    const cache = new FileCache(dir, () => now);
    await cache.set('osv:q:npm:a@1', ['GHSA-1'], 60);
    expect(await cache.get('osv:q:npm:a@1')).toEqual(['GHSA-1']);
    now += 61_000;
    expect(await cache.get('osv:q:npm:a@1')).toBeUndefined();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('never throws when the directory is not writable', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, '');
    const cache = new FileCache(join(file, 'sub'));
    await expect(cache.set('k', 1, 60)).resolves.toBeUndefined();
  });

  it('ignores corrupt entries', async () => {
    const cache = new FileCache(dir);
    await cache.set('k', 1, 60);
    const sub = join(dir, 'corrupt');
    mkdirSync(sub, { recursive: true });
    expect(await new FileCache(sub).get('k')).toBeUndefined();
  });

  it('defaults to XDG_CACHE_HOME', () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/x/cache';
    expect(defaultCacheDir()).toBe('/x/cache/vulnstack');
    delete process.env.XDG_CACHE_HOME;
    expect(defaultCacheDir()).toMatch(/\.cache\/vulnstack$/);
    if (prev !== undefined) process.env.XDG_CACHE_HOME = prev;
  });
});

import { FallbackCache, fromIoredis, fromNodeRedis, RedisCache } from '../src/cache/redis.js';

/** In-memory stand-in for a Redis server, exposing both client APIs. */
function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    ioredis: {
      get: async (k: string) => store.get(k)?.value ?? null,
      set: async (k: string, value: string, _mode: 'EX', ttl: number) =>
        store.set(k, { value, ttl }),
      mget: async (...keys: string[]) => keys.map((k) => store.get(k)?.value ?? null),
    },
    nodeRedis: {
      get: async (k: string) => store.get(k)?.value ?? null,
      set: async (k: string, value: string, o: { EX: number }) =>
        store.set(k, { value, ttl: o.EX }),
      mGet: async (keys: string[]) => keys.map((k) => store.get(k)?.value ?? null),
    },
  };
}

describe('RedisCache', () => {
  it('stores JSON with a prefix and TTL through ioredis', async () => {
    const r = fakeRedis();
    const cache = new RedisCache(fromIoredis(r.ioredis));
    await cache.set('osv:v:GHSA-1', { id: 'GHSA-1' }, 10.4);
    expect(r.store.get('vulnstack:osv:v:GHSA-1')).toEqual({ value: '{"id":"GHSA-1"}', ttl: 10 });
    expect(await cache.get('osv:v:GHSA-1')).toEqual({ id: 'GHSA-1' });
    expect(await cache.get('missing')).toBeUndefined();
    expect(await cache.getMany(['osv:v:GHSA-1', 'missing'])).toEqual(
      new Map([['osv:v:GHSA-1', { id: 'GHSA-1' }]]),
    );
    expect(await cache.getMany([])).toEqual(new Map());
  });

  it('works with node-redis and a custom prefix', async () => {
    const r = fakeRedis();
    const cache = new RedisCache(fromNodeRedis(r.nodeRedis), 'x:');
    await cache.set('k', [1], 0);
    expect(r.store.get('x:k')!.ttl).toBe(1);
    expect(await cache.getMany(['k'])).toEqual(new Map([['k', [1]]]));
    expect(await cache.get('k')).toEqual([1]);
  });
});

describe('FallbackCache', () => {
  it('switches to the fallback after the first primary error', async () => {
    const errors: unknown[] = [];
    const broken = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const fallback = new MemoryCache();
    const cache = new FallbackCache(broken, fallback, (e) => errors.push(e));
    await cache.set('a', 1, 60);
    expect(await cache.get('a')).toBe(1);
    expect(await cache.getMany(['a', 'b'])).toEqual(new Map([['a', 1]]));
    expect(errors).toHaveLength(1);
  });

  it('uses the primary while it works', async () => {
    const primary = new MemoryCache();
    const cache = new FallbackCache(primary, new MemoryCache());
    await cache.set('a', 1, 60);
    expect(await primary.get('a')).toBe(1);
    expect(await cache.getMany(['a'])).toEqual(new Map([['a', 1]]));
  });
});
