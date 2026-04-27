import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, isApiKeyFormat } from "./api-key.js";

describe("API Key", () => {
  describe("generateApiKey", () => {
    it("returns key with sk_live_ prefix and 32 hex chars", () => {
      const { key } = generateApiKey();
      expect(key).toMatch(/^sk_live_[0-9a-f]{32}$/);
    });

    it("returns a SHA-256 hash of the key", () => {
      const { key, keyHash } = generateApiKey();
      expect(keyHash).toBe(hashApiKey(key));
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns a prefix with sk_live_ + first 8 hex chars", () => {
      const { key, keyPrefix } = generateApiKey();
      const expectedPrefix = `sk_live_${key.slice(8, 16)}`;
      expect(keyPrefix).toBe(expectedPrefix);
    });

    it("generates unique keys", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(a.key).not.toBe(b.key);
      expect(a.keyHash).not.toBe(b.keyHash);
    });
  });

  describe("hashApiKey", () => {
    // Note: these inputs intentionally avoid the literal `sk_live_` prefix
    // so GitHub secret scanning does not match them as Stripe live keys.
    // hashApiKey is format-agnostic — any string works.
    it("is deterministic", () => {
      const key = "test-input-deterministic-fixture";
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it("returns 64-char hex string (SHA-256)", () => {
      const hash = hashApiKey("test-input-sha256-fixture");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("different keys produce different hashes", () => {
      const a = hashApiKey("test-input-fixture-a");
      const b = hashApiKey("test-input-fixture-b");
      expect(a).not.toBe(b);
    });
  });

  describe("isApiKeyFormat", () => {
    it("accepts valid API key", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(key)).toBe(true);
    });

    it("rejects key without prefix", () => {
      expect(isApiKeyFormat("abcdef1234567890abcdef1234567890")).toBe(false);
    });

    it("rejects key with wrong prefix", () => {
      expect(isApiKeyFormat("sk_test_abcdef1234567890abcdef1234567890")).toBe(false);
    });

    it("rejects key that is too short", () => {
      expect(isApiKeyFormat("sk_live_abcdef")).toBe(false);
    });

    it("rejects key with non-hex characters", () => {
      // Special chars break the Stripe live-key pattern that GitHub scans for,
      // while still exercising the hex validation in isApiKeyFormat.
      expect(isApiKeyFormat("sk_live_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isApiKeyFormat("")).toBe(false);
    });

    it("rejects dev-token", () => {
      expect(isApiKeyFormat("dev-token")).toBe(false);
    });
  });
});
