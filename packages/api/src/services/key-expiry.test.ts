import { describe, expect, it } from "vitest";
import { DEFAULT_API_KEY_TTL_DAYS, resolveDefaultKeyExpiry } from "./key-expiry.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function daysBetween(iso: string): number {
  return (new Date(iso).getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
}

describe("key-expiry: resolveDefaultKeyExpiry", () => {
  it("defaults to 90 days out when the operator sets nothing", () => {
    const iso = resolveDefaultKeyExpiry(NOW, {});
    expect(iso).toBeDefined();
    expect(daysBetween(iso as string)).toBe(DEFAULT_API_KEY_TTL_DAYS);
    expect(DEFAULT_API_KEY_TTL_DAYS).toBe(90);
  });

  it("honours the configured number of days", () => {
    const iso = resolveDefaultKeyExpiry(NOW, { SKRUN_API_KEY_TTL_DAYS: "30" });
    expect(daysBetween(iso as string)).toBe(30);
  });

  it("0 means no expiry — an explicit operator gesture", () => {
    expect(resolveDefaultKeyExpiry(NOW, { SKRUN_API_KEY_TTL_DAYS: "0" })).toBeUndefined();
  });

  it("a malformed or negative value falls back to the default, never to no expiry", () => {
    for (const raw of ["", "   ", "not-a-number", "-1"]) {
      const iso = resolveDefaultKeyExpiry(NOW, { SKRUN_API_KEY_TTL_DAYS: raw });
      expect(iso, `raw=${JSON.stringify(raw)}`).toBeDefined();
      expect(daysBetween(iso as string)).toBe(DEFAULT_API_KEY_TTL_DAYS);
    }
  });

  it("returns an ISO-8601 instant, which is what the database column stores", () => {
    const iso = resolveDefaultKeyExpiry(NOW, {}) as string;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
