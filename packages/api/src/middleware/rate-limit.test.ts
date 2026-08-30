import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiterFactory } from "../ratelimit/select.js";
import { rateLimiter } from "./rate-limit.js";

/** Build a tiny app whose `/x` route is rate-limited by an in-memory backend. */
function appWith(max: number) {
  const make = createRateLimiterFactory({} as NodeJS.ProcessEnv); // no Redis env → memory
  const app = new Hono();
  app.use("/x", rateLimiter({ windowMs: 60_000, max, make }));
  app.get("/x", (c) => c.text("ok"));
  return app;
}

describe("rateLimiter middleware keying (SEC-018 / SKRUN_TRUST_PROXY)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("VT-3: with SKRUN_TRUST_PROXY off, a spoofed X-Forwarded-For is ignored", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "");
    const app = appWith(1);
    const r1 = await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const r2 = await app.request("/x", { headers: { "x-forwarded-for": "2.2.2.2" } });
    // getConnInfo throws on the in-memory client → both key on "unknown", so the
    // spoofed XFF can't mint a fresh bucket: the 2nd request exceeds max=1.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  it("VT-3b: with SKRUN_TRUST_PROXY on, X-Forwarded-For is the key", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "1");
    const app = appWith(1);
    const a1 = await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const b1 = await app.request("/x", { headers: { "x-forwarded-for": "2.2.2.2" } });
    // Different XFF = different buckets → each within its own max=1.
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);
    // Same XFF again → that bucket is now over the limit.
    const a2 = await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(a2.status).toBe(429);
  });

  it("emits the X-RateLimit-* headers + RATE_LIMITED body on 429", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "");
    const app = appWith(1);
    await app.request("/x");
    const limited = await app.request("/x");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("X-RateLimit-Reset")).toBeTruthy();
    const body = await limited.json();
    expect(body.error?.code).toBe("RATE_LIMITED");
  });
});
