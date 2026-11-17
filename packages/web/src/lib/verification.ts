import type { AuthUser } from "./auth";

/** The operator's verification policy, as `GET /api/me` reports it. */
export type VerificationPolicy = NonNullable<AuthUser["verification_policy"]>;

/**
 * The policy the dashboard acts on. A server that predates the field reports
 * none, and so does a caller not signed in yet: both read as `admin`, the
 * strictest — a control the server would refuse is never offered.
 */
export function verificationPolicyOf(user: AuthUser | null | undefined): VerificationPolicy {
  return user?.verification_policy ?? "admin";
}

/**
 * Whether `POST /run` refuses a version because it is not verified: under the
 * `admin` policy only — `owner` and `disabled` run an unverified version.
 *
 * A copy of the server's rule (`isRunGatedByVerification` in
 * `packages/api/src/services/verification-policy.ts`): the dashboard does not
 * import the API. The server decides; this copy only keeps the Run button from
 * refusing a run the server would accept, or offering one it would refuse.
 * Change both together: `tests/e2e/verification-parity.test.ts` compares them on
 * every policy and both states, and fails when one changes alone.
 */
export function isRunGatedByVerification(policy: VerificationPolicy, verified: boolean): boolean {
  return policy === "admin" ? !verified : false;
}
