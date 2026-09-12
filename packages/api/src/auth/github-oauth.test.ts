import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForToken,
  fetchGithubUser,
  getGithubAuthUrl,
  isOAuthConfigured,
} from "./github-oauth.js";

describe("GitHub OAuth", () => {
  describe("isOAuthConfigured", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns true when both env vars are set", () => {
      process.env.GITHUB_CLIENT_ID = "id123";
      process.env.GITHUB_CLIENT_SECRET = "secret456";
      expect(isOAuthConfigured()).toBe(true);
    });

    it("returns false when CLIENT_ID is missing", () => {
      delete process.env.GITHUB_CLIENT_ID;
      process.env.GITHUB_CLIENT_SECRET = "secret456";
      expect(isOAuthConfigured()).toBe(false);
    });

    it("returns false when CLIENT_SECRET is missing", () => {
      process.env.GITHUB_CLIENT_ID = "id123";
      delete process.env.GITHUB_CLIENT_SECRET;
      expect(isOAuthConfigured()).toBe(false);
    });

    it("returns false when both are missing", () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      expect(isOAuthConfigured()).toBe(false);
    });
  });

  describe("getGithubAuthUrl", () => {
    it("builds correct URL with all params", () => {
      const url = getGithubAuthUrl(
        "my-client-id",
        "http://localhost:4000/auth/github/callback",
        "abc123",
      );
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://github.com");
      expect(parsed.pathname).toBe("/login/oauth/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("my-client-id");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "http://localhost:4000/auth/github/callback",
      );
      expect(parsed.searchParams.get("state")).toBe("abc123");
      expect(parsed.searchParams.get("scope")).toBe("read:user user:email");
    });
  });

  describe("exchangeCodeForToken", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends POST and returns access token", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_token123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const token = await exchangeCodeForToken("client-id", "client-secret", "code-123");
      expect(token).toBe("gho_token123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://github.com/login/oauth/access_token",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Accept: "application/json" }),
        }),
      );
    });

    it("throws on HTTP error", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      await expect(exchangeCodeForToken("a", "b", "c")).rejects.toThrow("token exchange failed");
    });

    it("throws on error response from GitHub", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad_verification_code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(exchangeCodeForToken("a", "b", "bad-code")).rejects.toThrow(
        "bad_verification_code",
      );
    });
  });

  describe("fetchGithubUser", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns user profile", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: "alice",
            email: "alice@example.com",
            avatar_url: "https://avatars.githubusercontent.com/u/12345",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const user = await fetchGithubUser("gho_token123");
      expect(user).toEqual({
        id: 12345,
        login: "alice",
        email: "alice@example.com",
        avatar_url: "https://avatars.githubusercontent.com/u/12345",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer gho_token123" }),
        }),
      );
    });

    it("throws on HTTP error", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

      await expect(fetchGithubUser("bad-token")).rejects.toThrow("user fetch failed");
    });

    // DT-17 branch (a). `GET /user` returns the PUBLIC profile address and null
    // when the user keeps theirs private — a common default — so for an unknown
    // share of accounts it is empty. These pin that /user/emails is consulted,
    // that only verified addresses are accepted, and that no failure of the extra
    // call can cost a user their login.
    //
    // Routed by URL rather than by call order: the order is an implementation
    // detail and a test that encodes it breaks on a harmless refactor.
    function routeFetch(routes: Record<string, Response | (() => never)>): void {
      vi.mocked(fetch).mockImplementation(((url: string) => {
        const hit = routes[String(url)];
        if (!hit) return Promise.resolve(new Response("not routed", { status: 404 }));
        if (typeof hit === "function") return Promise.reject(new Error("network down"));
        return Promise.resolve(hit.clone());
      }) as unknown as typeof fetch);
    }

    const profile = (email: string | null) =>
      new Response(
        JSON.stringify({ id: 1, login: "alice", email, avatar_url: "https://avatars/1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const emails = (list: unknown) =>
      new Response(JSON.stringify(list), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    it("uses the primary verified address, even when the profile exposes another", async () => {
      routeFetch({
        "https://api.github.com/user": profile("public@example.com"),
        "https://api.github.com/user/emails": emails([
          { email: "other@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ]),
      });

      const user = await fetchGithubUser("gho_x");
      expect(user.email).toBe("primary@example.com");
    });

    it("finds an address for a user whose profile email is private", async () => {
      // The case the whole change exists for: /user gives null, and without the
      // second call this account would have no address at all.
      routeFetch({
        "https://api.github.com/user": profile(null),
        "https://api.github.com/user/emails": emails([
          { email: "hidden@example.com", primary: true, verified: true },
        ]),
      });

      expect((await fetchGithubUser("gho_x")).email).toBe("hidden@example.com");
    });

    it("never accepts an unverified address", async () => {
      // Worse than none: account recovery is the reason to collect this, and
      // recovering onto an address GitHub has not confirmed defeats it.
      routeFetch({
        "https://api.github.com/user": profile(null),
        "https://api.github.com/user/emails": emails([
          { email: "unverified@example.com", primary: true, verified: false },
        ]),
      });

      expect((await fetchGithubUser("gho_x")).email).toBeNull();
    });

    it("takes a verified non-primary address when no primary is verified", async () => {
      routeFetch({
        "https://api.github.com/user": profile(null),
        "https://api.github.com/user/emails": emails([
          { email: "unverified@example.com", primary: true, verified: false },
          { email: "secondary@example.com", primary: false, verified: true },
        ]),
      });

      expect((await fetchGithubUser("gho_x")).email).toBe("secondary@example.com");
    });

    it("falls back to the profile address when the scope is missing (403)", async () => {
      // A token minted before we requested user:email still logs in.
      routeFetch({
        "https://api.github.com/user": profile("public@example.com"),
        "https://api.github.com/user/emails": new Response("Forbidden", { status: 403 }),
      });

      expect((await fetchGithubUser("gho_x")).email).toBe("public@example.com");
    });

    it("still signs the user in when the emails call throws", async () => {
      routeFetch({
        "https://api.github.com/user": profile("public@example.com"),
        "https://api.github.com/user/emails": () => {
          throw new Error("unreachable");
        },
      });

      const user = await fetchGithubUser("gho_x");
      expect(user.login).toBe("alice");
      expect(user.email).toBe("public@example.com");
    });

    it("returns null when neither source has an address", async () => {
      routeFetch({
        "https://api.github.com/user": profile(null),
        "https://api.github.com/user/emails": emails([]),
      });

      expect((await fetchGithubUser("gho_x")).email).toBeNull();
    });
  });
});
