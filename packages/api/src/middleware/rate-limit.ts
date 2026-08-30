import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { RateLimiterFactory } from "../ratelimit/select.js";

const TRUTHY = new Set(["1", "true", "on", "yes"]);

/**
 * Resolve the rate-limit key (client IP). Trust `X-Forwarded-For` ONLY when
 * `SKRUN_TRUST_PROXY` is enabled (cloud / proxied self-host) — otherwise it is
 * attacker-spoofable and would let one client masquerade as many. When not
 * trusting proxy headers, key on the connecting socket IP. `getConnInfo` THROWS
 * on the in-memory Hono test client (no socket); fall back to "unknown" so tests
 * and bare deploys still key deterministically. Scoped to the limiter — does NOT
 * touch `external-url.ts` (a separate proxy-awareness concern).
 */
function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
    const xri = c.req.header("x-real-ip")?.trim();
    if (xri) return xri;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Per-IP rate-limit middleware. The backend (in-memory vs Upstash
 * Redis) is built once for this route's (windowMs, max) via the env-selected
 * `make` factory — see `ratelimit/select.ts`. Emits the same 429 +
 * `X-RateLimit-*` contract as the original in-memory limiter.
 */
export function rateLimiter(opts: {
  windowMs: number;
  max: number;
  make: RateLimiterFactory;
}): MiddlewareHandler {
  const adapter = opts.make({ windowMs: opts.windowMs, max: opts.max });
  const trustProxy = TRUTHY.has((process.env.SKRUN_TRUST_PROXY ?? "").toLowerCase());

  return async (c, next) => {
    const result = await adapter.check(clientKey(c, trustProxy));

    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(result.resetSeconds));

    if (!result.success) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Too many requests. Limit: ${opts.max} per ${opts.windowMs / 1000}s.`,
          },
        },
        429,
      );
    }

    await next();
  };
}
