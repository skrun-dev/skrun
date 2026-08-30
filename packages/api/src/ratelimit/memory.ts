import type { RateLimiterAdapter, RateLimitResult } from "./adapter.js";

/**
 * In-process fixed-window counter — the default backend (self-host single
 * instance) and the runtime fallback for `RedisRateLimiter` when Redis is
 * unreachable. Ports the original `middleware/rate-limit.ts` Map logic verbatim
 * (incl. the >10k-entry opportunistic cleanup). Per-instance: correct on a
 * single node, NOT coordinated across a multi-instance cloud deploy (that's
 * what the Redis backend is for).
 */
export class MemoryRateLimiter implements RateLimiterAdapter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;

    // Opportunistic cleanup of expired entries to bound memory.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (now > v.resetAt) this.hits.delete(k);
      }
    }

    return {
      success: entry.count <= this.max,
      limit: this.max,
      remaining: Math.max(0, this.max - entry.count),
      resetSeconds: Math.ceil(entry.resetAt / 1000),
    };
  }
}
