import { describe, expect, it } from "vitest";
import { fingerprintBytes, InMemoryProviderFileCache } from "./file-cache.js";

describe("InMemoryProviderFileCache", () => {
  it("returns undefined for unknown (provider, fingerprint)", () => {
    const cache = new InMemoryProviderFileCache();
    expect(cache.get("anthropic", "abc")).toBeUndefined();
  });

  it("stores and retrieves by (provider, fingerprint)", () => {
    const cache = new InMemoryProviderFileCache();
    cache.set("anthropic", "abc", "file-1");
    expect(cache.get("anthropic", "abc")).toBe("file-1");
  });

  it("isolates entries across providers (same fingerprint, different providers)", () => {
    const cache = new InMemoryProviderFileCache();
    cache.set("anthropic", "abc", "file-anthropic");
    cache.set("openai", "abc", "file-openai");
    expect(cache.get("anthropic", "abc")).toBe("file-anthropic");
    expect(cache.get("openai", "abc")).toBe("file-openai");
  });

  it("isolates entries across fingerprints within the same provider", () => {
    const cache = new InMemoryProviderFileCache();
    cache.set("anthropic", "abc", "file-1");
    cache.set("anthropic", "def", "file-2");
    expect(cache.get("anthropic", "abc")).toBe("file-1");
    expect(cache.get("anthropic", "def")).toBe("file-2");
  });

  it("set overwrites existing value", () => {
    const cache = new InMemoryProviderFileCache();
    cache.set("anthropic", "abc", "file-1");
    cache.set("anthropic", "abc", "file-2");
    expect(cache.get("anthropic", "abc")).toBe("file-2");
  });
});

describe("fingerprintBytes", () => {
  it("returns a 64-char SHA-256 hex digest", () => {
    const fp = fingerprintBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same bytes produce same fingerprint", () => {
    const a = fingerprintBytes(new Uint8Array([1, 2, 3, 4]));
    const b = fingerprintBytes(new Uint8Array([1, 2, 3, 4]));
    expect(a).toBe(b);
  });

  it("differs for different bytes", () => {
    const a = fingerprintBytes(new Uint8Array([1, 2, 3]));
    const b = fingerprintBytes(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});
