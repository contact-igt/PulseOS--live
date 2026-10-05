// A small in-memory sliding-window rate limiter for public endpoints. State is per API process (behind several instances each
// enforces its own limit - a shared store is the upgrade path). Keys are caller-chosen strings (never stored in the clear
// beyond the window) and the number of tracked keys is capped so a flood of random keys cannot grow memory without bound.

export interface RateDecision {
  allowed: boolean;
  /** Whole seconds until the oldest counted request leaves the window; 0 when allowed. */
  retryAfterSeconds: number;
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts this request and says whether it is within the limit. A refused request is not counted again. */
  hit(key: string, now = Date.now()): RateDecision {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so the Map keeps recently used keys last
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
