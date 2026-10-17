import type { CacheStore } from './types.js';

/**
 * The few Redis commands the cache needs. Adapters for ioredis and node-redis
 * are below, so core doesn't depend on either client.
 */
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  setEx(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  mGet(keys: string[]): Promise<(string | null)[]>;
}

/** ioredis: `get`, `set(key, value, 'EX', ttl)`, `mget(...keys)`. */
export function fromIoredis(client: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}): RedisCommands {
  return {
    get: (k) => client.get(k),
    setEx: (k, ttl, v) => client.set(k, v, 'EX', ttl),
    mGet: (keys) => client.mget(...keys),
  };
}

/** node-redis v4+: `get`, `set(key, value, { EX })`, `mGet(keys)`. */
export function fromNodeRedis(client: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  mGet(keys: string[]): Promise<(string | null)[]>;
}): RedisCommands {
  return {
    get: (k) => client.get(k),
    setEx: (k, ttl, v) => client.set(k, v, { EX: ttl }),
    mGet: (keys) => client.mGet(keys),
  };
}

/** Values are stored as JSON under `prefix + key`; Redis handles expiry. */
export class RedisCache implements CacheStore {
  constructor(
    private readonly redis: RedisCommands,
    private readonly prefix = 'vulnstack:',
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.setEx(
      this.prefix + key,
      Math.max(1, Math.round(ttlSeconds)),
      JSON.stringify(value),
    );
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    if (keys.length === 0) return result;
    const values = await this.redis.mGet(keys.map((k) => this.prefix + k));
    values.forEach((raw, i) => {
      if (raw !== null && raw !== undefined) result.set(keys[i]!, JSON.parse(raw) as T);
    });
    return result;
  }
}

/** Uses the primary cache, falling back to `fallback` when it errors (e.g. Redis is down). */
export class FallbackCache implements CacheStore {
  private primaryDown = false;

  constructor(
    private readonly primary: CacheStore,
    private readonly fallback: CacheStore,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  private async run<T>(op: (c: CacheStore) => Promise<T>): Promise<T> {
    if (!this.primaryDown) {
      try {
        return await op(this.primary);
      } catch (error) {
        this.primaryDown = true;
        this.onError(error);
      }
    }
    return op(this.fallback);
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.run((c) => c.get<T>(key));
  }

  set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    return this.run((c) => c.set(key, value, ttlSeconds));
  }

  getMany<T>(keys: string[]): Promise<Map<string, T>> {
    return this.run(async (c) => {
      if (c.getMany) return c.getMany<T>(keys);
      const out = new Map<string, T>();
      for (const k of keys) {
        const v = await c.get<T>(k);
        if (v !== undefined) out.set(k, v);
      }
      return out;
    });
  }
}
