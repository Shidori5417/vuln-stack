/**
 * Fixed-window counter per key, in memory. Good for a single instance; the
 * account features (phase 5) swap this for Redis/Postgres.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, otherwise the seconds until the window resets. */
  hit(key: string): number {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(now);
    }
    w.count++;
    return w.count > this.limit ? Math.ceil((w.start + this.windowMs - now) / 1000) : 0;
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** Client address for rate limiting. Forwarded headers are only trusted behind a proxy. */
export function clientKey(headers: Headers, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
    const real = headers.get('x-real-ip');
    if (real) return real;
  }
  return 'anonymous';
}
