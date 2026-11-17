import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { LLMRouter, RunnerPool } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookieName } from "./auth/session.js";
import { MemoryDb } from "./db/memory.js";
import { SCALAR_BUNDLE_SRI, SCALAR_BUNDLE_URL } from "./docs-page.js";
import { createApp } from "./index.js";
import { OperatorSiteError } from "./operator-site.js";
import { parseQuotaEnv, QUOTA_ENV_NAMES, QuotaConfigError } from "./quotas/thresholds.js";
import { validBundle } from "./routes/agent-bundle.shared.js";
import {
  beginLogin,
  callback,
  sessionCookieFrom,
  stubGithubOk,
  withEnv,
} from "./routes/oauth-flow.shared.js";
import { MemoryStorage } from "./storage/memory.js";

// The startup lock logs the cookie domain it kept, and that line is an assertion
// target (#123-VT-9). pino writes to fd 1 directly, bypassing process.stdout.write,
// so the only way to observe it is to replace the factory. vi.mock is hoisted above
// the `./index.js` import, therefore above the module-level createLogger call there.
// vi.hoisted declares the spies in lock-step. Only createLogger is replaced; the
// rest of @skrun-dev/runtime is left intact. Same shape as routes/auth.test.ts.
const { logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logWarnSpy: vi.fn(),
  logErrorSpy: vi.fn(),
  logOtherSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const levels = {
    info: logInfoSpy,
    warn: logWarnSpy,
    error: logErrorSpy,
    debug: logOtherSpy,
    trace: logOtherSpy,
    fatal: logOtherSpy,
  };
  return {
    ...actual,
    createLogger: () => ({ ...levels, level: "info", child: () => levels }),
  };
});

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

describe("createApp — a quota setting it cannot apply refuses the start", () => {
  const previous = new Map(QUOTA_ENV_NAMES.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    for (const name of QUOTA_ENV_NAMES) delete process.env[name];
  });

  it("a window that does not divide a day: createApp throws the setting's refusal, naming it", () => {
    process.env.SKRUN_QUOTA_WINDOW_S = "18000";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(QuotaConfigError);
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /^SKRUN_QUOTA_WINDOW_S must divide one day/,
    );
  });

  it("compute seconds without their window: refused at start too", () => {
    process.env.SKRUN_QUOTA_COMPUTE_SECONDS = "3600";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /SKRUN_QUOTA_COMPUTE_SECONDS is set without SKRUN_QUOTA_WINDOW_S/,
    );
  });

  it("no quota setting: the app starts, and answers as before", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("valid settings: the app starts", () => {
    process.env.SKRUN_QUOTA_CONCURRENT_RUNS = "free=2,pro=5";
    process.env.SKRUN_QUOTA_COMPUTE_SECONDS = "free=3600,pro=14400";
    process.env.SKRUN_QUOTA_WINDOW_S = "21600";
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
  });

  it("settings passed explicitly are used as they are: the environment is not read", () => {
    process.env.SKRUN_QUOTA_WINDOW_S = "18000";
    expect(() =>
      createApp(new MemoryStorage(), new MemoryDb(), { quotaConfig: parseQuotaEnv({}) }),
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
    // On the cloud runtime the app starts the maintenance of the runners'
    // machines, whatever the pool's size. This case is about the startup: the
    // maintenance itself — a listing of the platform at once, then one per
    // minute — is not run here.
    const start = vi.spyOn(RunnerPool.prototype, "start").mockImplementation(() => {});
    try {
      expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      start.mockRestore();
    }
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
    // The signed-in user's GitHub avatar is the one remote image the SPA renders;
    // exact directive, so a narrowing that drops it (or a widening) fails here.
    expect(csp).toContain("img-src 'self' data: https://avatars.githubusercontent.com;");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("does NOT set CSP on /api/* (JSON responses don't need it)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/health");
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

  // The page fallback answers each of these paths as it did before
  // @hono/node-server 2.1.3: the dashboard for a path that holds a `%` once
  // decoded (2.1.3's check, lifted for the fallback alone), a 404 for one with an
  // empty segment or an encoded backslash, alone or after `..` (the checks it
  // keeps). A raw backslash is answered 400 by @hono/node-server before routing
  // (since 2.1.6), which `app.request` does not go through.
  it.each([
    { path: "/dashboard/%E0", status: 200 },
    { path: "/dashboard/a%2Fb", status: 200 },
    { path: "/dashboard/a%25b", status: 200 },
    { path: "/dashboard//agents", status: 404 },
    { path: "/dashboard/a//b", status: 404 },
    { path: "/dashboard/a%5cb", status: 404 },
    { path: "/dashboard/..%5csecret.txt", status: 404 },
    // The URL parser resolves this `..` before routing: it never reaches the
    // fallback's checks, and answers 404 whatever its options.
    { path: "/dashboard/%2e%2e/secret.txt", status: 404 },
  ])("the page fallback answers $path with a $status", async ({ path, status }) => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request(path);
    expect(res.status).toBe(status);
    if (status === 200) expect(await res.text()).toContain("fixture-spa");
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

  // The CSRF guard is mounted on "*", so it sits on the path of the SPA shell, of
  // every static asset and of /health. It must do nothing there: those are safe
  // methods and the library steps out on its first test. That was measured either
  // side of the mount — the three responses came back byte-identical in status,
  // body and headers — and the measurement is recorded outside this file. What
  // stays here is the one assertion that would notice a guard later widened to
  // safe methods: a session cookie on a GET must change none of the three.
  it("leaves the dashboard, the static assets and /health untouched (#123)", async () => {
    const db = new MemoryDb();
    const app = createApp(new MemoryStorage(), db);
    const user = await db.createUser({ github_id: "gh-q2", username: "q2" });
    const cookie = `${sessionCookieName()}=${await createSession(db, user.id)}`;

    for (const path of ["/dashboard/", "/dashboard/assets/app.js", "/health"]) {
      const res = await app.request(path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      // The body is asserted too: the guard's refusal is a 403 whose body is
      // exactly "Forbidden", and a status alone would not tell it apart from
      // any other 403 this app can produce.
      expect(await res.text(), path).not.toBe("Forbidden");
    }
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

// An error no route handles. The framework's default handler printed it whole
// to stderr: its message, its stack, and whatever a driver hangs on it, any of
// which can quote a row. The app answers exactly as that default did, and logs
// the error's class and code instead, under the route's pattern.
describe("createApp — an error no route handles", () => {
  const envSnapshot = { ...process.env };
  const WITNESS = "row-7f3a-never-in-a-log";
  // A read that fails the way a database driver's does: a message that quotes a
  // row, a code, and a field of its own that quotes the row again.
  const failingRead = async (): Promise<never> => {
    throw Object.assign(new Error(`duplicate key value violates unique constraint "${WITNESS}"`), {
      code: "23505",
      detail: `Key (namespace, name)=(${WITNESS}) already exists.`,
    });
  };

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_RUNTIME;
    process.env.NODE_ENV = "test";
    process.env.SKRUN_DEV_AUTH = "1";
    for (const spy of [logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy]) spy.mockClear();
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

  /** Every call of every log level, as one text. */
  function everythingLogged(): string {
    const calls = [logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy].map((spy) => spy.mock.calls);
    return inspect(calls, { depth: 10 });
  }

  function unhandledLines(): unknown[][] {
    return logErrorSpy.mock.calls.filter(([fields]) => fields?.event === "unhandled_error");
  }

  it.each([
    ["/api/agents", "/api/agents"],
    // This route catches the error and hands it to dispatchRegistryError, which
    // throws on anything that is not a RegistryError: it lands here too.
    ["/api/agents/dev/witness", "/api/agents/:namespace/:name"],
  ])("answers GET %s with the framework's bare 500, and logs the error's class and code under the route's pattern", async (path, route) => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new MemoryDb();
    db.listAgents = failingRead;
    db.getAgent = failingRead;

    const res = await createApp(new MemoryStorage(), db).request(path, {
      headers: { Authorization: "Bearer dev-token" },
    });

    // The answer of the framework's default handler, unchanged.
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("Internal Server Error");
    // Nothing reaches stderr, where that default printed the whole error.
    expect(inspect(printed.mock.calls, { depth: 10 })).not.toContain(WITNESS);
    expect(printed).not.toHaveBeenCalled();
    // The message, and the row it quotes, reach no log line either.
    expect(everythingLogged()).not.toContain(WITNESS);
    // One line: the class and the code, the frames of the stack, the route's
    // pattern, never the path.
    expect(unhandledLines()).toEqual([
      [
        {
          event: "unhandled_error",
          method: "GET",
          route,
          error_name: "Error",
          error_code: "23505",
          error_stack: expect.any(Array),
        },
        expect.any(String),
      ],
    ]);
    const [[fields]] = unhandledLines() as [[{ error_stack: string[] }]];
    expect(fields.error_stack.length).toBeGreaterThan(0);
    expect(fields.error_stack.every((line) => line.startsWith("at "))).toBe(true);
  });

  it("answers an HTTPException with its own response, as before: the forgery guard's 403", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await createApp(new MemoryStorage(), new MemoryDb()).request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=00000000-0000-4000-8000-000000000000`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "name=forged",
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(await res.text()).toBe("Forbidden");
    expect(unhandledLines()).toEqual([]);
    expect(printed).not.toHaveBeenCalled();
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
      runtimeMode: "flyio",
      flyioDeps: fakeDeps({ enabled: true, start, stats: () => ({}) }),
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("is a no-op on cloud dependencies built without a pool", () => {
    expect(() =>
      createApp(new MemoryStorage(), new MemoryDb(), {
        runtimeMode: "flyio",
        flyioDeps: fakeDeps(undefined),
      }),
    ).not.toThrow();
  });

  // Started last: a start refused by a check after the cloud dependencies are
  // read leaves no maintenance running behind it — whoever catches the refusal
  // holds no server, and must not hold a maintenance that lists machines.
  describe("a start refused once the cloud dependencies are read", () => {
    const envSnapshot = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
      }
      for (const [k, v] of Object.entries(envSnapshot)) {
        if (v !== undefined) process.env[k] = v;
      }
    });

    it.each([
      [
        "a secrets encryption key that is malformed",
        () => {
          process.env.SKRUN_SECRETS_ENCRYPTION_KEY = "too-short";
        },
        /32 bytes/,
      ],
      [
        "a production server without CORS_ORIGIN",
        () => {
          process.env.NODE_ENV = "production";
          delete process.env.CORS_ORIGIN;
          delete process.env.SKRUN_DEV_AUTH;
        },
        /CORS_ORIGIN env var is required/,
      ],
      [
        "a body cap that is not a decimal number — the last check of the assembly",
        () => {
          process.env.SKRUN_MAX_BODY_MB = "0x10";
        },
        /SKRUN_MAX_BODY_MB must be a positive decimal number/,
      ],
    ] as const)("%s: no maintenance is started", (_what, setUp, refusal) => {
      setUp();
      const start = vi.fn();

      expect(() =>
        createApp(new MemoryStorage(), new MemoryDb(), {
          runtimeMode: "flyio",
          flyioDeps: fakeDeps({ enabled: true, start, stats: () => ({}) }),
        }),
      ).toThrow(refusal);
      expect(start).not.toHaveBeenCalled();
    });
  });
});

/**
 * The entry points decide the runtime mode once and hand createApp the mode and
 * the cloud dependencies together — the output purge starts on those same
 * dependencies. Any pair that could disagree is refused at startup.
 */
describe("createApp — the runtime mode is decided once (#127)", () => {
  const fakeDeps = () => ({ flyApi: {}, storage: {}, runtimeImageTag: "img" }) as never;

  /** The message `build` throws with, or a failure if it does not throw. */
  function refusal(build: () => unknown): string {
    try {
      build();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("createApp did not refuse");
  }

  /**
   * Whoever embeds the app reads this advice, so it may name only what they can
   * reach: the two options, not the function the server entry points use, which
   * the package does not export.
   */
  function expectAdvice(message: string): void {
    expect(message).toContain('Pass runtimeMode "flyio" and flyioDeps together, or neither.');
    expect(message).not.toContain("resolveRuntime");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("VT-17 (#127): cloud dependencies with the local mode are refused", () => {
    const message = refusal(() =>
      createApp(new MemoryStorage(), new MemoryDb(), {
        runtimeMode: "local",
        flyioDeps: fakeDeps(),
      }),
    );
    expect(message).toMatch(/cloud-runtime dependencies, but the runtime mode is "local"/);
    expectAdvice(message);
  });

  it("VT-17 (#127): cloud dependencies with no mode, and none in the environment, are refused", () => {
    vi.stubEnv("SKRUN_RUNTIME", undefined);
    const message = refusal(() =>
      createApp(new MemoryStorage(), new MemoryDb(), { flyioDeps: fakeDeps() }),
    );
    expect(message).toMatch(/cloud-runtime dependencies, but the runtime mode is "local"/);
    expectAdvice(message);
  });

  it("VT-17 (#127): the cloud mode without its dependencies is refused", () => {
    const message = refusal(() =>
      createApp(new MemoryStorage(), new MemoryDb(), { runtimeMode: "flyio" }),
    );
    expect(message).toMatch(/runtime mode "flyio" without its dependencies/);
    expectAdvice(message);
  });

  it("VT-17 (#127): a mode that is given is not read again — whatever SKRUN_RUNTIME says", () => {
    vi.stubEnv("SKRUN_RUNTIME", "kubernetes");
    expect(() =>
      createApp(new MemoryStorage(), new MemoryDb(), {
        runtimeMode: "flyio",
        flyioDeps: fakeDeps(),
      }),
    ).not.toThrow();
  });
});

/**
 * A purge nothing starts deletes nothing, and the retention window it enforces
 * would quietly become a claim with nothing behind it. The two entry points are
 * the only places a server is run from: each must decide its runtime once, hand
 * that same decision to createApp, and start the purge on the store it carries.
 */
describe("the server entry points and the output purge (#127)", () => {
  it("VT-9 (#127): server.ts and dev.ts decide the runtime once and start the purge on its store", async () => {
    const { readFileSync } = await import("node:fs");
    for (const entry of ["server.ts", "dev.ts"]) {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), entry), "utf-8");
      const count = (text: string) => source.split(text).length - 1;
      expect(count("resolveRuntime("), entry).toBe(1);
      expect(
        count(
          "createApp(storage, db, { runtimeMode: runtime.mode, flyioDeps: runtime.flyioDeps })",
        ),
        entry,
      ).toBe(1);
      expect(count("startRunOutputPurge(db, runtime.flyioDeps?.storage)"), entry).toBe(1);
      expect(count("selectRuntimeMode("), entry).toBe(0);
      expect(count("buildFlyioDeps("), entry).toBe(0);
    }
  });
});

describe("proxy trust wiring (#116)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("VT-8: the shipped compose sets SKRUN_TRUST_PROXY on the api service", async () => {
    // infra/docker-compose.yml is in .sync-allowlist, so this test can read it
    // in the public mirror too. It pins the shipped mount, not the middleware.
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../infra/docker-compose.yml"),
      "utf-8",
    );
    // Anchored: inside the api service's environment block, not anywhere else.
    const api = compose.split(/\r?\n/);
    let inApi = false;
    let inEnv = false;
    let found = false;
    for (const line of api) {
      if (/^ {2}api:\s*$/.test(line)) {
        inApi = true;
        continue;
      }
      if (inApi && /^ {2}\S/.test(line)) break;
      if (inApi && /^ {4}environment:\s*$/.test(line)) {
        inEnv = true;
        continue;
      }
      if (inEnv && /^ {4}\S/.test(line)) inEnv = false;
      if (inEnv && /^ {6}SKRUN_TRUST_PROXY:/.test(line)) found = true;
    }
    expect(found).toBe(true);
  });

  it("VT-6: two callers behind one gateway get two counters on the real push route", async () => {
    // trustProxy is captured when the middleware mounts — the stub must be in
    // place BEFORE createApp.
    vi.stubEnv("SKRUN_TRUST_PROXY", "1");
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const bundle = await validBundle("vt6-agent");
    const push = (ip: string, version: string) =>
      app.request(`/api/agents/dev/vt6-agent/push?version=${version}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-token",
          "Content-Type": "application/octet-stream",
          "X-Forwarded-For": ip,
        },
        body: new Uint8Array(bundle),
      });
    // Caller A exhausts ITS window…
    for (let i = 1; i <= 10; i++) {
      expect((await push("10.0.0.1", `1.0.${i}`)).status).toBe(200);
    }
    expect((await push("10.0.0.1", "1.0.11")).status).toBe(429);
    // …caller B is untouched: its own counter, not a shared one.
    const b = await push("10.0.0.2", "2.0.0");
    expect(b.status).toBe(200);
    expect(b.headers.get("X-RateLimit-Remaining")).toBe("9");
  });
});

// `/docs` — the interactive API docs page. The renderer is a third-party bundle
// that runs on this origin, where the signed-in user's session cookie rides on
// every request it makes. So: exactly one external script, pinned by version AND
// integrity; no inline script; a CSP that names that one source; Scalar's own
// third-party relays (request proxy, fonts) switched off.
//
// The "no external script without integrity" case is the guard: it goes red the
// day someone puts the CDN-by-default renderer back.
describe("createApp — /docs page", () => {
  const externalScriptTags = (html: string) => [
    ...html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]*)"[^>]*>/g),
  ];

  it("loads the Scalar bundle pinned by version AND integrity, cross-origin anonymous", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(SCALAR_BUNDLE_URL).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\//,
    );
    expect(SCALAR_BUNDLE_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(html).toContain(
      `<script src="${SCALAR_BUNDLE_URL}" integrity="${SCALAR_BUNDLE_SRI}" crossorigin="anonymous"></script>`,
    );
  });

  it("references no external script without an integrity attribute (guard)", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const html = await (await app.request("/docs")).text();
    const tags = externalScriptTags(html);
    expect(tags.length).toBeGreaterThan(0);
    for (const [tag] of tags) {
      expect(tag).toMatch(/\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/);
      expect(tag).toMatch(/\bcrossorigin="anonymous"/);
    }
    // And the version is pinned: no bare "@scalar/api-reference" (= latest) anywhere.
    expect(html).not.toMatch(/@scalar\/api-reference(?!@\d)/);
  });

  it("carries no inline script — Scalar reads its configuration from #api-reference", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const html = await (await app.request("/docs")).text();
    const inlineWithBody = [
      ...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
    ].filter((m) => m[1].trim().length > 0);
    expect(inlineWithBody).toEqual([]);
    expect(html).toMatch(/<script id="api-reference" data-configuration="/);
  });

  it("switches off Scalar's request proxy and remote fonts, and points at our spec", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const html = await (await app.request("/docs")).text();
    const m = html.match(/data-configuration="([^"]*)"/);
    expect(m).not.toBeNull();
    const decoded = (m as RegExpMatchArray)[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const config = JSON.parse(decoded);
    expect(config.url).toBe("/openapi.json");
    expect(config.proxyUrl).toBe("");
    expect(config.withDefaultFonts).toBe(false);
  });

  it("sets a CSP on /docs that names exactly the pinned bundle as the only remote script source", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb());
    const res = await app.request("/docs");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src 'self' ${SCALAR_BUNDLE_URL}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    // No wildcard CDN host: a different file on jsdelivr must not be loadable.
    expect(csp).not.toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net(\s|;|$)/);
  });
});

// The session-cookie handoff startup locks. Same shape as the two gates above:
// createApp() is the whole surface, and a refusal is a thrown Error naming the
// value it got. These exist because the failure they prevent is SILENT — a cookie
// scoped to a domain the browser rejects produces no error anywhere, just a user
// who is never logged in.
describe("createApp — session cookie handoff startup locks (#123)", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    logInfoSpy.mockClear();
  });

  afterEach(() => {
    for (const key of ["SKRUN_PUBLIC_URL", "SKRUN_SESSION_COOKIE_DOMAIN"]) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  const boot = () => createApp(new MemoryStorage(), new MemoryDb());

  // VT-5 — the domain must be a suffix of the canonical host, at a label boundary.
  it("VT-5: refuses a cookie domain that is not a suffix of the canonical host", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "autre.com";
    expect(boot).toThrow(/"autre.com" is not a suffix of the canonical host "api\.example\.com"/);
  });

  // A bare endsWith() would accept this: "api.example.com".endsWith("ample.com") is
  // true, and "ample.com" is a completely different registrable domain.
  it("VT-5: the suffix must match at a label boundary, not by string ending", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "ample.com";
    expect(boot).toThrow(/"ample.com" is not a suffix of the canonical host/);
  });

  // VT-6 — the rule no structural check reaches: co.uk IS a label-boundary suffix
  // of api.example.co.uk. Only a public-suffix list separates the two.
  it("VT-6: refuses a public suffix, which a structural suffix check would accept", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.co.uk";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "co.uk";
    expect(boot).toThrow(/"co.uk" is a public suffix/);
    // And the registrable domain under it is accepted — otherwise the rule would be
    // refusing the shape rather than the suffix.
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.co.uk";
    expect(boot).not.toThrow();
  });

  // The list is consulted with private domains included. Without that option
  // getDomain("fly.dev") returns "fly.dev" and this boots — then the browser drops
  // every cookie, silently, on the one platform we actually deploy to.
  it("VT-6: refuses a private-section public suffix such as a platform subdomain", () => {
    process.env.SKRUN_PUBLIC_URL = "https://skrun-cloud-api-test.fly.dev";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "fly.dev";
    expect(boot).toThrow(/"fly.dev" is a public suffix/);
  });

  // VT-7 — a single-label domain. Ordered before the public-suffix rule on purpose:
  // "no dot" is the message that tells the operator what to type instead.
  it("VT-7: refuses a cookie domain with no dot", () => {
    process.env.SKRUN_PUBLIC_URL = "http://localhost:4000";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "localhost";
    expect(boot).toThrow(/must contain at least one dot \(got "localhost"\)/);
  });

  // VT-8 — the missing variable is named, because the alternative source for the
  // canonical host would be the Host header, i.e. the caller.
  it("VT-8: refuses a cookie domain with no canonical URL, naming the missing variable", () => {
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    expect(boot).toThrow(/SKRUN_PUBLIC_URL is not set/);
  });

  // VT-38 — Domain has no meaning on an IP host (RFC 6265 §5.1.3).
  it("VT-38: refuses a cookie domain when the canonical host is a literal IPv4", () => {
    process.env.SKRUN_PUBLIC_URL = "https://192.168.1.5:4000";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "168.1.5";
    expect(boot).toThrow(/"192\.168\.1\.5" \(from SKRUN_PUBLIC_URL\) is a literal IP address/);
  });

  it("VT-38: refuses a cookie domain when the canonical host is a literal IPv6", () => {
    process.env.SKRUN_PUBLIC_URL = "https://[::1]";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "::1";
    // The brackets are stripped before the check, so the message names the address
    // as isIP() sees it rather than as the URL spells it.
    expect(boot).toThrow(/"::1" \(from SKRUN_PUBLIC_URL\) is a literal IP address/);
  });

  // The other half of VT-38, and the one that keeps the rule honest: it is the
  // DOMAIN that is refused on an IP host, never the URL. A LAN self-hoster with no
  // DNS still boots and still gets a working host-only cookie.
  it("VT-38: an IP canonical host with no cookie domain boots (host-only cookie)", () => {
    process.env.SKRUN_PUBLIC_URL = "https://192.168.1.5:4000";
    expect(boot).not.toThrow();
  });

  // VT-10 — three malformed canonical URLs, each refused.
  it("VT-10: refuses a canonical URL with no scheme", () => {
    process.env.SKRUN_PUBLIC_URL = "api.example.com";
    expect(boot).toThrow(/SKRUN_PUBLIC_URL must be an absolute http\(s\) origin/);
  });

  it("VT-10: refuses a canonical URL carrying a path", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com/v1";
    expect(boot).toThrow(/it carries a path, query or fragment/);
  });

  it("VT-10: refuses a canonical URL on a non-http scheme", () => {
    process.env.SKRUN_PUBLIC_URL = "ftp://api.example.com";
    expect(boot).toThrow(/scheme "ftp"/);
  });

  // A port is explicitly allowed — self-hosting on :4000 is a supported shape, and
  // refusing it here would be a rule nobody asked for.
  it("VT-10: accepts a canonical URL with a port", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com:8443";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    expect(boot).not.toThrow();
  });

  // VT-9 — a valid pair boots AND names the domain it kept. Without this line a
  // session broken by a rejected cookie leaves no trace at all.
  it("VT-9: a valid configuration boots and logs the retained domain", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    expect(boot).not.toThrow();
    const logged = logInfoSpy.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === "session_cookie_domain",
    );
    expect(logged).toBeDefined();
    expect(logged?.[0]).toMatchObject({
      event: "session_cookie_domain",
      domain: "example.com",
      canonical_origin: "https://api.example.com",
    });
  });

  // A leading dot is what the cookie spec ignores, so we accept the form and drop
  // the dot rather than fail on a value copied from an older guide.
  it("VT-9: a leading dot is normalised away, and the log shows the normalised value", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = ".Example.COM";
    expect(boot).not.toThrow();
    const logged = logInfoSpy.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === "session_cookie_domain",
    );
    expect(logged?.[0]).toMatchObject({ domain: "example.com" });
  });

  // No domain configured means no line — the log is a signal, not a heartbeat.
  it("VT-9: no cookie domain means no startup line at all", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    expect(boot).not.toThrow();
    const logged = logInfoSpy.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === "session_cookie_domain",
    );
    expect(logged).toBeUndefined();
  });
});

// VT-19 / RT-9 — the canonical host is pinned for all three callers that hand out
// an externally-visible URL. The attack shape is a request that supplies its own
// Host and X-Forwarded-Proto; measured beforehand, Hono's test client does pass a
// Host header through, and externalBaseUrl prefers it over the request URL, so this
// is the real precedence being exercised and not a proxy for it.
describe("createApp — the canonical host is pinned, not derived (#123)", () => {
  const envSnapshot = { ...process.env };
  const FORGED = {
    Host: "evil.example",
    "X-Forwarded-Proto": "http",
  };

  beforeEach(() => {
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    // GET /auth/github and POST /auth/device/code both require OAuth to be
    // configured before they will produce a URL at all.
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    for (const key of [
      "SKRUN_PUBLIC_URL",
      "SKRUN_SESSION_COOKIE_DOMAIN",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  /** The three externally-visible URLs the app hands out, under one set of headers. */
  async function threeUrls(headers: Record<string, string>) {
    const app = createApp(new MemoryStorage(), new MemoryDb());

    const github = await app.request("/auth/github", { redirect: "manual", headers });
    const location = github.headers.get("Location") ?? "";
    const redirectUri = new URL(location).searchParams.get("redirect_uri") ?? "";

    const device = await app.request("/auth/device/code", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code_challenge: "abc", code_challenge_method: "S256" }),
    });
    const deviceBody = (await device.json()) as { verification_uri: string };

    const openapi = await app.request("/openapi.json", { headers });
    const schema = (await openapi.json()) as { servers: { url: string }[] };

    return {
      redirectUri,
      verificationUri: deviceBody.verification_uri,
      serversUrl: schema.servers[0]?.url ?? "",
      deviceStatus: device.status,
    };
  }

  it("VT-19: all three callers name the canonical origin, and never the forged Host", async () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    const urls = await threeUrls(FORGED);

    expect(urls.deviceStatus).toBe(200);
    expect(urls.redirectUri).toBe("https://api.example.com/auth/github/callback");
    expect(urls.verificationUri).toBe("https://api.example.com/device");
    expect(urls.serversUrl).toBe("https://api.example.com");

    // Zero occurrences of the forged host anywhere in the three values — asserted as
    // an absence and not only as an equality, because a URL that merely CONTAINS the
    // canonical origin could still carry the forged one somewhere else in it.
    for (const value of [urls.redirectUri, urls.verificationUri, urls.serversUrl]) {
      expect(value).not.toContain("evil.example");
    }
  });

  it("RT-9: with no canonical origin the three callers derive from the headers, unchanged", async () => {
    const urls = await threeUrls({ Host: "self.example", "X-Forwarded-Proto": "https" });

    expect(urls.deviceStatus).toBe(200);
    expect(urls.redirectUri).toBe("https://self.example/auth/github/callback");
    expect(urls.verificationUri).toBe("https://self.example/device");
    expect(urls.serversUrl).toBe("https://self.example");
  });

  it("RT-9: the http fallback is preserved too — the derivation is untouched", async () => {
    const urls = await threeUrls(FORGED);

    // Exactly what this deployment returned before the variable existed: the Host
    // header wins over the request URL, and X-Forwarded-Proto decides the scheme.
    expect(urls.redirectUri).toBe("http://evil.example/auth/github/callback");
    expect(urls.verificationUri).toBe("http://evil.example/device");
    expect(urls.serversUrl).toBe("http://evil.example");
  });
});

// The CSRF guard's exemption for Authorization-bearing requests, and the whole
// "PUT/PATCH/DELETE are protected by the preflight" argument, rest on ONE fact:
// the CORS mount carries no credentials. The day someone adds `credentials: true`
// "to make the dashboard work", four DELETEs and three PUTs become forgeable
// without a single line of the guard changing — and nothing would say so.
//
// The check is BEHAVIOURAL, never a text search in index.ts: an option passed by
// spread (`cors({ origin, ...opts })`) would leave the word absent from the call
// site and the check green. What is asserted is the object actually built,
// through the response it produces.
describe("createApp — the CORS mount grants no credentials (#123)", () => {
  const previous = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (previous === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previous;
  });

  it("VT-30: a cross-origin preflight comes back with no Access-Control-Allow-Credentials", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = createApp(new MemoryStorage(), new MemoryDb());

    const res = await app.request("/api/keys", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.headers.get("access-control-allow-credentials")).toBeNull();

    // And the second half, which the CSRF mount assumed rather than checked: the
    // preflight is answered by CORS and never reaches the guard. If it did, this
    // would be the guard's bare 403 "Forbidden" instead of a CORS response.
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toBe("Forbidden");
  });
});

// A browser on another origin reads only the response headers it is told it may.
// Without the list, a dashboard or a client page could not see the wait a
// refusal asks for, the limiter's numbers, or an account's quota numbers —
// they would reach the browser and stay unreadable to the page.
describe("createApp — the headers a browser on another origin may read", () => {
  const previous = process.env.CORS_ORIGIN;
  const EXPOSED = [
    "Retry-After",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "X-Quota-Runs-Limit",
    "X-Quota-Runs-Remaining",
    "X-Quota-Compute-Limit",
    "X-Quota-Compute-Remaining",
    "X-Quota-Compute-Reset",
    "X-Quota-Fast-Runs-Limit",
    "X-Quota-Fast-Runs-Remaining",
  ];

  afterEach(() => {
    if (previous === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previous;
  });

  /** The names a response exposes, as sent. */
  const exposedBy = (res: Response) =>
    (res.headers.get("access-control-expose-headers") ?? "").split(",").map((name) => name.trim());

  it("a preflight for a run, and the run's own response, expose the wait, the limiter's numbers and the quota numbers", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = createApp(new MemoryStorage(), new MemoryDb());

    const preflight = await app.request("/api/agents/dev/some-agent/run", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(exposedBy(preflight)).toEqual(EXPOSED);

    const run = await app.request("/api/agents/dev/some-agent/run", {
      method: "POST",
      headers: {
        Origin: "https://app.example.com",
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });
    expect(run.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(exposedBy(run)).toEqual(EXPOSED);
  });
});

describe("createApp — the operator's own site settings, refused at start", () => {
  const NAMES = [
    "SKRUN_LOGIN_RETURN_PATH",
    "SKRUN_LOGIN_PAGE_URL",
    "SKRUN_TERMS_URL",
    "SKRUN_PRIVACY_URL",
    "SKRUN_DOCS_URL",
  ] as const;
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = withEnv([...NAMES, "SKRUN_PUBLIC_URL", "SKRUN_SESSION_COOKIE_DOMAIN"]);
    for (const name of [...NAMES, "SKRUN_PUBLIC_URL", "SKRUN_SESSION_COOKIE_DOMAIN"]) {
      delete process.env[name];
    }
  });

  afterEach(() => restoreEnv());

  const boot = () => createApp(new MemoryStorage(), new MemoryDb());

  /** The refusal the start throws: fails the case when the app starts. */
  const refusal = (): OperatorSiteError => {
    try {
      boot();
    } catch (err) {
      if (err instanceof OperatorSiteError) return err;
      throw err;
    }
    throw new Error("the app started; a refused start was expected");
  };

  // One value of the wrong form per setting: what proves each one is read at start.
  it.each([
    { name: "SKRUN_LOGIN_RETURN_PATH", value: "signin" },
    { name: "SKRUN_LOGIN_PAGE_URL", value: "/signin" },
    { name: "SKRUN_TERMS_URL", value: "javascript:alert(1)" },
    { name: "SKRUN_PRIVACY_URL", value: "javascript:alert(1)" },
    { name: "SKRUN_DOCS_URL", value: "javascript:alert(1)" },
  ])("refuses to start on $name=$value, naming the variable and the value", ({ name, value }) => {
    process.env[name] = value;
    const err = refusal();

    expect(err.variable).toBe(name);
    expect(err.message.startsWith(`${name} must be `)).toBe(true);
    expect(err.message.endsWith(` — received ${JSON.stringify(value)}`)).toBe(true);
  });

  it.each(NAMES)("starts with %s empty, or made of blanks: a value not set", (name) => {
    process.env[name] = "";
    expect(boot).not.toThrow();
    process.env[name] = "   ";
    expect(boot).not.toThrow();
  });

  it("refuses a return path with no cookie domain, naming both variables and where a sign-in would go", () => {
    process.env.SKRUN_LOGIN_RETURN_PATH = "/signin";
    const err = refusal();

    expect(err.variable).toBe("SKRUN_LOGIN_RETURN_PATH");
    expect(err.message).toContain("SKRUN_SESSION_COOKIE_DOMAIN");
    expect(err.message).toContain("/dashboard");
    expect(err.message.endsWith(' — received "/signin"')).toBe(true);
  });

  it("starts with a return path once the cookie domain is set", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    process.env.SKRUN_LOGIN_RETURN_PATH = "/signin";
    expect(boot).not.toThrow();
  });

  it.each([
    "https://api.example.com/login",
    "https://api.example.com/%6Cogin",
    "http://api.example.com/login",
    "https://api.example.com./login",
    "HTTP://API.EXAMPLE.COM:80/login",
  ])("refuses the sign-in page %s on the canonical host: /login would redirect to it forever", (page) => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_LOGIN_PAGE_URL = page;
    const err = refusal();

    expect(err.variable).toBe("SKRUN_LOGIN_PAGE_URL");
    expect(err.message).toContain("/login");
    expect(err.message).toContain("https://api.example.com");
  });

  it("starts with a sign-in page on another host or port, or with no canonical origin to compare it to", () => {
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_LOGIN_PAGE_URL = "https://example.com/login";
    expect(boot).not.toThrow();

    process.env.SKRUN_LOGIN_PAGE_URL = "https://api.example.com:8443/login";
    expect(boot).not.toThrow();

    delete process.env.SKRUN_PUBLIC_URL;
    process.env.SKRUN_LOGIN_PAGE_URL = "https://api.example.com/login";
    expect(boot).not.toThrow();
  });

  it("never prints the credentials of a refused value", () => {
    process.env.SKRUN_LOGIN_PAGE_URL = "https://user:secret@x/";
    const err = refusal();

    expect(err.message).not.toContain("secret");
    expect(err.message).toContain("***@");
  });

  // The order decides which message an operator reads first: the cookie domain's
  // own checks, then each setting on its own form, then the rules that read a pair.
  it("reads the cookie domain first, then each setting's form, then the pairs", () => {
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    process.env.SKRUN_LOGIN_RETURN_PATH = "signin";
    expect(boot).toThrow(/SKRUN_PUBLIC_URL is not set/);

    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    process.env.SKRUN_LOGIN_PAGE_URL = "/signin";
    expect(refusal().variable).toBe("SKRUN_LOGIN_RETURN_PATH");

    process.env.SKRUN_LOGIN_RETURN_PATH = "/signin";
    process.env.SKRUN_LOGIN_PAGE_URL = "https://api.example.com/login";
    expect(refusal().message).toContain("SKRUN_SESSION_COOKIE_DOMAIN");
  });
});

// An empty line of an env file (`NAME=`) reaches the server as the name present
// with an empty value — the Docker Compose stack hands its whole `.env` to the
// api. For each name below, that empty value must read exactly as the name left
// out. Each row observes one behaviour the name changes, on an app built after
// the environment is set; its witness sets a value and sees the observation
// change, so a row cannot pass by observing nothing.
// Read the same way and tested elsewhere: the five settings of the operator's own
// site ("starts with … empty, or made of blanks", above) and the trusted gateway
// header (middleware/rate-limit.test.ts, which clears it to "" for every case).
describe("createApp — a setting present but empty behaves as unset", () => {
  /** Every name this block sets or clears, put back after each case. */
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_AGENTS_DIR",
    "XAI_API_KEY",
    "SESSION_TTL_S",
  ] as const;
  /** Cleared before each case; the others keep the suite's own values (NODE_ENV=test, the dev token on). */
  const CLEARED = [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_AGENTS_DIR",
    "XAI_API_KEY",
    "SESSION_TTL_S",
  ] as const;
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = withEnv(KEYS);
    for (const key of CLEARED) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  const boot = () => createApp(new MemoryStorage(), new MemoryDb());

  /** Sets a name to a value, or leaves it out for `undefined`. */
  const put = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  /** Whether the GitHub sign-in starts: its redirect, or the code of its refusal. */
  const githubStart = async () => {
    const res = await boot().request("/auth/github", { redirect: "manual" });
    if (res.status !== 404) return { status: res.status };
    const body = (await res.json()) as { error?: { code?: string } };
    return { status: res.status, code: body.error?.code };
  };

  /** The address the server hands out for itself, to a request made to another host. */
  const ownAddress = async () => {
    const res = await boot().request("http://other.example/openapi.json");
    const doc = (await res.json()) as { servers: { url: string }[] };
    return doc.servers[0]?.url;
  };

  /** A whole GitHub sign-in, GitHub answering: where it lands, and the session cookie it sets. */
  const signIn = async () => {
    stubGithubOk({ id: 515151, login: "empty-line-reader" });
    const app = boot();
    const { state, cookie } = await beginLogin(app);
    const res = await callback(app, `?code=c&state=${state}`, cookie);
    const line = sessionCookieFrom(res);
    return {
      status: res.status,
      location: res.headers.get("Location"),
      cookie: line?.slice(0, line.indexOf("=")),
      domain: line === undefined ? undefined : /;\s*Domain=/i.test(line),
    };
  };

  /** What the agents-directory scan answers an admin: whether a directory is configured. */
  const agentsScan = async () => {
    const res = await boot().request("/api/agents/scan", {
      headers: { Authorization: "Bearer dev-token" },
    });
    const body = (await res.json()) as { configured?: boolean };
    return { status: res.status, configured: body.configured };
  };

  /** Whether a run of the xai provider finds a key of the server's own. */
  const xaiKey = async () => new LLMRouter().checkKeyResolvable("xai");

  interface Row {
    /** The case's name. */
    label: string;
    /** The names set together to each value. */
    names: readonly string[];
    /** The values that must read as unset — the name left out first. */
    unset: readonly (string | undefined)[];
    /** What the observation sees when the names read as unset. */
    unsetSeen: unknown;
    /** A value that is read, and what the observation then sees — absent where the left-out name is the witness. */
    witness?: { value: string; seen: unknown };
    /** Everything else the observation needs. */
    env: Record<string, string | undefined>;
    observe: () => Promise<unknown>;
  }

  const ROWS: Row[] = [
    {
      label: "GITHUB_CLIENT_ID alone, its secret set",
      names: ["GITHUB_CLIENT_ID"],
      unset: [undefined, ""],
      unsetSeen: { status: 404, code: "OAUTH_NOT_CONFIGURED" },
      witness: { value: "id", seen: { status: 302 } },
      env: { GITHUB_CLIENT_SECRET: "secret" },
      observe: githubStart,
    },
    {
      label: "both GitHub OAuth credentials",
      names: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      unset: [undefined, ""],
      unsetSeen: { status: 404, code: "OAUTH_NOT_CONFIGURED" },
      witness: { value: "id-or-secret", seen: { status: 302 } },
      env: {},
      observe: githubStart,
    },
    {
      label: "SKRUN_PUBLIC_URL",
      names: ["SKRUN_PUBLIC_URL"],
      unset: [undefined, ""],
      // No canonical origin: the address follows the request's host.
      unsetSeen: "http://other.example",
      witness: { value: "https://api.example.com", seen: "https://api.example.com" },
      env: {},
      observe: ownAddress,
    },
    {
      label: "SKRUN_SESSION_COOKIE_DOMAIN",
      names: ["SKRUN_SESSION_COOKIE_DOMAIN"],
      unset: [undefined, "", "   "],
      // A host-only cookie: in production its name carries the __Host- prefix, and
      // a sign-in with no cookie domain lands on the dashboard of this server.
      unsetSeen: {
        status: 302,
        location: "/dashboard",
        cookie: "__Host-skrun_session",
        domain: false,
      },
      env: {
        NODE_ENV: "production",
        CORS_ORIGIN: "https://app.example.com",
        SKRUN_DEV_AUTH: undefined,
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
      },
      observe: signIn,
    },
    {
      label: "SKRUN_ALLOWED_GITHUB_USERS",
      names: ["SKRUN_ALLOWED_GITHUB_USERS"],
      unset: [undefined, ""],
      // Open sign-up: the account is created and signed in.
      unsetSeen: { status: 302, location: "/dashboard", cookie: "skrun_session", domain: false },
      witness: {
        value: "someone-else",
        seen: { status: 403, location: null, cookie: undefined, domain: undefined },
      },
      env: { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" },
      observe: signIn,
    },
    {
      label: "SKRUN_AGENTS_DIR",
      names: ["SKRUN_AGENTS_DIR"],
      unset: [undefined, ""],
      unsetSeen: { status: 200, configured: false },
      witness: {
        value: join(dirname(fileURLToPath(import.meta.url)), "no-such-agents-directory"),
        seen: { status: 200, configured: true },
      },
      env: {},
      observe: agentsScan,
    },
    {
      label: "XAI_API_KEY",
      names: ["XAI_API_KEY"],
      unset: [undefined, ""],
      unsetSeen: { refused: "no-key" },
      witness: { value: "xai-not-a-real-key", seen: { tier: "server" } },
      env: {},
      observe: xaiKey,
    },
  ];

  const prepare = (row: Row, value: string | undefined) => {
    for (const [name, v] of Object.entries(row.env)) put(name, v);
    for (const name of row.names) put(name, value);
  };

  it.each(
    ROWS.flatMap((row) =>
      row.unset.map((value) => ({
        ...row,
        value,
        shown: value === undefined ? "left out" : `set to ${JSON.stringify(value)}`,
      })),
    ),
  )("$label $shown reads as unset", async (row) => {
    prepare(row, row.value);
    expect(await row.observe()).toEqual(row.unsetSeen);
  });

  it.each(
    ROWS.filter((row) => row.witness !== undefined),
  )("$label set to a value is read — the witness of its row", async (row) => {
    const witness = row.witness as { value: string; seen: unknown };
    prepare(row, witness.value);
    expect(await row.observe()).toEqual(witness.seen);
  });
});
