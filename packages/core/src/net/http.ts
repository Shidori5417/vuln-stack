import type { FetchFn } from './context.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

export interface RetryOptions {
  retries?: number;
  /** Base delay for exponential backoff, in ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * fetch + JSON with retries on network errors, 429 and 5xx. Honours Retry-After,
 * otherwise uses exponential backoff with full jitter.
 */
export async function fetchJson<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 300, maxDelayMs = 10_000, sleep = defaultSleep } = options;

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let delay: number | undefined;
    try {
      const response = await fetchFn(
        url,
        options.signal ? { ...init, signal: options.signal } : init,
      );
      if (response.ok) return (await response.json()) as T;

      const body = await response.text().catch(() => '');
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) {
        throw new HttpError(response.status, url, body);
      }
      delay = retryAfterMs(response.headers.get('retry-after'));
    } catch (error) {
      if (error instanceof HttpError || options.signal?.aborted || attempt >= retries) throw error;
    }
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    await sleep(Math.min(maxDelayMs, delay ?? Math.random() * backoff));
  }
}
