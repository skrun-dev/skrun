/**
 * GitHub-signup allowlist (operator opt-in).
 *
 * `SKRUN_ALLOWED_GITHUB_USERS` restricts who may create an account / log in via
 * GitHub OAuth — for a curated closed beta or a private self-host instance. It is
 * the **inverse default** of `dev-auth.ts`: **unset / empty = open** (public signup
 * is the intended cloud default, not a vuln). When set, only listed accounts pass
 * the gate in the OAuth callback (every login, web + device).
 *
 *   SKRUN_ALLOWED_GITHUB_USERS   comma-separated; each entry (trimmed + lowercased):
 *                                - a username  → matched against `login`, or
 *                                - `id:NNN`    → matched against the immutable id.
 *                                unset / empty / whitespace / only-blank = open (allow all).
 *
 * A GitHub username can never contain `:` (`[a-z0-9-]` only), so there is no
 * username/`id:` collision. A malformed `id:` entry (blank or non-numeric suffix —
 * `id:` / `id:abc`) is a **no-match** (never a silent dead entry); the operator is
 * warned at boot — see {@link getMalformedAllowlistEntries}.
 *
 * Pure module (no Hono / no fs / no logger / no throw) so every branch is
 * unit-testable in isolation, mirroring `dev-auth.ts`.
 */

/** The subset of a GitHub profile the allowlist matches on. */
type GithubIdentity = { id: number; login: string };

type ParsedAllowlist = {
  /** Lowercased usernames. */
  usernames: string[];
  /** Numeric id strings (the suffix of a valid `id:NNN` entry). */
  ids: string[];
  /** Raw entries that started with `id:` but had a blank/non-numeric suffix. */
  malformed: string[];
};

/** Parse the raw env value into username / id / malformed buckets. Pure. */
function parseAllowlist(raw: string | undefined): ParsedAllowlist {
  const usernames: string[] = [];
  const ids: string[] = [];
  const malformed: string[] = [];
  if (!raw) return { usernames, ids, malformed };

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue; // blank entry — ignored
    const entry = trimmed.toLowerCase();
    if (entry.startsWith("id:")) {
      const id = entry.slice(3);
      if (id.length > 0 && /^\d+$/.test(id)) ids.push(id);
      else malformed.push(trimmed); // `id:` / `id:abc` — surfaced, never silent
    } else {
      usernames.push(entry);
    }
  }
  return { usernames, ids, malformed };
}

/**
 * Whether a GitHub identity may create an account / log in on this instance.
 *
 * **Open by default**: when nothing is listed (unset / empty / whitespace /
 * only-blank entries) every identity is allowed. Once at least one entry of any
 * kind is present the gate **enforces** — a list of only malformed entries matches
 * no one (fail-closed on misconfiguration; the boot warning explains why).
 */
export function isGithubUserAllowed(
  ghUser: GithubIdentity,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const { usernames, ids, malformed } = parseAllowlist(env.SKRUN_ALLOWED_GITHUB_USERS);
  // Nothing listed at all → open (feature off).
  if (usernames.length === 0 && ids.length === 0 && malformed.length === 0) return true;
  // Enforcing: match username (case-insensitive) or the immutable id.
  if (usernames.includes(ghUser.login.toLowerCase())) return true;
  if (ids.includes(String(ghUser.id))) return true;
  return false;
}

/**
 * The malformed `id:` entries (blank / non-numeric suffix) in the current config,
 * for a one-time boot warning. Empty when the config is clean. Pure (no logging) —
 * the caller logs, keeping this module side-effect-free.
 */
export function getMalformedAllowlistEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAllowlist(env.SKRUN_ALLOWED_GITHUB_USERS).malformed;
}
