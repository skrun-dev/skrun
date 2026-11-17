import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createLogger,
  DEFAULT_STARTED_ORPHAN_WINDOW_MS,
  MACHINE_LIFETIME_GRACE_MS,
  readPrimaryFailoverMs,
  undeclaredLifetimeFallbackMs,
} from "@skrun-dev/runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { getDomain } from "tldts";
import { isDevAuthEnabled } from "./auth/dev-auth.js";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import { sessionCookieDomain } from "./auth/session.js";
import { resolveDashboardConfig, warnDashboardDirMissing } from "./dashboard.js";
import type { DbAdapter } from "./db/adapter.js";
import { DATABASE_TIMEOUT_RETRY_AFTER_S, databaseTimeoutCause } from "./db/pg-timeouts.js";
import { renderDocsPage, SCALAR_BUNDLE_URL } from "./docs-page.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import {
  createBodyLimits,
  RequestBodyTooLarge,
  readBodyLimitConfig,
} from "./middleware/body-limit.js";
import { createCsrfGuard } from "./middleware/csrf.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { getOpenAPISchema } from "./openapi.js";
import { readOperatorSite } from "./operator-site.js";
import { QUOTA_HEADERS } from "./quotas/admission.js";
import { type QuotaConfig, readQuotaConfig } from "./quotas/thresholds.js";
import { createRateLimiterFactory } from "./ratelimit/select.js";
import { createAccountRoutes } from "./routes/account.js";
import { createAdminPoolRoutes } from "./routes/admin-pool.js";
import { createAgentLlmKeyRoutes } from "./routes/agent-llm-keys.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createFilesRoutes } from "./routes/files.js";
import { createInstanceRoutes } from "./routes/instance.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createRunRoutes } from "./routes/run.js";
import { createScanRoutes } from "./routes/scan.js";
import { createStatsRoutes } from "./routes/stats.js";
import { createUsageRoutes } from "./routes/usage.js";
import { runAcquisitionBounds } from "./runtime/acquisition-bounds.js";
import {
  buildFlyioDeps,
  type FlyioRuntimeDeps,
  type RuntimeMode,
  selectRuntimeMode,
} from "./runtime/adapter-selection.js";
import { createRunMachineSweep } from "./runtime/machine-sweep.js";
import { assertAgentYamlWorkerPresent } from "./services/agent-yaml-reader.js";
import { createDeletionJournal, readDeletionJournal } from "./services/deletion-journal.js";
import { RegistryService } from "./services/registry.js";
import { getKeyProvider } from "./services/secrets/key-provider.js";
import { readVerificationPolicy, type VerificationPolicy } from "./services/verification-policy.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { getMaxDecompressedBytes } from "./utils/bundle.js";
import { errorFields } from "./utils/error-fields.js";
import { externalBaseUrl, parsePublicUrl } from "./utils/external-url.js";

// "startup" and not "api": run.ts:48 already holds "api", and two modules logging
// under one name make the filter useless for whoever is reading a boot log.
const startupLogger = createLogger("startup");
// The error a route lets escape, logged by the app's error handler below.
const httpLogger = createLogger("http");

/** The response headers a browser on another origin may read (`Access-Control-Expose-Headers`). */
const EXPOSED_HEADERS: string[] = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  ...Object.values(QUOTA_HEADERS),
];

export function createApp(
  storage: StorageAdapter,
  db: DbAdapter,
  opts: {
    verificationPolicy?: VerificationPolicy;
    /**
     * The runtime mode, decided once by the entry point (`resolveRuntime()`).
     * Given, it is used as it is: `SKRUN_RUNTIME` is not read a second time.
     * Omitted, the mode is read from the environment here.
     */
    runtimeMode?: RuntimeMode;
    /**
     * The cloud-runtime dependencies, decided together with the mode. The server
     * entry points pass both, because they start the output purge on the store
     * in these same dependencies. Omitted on the cloud runtime, they are built
     * here from the environment. A pair that could disagree — dependencies with
     * any other mode, or the cloud mode given without them — refuses to start.
     */
    flyioDeps?: FlyioRuntimeDeps;
    /**
     * The per-plan quota settings. Omitted, they are read here from the
     * environment, once (`readQuotaConfig`); a test passes its own.
     */
    quotaConfig?: QuotaConfig;
  } = {},
) {
  const app = new Hono();
  const service = new RegistryService(storage, db);
  const authMiddleware = createAuthMiddleware(db);

  // Runtime adapter selection — decided once and threaded into the run routes.
  // The server entry points decide it with resolveRuntime() and pass the mode
  // and its dependencies; a caller that passes neither gets them from the
  // environment here. Either way SKRUN_RUNTIME=flyio fails fast when the cloud
  // credentials are missing, so a misconfigured server cannot start and
  // silently mis-execute runs against the wrong backend.
  const runtimeMode = opts.runtimeMode ?? selectRuntimeMode();
  // The two pairs that could disagree are refused, not reconciled: the output
  // purge runs on the store of the dependencies the entry point holds, so
  // dependencies this app would ignore, or a cloud app built on another set,
  // would leave the runs' objects where nothing deletes them. The advice names
  // only the two options: whoever embeds the app cannot import resolveRuntime().
  if (opts.flyioDeps && runtimeMode !== "flyio") {
    throw new Error(
      `createApp was given cloud-runtime dependencies, but the runtime mode is "${runtimeMode}". ` +
        'Pass runtimeMode "flyio" and flyioDeps together, or neither.',
    );
  }
  if (opts.runtimeMode === "flyio" && !opts.flyioDeps) {
    throw new Error(
      'createApp was given the runtime mode "flyio" without its dependencies. ' +
        'Pass runtimeMode "flyio" and flyioDeps together, or neither.',
    );
  }
  const flyioDeps = opts.flyioDeps ?? (runtimeMode === "flyio" ? buildFlyioDeps() : undefined);

  // Verification policy — resolved once at startup. An invalid value throws
  // here (fail-fast, like SKRUN_RUNTIME / SKRUN_DEV_AUTH) so a typo can't run
  // the server with an undefined gate. Tests pass an explicit override to skip
  // the env read.
  const verificationPolicy = opts.verificationPolicy ?? readVerificationPolicy();

  // Per-plan quota settings — read once, here, by the one module that reads
  // the eight variables, and handed to the routes that bound an account. A
  // value it cannot apply throws QuotaConfigError naming the variable: a
  // refused start, like the policy above. None set: nothing is bounded.
  const quotaConfig = opts.quotaConfig ?? readQuotaConfig(process.env);

  // Secrets encryption provider for creator-attached LLM keys — built once at
  // startup. getKeyProvider() throws HERE if SKRUN_SECRETS_ENCRYPTION_KEY is set
  // but malformed (fail-fast boot interlock, like SKRUN_RUNTIME above); unset =
  // unconfigured (creator-key attach is then refused, fail-closed).
  const keyProvider = getKeyProvider();

  // How long one call of a primary model may go unanswered before a declared
  // fallback takes over, while no tool of the run has been called — read once,
  // here, and handed to the run routes' model router. A malformed value throws
  // naming SKRUN_PRIMARY_FAILOVER_MS: a refused start, like the interlocks above.
  const primaryFailoverMs = readPrimaryFailoverMs(process.env);

  // The deletion journal — read once, here: on, each account deletion and each
  // API key revocation leaves an empty object in the store this app keeps
  // bundles in, so that a database restored from an earlier copy can have them
  // done again. A malformed value throws naming SKRUN_DELETION_JOURNAL: a
  // refused start, like the interlocks above. The server entry points read it
  // too, before any connection, for the same refusal in their own form.
  const deletionJournal = readDeletionJournal(process.env)
    ? createDeletionJournal(storage)
    : undefined;

  // Session-cookie handoff — the two operator settings, resolved and validated ONCE
  // here, in the same fail-fast form as the four interlocks above.
  //
  // Why a boot interlock and not a request-time check: a cookie the browser refuses
  // produces NO error. Nothing throws, nothing 500s — the user simply is not logged
  // in, and on a mistyped shared domain the symptom is "I get signed out when I move
  // between hosts", weeks later, with no trace. This block is the only thing that
  // turns that silence into a message, so it must run on the path that cannot be
  // skipped: createApp is both the server's startup and what every test builds.
  //
  // The five rules are ONE guard and ship together — shipping a subset would let
  // through exactly the value the missing rule refuses. Their ORDER is chosen: it
  // decides which message an operator reads first, and the most useful one is
  // always the one naming the thing they can fix.
  const publicUrlRaw = process.env.SKRUN_PUBLIC_URL?.trim();
  // (1) Format. Throws by itself, naming the value and the expected shape.
  const canonicalUrl = publicUrlRaw ? parsePublicUrl(publicUrlRaw) : undefined;
  const canonicalOrigin = canonicalUrl?.origin;

  // Read and normalised by session.ts — the module that actually puts the value on
  // the cookie. Validating anything else here would mean validating a string the
  // cookie never uses: two normalisations that differ by a trim would let this
  // interlock approve a domain the browser then never sees. One normalisation, two
  // readers. (A leading dot is dropped there, as the cookie spec ignores it.)
  const cookieDomain = sessionCookieDomain();

  if (cookieDomain) {
    // (2) A domain with nothing to compare it against. The only other source for the
    // canonical host would be the `Host` header — i.e. the caller — so we refuse
    // rather than validate a domain against a value an attacker supplies.
    if (!canonicalUrl) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN is set to "${cookieDomain}" but SKRUN_PUBLIC_URL is not set. ` +
          "The cookie domain is validated against the canonical public host, so that host must be " +
          "configured — deriving it from the Host header would mean validating against the caller. " +
          "Set SKRUN_PUBLIC_URL (e.g. https://api.example.com).",
      );
    }
    // `new URL("https://[::1]").hostname` keeps the brackets; isIP() does not want them.
    const canonicalHost = canonicalUrl.hostname.replace(/^\[/, "").replace(/\]$/, "");

    // (3) A literal IP host. `Domain` has no meaning on an IP (RFC 6265 §5.1.3) and
    // browsers disagree about what to do with it. Note the boundary: an IP host with
    // NO domain configured boots fine and gets a host-only cookie — it is the domain
    // that is refused here, never the URL.
    if (isIP(canonicalHost) !== 0) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN is set to "${cookieDomain}" but the canonical host ` +
          `"${canonicalHost}" (from SKRUN_PUBLIC_URL) is a literal IP address. A cookie Domain ` +
          "attribute has no meaning on an IP address. Use a hostname, or unset " +
          "SKRUN_SESSION_COOKIE_DOMAIN to keep a host-only cookie.",
      );
    }
    // (4a) At least one dot. Catches `localhost` and other single-label values, which
    // a browser will not accept as a cookie domain.
    if (!cookieDomain.includes(".")) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN must contain at least one dot (got "${cookieDomain}"). ` +
          "A single-label domain is not a valid cookie domain — use e.g. example.com.",
      );
    }
    // (4b) A suffix at a LABEL boundary of the canonical host. A bare endsWith would
    // accept "ample.com" for host "api.example.com", which is a different domain.
    if (canonicalHost !== cookieDomain && !canonicalHost.endsWith(`.${cookieDomain}`)) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN "${cookieDomain}" is not a suffix of the canonical host ` +
          `"${canonicalHost}" (from SKRUN_PUBLIC_URL). A browser silently drops a cookie whose ` +
          "Domain the sending host does not belong to. Expected the canonical host to be the " +
          `domain itself or one of its subdomains (e.g. api.${cookieDomain}).`,
      );
    }
    // (5) Not a public suffix. This is the rule no structural check reaches: "co.uk"
    // IS a label-boundary suffix of "api.example.co.uk", and every browser refuses a
    // cookie scoped to it. `allowPrivateDomains` is load-bearing and measured, not a
    // default copied over: without it getDomain("fly.dev") returns "fly.dev", so a
    // platform subdomain like *.fly.dev — which a browser treats exactly like a
    // public suffix — would be accepted here and then silently dropped there.
    if (getDomain(cookieDomain, { allowPrivateDomains: true }) === null) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN "${cookieDomain}" is a public suffix — no registrable domain ` +
          "sits under it. Browsers refuse a cookie scoped to a public suffix, so the session " +
          "would silently never be sent. Use the registrable domain you own (e.g. example.co.uk, " +
          "not co.uk).",
      );
    }

    // Boot accepted, and the retained domain is named. Without this line a session
    // broken by a domain the browser quietly rejects leaves no trace at all.
    startupLogger.info(
      { event: "session_cookie_domain", domain: cookieDomain, canonical_origin: canonicalOrigin },
      `Session cookie scoped to domain "${cookieDomain}" (canonical origin ${canonicalOrigin})`,
    );
  }

  // The operator's own site — where a finished sign-in returns, the sign-in page,
  // the terms, privacy and docs addresses — read and validated ONCE here, after the
  // domain it depends on. A value outside its setting's form refuses the start,
  // naming the variable: a path must already be in the normalised form it is
  // served in, an absolute address is served in its normalised form. A return path
  // without the cookie domain, or a sign-in page that would send the browser back
  // to /login, refuses it too. What is read here is what every request serves;
  // nothing reads these settings again.
  const site = readOperatorSite(process.env, { canonicalUrl, cookieDomain });

  // Dashboard (packages/web SPA) — served at /dashboard/* in api-server mode.
  // Gated by SKRUN_DASHBOARD (default on); root resolved from SKRUN_DASHBOARD_DIR
  // (absolute in the published image; cwd-relative "../web/dist" in dev).
  const dashboard = resolveDashboardConfig();
  const serveDashboard = dashboard.enabled && existsSync(dashboard.dir);
  if (dashboard.enabled && !serveDashboard) {
    warnDashboardDirMissing(dashboard.dir);
  }

  // Security headers — applied BEFORE CORS so they are present on every
  // response including CORS preflight.
  //   - X-Frame-Options: DENY (clickjacking defense; tighter than Hono default SAMEORIGIN)
  //   - HSTS: 2 years + preload (Cloudflare / browser-preload-list grade)
  //   - Cross-Origin-Resource-Policy: cross-origin so the dashboard can load
  //     /api/files/:id/content from a different host (cloud deployment).
  //   - CSP is scoped to the two HTML surfaces below: `/dashboard/*` (the SPA)
  //     and `/docs` (the API docs page, which loads one pinned third-party
  //     bundle). API JSON responses are intentionally left without CSP.
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      crossOriginResourcePolicy: "cross-origin",
    }),
  );

  // CSP scoped to `/dashboard/*` — defense-in-depth against XSS in the
  // bundled React SPA. Allows the SPA's own bundle (script-src 'self') and
  // its CSS (style-src 'self'), plus 'unsafe-inline' for the rare React
  // inline-style prop (DOM-level style attribute — minor XSS risk via
  // injected style is acceptable trade-off vs the script-src protection).
  // Same-origin only for fetch / fonts / form actions. Images: same-origin,
  // plus the ONE remote origin the SPA renders — the signed-in user's GitHub
  // avatar (`user.avatar_url`, set by the OAuth callback, shown in the header
  // and on Settings). Without it the browser blocks the avatar on every load;
  // unseen until the first real OAuth sign-in because the dev token has none.
  if (dashboard.enabled) {
    app.use(
      "/dashboard/*",
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
        },
      }),
    );
  }

  // CSP on `/docs` — the page itself is ours and carries no inline script; the
  // renderer is Scalar's browser bundle, the ONE remote script this policy allows,
  // by exact URL (version-pinned; `docs-page.ts` also pins its integrity hash).
  // `connect-src 'self'` keeps every "Try it" request — and the API key typed into
  // it — on this origin: Scalar's default relay through proxy.scalar.com cannot be
  // reached even if its configuration were changed. A bare CDN URL put back in the
  // page would be blocked here and the page would blank — visibly.
  app.use(
    "/docs",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", SCALAR_BUNDLE_URL],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    }),
  );

  // CORS — production-safe by default.
  //   - production: CORS_ORIGIN is REQUIRED (fail loud at startup if unset),
  //     no '*' wildcard allowed (per the CORS spec, '*' cannot be paired with
  //     credentials anyway).
  //   - dev / test: falls back to '*' so local pnpm dev:registry + dashboard
  //     stay frictionless.
  const corsOriginEnv = process.env.CORS_ORIGIN;
  if (process.env.NODE_ENV === "production" && !corsOriginEnv) {
    throw new Error(
      "CORS_ORIGIN env var is required when NODE_ENV=production. " +
        "Set it to a comma-separated list of allowed origins (e.g. https://app.example.com). " +
        "See .env.example.",
    );
  }
  // A browser on another origin reads only the response headers it is told it
  // may: the wait a refusal asks for, the per-address limiter's numbers, and an
  // account's quota numbers.
  app.use("*", cors({ origin: corsOriginEnv ?? "*", exposeHeaders: EXPOSED_HEADERS }));

  // CSRF on every cookie-authenticated mutation — mounted right after CORS and
  // before the rate limiters, so it runs well ahead of the routers and of
  // authMiddleware. The guard depends on no authentication decision: it only
  // looks at the shape of the request.
  //
  // Mounted on `*` and not on a route list. The selectivity already lives in the
  // guard's own predicate (no session cookie, or an Authorization header, and it
  // steps aside), so widening the path costs nothing in false positives — while a
  // list like `/api/*` + `/auth/logout` is a thing a new route silently fails to
  // join. This repo has already shipped a middleware mounted on a pattern that
  // matched no real route; a mount that cannot go stale is worth more here than
  // one that looks narrow.
  //
  // `canonicalOrigin` is the value the startup interlock above already computed —
  // createApp does not read the environment a second time.
  //
  // The OPTIONS preflight never reaches this: cors() answers it and does not call
  // on. (csrf() treats OPTIONS as safe anyway.) That is asserted, not assumed.
  app.use("*", createCsrfGuard({ canonicalOrigin }));

  // Dev-auth fail-secure interlock. SKRUN_DEV_AUTH lets any `Bearer dev-token`
  // caller act as admin, so it must never run in an untrusted context without
  // OAuth. Allowlist (not `NODE_ENV === "production"`) so an unset/garbage
  // NODE_ENV is treated as untrusted → refuse to boot. Warn (dev only) when on.
  if (isDevAuthEnabled() && !isOAuthConfigured()) {
    const nodeEnv = process.env.NODE_ENV ?? "";
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      throw new Error(
        "SKRUN_DEV_AUTH is enabled without OAuth outside development/test — anyone who " +
          "reaches this server would get admin. Configure GitHub OAuth, or only enable " +
          "SKRUN_DEV_AUTH on a trusted localhost/LAN dev host (NODE_ENV=development).",
      );
    }
    if (nodeEnv === "development") {
      console.warn(
        "[skrun] ⚠️  SKRUN_DEV_AUTH is ENABLED — any caller with `Bearer dev-token` is admin. " +
          "Use only on localhost / a trusted private network, never a public host.",
      );
    }
  }

  // Rate limiting — per-IP on mutating endpoints. The backend (in-memory for
  // self-host single-instance, Upstash Redis for multi-instance cloud)
  // is env-selected once here and shared across both routes.
  //
  // The mount patterns are the EXPLICIT route shapes, deliberately:
  // - A mid-path `*` in Hono matches exactly ONE segment, so `/api/agents/*/push`
  //   never matches the real two-segment route `/:namespace/:name/push` — the
  //   limiter would exist without ever running (measured on hono 4.13.5).
  // - A trailing star (`/api/agents/*`) would run, but it is anchored to nothing:
  //   it would drag read-only GETs and any future route under /api/agents/ into
  //   thresholds sized for writes.
  // These patterns also match `POST /api/agents/scan/:name/push` (`:namespace`
  // binds to the literal "scan") — intended: it is a push, same threshold. The
  // middleware is matched by path pattern, independently of router order
  // (measured: it runs with the scan router mounted before OR after the
  // registry router). What router order does decide is WHICH handler answers a
  // scan push — the registry router would swallow it if mounted first.
  // Each mount names its counter: on the shared store the name is the key
  // namespace; without it, every mount with the same window shares one counter.
  const makeRateLimiter = createRateLimiterFactory();
  app.use(
    "/api/agents/:namespace/:name/push",
    rateLimiter({ name: "push", windowMs: 60_000, max: 10, make: makeRateLimiter }),
  );
  app.use(
    "/api/agents/:namespace/:name/run",
    rateLimiter({ name: "run", windowMs: 60_000, max: 60, make: makeRateLimiter }),
  );
  // Device-login endpoints — per-IP. The poll is hit frequently by design
  // (interval ~5s) so a generous cap; the consent page + code mint get a tighter
  // one. Covers all of /auth/device/* plus the /device consent page.
  app.use(
    "/auth/device/*",
    rateLimiter({ name: "device-auth", windowMs: 60_000, max: 120, make: makeRateLimiter }),
  );
  app.use(
    "/device",
    rateLimiter({ name: "device-consent", windowMs: 60_000, max: 30, make: makeRateLimiter }),
  );

  // Request-body caps — one table, one cap per route that reads a body
  // (middleware/body-limit.ts): the push keeps SKRUN_PUSH_MAX_BODY_MB, an upload
  // its file limit plus framing, a run a cap derived from the inline file cap,
  // and every other route the SKRUN_MAX_BODY_MB default. Mounted once, after the
  // per-address limiters — the counter is the cheaper check — and before the
  // routers. It reads nothing itself: a declared Content-Length over the cap is
  // refused on the header, and a body without one is counted as the route reads
  // it, after the route's own checks (its authentication, where it has one).
  // The push cap bounds the COMPRESSED body; the decompression cap in
  // utils/bundle.ts bounds the EXPANDED archive after it — they coexist, neither
  // replaces the other. A malformed value of either variable refuses to start:
  // the decompression cap, read again for each bundle, is read once here first,
  // by the same reading as the body caps (`readMbSetting`).
  app.use("*", createBodyLimits(readBodyLimitConfig(process.env)));
  getMaxDecompressedBytes();
  // The module every agent.yaml is read in — a push's, a run's — is a file the
  // build copies, not one it compiles: a server built without it refuses to
  // start, naming it, rather than answer each of those a 500.
  assertAgentYamlWorkerPresent();

  // An error no route handles. An error that carries its response (hono's
  // HTTPException — the forgery guard's 403, for one) answers with it. A
  // database that did not answer in time — a statement past its bound, a
  // connection gone silent, every connection of the pool busy past the wait
  // for one, a new connection that got no answer — answers 503
  // DATABASE_TIMEOUT with a Retry-After. Anything else is the framework's own
  // default, a bare 500. What changes is the trace: that default prints the
  // whole error to stderr — its message, its stack, and whatever a database
  // driver hangs on it, any of which can quote a row. Here it is one log line
  // with the error's class and code (and, for an error nothing else answers,
  // the frames of its stack without the message), and the route's pattern,
  // never the path, which carries names.
  app.onError((err, c) => {
    // A body read past its route's cap, the error let through by the route: the
    // cap's own answer, not a 500.
    if (err instanceof RequestBodyTooLarge) {
      return c.json({ error: { code: err.code, message: err.message } }, 413);
    }
    if ("getResponse" in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }
    // Not a fault of the request: the caller may send it again a few seconds
    // later — after checking whether a change it asked for took effect, since
    // the database may have made it all the same. The line names the cause,
    // never the error's message nor what the driver hangs on it (its client,
    // and the connection string the client carries).
    const cause = databaseTimeoutCause(err);
    if (cause !== null) {
      httpLogger.error(
        {
          event: "database_timeout",
          method: c.req.method,
          route: routePath(c),
          cause,
          ...errorFields(err),
        },
        "The database did not answer in time; the request was answered 503",
      );
      return c.json(
        {
          error: {
            code: "DATABASE_TIMEOUT",
            message:
              "The database did not answer in time. Try again in a few seconds; if the request changes something, check first whether it took effect.",
          },
        },
        503,
        { "Retry-After": String(DATABASE_TIMEOUT_RETRY_AFTER_S) },
      );
    }
    httpLogger.error(
      {
        event: "unhandled_error",
        method: c.req.method,
        route: routePath(c),
        ...errorFields(err, { stack: true }),
      },
      "Unhandled error in a route",
    );
    return c.text("Internal Server Error", 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI schema + interactive docs
  app.get("/openapi.json", (c) => {
    const baseUrl = externalBaseUrl(c);
    return c.json(getOpenAPISchema(baseUrl));
  });
  app.get("/docs", (c) =>
    c.html(renderDocsPage({ specUrl: "/openapi.json", pageTitle: "Skrun API — Interactive Docs" })),
  );

  // Legacy playground redirect → dashboard (only when the dashboard is served)
  if (dashboard.enabled) {
    app.get("/playground", (c) => c.redirect("/dashboard/agents"));
    app.get("/playground/*", (c) => c.redirect("/dashboard/agents"));
  }

  app.route("", createAuthRoutes(db, authMiddleware, verificationPolicy, site, deletionJournal));
  // Deleting an account reaches both stores: the bundles on the one this app was
  // built with, a cloud run's outputs on the cloud runtime's; and, when the
  // operator keeps one, the deletion journal. Assigning a plan takes only one
  // the quota settings name.
  app.route(
    "/api",
    createAccountRoutes(
      db,
      authMiddleware,
      { bundleStorage: storage, outputStorage: flyioDeps?.storage, deletionJournal },
      { knownPlans: quotaConfig.knownPlans },
    ),
  );
  // Both push entrypoints answer to the quota settings: the server's longest
  // timeout and the account's bundle storage, checked before anything is stored.
  app.route("/api", createScanRoutes(db, authMiddleware, service, quotaConfig));
  app.route("/api", createStatsRoutes(db, authMiddleware));
  // What an account consumes, read by the account itself. The fast runs are
  // told only while the cloud runtime's pool runs: the same pool the run routes
  // give a run the right to.
  app.route("/api", createUsageRoutes(db, authMiddleware, { quotaConfig, pool: flyioDeps?.pool }));
  // The instance's own links — docs, terms, privacy — for the dashboard, from the
  // operator's site as the start read it.
  app.route("/api", createInstanceRoutes(authMiddleware, site));
  app.route(
    "/api",
    createRegistryRoutes(service, authMiddleware, db, verificationPolicy, quotaConfig),
  );
  app.route("/api", createAgentLlmKeyRoutes(db, authMiddleware, keyProvider));
  app.route(
    "/api",
    createRunRoutes(service, db, authMiddleware, {
      runtimeMode,
      flyioDeps,
      verificationPolicy,
      keyProvider,
      quotaConfig,
      primaryFailoverMs,
    }),
  );
  // The link route presigns a cloud run's outputs on the store the run uploaded
  // them to: the same dependencies as the run routes. The quota settings bound
  // an account's live uploads.
  app.route(
    "/api",
    createFilesRoutes(db, authMiddleware, {
      runtimeMode,
      storage: flyioDeps?.storage,
      quotaConfig,
    }),
  );
  // Operator-only view of the pre-warm pool. Its state is in-process memory,
  // so this route is the only way it reaches an operator.
  app.route("/api", createAdminPoolRoutes(authMiddleware, flyioDeps?.pool));

  // Dashboard static files (served from the configured SPA dir). Mounted only
  // when enabled AND the dir exists — handing serveStatic a missing root makes
  // @hono/node-server log its own error, so we guard + warn (above) instead.
  if (serveDashboard) {
    app.use(
      "/dashboard/*",
      serveStatic({
        root: dashboard.dir,
        rewriteRequestPath: (path) => path.replace("/dashboard", ""),
      }),
    );
    // The page fallback. Since @hono/node-server 2.1.3, serveStatic refuses a
    // request path that still holds a `%` once decoded; this handler lifts that
    // one check, and only here: whatever the path, it serves nothing but
    // index.html. Its other path checks still answer 404: an empty segment (`//`)
    // and an encoded backslash (`%5C`, `..%5C`). A raw backslash never gets here
    // over HTTP: @hono/node-server answers 400 before routing (since 2.1.6). Nor
    // does a plain `..` segment: the URL parser resolves it first, so
    // /dashboard/a/../agents is /dashboard/agents. The dashboard's real files,
    // above, keep every check, and answer GET and HEAD only (since 2.1.5). A
    // fixed `path` would skip all of them.
    app.get(
      "/dashboard/*",
      serveStatic({
        root: dashboard.dir,
        rewriteRequestPath: () => "/index.html",
        allowPercentInPath: true,
      }),
    );
  }

  // The cloud runtime's machine maintenance. Started here rather than inside the
  // pool's constructor: this is the one place a server is assembled, and a
  // maintenance nobody starts is silent — every run still takes a working path,
  // and the machines nobody destroys go on billing without a word. It runs
  // whatever the pool's size, 0 included: each pass reconciles the pool's
  // machines and sweeps the machines of runs, judged on their rows in this
  // database — the one thing that destroys a machine a process that died left
  // behind. It fills only a pool that keeps a stock. Started last, once every
  // check of the assembly has passed: a start refused above leaves no
  // maintenance running for whoever catches the refusal. The sweep leaves
  // unread a machine younger than the longest acquisition of a run, and a
  // started pooled machine nobody holds is spared for as long as the
  // instance's longest run may last — its longest timeout, its seat's margin
  // and the lifetime's grace, never less than the pool's default. Without a
  // longest timeout, the pool's default.
  const pool = flyioDeps?.pool;
  if (flyioDeps && pool) {
    const bounds = runAcquisitionBounds(quotaConfig, pool.enabled);
    pool.start({
      sweep: createRunMachineSweep({
        db,
        flyApi: flyioDeps.flyApi,
        pool,
        readFloorMs: bounds.acquisitionBudgetMs,
        graceMs: MACHINE_LIFETIME_GRACE_MS,
        fallbackMs: undeclaredLifetimeFallbackMs(),
      }),
      startedOrphanWindowMs:
        quotaConfig.maxTimeoutS === null
          ? DEFAULT_STARTED_ORPHAN_WINDOW_MS
          : Math.max(
              DEFAULT_STARTED_ORPHAN_WINDOW_MS,
              quotaConfig.maxTimeoutS * 1000 + bounds.seatMarginMs + MACHINE_LIFETIME_GRACE_MS,
            ),
    });
  }

  return app;
}

export type { DbAdapter } from "./db/adapter.js";
export { MemoryDb } from "./db/memory.js";
export { SqliteDb } from "./db/sqlite.js";
export { RegistryError, RegistryService } from "./services/registry.js";
export type { StorageAdapter } from "./storage/adapter.js";
export { LocalStorage } from "./storage/local.js";
export { MemoryStorage } from "./storage/memory.js";
export type {
  AgentMetadata,
  AgentVersionInfo,
  RegistryErrorResponse,
  UserContext,
} from "./types.js";
