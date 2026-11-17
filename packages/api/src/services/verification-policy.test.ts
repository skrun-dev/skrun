import { describe, expect, it } from "vitest";
import type { KeyContext, UserContext } from "../types.js";
import {
  canSetVerified,
  isRunGatedByVerification,
  readVerificationPolicy,
  VERIFICATION_POLICIES,
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
  type Who = Pick<UserContext, "id" | "role" | "key">;
  const owner: Who = { id: "u-owner", role: "user", key: null };
  const stranger: Who = { id: "u-stranger", role: "user", key: null };
  const admin: Who = { id: "u-admin", role: "admin", key: null };
  const agent = { owner_id: "u-owner" };

  // [policy, user, expected]
  const cases: Array<[VerificationPolicy, Who, boolean]> = [
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

  // The administrator's authority is carried by a master credential, never by
  // the role alone: a key the administrator reduced or delegated is held to the
  // policy like the same key of any other account.
  const reduced: KeyContext = {
    id: "k-reduced",
    scope_kind: "account",
    operations: ["agent:verify"],
    agent_ids: [],
  };
  const delegated: KeyContext = {
    id: "k-delegated",
    scope_kind: "agents",
    operations: ["agent:run", "agent:push", "agent:verify"],
    agent_ids: ["a-1"],
  };
  for (const key of [reduced, delegated]) {
    it(`an administrator's ${key.scope_kind === "agents" ? "delegated" : "reduced"} key cannot attest another account's agent under any policy`, () => {
      for (const policy of VERIFICATION_POLICIES) {
        expect(canSetVerified(policy, { ...admin, key }, agent)).toBe(false);
      }
    });
  }
  it("an administrator's account-wide key with every operation still attests under the admin policy", () => {
    const full: KeyContext = {
      ...reduced,
      operations: ["agent:run", "agent:push", "agent:verify"],
    };
    expect(canSetVerified("admin", { ...admin, key: full }, agent)).toBe(true);
  });
});

describe("verificationKind (tie-break: admin wins)", () => {
  it("returns admin for an instance admin (even if they own the agent)", () => {
    expect(verificationKind({ role: "admin", key: null })).toBe("admin");
  });

  it("returns owner_self for a non-admin (necessarily the owner)", () => {
    expect(verificationKind({ role: "user", key: null })).toBe("owner_self");
  });

  it("returns owner_self for an administrator attesting through a reduced key", () => {
    const reduced: KeyContext = {
      id: "k",
      scope_kind: "account",
      operations: ["agent:verify"],
      agent_ids: [],
    };
    expect(verificationKind({ role: "admin", key: reduced })).toBe("owner_self");
  });
});
