/**
 * The dashboard's copy of the server's run gate, compared with it.
 *
 * `POST /run` refuses an unverified version with the rule of
 * `packages/api/src/services/verification-policy.ts`; the playground's Run
 * button decides with its own copy, `packages/web/src/lib/verification.ts`,
 * because the dashboard does not import the API. Two copies of one rule drift
 * in silence: a button that offers a run the server refuses, or withholds one
 * it would accept. This test reads both rules and compares them on every
 * policy the server knows and both states of a version — the place where the
 * two packages meet without depending on each other.
 */
import { describe, expect, it } from "vitest";
import {
  isRunGatedByVerification as serverRule,
  VERIFICATION_POLICIES,
} from "../../packages/api/src/services/verification-policy.js";
import { isRunGatedByVerification as dashboardRule } from "../../packages/web/src/lib/verification.js";

const CASES = VERIFICATION_POLICIES.flatMap((policy) =>
  [true, false].map((verified) => ({ policy, verified })),
);

describe("the dashboard's run gate is the server's", () => {
  it("covers every policy the server knows, verified and not", () => {
    expect(VERIFICATION_POLICIES.length).toBeGreaterThan(0);
    expect(CASES).toHaveLength(VERIFICATION_POLICIES.length * 2);
  });

  it.each(CASES)("policy $policy, verified $verified: the same answer", ({ policy, verified }) => {
    expect(dashboardRule(policy, verified)).toBe(serverRule(policy, verified));
  });
});
