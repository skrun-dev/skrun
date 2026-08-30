import type { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "./memory.js";
import { RedisRateLimiter } from "./redis.js";
import { createRateLimiterFactory } from "./select.js";

/**
 * FakeRedis — a deterministic in-process stand-in for @upstash/redis. It runs a
 * SIMPLE shared per-window counter (NOT Upstash's real Lua sliding-window), so
 * two RedisRateLimiter instances sharing one FakeRedis can be observed enforcing
 * JOINTLY — the SEC-018 multi-instance property. Per spec SC-2 this proves the
 * shared-store path, NOT Upstash's internal atomic correctness (that rests on
 * Upstash's documented eval guarantee). The script contract (from @upstash
 * source): keys=[currentKey, previousKey, dynamicLimitKey], args=[tokens, now,
 * windowSize, incrementBy]; returns [remainingTokens, effectiveLimit]; success =
 * remainingTokens >= 0.
 */
class FakeRedis {
  store = new Map<string, number>();
  private run(keys: string[], args: Array<string | number>): [number, number] {
    const currentKey = keys[0];
    const tokens = Number(args[0]);
    const incrementBy = Number(args[3] ?? 1);
    const count = (this.store.get(currentKey) ?? 0) + incrementBy;
    this.store.set(currentKey, count);
    return [tokens - count, tokens];
  }
  async evalsha(_hash: string, keys: string[], args: Array<string | number>) {
    return this.run(keys, args);
  }
  async eval(_script: string, keys: string[], args: Array<string | number>) {
    return this.run(keys, args);
  }
  async scriptLoad() {
    return "fakehash";
  }
}

class ThrowingRedis {
  async evalsha(): Promise<never> {
    throw new Error("upstash unreachable");
  }
  async eval(): Promise<never> {
    throw new Error("upstash unreachable");
  }
  async scriptLoad(): Promise<never> {
    throw new Error("upstash unreachable");
  }
}

describe("rate limiter backends (SEC-018)", () => {
  it("VT-4: MemoryRateLimiter enforces the limit per key", async () => {
    const rl = new MemoryRateLimiter(60_000, 3);
    expect((await rl.check("ip")).success).toBe(true); // 1
    expect((await rl.check("ip")).success).toBe(true); // 2
    const third = await rl.check("ip"); // 3
    expect(third.success).toBe(true);
    expect(third.remaining).toBe(0);
    expect(third.limit).toBe(3);
    expect(third.resetSeconds).toBeGreaterThan(0);
    expect((await rl.check("ip")).success).toBe(false); // 4 > 3
    expect((await rl.check("other")).success).toBe(true); // distinct key is independent
  });

  it("VT-2: two RedisRateLimiter over one shared store enforce jointly (multi-instance)", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const a = new RedisRateLimiter(60_000, 3, redis);
    const b = new RedisRateLimiter(60_000, 3, redis);
    expect((await a.check("ip")).success).toBe(true); // joint count 1
    expect((await b.check("ip")).success).toBe(true); // 2
    expect((await a.check("ip")).success).toBe(true); // 3
    // 4th request, on the OTHER instance, exceeds the SHARED limit → no per-instance bypass.
    expect((await b.check("ip")).success).toBe(false);
  });

  it("VT-6: RedisRateLimiter falls back to in-memory on a Redis error (no throw, still limits)", async () => {
    const limiter = new RedisRateLimiter(60_000, 2, new ThrowingRedis() as unknown as Redis);
    expect((await limiter.check("ip")).success).toBe(true); // fallback memory: 1
    expect((await limiter.check("ip")).success).toBe(true); // 2
    expect((await limiter.check("ip")).success).toBe(false); // 3 > 2 — fallback limits, never threw
  });

  it("VT-1: factory selects Redis when env present, else in-memory", () => {
    const redisFactory = createRateLimiterFactory({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(redisFactory({ windowMs: 1000, max: 1 })).toBeInstanceOf(RedisRateLimiter);

    const memFactory = createRateLimiterFactory({} as NodeJS.ProcessEnv);
    expect(memFactory({ windowMs: 1000, max: 1 })).toBeInstanceOf(MemoryRateLimiter);
  });
});
