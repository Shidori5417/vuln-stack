export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Sliding-window limiter: at most `limit` acquisitions per `windowMs`.
 * `acquire` resolves false instead of waiting past `deadline`.
 */
export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  acquire(deadline = Infinity): Promise<boolean> {
    // Serialise callers so the window bookkeeping stays consistent.
    const next = this.chain.then(() => this.take(deadline));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async take(deadline: number): Promise<boolean> {
    for (;;) {
      const now = this.clock.now();
      while (this.stamps.length && this.stamps[0]! <= now - this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return true;
      }
      const wait = this.stamps[0]! + this.windowMs - now;
      if (now + wait > deadline) return false;
      await this.clock.sleep(wait);
    }
  }
}
