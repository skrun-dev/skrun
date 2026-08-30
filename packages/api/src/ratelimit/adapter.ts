/**
 * Rate-limiter abstraction. Mirrors the DbAdapter / StorageAdapter /
 * RuntimeAdapter pattern so the backend is swappable: `MemoryRateLimiter` for
 * self-host single-instance (correct as-is), `RedisRateLimiter` (Upstash) for
 * cloud multi-instance. The backend is auto-selected from env at app
 * construction (see `select.ts`); self-host with no Redis config keeps working
 * unchanged.
 */

export interface RateLimitResult {
  /** false ⟹ over the limit for this window (the caller should emit 429). */
  success: boolean;
  /** The configured ceiling for the window (for the X-RateLimit-Limit header). */
  limit: number;
  /** Requests left in the window (never negative). */
  remaining: number;
  /** Unix epoch SECONDS when the window resets (for X-RateLimit-Reset). */
  resetSeconds: number;
}

export interface RateLimiterAdapter {
  /**
   * Record one hit for `key` (typically the client IP) and report whether it
   * is within the limit. One adapter instance is bound to a single
   * (windowMs, max) pair.
   */
  check(key: string): Promise<RateLimitResult>;
}
