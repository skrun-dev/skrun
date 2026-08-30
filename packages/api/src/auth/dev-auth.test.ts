import { describe, expect, it } from "vitest";
import { isDevAuthEnabled } from "./dev-auth.js";

describe("isDevAuthEnabled (VT-7)", () => {
  it("enables on 1/true/on/yes (case-insensitive, trimmed)", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", "On", "YES", " yes "]) {
      expect(isDevAuthEnabled({ SKRUN_DEV_AUTH: v })).toBe(true);
    }
  });

  it("stays OFF for unset / empty / 0 / false / off / anything else (fail-secure)", () => {
    expect(isDevAuthEnabled({})).toBe(false);
    for (const v of ["", " ", "0", "false", "off", "no", "nope", "2", "enabled"]) {
      expect(isDevAuthEnabled({ SKRUN_DEV_AUTH: v })).toBe(false);
    }
  });
});
