import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "./db/memory.js";
import { createApp } from "./index.js";
import { MemoryStorage } from "./storage/memory.js";

/** Absolute path to the test fixture SPA — serveStatic resolves `root` from cwd. */
const FIXTURE_WEB_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/web-dist",
);

describe("createApp — verification policy startup gate", () => {
  const previous = process.env.SKRUN_VERIFICATION_POLICY;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SKRUN_VERIFICATION_POLICY;
    } else {
      process.env.SKRUN_VERIFICATION_POLICY = previous;
    }
  });

  it("throws at startup when SKRUN_VERIFICATION_POLICY is invalid", () => {
    process.env.SKRUN_VERIFICATION_POLICY = "bogus";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /Invalid SKRUN_VERIFICATION_POLICY/,
    );
  });

  it("starts cleanly when the policy is unset (default admin) or valid", () => {
    delete process.env.SKRUN_VERIFICATION_POLICY;
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
    process.env.SKRUN_VERIFICATION_POLICY = "owner";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("an explicit override bypasses the env read (test path)", () => {
    process.env.SKRUN_VERIFICATION_POLICY = "bogus";
    expect(() =>
      createApp(new MemoryStorage(), new MemoryDb(), { verificationPolicy: "owner" }),
    ).not.toThrow();
  });
});

// SEC-016: CORS deny-by-default in production.
describe("createApp — CORS startup gate (SEC-016)", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.CORS_ORIGIN;
  const previousDevAuth = process.env.SKRUN_DEV_AUTH;

  beforeEach(() => {
    delete process.env.CORS_ORIGIN;
    // Isolate the CORS gate from the dev-auth interlock — production runs with
    // dev-auth off (the secure default), so these production-NODE_ENV cases must
    // not trip SKRUN_DEV_AUTH.
    delete process.env.SKRUN_DEV_AUTH;
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
    if (previousDevAuth === undefined) {
      delete process.env.SKRUN_DEV_AUTH;
    } else {
      process.env.SKRUN_DEV_AUTH = previousDevAuth;
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

// Cloud runtime selection — fail fast when SKRUN_RUNTIME=flyio is set
// without the matching env block. A misconfigured cloud server must NOT
// silently start with the local in-process adapter.
describe("createApp — SKRUN_RUNTIME=flyio startup gate", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    delete process.env.SKRUN_RUNTIME;
    delete process.env.FLY_API_TOKEN;
    delete process.env.SKRUN_RUNNERS_APP;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_ACCOUNT_ID;
    delete process.env.S3_REGION;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("throws with a clear list of missing env vars when SKRUN_RUNTIME=flyio without Fly+S3 creds", () => {
    process.env.SKRUN_RUNTIME = "flyio";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /SKRUN_RUNTIME=flyio is missing required env vars/,
    );
  });

  it("throws naming FLY_API_TOKEN when only that var is missing", () => {
    process.env.SKRUN_RUNTIME = "flyio";
    process.env.SKRUN_RUNNERS_APP = "skrun-cloud";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "skrun-bundles";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(/FLY_API_TOKEN/);
  });

  it("starts cleanly when SKRUN_RUNTIME=flyio and all required envs are set", () => {
    process.env.SKRUN_RUNTIME = "flyio";
    process.env.FLY_API_TOKEN = "fly-test-token";
    process.env.SKRUN_RUNNERS_APP = "skrun-cloud";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_BUCKET = "skrun-bundles";
    process.env.S3_ENDPOINT = "https://minio.example";
    // RUNTIME_IMAGE_TAG is now required (#17 fail-fast — no silent :latest).
    process.env.RUNTIME_IMAGE_TAG = "ghcr.io/skrun-dev/skrun-runtime:edge";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("starts cleanly with SKRUN_RUNTIME unset (defaults to local — no cloud envs required)", () => {
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("rejects an invalid SKRUN_RUNTIME value loudly instead of falling back", () => {
    process.env.SKRUN_RUNTIME = "kubernetes";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /SKRUN_RUNTIME="kubernetes" is not a valid runtime/,
    );
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
// The dashboard defaults OFF in tests (vitest.setup.ts), so enable it + point
// at the fixture SPA so /dashboard/* actually mounts (CSP + static serving).
describe("createApp — dashboard CSP", () => {
  const envSnapshot = { ...process.env };
  beforeEach(() => {
    process.env.SKRUN_DASHBOARD = "on";
    process.env.SKRUN_DASHBOARD_DIR = FIXTURE_WEB_DIST;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("serves the SPA + sets Content-Security-Policy on /dashboard/* responses", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/dashboard/index.html");
    expect(res.status).toBe(200);
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

// Dashboard serving from a real (fixture) dist — #93 VT-1 / VT-2 / VT-9.
describe("createApp — dashboard serving (enabled, dir present)", () => {
  const envSnapshot = { ...process.env };
  beforeEach(() => {
    process.env.SKRUN_DASHBOARD = "on";
    process.env.SKRUN_DASHBOARD_DIR = FIXTURE_WEB_DIST;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("serves the SPA index at /dashboard/ (VT-1)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/dashboard/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture-spa");
  });

  it("serves assets with the correct Content-Type (VT-1, SC-12)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const js = await app.request("/dashboard/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type") ?? "").toMatch(/javascript/);
    const css = await app.request("/dashboard/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type") ?? "").toContain("text/css");
  });

  it("falls back to index.html for SPA deep-links (VT-2)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/dashboard/agents");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture-spa");
  });

  it("does not regress the API surface when the dashboard is bundled (VT-9)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/openapi.json")).status).toBe(200);
  });

  it("redirects /playground → /dashboard/agents when enabled (RT-2)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/playground");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/agents");
  });
});

// Flag off + enabled-but-missing-dir — #93 VT-3 (HTTP), SC-5b, Q-3.
describe("createApp — SKRUN_DASHBOARD off / missing dir", () => {
  const envSnapshot = { ...process.env };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  for (const value of ["off", "false", "0"]) {
    it(`disables /dashboard + /playground when SKRUN_DASHBOARD=${value} (VT-3, SC-5b)`, async () => {
      process.env.SKRUN_DASHBOARD = value;
      const app = createApp(new MemoryStorage(), new MemoryDb());
      const dash = await app.request("/dashboard/");
      expect(dash.status).toBe(404);
      expect(dash.headers.get("content-security-policy")).toBeNull();
      expect((await app.request("/playground")).status).toBe(404);
      expect((await app.request("/health")).status).toBe(200);
      expect((await app.request("/api/agents")).status).not.toBe(404);
    });
  }

  it("404s /dashboard non-fatally when enabled but the dir is absent (Q-3)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SKRUN_DASHBOARD = "on";
    process.env.SKRUN_DASHBOARD_DIR = "/no/such/dir";
    const app = createApp(new MemoryStorage(), new MemoryDb());
    expect((await app.request("/dashboard/")).status).toBe(404);
    expect((await app.request("/health")).status).toBe(200);
  });
});

// Fail-secure dev-auth startup interlock — #009 VT-4 / VT-4b / VT-5 / VT-6.
describe("createApp — dev-auth startup interlock (#009)", () => {
  const envSnapshot = { ...process.env };
  beforeEach(() => {
    // Isolate: no OAuth; clear SKRUN_RUNTIME so the flyio gate can't mask the
    // interlock (CONCERN-5); set CORS_ORIGIN so the CORS gate doesn't fire first.
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_RUNTIME;
    process.env.CORS_ORIGIN = "https://app.example.com";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("VT-4: throws when NODE_ENV=production + dev-auth + no OAuth", () => {
    process.env.NODE_ENV = "production";
    process.env.SKRUN_DEV_AUTH = "1";
    // Distinct from the CORS gate's message (CORS_ORIGIN is set in beforeEach).
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /SKRUN_DEV_AUTH is enabled without OAuth/,
    );
  });

  it("VT-4b: throws when NODE_ENV is unset + dev-auth + no OAuth (untrusted)", () => {
    delete process.env.NODE_ENV;
    process.env.SKRUN_DEV_AUTH = "1";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /SKRUN_DEV_AUTH is enabled without OAuth/,
    );
  });

  it("VT-5: production + dev-auth OFF boots and rejects dev-token (401)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SKRUN_DEV_AUTH;
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/api/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(401);
  });

  it("VT-6: warns once when dev-auth is enabled in development", () => {
    process.env.NODE_ENV = "development";
    process.env.SKRUN_DEV_AUTH = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createApp(new MemoryStorage(), new MemoryDb());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SKRUN_DEV_AUTH is ENABLED");
  });
});

// Secrets encryption key boot interlock — #102 VT-7. A malformed master key must
// fail-fast at startup (not surprise at the first attach); unset is fine (attach
// is then refused, fail-closed).
describe("createApp — SKRUN_SECRETS_ENCRYPTION_KEY boot interlock (#102)", () => {
  const previous = process.env.SKRUN_SECRETS_ENCRYPTION_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.SKRUN_SECRETS_ENCRYPTION_KEY;
    else process.env.SKRUN_SECRETS_ENCRYPTION_KEY = previous;
  });

  it("VT-7: throws at startup when the key is set but malformed (wrong length)", () => {
    process.env.SKRUN_SECRETS_ENCRYPTION_KEY = "too-short";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(/32 bytes/);
  });

  it("starts cleanly when the key is unset (attach refused, fail-closed)", () => {
    delete process.env.SKRUN_SECRETS_ENCRYPTION_KEY;
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("starts cleanly with a valid 32-byte base64 key", () => {
    process.env.SKRUN_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });
});

/**
 * Regression guard for a gap the unit suite could not see: the pool had a
 * `fill()` that nothing ever called, so it stayed empty and every run took the
 * cold path — correct behaviour, and therefore silent. Only a cloud run
 * surfaced it. This asserts the composition root actually starts the thing.
 */
describe("createApp — pre-warm pool startup", () => {
  function fakeDeps(pool: unknown) {
    return { flyApi: {}, storage: {}, runtimeImageTag: "img", pool } as never;
  }

  it("starts the pool's background maintenance when one is configured", () => {
    const start = vi.fn();
    createApp(new MemoryStorage(), new MemoryDb(), {
      flyioDeps: fakeDeps({ enabled: true, start, stats: () => ({}) }),
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("is a no-op when the deployment runs no pool — the default everywhere", () => {
    expect(() =>
      createApp(new MemoryStorage(), new MemoryDb(), { flyioDeps: fakeDeps(undefined) }),
    ).not.toThrow();
  });
});
