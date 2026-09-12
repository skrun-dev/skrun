const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const OAUTH_SCOPE = "read:user user:email";

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
}

/**
 * Check if GitHub OAuth is configured via environment variables.
 */
export function isOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

/**
 * Build the GitHub OAuth authorization URL.
 */
export function getGithubAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for an access token.
 */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub token exchange error: ${data.error ?? "no access_token in response"}`);
  }

  return data.access_token;
}

/**
 * The user's primary VERIFIED e-mail address, or null.
 *
 * Exported for tests. `GET /user` only ever carries the address a user chose to
 * show on their public profile, and `null` when they keep it private — a common
 * default — so for an unknown share of accounts it is the only field we read and
 * it is empty. `GET /user/emails` is what the `user:email` scope we already
 * request exists to serve, and it is the only way to obtain an address for those
 * accounts.
 *
 * **Verified only.** An unverified address is worse than none: account recovery
 * is the reason this is collected at all, and recovering onto an address whose
 * ownership GitHub has not confirmed defeats the purpose.
 *
 * **Best-effort by design.** The address serves recovery and security notices,
 * not signing in. A token minted before this scope was requested, a GitHub App
 * without it, a rate limit — none of those should cost the user their login, so
 * every failure path returns null and lets the caller fall back.
 */
export async function fetchPrimaryVerifiedEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;

    const emails = (await res.json()) as GitHubEmail[];
    if (!Array.isArray(emails)) return null;

    const verified = emails.filter(
      (e) => e?.verified === true && typeof e.email === "string" && e.email.length > 0,
    );
    // Primary first; any other verified address is still better than nothing.
    return verified.find((e) => e.primary === true)?.email ?? verified[0]?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the authenticated user's GitHub profile.
 *
 * The address comes from `/user/emails` when available and falls back to the
 * public profile one — see `fetchPrimaryVerifiedEmail` for why the extra call
 * exists and why it never throws.
 */
export async function fetchGithubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub user fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as GitHubUser;
  return {
    id: data.id,
    login: data.login,
    email: (await fetchPrimaryVerifiedEmail(accessToken)) ?? data.email ?? null,
    avatar_url: data.avatar_url,
  };
}
