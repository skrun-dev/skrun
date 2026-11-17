/**
 * Test-support module, not a test file: the pieces of a GitHub sign-in that
 * several test files drive the same way — a GitHub that answers or fails, the
 * start of a login, the callback as the browser reaches it, the session cookie
 * the callback sets, and the environment a test changes and must put back.
 *
 * The two GitHub fakes replace the global `fetch` (`vi.stubGlobal`): a file that
 * uses them calls `vi.unstubAllGlobals()` in its `afterEach`. Nothing here mocks
 * a module — `vi.mock` is hoisted to the top of the file that calls it, so a file
 * that reads the log keeps its own.
 */
import type { Hono } from "hono";
import { vi } from "vitest";

/** The message of a failed token exchange: a string nothing else produces. */
export const GITHUB_EXCHANGE_FAILURE = "github-exchange-failure-3c9d1e-never-shown-to-a-browser";

/** GitHub's token and profile endpoints, both answering, for one identity. */
export function stubGithubOk(gh: { id: number; login: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const body = url.includes("access_token")
        ? { access_token: "tok" }
        : { id: gh.id, login: gh.login, email: null };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

/** A token exchange that throws, with `GITHUB_EXCHANGE_FAILURE` for its message. */
export function stubGithubThrows(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(GITHUB_EXCHANGE_FAILURE)));
}

/**
 * Starts a login: the `state` GitHub would hand back, and the state cookie the
 * browser now holds, as a `Cookie` header pair. Throws when `/auth/github` does
 * not redirect — OAuth is not configured for the app under test.
 */
export async function beginLogin(app: Hono): Promise<{ state: string; cookie: string }> {
  const res = await app.request("/auth/github", { redirect: "manual" });
  const location = res.headers.get("Location");
  if (!location) throw new Error("no Location on /auth/github — OAuth not configured?");
  return {
    state: new URL(location).searchParams.get("state") ?? "",
    cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
  };
}

/** The callback as the browser reaches it: this query, this cookie header, no redirect followed. */
export async function callback(
  app: Hono,
  query: string,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(`/auth/github/callback${query}`, {
    headers: { Cookie: cookie, ...headers },
    redirect: "manual",
  });
}

/**
 * Records the given environment names now, and returns the function that puts
 * each one back — unset again if it was unset. Call it before the test changes
 * anything, and the returned function once the test is done.
 */
export function withEnv(keys: readonly string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The `Set-Cookie` line that sets the session cookie, whatever its prefix, or
 * `undefined` when the response sets none. An erasure (an empty value) is not a
 * session cookie being set, so it is never the one returned.
 */
export function sessionCookieFrom(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((line) => /^(?:__Secure-|__Host-)?skrun_session=[^;]/.test(line));
}
