import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { RateLimiterFactory } from "../ratelimit/select.js";

const TRUTHY = new Set(["1", "true", "on", "yes"]);

/**
 * Resolve the rate-limit key (client address). Trust forwarded headers ONLY
 * when `SKRUN_TRUST_PROXY` is enabled (cloud / proxied self-host) — otherwise
 * they are attacker-spoofable and would let one client masquerade as many.
 *
 * Which header is authoritative depends on the gateway, so it is configurable
 * rather than assumed. Two gateway behaviours exist, both observed:
 *
 *  - A gateway that **overwrites** `X-Forwarded-For` with the socket address
 *    (the shipped compose stack does, via `header_up`): the first hop of that
 *    header is written by the gateway, so it is authoritative. Leave
 *    `SKRUN_TRUST_PROXY_HEADER` unset — that is this branch.
 *  - A gateway that **appends** to `X-Forwarded-For`, preserving whatever the
 *    caller sent: the first hop is then chosen by the caller, and keying on it
 *    lets one client mint a fresh counter per request. Such a gateway normally
 *    writes the address into a header of its own that a caller cannot dictate;
 *    name that header in `SKRUN_TRUST_PROXY_HEADER` and it becomes the key.
 *
 * When a header is named but missing from the request, the request did not
 * reach us through that gateway: fall back to the socket address — degraded
 * (one counter for everything behind an unknown path) but never spoofable.
 * Falling back to `X-Forwarded-For` there would hand the key back to the
 * caller, which is the whole failure this setting exists to avoid.
 *
 * `getConnInfo` THROWS on the in-memory Hono test client (no socket); fall
 * back to "unknown" so tests and bare deploys still key deterministically.
 * Scoped to the limiter — does NOT touch `external-url.ts` (a separate
 * proxy-awareness concern).
 */
function clientKey(c: Context, trustProxy: boolean, trustedHeader?: string): string {
  if (trustProxy) {
    if (trustedHeader) {
      const posted = c.req.header(trustedHeader)?.trim();
      if (posted) return posted;
      // Deliberately no `X-Forwarded-For` fallback here — see above.
    } else {
      const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (xff) return xff;
      const xri = c.req.header("x-real-ip")?.trim();
      if (xri) return xri;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Per-IP rate-limit middleware. The backend (in-memory vs Upstash
 * Redis) is built once for this mount's (name, windowMs, max) via the
 * env-selected `make` factory — see `ratelimit/select.ts`. `name` is the
 * mount's counter namespace: two mounts with the same window but different
 * names never share a counter on the shared store. Emits the same 429 +
 * `X-RateLimit-*` contract as the original in-memory limiter.
 */
export function rateLimiter(opts: {
  name: string;
  windowMs: number;
  max: number;
  make: RateLimiterFactory;
}): MiddlewareHandler {
  const adapter = opts.make({ name: opts.name, windowMs: opts.windowMs, max: opts.max });
  const trustProxy = TRUTHY.has((process.env.SKRUN_TRUST_PROXY ?? "").toLowerCase());
  // Header names are case-insensitive; normalise so the operator can write it
  // in whatever case the gateway's own documentation uses.
  const trustedHeader = process.env.SKRUN_TRUST_PROXY_HEADER?.trim().toLowerCase() || undefined;

  return async (c, next) => {
    const result = await adapter.check(clientKey(c, trustProxy, trustedHeader));

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
