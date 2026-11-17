/**
 * The name a new account is given — its namespace, stored in `users.username`.
 *
 * By default it is the GitHub login in lowercase. When that name is taken,
 * the account gets `<base>--N`, N = 2, 3, … up to the first free one. GitHub
 * does not allow consecutive hyphens in a login, and `namespaceBase` merges
 * them, so a derived name is never the default name of another login.
 * Availability is still checked by the adapter, for older accounts created
 * before these rules.
 *
 * An existing account is never renamed: neither when its GitHub login
 * changes nor by a derivation. The name is chosen once, at creation, by
 * `DbAdapter.createOAuthUser`, which reads and inserts in one step.
 */

/** The longest namespace the agent routes accept. */
export const NAMESPACE_MAX_LENGTH = 64;

/**
 * The shape of one segment of an agent's address — its namespace or its name —
 * that every agent route accepts (`routes/registry.ts`, `routes/scan.ts`,
 * `routes/agent-llm-keys.ts`), and that a namespace must have for an account
 * deletion to sweep its storage folder (`services/account-deletion.ts`). One
 * definition: the four used to be copies.
 */
export const PATH_SEGMENT_REGEX = /^[a-z0-9-]{1,64}$/;

/**
 * How many names `createOAuthUser` tries before giving up: the base, then
 * `--2` … `--1000`. Past it, the sign-in fails with `NamespaceUnavailableError`.
 */
export const NAMESPACE_MAX_ATTEMPTS = 1000;

/** What a login with nothing usable left after sanitizing becomes. */
const EMPTY_LOGIN_FALLBACK = "user";

/**
 * The default namespace for a GitHub login: lowercase, every character
 * outside `[a-z0-9-]` replaced by a hyphen, consecutive hyphens merged,
 * leading and trailing hyphens removed, truncated to 64 characters; an empty
 * result becomes `user`.
 *
 * The output always matches `^[a-z0-9-]{1,64}$`, the path-segment rule every
 * agent route applies to a namespace (`routes/registry.ts`). Two logins can
 * share a base (`a_b` and `a-b`): the first account created takes it, the
 * next one gets a derived name.
 */
export function namespaceBase(login: string): string {
  const sanitized = login
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = sanitized.slice(0, NAMESPACE_MAX_LENGTH).replace(/-+$/, "");
  return truncated.length > 0 ? truncated : EMPTY_LOGIN_FALLBACK;
}

/**
 * The name tried at attempt `n`: the base itself at `n = 1`, `<base>--<n>`
 * from `n = 2`. The base is truncated so the result fits in 64 characters,
 * and never left ending in a hyphen (which would make three in a row).
 */
export function derivedNamespace(base: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`namespace attempt must be a positive integer, got ${n}`);
  }
  if (n === 1) return base;
  const suffix = `--${n}`;
  const head = base.slice(0, NAMESPACE_MAX_LENGTH - suffix.length).replace(/-+$/, "");
  return `${head.length > 0 ? head : EMPTY_LOGIN_FALLBACK}${suffix}`;
}

/**
 * Every candidate name was taken. Carries no login: the message names only
 * the bound, so it can be logged as is.
 */
export class NamespaceUnavailableError extends Error {
  readonly code = "NAMESPACE_UNAVAILABLE";

  constructor(attempts: number) {
    super(`no free namespace after ${attempts} attempts`);
    this.name = "NamespaceUnavailableError";
  }
}
