import type { CacheStore } from '../cache/types.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface NetContext {
  fetch: FetchFn;
  cache: CacheStore;
  /** Sent as User-Agent where the runtime allows it. */
  userAgent: string;
  signal?: AbortSignal;
}
