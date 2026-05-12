import { describe, expect, it } from "vitest";
import { hashCacheKey } from "./cache-key.js";

describe("hashCacheKey", () => {
  it("produces a 64-character hex digest", () => {
    const key = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    const b = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    expect(a).toBe(b);
  });

  it("produces different outputs for different agent names", () => {
    const a = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    const b = hashCacheKey("acme/bar", "1.2.3", "prod-us");
    expect(a).not.toBe(b);
  });

  it("produces different outputs for different agent versions", () => {
    const a = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    const b = hashCacheKey("acme/foo", "1.2.4", "prod-us");
    expect(a).not.toBe(b);
  });

  it("produces different outputs for different environment ids", () => {
    const a = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    const b = hashCacheKey("acme/foo", "1.2.3", "prod-eu");
    expect(a).not.toBe(b);
  });

  // VT-5d (peer-review C1) — special characters in agent name (slashes) and
  // version (dots, dashes, plus) produce alphanumeric-only hex output. No
  // `/`, `@`, `+`, `.`, `-` in the hashed key — safe for HTTP headers
  // (x-grok-conv-id) and JSON body fields (prompt_cache_key) across all
  // providers.
  it("VT-5d: agent name with slash + version with dots/dashes/plus → alphanumeric-only output", () => {
    const key = hashCacheKey("dev/my-agent", "1.0.0-beta+build.42", "prod-us");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("/");
    expect(key).not.toContain("@");
    expect(key).not.toContain("+");
    expect(key).not.toContain(".");
    expect(key).not.toContain("-");
  });

  it("VT-5d: empty strings still produce a valid hex digest (degenerate but safe)", () => {
    const key = hashCacheKey("", "", "");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  // Catches accidental regressions where a future maintainer "optimizes"
  // the helper to skip hashing for short inputs. The whole point is that
  // the OUTPUT length and character set must be invariant.
  it("output length is always 64 regardless of input length", () => {
    const short = hashCacheKey("a", "b", "c");
    const long = hashCacheKey(
      "very-long-agent-name-that-goes-on-and-on/sub-namespace",
      "100.200.300-rc.999+build.12345",
      "very-long-environment-identifier-string",
    );
    expect(short).toHaveLength(64);
    expect(long).toHaveLength(64);
  });

  // Locks in a specific known output for a representative input. Catches
  // the rare regression where someone changes the concatenation order or
  // separators (which would invalidate everyone's existing caches).
  it("known fixture: hashCacheKey('acme/foo', '1.2.3', 'prod-us') is stable", () => {
    const key = hashCacheKey("acme/foo", "1.2.3", "prod-us");
    // Computed via: echo -n 'acme/foo@1.2.3+prod-us' | sha256sum
    expect(key).toBe("a5c5838c616f8b19a96730d15b97c46fb962d29834f4f09306099aaa120f974c");
  });
});
