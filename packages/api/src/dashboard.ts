/**
 * Dashboard serving configuration for the api-server.
 *
 * The operator dashboard (`packages/web`, a Vite SPA) is served by the
 * api-server at `/dashboard/*`. Two env knobs control it:
 *
 *   SKRUN_DASHBOARD      `on` (default) | `off` — set to `off`/`false`/`0`
 *                        (case-insensitive) to disable the dashboard route
 *                        entirely (headless API deployment).
 *   SKRUN_DASHBOARD_DIR  filesystem path to the built SPA (`web/dist`). The
 *                        published image sets this to an absolute path
 *                        (`/opt/skrun-web/dist`); when unset it falls back to
 *                        the cwd-relative `../web/dist` so `pnpm dev:registry`
 *                        (cwd = `packages/api`) keeps serving the dashboard
 *                        unchanged.
 *
 * Pure module (no Hono / no fs) so the parsing is unit-testable in isolation.
 * The caller (`index.ts`) is responsible for the on-disk existence check.
 */

/** Values (case-insensitive) that turn the dashboard off. */
const DISABLED_VALUES = new Set(["off", "false", "0"]);

/** Default dashboard root, relative to `process.cwd()` (preserves dev). */
const DEFAULT_DASHBOARD_DIR = "../web/dist";

export interface DashboardConfig {
  /** Whether the `/dashboard/*` route + CSP + `/playground` redirects mount. */
  enabled: boolean;
  /** Filesystem path the SPA is served from. */
  dir: string;
}

/**
 * Resolve the dashboard config from the environment. Default: enabled, served
 * from `../web/dist`. Disabled only when `SKRUN_DASHBOARD` is `off`/`false`/`0`.
 */
export function resolveDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const flag = env.SKRUN_DASHBOARD?.trim().toLowerCase();
  const enabled = flag === undefined || flag === "" ? true : !DISABLED_VALUES.has(flag);
  const dir = env.SKRUN_DASHBOARD_DIR ?? DEFAULT_DASHBOARD_DIR;
  return { enabled, dir };
}

/**
 * Log a one-line warning that the dashboard is enabled but its directory is
 * absent. Non-fatal — the api-server (and `POST /run`) must boot regardless of
 * the dashboard. The caller decides when to invoke this (see `index.ts`).
 */
export function warnDashboardDirMissing(dir: string): void {
  console.warn(
    `[skrun] SKRUN_DASHBOARD is enabled but the dashboard directory was not found: ${dir}. ` +
      "The /dashboard route will 404. Point SKRUN_DASHBOARD_DIR at the built web/dist, " +
      "or set SKRUN_DASHBOARD=off to silence this.",
  );
}
