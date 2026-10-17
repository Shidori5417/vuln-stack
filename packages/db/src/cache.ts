import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import type { CacheStore } from '@vulnstack/core';
import type { Db } from './client.js';
import { vulnCache } from './schema.js';

/** CacheStore on the vuln_cache table: the fallback when Redis isn't configured. */
export class PgCacheStore implements CacheStore {
  private writes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.db.query.vulnCache.findFirst({
      where: and(eq(vulnCache.key, key), gt(vulnCache.expiresAt, this.now())),
    });
    return row ? (row.value as T) : undefined;
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 500) {
      const rows = await this.db.query.vulnCache.findMany({
        where: and(
          inArray(vulnCache.key, keys.slice(i, i + 500)),
          gt(vulnCache.expiresAt, this.now()),
        ),
      });
      for (const r of rows) out.set(r.key, r.value as T);
    }
    return out;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    const json = value as object;
    await this.db
      .insert(vulnCache)
      .values({ key, value: json, expiresAt })
      .onConflictDoUpdate({ target: vulnCache.key, set: { value: json, expiresAt } });
    // Sweep expired rows now and then instead of running a separate job.
    if (++this.writes % 500 === 0) await this.prune();
  }

  async prune(): Promise<number> {
    const deleted = await this.db
      .delete(vulnCache)
      .where(lt(vulnCache.expiresAt, this.now()))
      .returning({ key: vulnCache.key });
    return deleted.length;
  }
}
