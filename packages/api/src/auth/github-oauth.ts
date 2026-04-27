const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const OAUTH_SCOPE = "read:user user:email";

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
 * Fetch the authenticated user's GitHub profile.
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
    email: data.email,
    avatar_url: data.avatar_url,
  };
}
