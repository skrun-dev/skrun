import { createLogger } from "@skrun-dev/runtime";
import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import type { RateLimiterAdapter, RateLimitResult } from "./adapter.js";
import { MemoryRateLimiter } from "./memory.js";

const logger = createLogger("ratelimit-redis");

/**
 * Distributed rate limiter on Upstash Redis. Closes the multi-instance
 * bypass: a counter shared across every api instance, so an attacker can't
 * rotate instances to multiply the effective limit. Uses Upstash's sliding-window
 * algorithm (HTTP/REST — works on Node today and Cloudflare Workers later).
 *
 * Resilience: on ANY Redis runtime error (Upstash outage / network
 * partition) it falls back to an in-memory limiter (degraded to per-instance) —
 * never fail-open (no limiting) and never fail-closed (429-all). A Redis outage
 * thus loses cross-instance coordination but keeps both abuse protection and
 * availability.
 */
export class RedisRateLimiter implements RateLimiterAdapter {
  private readonly ratelimit: Ratelimit;
  private readonly fallback: MemoryRateLimiter;

  constructor(windowMs: number, max: number, redis: Redis) {
    this.ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${windowMs} ms`),
      analytics: false,
      prefix: "skrun:rl",
    });
    this.fallback = new MemoryRateLimiter(windowMs, max);
  }

  async check(key: string): Promise<RateLimitResult> {
    try {
      const r = await this.ratelimit.limit(key);
      // On Cloudflare Workers, flush `r.pending` analytics via `waitUntil` once the
      // API runs on Workers. On Node it resolves inline; nothing to do.
      return {
        success: r.success,
        limit: r.limit,
        remaining: Math.max(0, r.remaining),
        resetSeconds: Math.ceil(r.reset / 1000),
      };
    } catch (err) {
      logger.error(
        { event: "ratelimit_redis_error", error: err instanceof Error ? err.message : String(err) },
        "Redis rate-limiter unreachable — falling back to in-memory (per-instance) for this request",
      );
      return this.fallback.check(key);
    }
  }
}
