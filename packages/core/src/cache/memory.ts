import type { CacheStore } from './types.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryCache implements CacheStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
}

export async function getMany<T>(cache: CacheStore, keys: string[]): Promise<Map<string, T>> {
  if (cache.getMany) return cache.getMany<T>(keys);
  const result = new Map<string, T>();
  await Promise.all(
    keys.map(async (key) => {
      const value = await cache.get<T>(key);
      if (value !== undefined) result.set(key, value);
    }),
  );
  return result;
}
