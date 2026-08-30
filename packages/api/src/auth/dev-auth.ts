/**
 * Dev-token auth gate (fail-secure).
 *
 * The api accepts a Bearer `dev-token` (any non-`sk_live_` bearer) as an admin
 * shortcut for local development / CI. It is **off unless `SKRUN_DEV_AUTH` is
 * explicitly enabled** — because enabling it grants admin to anyone who can
 * reach the server, so it must only be used on localhost / a trusted LAN, never
 * a public host. `createApp` additionally refuses to boot if this is enabled
 * outside `development`/`test` without OAuth configured (see `index.ts`).
 *
 *   SKRUN_DEV_AUTH   off (default) | on — `1`/`true`/`on`/`yes` (case-insensitive)
 *                    enable it; unset / empty / `0`/`false`/`off` / anything
 *                    else keeps it off.
 *
 * Pure module (no Hono / no fs) so the parsing is unit-testable in isolation.
 */

/** Values (case-insensitive) that enable dev-token auth. Default is OFF. */
const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * Whether the dev-token admin shortcut is enabled. Fail-secure: returns `false`
 * unless `SKRUN_DEV_AUTH` is explicitly set to a truthy value.
 */
export function isDevAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SKRUN_DEV_AUTH?.trim().toLowerCase();
  return flag !== undefined && ENABLED_VALUES.has(flag);
}
