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
      // biome-ignore lint/performance/noDelete: must truly remove env vars
      delete process.env.GITHUB_CLIENT_ID;
      process.env.GITHUB_CLIENT_SECRET = "secret456";
      expect(isOAuthConfigured()).toBe(false);
    });

    it("returns false when CLIENT_SECRET is missing", () => {
      process.env.GITHUB_CLIENT_ID = "id123";
      // biome-ignore lint/performance/noDelete: must truly remove env vars
      delete process.env.GITHUB_CLIENT_SECRET;
      expect(isOAuthConfigured()).toBe(false);
    });

    it("returns false when both are missing", () => {
      // biome-ignore lint/performance/noDelete: must truly remove env vars
      delete process.env.GITHUB_CLIENT_ID;
      // biome-ignore lint/performance/noDelete: must truly remove env vars
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
  });
});
