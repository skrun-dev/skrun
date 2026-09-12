import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiterFactory } from "../ratelimit/select.js";
import { rateLimiter } from "./rate-limit.js";

/** Build a tiny app whose `/x` route is rate-limited by an in-memory backend. */
function appWith(max: number) {
  const make = createRateLimiterFactory({} as NodeJS.ProcessEnv); // no Redis env → memory
  const app = new Hono();
  app.use("/x", rateLimiter({ name: "x", windowMs: 60_000, max, make }));
  app.get("/x", (c) => c.text("ok"));
  return app;
}

describe("rateLimiter middleware keying (SEC-018 / SKRUN_TRUST_PROXY)", () => {
  beforeEach(() => {
    // No trusted gateway header by default: the cases below that don't set one
    // must exercise the X-Forwarded-For branch regardless of the host's env.
    vi.stubEnv("SKRUN_TRUST_PROXY_HEADER", "");
  });

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

  // VT-3b doubles as the "no gateway header named" branch of VT-7: where the
  // gateway overwrites X-Forwarded-For, its first hop is authoritative.
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

  it("VT-7: a named gateway header is the key, and a forged X-Forwarded-For is not", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "1");
    vi.stubEnv("SKRUN_TRUST_PROXY_HEADER", "X-Edge-Client-Ip"); // mixed case on purpose
    const app = appWith(1);
    const hit = (edge: string, forged: string) =>
      app.request("/x", { headers: { "x-edge-client-ip": edge, "x-forwarded-for": forged } });
    // First request from the address the gateway posted.
    expect((await hit("9.9.9.9", "1.1.1.1")).status).toBe(200);
    // Same gateway-posted address, a DIFFERENT forged X-Forwarded-For: if the
    // forged hop were the key this would open a fresh bucket and pass.
    expect((await hit("9.9.9.9", "2.2.2.2")).status).toBe(429);
    // A different gateway-posted address is a different caller, even reusing
    // the very X-Forwarded-For value the first caller sent.
    expect((await hit("8.8.8.8", "1.1.1.1")).status).toBe(200);
  });

  it("VT-7: a named gateway header that is absent falls back to the socket, never to X-Forwarded-For", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "1");
    vi.stubEnv("SKRUN_TRUST_PROXY_HEADER", "x-edge-client-ip");
    const app = appWith(1);
    // The request did not come through the gateway: no posted header, only a
    // caller-supplied one. Both requests must share the socket-derived key
    // ("unknown" on the in-memory client), so the second exceeds max=1.
    expect((await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(
      200,
    );
    expect((await app.request("/x", { headers: { "x-forwarded-for": "2.2.2.2" } })).status).toBe(
      429,
    );
  });

  it("VT-7: a named gateway header is ignored while proxy trust is off", async () => {
    vi.stubEnv("SKRUN_TRUST_PROXY", "");
    vi.stubEnv("SKRUN_TRUST_PROXY_HEADER", "x-edge-client-ip");
    const app = appWith(1);
    const hit = (edge: string) => app.request("/x", { headers: { "x-edge-client-ip": edge } });
    expect((await hit("9.9.9.9")).status).toBe(200);
    expect((await hit("8.8.8.8")).status).toBe(429);
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
