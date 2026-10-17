/**
 * Key/value cache with per-entry TTL. Implementations: in-memory (default),
 * file (CLI, see `@vulnstack/core/node`), Redis and Postgres (web, in `@vulnstack/db`).
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Optional bulk read; falls back to sequential `get` when absent. */
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;
}

export const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
