/**
 * Configurable verification policy.
 *
 * The operator chooses how agent verification gates runs and who may attest an
 * agent version, via `SKRUN_VERIFICATION_POLICY`:
 *
 *   admin    (default) — only an instance admin may verify; an unverified
 *                        version cannot run. Reproduces the legacy behavior
 *                        exactly, so an unset var is a no-op for existing
 *                        deployments.
 *   owner              — the agent owner is the trust authority for their own
 *                        agents: they (or an admin) may verify, and a private
 *                        agent runs without a verification gate (owner
 *                        authority + sandbox isolation + reactive abuse).
 *   disabled           — no run is gated on verification; the flag is inert
 *                        metadata (owner or admin may still set it).
 *
 * The run gate is visibility-independent: setting an agent `public` is disabled
 * for now (private-only hosting era), so every live agent is private. The
 * dormant run-auth `public` branch and a future public-agent verification gate
 * are a single bundle reactivated later by the marketplace work.
 *
 * Pure module (no Hono / no fs) so every branch is unit-testable in isolation,
 * mirroring `auth/dev-auth.ts`.
 */

import type { Agent } from "../db/schema.js";
import type { UserContext } from "../types.js";

export const VERIFICATION_POLICIES = ["admin", "owner", "disabled"] as const;
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];

/**
 * Resolve the operator verification policy from the environment. Defaults to
 * `"admin"` (legacy behavior) when unset/empty; **throws** on any other value
 * so a typo fails the app at boot rather than running with an undefined gate
 * (same fail-fast spirit as the `SKRUN_DEV_AUTH` interlock in `index.ts`).
 */
export function readVerificationPolicy(env: NodeJS.ProcessEnv = process.env): VerificationPolicy {
  const raw = env.SKRUN_VERIFICATION_POLICY?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return "admin";
  }
  if ((VERIFICATION_POLICIES as readonly string[]).includes(raw)) {
    return raw as VerificationPolicy;
  }
  throw new Error(
    `Invalid SKRUN_VERIFICATION_POLICY="${env.SKRUN_VERIFICATION_POLICY}". ` +
      `Allowed: ${VERIFICATION_POLICIES.join(" | ")} (default "admin" when unset).`,
  );
}

/**
 * Whether a run must be blocked because the resolved version is unverified.
 * Only the `admin` policy gates on verification; `owner` and `disabled` never
 * gate (see the module note on why this is visibility-independent today).
 */
export function isRunGatedByVerification(policy: VerificationPolicy, verified: boolean): boolean {
  return policy === "admin" ? !verified : false;
}

/**
 * Whether `user` may set the `verified` flag on `agent`'s versions. An instance
 * admin always may. Under `owner`/`disabled` the agent owner may attest their
 * own agents; under `admin` only the admin may. Ownership is resource-based
 * (`agent.owner_id === user.id`) — not a namespace string match — so it
 * generalises to org namespaces later.
 */
export function canSetVerified(
  policy: VerificationPolicy,
  user: Pick<UserContext, "id" | "role">,
  agent: Pick<Agent, "owner_id">,
): boolean {
  if (user.role === "admin") {
    return true;
  }
  if (policy === "admin") {
    return false;
  }
  return agent.owner_id === user.id;
}

/**
 * The attestation kind recorded on the verify log, for forensic abuse tracing.
 * Tie-break: when the actor is both an admin and the owner, **`admin` wins**.
 * A non-admin can only reach the log as the owner (gated by `canSetVerified`),
 * hence `owner_self`.
 */
export function verificationKind(user: Pick<UserContext, "role">): "admin" | "owner_self" {
  return user.role === "admin" ? "admin" : "owner_self";
}
