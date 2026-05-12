import type { MiddlewareHandler } from "hono";

/**
 * Simple in-memory rate limiter.
 * Limits requests per IP per window (sliding window counter).
 * For MVP — production should use Redis-backed limiter.
 */
export function rateLimiter(opts: { windowMs: number; max: number }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const now = Date.now();

    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(ip, entry);
    }

    entry.count++;

    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
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

    // Cleanup old entries periodically
    if (hits.size > 10000) {
      for (const [key, val] of hits) {
        if (now > val.resetAt) hits.delete(key);
      }
    }

    await next();
  };
}
