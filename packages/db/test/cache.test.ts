import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCacheStore, schema, type DbHandle } from '../src/index.js';
import { freshDb } from './helpers.js';

let h: DbHandle;
beforeAll(async () => {
  h = await freshDb();
});
afterAll(() => h.close());

describe('PgCacheStore', () => {
  it('gets, sets and overwrites', async () => {
    const c = new PgCacheStore(h.db);
    expect(await c.get('k')).toBeUndefined();
    await c.set('k', { a: 1 }, 60);
    expect(await c.get('k')).toEqual({ a: 1 });
    await c.set('k', ['x'], 60);
    expect(await c.get('k')).toEqual(['x']);
  });

  it('expires entries using the injected clock', async () => {
    let now = new Date('2030-01-01T00:00:00Z');
    const c = new PgCacheStore(h.db, () => now);
    await c.set('ttl', 1, 10);
    now = new Date('2030-01-01T00:00:09Z');
    expect(await c.get('ttl')).toBe(1);
    now = new Date('2030-01-01T00:00:11Z');
    expect(await c.get('ttl')).toBeUndefined();
    expect((await c.getMany(['ttl'])).size).toBe(0);
    expect(await c.prune()).toBeGreaterThanOrEqual(1);
    expect(await c.prune()).toBe(0);
  });

  it('getMany handles more than 500 keys and skips misses', async () => {
    const c = new PgCacheStore(h.db);
    const keys = Array.from({ length: 1100 }, (_, i) => `many:${i}`);
    await h.db
      .insert(schema.vulnCache)
      .values(
        keys.map((key, i) => ({ key, value: { i }, expiresAt: new Date(Date.now() + 60_000) })),
      );
    const got = await c.getMany<{ i: number }>([...keys, 'many:missing']);
    expect(got.size).toBe(1100);
    expect(got.get('many:1050')).toEqual({ i: 1050 });
    expect((await c.getMany([])).size).toBe(0);
  });

  it('sweeps expired rows every 500 writes', async () => {
    let now = new Date('2031-01-01T00:00:00Z');
    const c = new PgCacheStore(h.db, () => now);
    await c.set('old', 1, 1);
    now = new Date('2031-01-01T01:00:00Z');
    for (let i = 0; i < 500; i++) await c.set(`sweep:${i}`, i, 3600);
    const rows = await h.db.select().from(schema.vulnCache);
    expect(rows.find((r) => r.key === 'old')).toBeUndefined();
  });
});
