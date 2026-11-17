/**
 * Default lifetime of a key minted by the CLI login flow.
 *
 * A key that never expires is a credential that outlives the laptop it was
 * copied onto. The login flow can afford a default because re-running `skrun
 * login` costs one command; keys minted through the API cannot, so they get no
 * default at all (a delegated key handed to a client would break on the day the
 * default ran out, with nothing in the caller's own configuration to explain
 * it). That asymmetry is deliberate — this module is only for the login path.
 *
 * `SKRUN_API_KEY_TTL_DAYS` lets an operator pick the window; `0` means "no
 * expiry", an explicit gesture rather than a magic string. A malformed or
 * negative value falls back to the default rather than silently disabling the
 * expiry: fail-closed on the side that keeps the credential short-lived. A
 * window past `MAX_API_KEY_TTL_DAYS` is read as that bound.
 */

/** Days a login-minted key stays valid when the operator sets nothing. */
export const DEFAULT_API_KEY_TTL_DAYS = 90;

/**
 * The longest window `SKRUN_API_KEY_TTL_DAYS` can set: 36 500 days, a hundred
 * years. A bound on the date, not a policy, and a margin, not the breaking
 * point: a hundred years keep the expiry far from both limits of its ISO form.
 * Past year 9999 the string grows a sign and two more digits, and past about
 * year 275760 it is no date at all — minting the key would throw, and the
 * login with it. `0` is not a window, and stays "no expiry".
 */
const MAX_API_KEY_TTL_DAYS = 36_500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve the `expires_at` a login-minted key should carry, as an ISO-8601
 * instant — or `undefined` when the operator disabled expiry with `0`.
 */
export function resolveDefaultKeyExpiry(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const days = resolveTtlDays(env);
  if (days === 0) return undefined;
  return new Date(now.getTime() + days * MS_PER_DAY).toISOString();
}

function resolveTtlDays(env: NodeJS.ProcessEnv): number {
  const raw = env.SKRUN_API_KEY_TTL_DAYS?.trim();
  if (!raw) return DEFAULT_API_KEY_TTL_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_API_KEY_TTL_DAYS;
  return Math.min(parsed, MAX_API_KEY_TTL_DAYS);
}
