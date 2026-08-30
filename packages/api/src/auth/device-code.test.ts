import { describe, expect, it } from "vitest";
import {
  computeExpiresIn,
  generateDeviceCode,
  generateUserCode,
  hashCode,
  issueCsrfToken,
  ttlSeconds,
  verifyCsrfToken,
} from "./device-code.js";

const USER_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

describe("device-code primitives", () => {
  it("generateUserCode matches the unambiguous XXXX-XXXX charset", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateUserCode()).toMatch(USER_CODE_RE);
    }
  });

  it("generateDeviceCode is high-entropy and unique", () => {
    const a = generateDeviceCode();
    const b = generateDeviceCode();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it("hashCode is deterministic SHA-256 hex and not the raw value", () => {
    expect(hashCode("abc")).toBe(hashCode("abc"));
    expect(hashCode("abc")).not.toBe("abc");
    expect(hashCode("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CSRF token verifies against itself and rejects mismatches/empty", () => {
    const t = issueCsrfToken();
    expect(verifyCsrfToken(t, t)).toBe(true);
    expect(verifyCsrfToken(t, issueCsrfToken())).toBe(false);
    expect(verifyCsrfToken(undefined, t)).toBe(false);
    expect(verifyCsrfToken(t, undefined)).toBe(false);
  });

  it("computeExpiresIn returns whole seconds, floored at 0", () => {
    expect(computeExpiresIn(new Date(Date.now() + 600_000).toISOString())).toBeGreaterThan(595);
    expect(computeExpiresIn(new Date(Date.now() - 1000).toISOString())).toBe(0);
  });

  it("ttlSeconds honours the env override and falls back to 600", () => {
    const prev = process.env.SKRUN_DEVICE_CODE_TTL_S;
    try {
      delete process.env.SKRUN_DEVICE_CODE_TTL_S;
      expect(ttlSeconds()).toBe(600);
      process.env.SKRUN_DEVICE_CODE_TTL_S = "120";
      expect(ttlSeconds()).toBe(120);
      process.env.SKRUN_DEVICE_CODE_TTL_S = "garbage";
      expect(ttlSeconds()).toBe(600);
    } finally {
      if (prev === undefined) delete process.env.SKRUN_DEVICE_CODE_TTL_S;
      else process.env.SKRUN_DEVICE_CODE_TTL_S = prev;
    }
  });
});
