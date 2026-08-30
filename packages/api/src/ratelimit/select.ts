import { createLogger } from "@skrun-dev/runtime";
import { Redis } from "@upstash/redis";
import type { RateLimiterAdapter } from "./adapter.js";
import { MemoryRateLimiter } from "./memory.js";
import { RedisRateLimiter } from "./redis.js";

const logger = createLogger("ratelimit");

export type RateLimiterFactory = (opts: { windowMs: number; max: number }) => RateLimiterAdapter;

/**
 * Build a rate-limiter factory from env, once at app construction.
 * Redis backend when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are
 * both present (cloud multi-instance), otherwise in-memory (self-host single
 * instance) — same "configure from env, no hard dependency" shape as storage/db
 * selection. One shared `Redis` client is reused across both rate-limited routes.
 */
export function createRateLimiterFactory(env: NodeJS.ProcessEnv = process.env): RateLimiterFactory {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    const redis = new Redis({ url, token });
    logger.info(
      { event: "ratelimit_backend", backend: "redis" },
      "Rate limiter: Upstash Redis (multi-instance coordinated)",
    );
    return ({ windowMs, max }) => new RedisRateLimiter(windowMs, max, redis);
  }

  logger.info(
    { event: "ratelimit_backend", backend: "memory" },
    "Rate limiter: in-memory (single-instance; set UPSTASH_REDIS_REST_URL/TOKEN for multi-instance)",
  );
  return ({ windowMs, max }) => new MemoryRateLimiter(windowMs, max);
}
