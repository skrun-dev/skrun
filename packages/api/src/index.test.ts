import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "./db/memory.js";
import { createApp } from "./index.js";
import { MemoryStorage } from "./storage/memory.js";

// SEC-016: CORS deny-by-default in production.
describe("createApp — CORS startup gate (SEC-016)", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.CORS_ORIGIN;

  beforeEach(() => {
    delete process.env.CORS_ORIGIN;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = previousCorsOrigin;
    }
  });

  it("throws at startup when NODE_ENV=production and CORS_ORIGIN is unset", () => {
    process.env.NODE_ENV = "production";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /CORS_ORIGIN env var is required when NODE_ENV=production/,
    );
  });

  it("starts cleanly when NODE_ENV=production and CORS_ORIGIN is set", () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("falls back to '*' in dev when CORS_ORIGIN is unset", () => {
    process.env.NODE_ENV = "development";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("falls back to '*' when NODE_ENV is undefined (test fixtures)", () => {
    delete process.env.NODE_ENV;
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });
});

// SEC-015: hono/secure-headers middleware.
describe("createApp — secure headers (SEC-015)", () => {
  it("sets X-Frame-Options: DENY on all responses", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets HSTS with 2-year max-age + preload", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("sets X-Content-Type-Options: nosniff and Referrer-Policy", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("CORP is cross-origin (so dashboard can load /api/files/:id/content cross-host)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});

// Scoped Content-Security-Policy on `/dashboard/*`.
describe("createApp — dashboard CSP", () => {
  it("sets Content-Security-Policy on /dashboard/* responses", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/dashboard/index.html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("does NOT set CSP on /api/* (JSON responses don't need it; Scalar /docs loads from CDN)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("does NOT set CSP on /docs (Scalar loads its bundle from a CDN — CSP would break it)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/docs");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
