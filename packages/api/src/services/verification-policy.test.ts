import { describe, expect, it } from "vitest";
import {
  canSetVerified,
  isRunGatedByVerification,
  readVerificationPolicy,
  type VerificationPolicy,
  verificationKind,
} from "./verification-policy.js";

describe("readVerificationPolicy (VT-1)", () => {
  it("defaults to admin when unset or empty", () => {
    expect(readVerificationPolicy({})).toBe("admin");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "" })).toBe("admin");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "   " })).toBe("admin");
  });

  it("parses each valid value (case-insensitive, trimmed)", () => {
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "admin" })).toBe("admin");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "owner" })).toBe("owner");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "disabled" })).toBe("disabled");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "OWNER" })).toBe("owner");
    expect(readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "  Disabled  " })).toBe("disabled");
  });

  it("throws on any other value (fail-fast at boot)", () => {
    expect(() => readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "bogus" })).toThrow(
      /Invalid SKRUN_VERIFICATION_POLICY/,
    );
    expect(() => readVerificationPolicy({ SKRUN_VERIFICATION_POLICY: "off" })).toThrow();
  });
});

describe("isRunGatedByVerification (VT-2)", () => {
  const cases: Array<[VerificationPolicy, boolean, boolean]> = [
    // [policy, verified, expectedGated]
    ["admin", false, true], // admin: unverified is gated
    ["admin", true, false], // admin: verified runs
    ["owner", false, false], // owner: never gates (owner authority + isolation)
    ["owner", true, false],
    ["disabled", false, false], // disabled: never gates
    ["disabled", true, false],
  ];

  for (const [policy, verified, expected] of cases) {
    it(`policy=${policy} verified=${verified} -> gated=${expected}`, () => {
      expect(isRunGatedByVerification(policy, verified)).toBe(expected);
    });
  }
});

describe("canSetVerified (VT-3)", () => {
  const owner = { id: "u-owner", role: "user" as const };
  const stranger = { id: "u-stranger", role: "user" as const };
  const admin = { id: "u-admin", role: "admin" as const };
  const agent = { owner_id: "u-owner" };

  // [policy, user, expected]
  const cases: Array<[VerificationPolicy, typeof owner, boolean]> = [
    // admin policy: admin-only
    ["admin", admin, true],
    ["admin", owner, false],
    ["admin", stranger, false],
    // owner policy: owner or admin
    ["owner", admin, true],
    ["owner", owner, true],
    ["owner", stranger, false],
    // disabled policy: same authority as owner (owner or admin)
    ["disabled", admin, true],
    ["disabled", owner, true],
    ["disabled", stranger, false],
  ];

  for (const [policy, user, expected] of cases) {
    it(`policy=${policy} user=${user.role}/${user.id === agent.owner_id ? "owner" : "other"} -> ${expected}`, () => {
      expect(canSetVerified(policy, user, agent)).toBe(expected);
    });
  }
});

describe("verificationKind (tie-break: admin wins)", () => {
  it("returns admin for an instance admin (even if they own the agent)", () => {
    expect(verificationKind({ role: "admin" })).toBe("admin");
  });

  it("returns owner_self for a non-admin (necessarily the owner)", () => {
    expect(verificationKind({ role: "user" })).toBe("owner_self");
  });
});
