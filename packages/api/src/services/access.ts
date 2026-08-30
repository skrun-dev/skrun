import type { Agent } from "../db/schema.js";
import type { UserContext } from "../types.js";
import { RegistryError } from "./registry.js";

/**
 * Multi-tenant ownership gate for registry GET endpoints.
 *
 * Throws `RegistryError("NOT_FOUND", ..., 404)` indistinguishably whether
 * the agent doesn't exist OR the caller is non-owner non-admin. Both
 * branches produce the SAME `RegistryError` instance shape (same code,
 * same message, same status) so the eventual JSON response body is
 * byte-identical — opaque to the client and to any timing analysis.
 *
 * Read/write split rationale:
 *  - GET routes (list, metadata, versions, stats, pull) use this helper
 *    → 404 opaque. Hides existence from non-privileged readers
 *    (GitHub Private Repo / Stripe / Linear pattern).
 *  - DELETE / PATCH `/verify` write routes (shipped via the verify
 *    feature) keep 403 FORBIDDEN explicit — writes announce permission
 *    denial so the actor knows why their action failed and can switch
 *    accounts.
 *
 * Ordering constraint: callers MUST invoke this helper BEFORE
 * any subsequent storage / bundle / version fetch on pull-like routes,
 * so the response latency is constant between genuine-404 (agent row
 * absent) and ownership-404 (agent row present but not visible to the
 * caller). Reversing the order — fetch storage first, then check
 * ownership — creates a measurable latency differential the helper
 * cannot prevent.
 *
 * @param agent  Result of `db.getAgent(ns, name)` — may be null.
 * @param user   `UserContext` from the auth middleware (`getUser(c)`).
 * @param requestedNs   Namespace path-param requested by the client.
 * @param requestedName Name path-param requested by the client.
 * @throws RegistryError NOT_FOUND (404) if the agent is null OR the caller
 *         is neither the owner nor an admin.
 */
export function assertAgentVisibleOrThrow(
  agent: Agent | null,
  user: UserContext,
  requestedNs: string,
  requestedName: string,
): asserts agent is Agent {
  if (!agent) {
    throw new RegistryError("NOT_FOUND", `Agent ${requestedNs}/${requestedName} not found`, 404);
  }
  if (agent.owner_id !== user.id && user.role !== "admin") {
    // SAME exception shape as the agent-not-found case — by design.
    // Any divergence here (different message, different code, status
    // 403 vs 404, additional fields) would leak existence to clients
    // who can compare the two response bodies. Keep this in sync.
    throw new RegistryError("NOT_FOUND", `Agent ${requestedNs}/${requestedName} not found`, 404);
  }
}

/**
 * Run-authorization gate for `POST /run`. `public` agents are runnable by any
 * authenticated caller; everything else (`private`, or absent) **delegates to
 * `assertAgentVisibleOrThrow`** so the opaque 404 shape is shared and cannot
 * drift between the read path and the run path. Owner/admin may run a private
 * agent; a non-owner gets a 404 byte-identical to a genuinely-absent agent.
 *
 * This gate answers "may this account reach this agent at all?" (ownership /
 * visibility). API-key scoping is a SEPARATE, narrower restriction layered
 * AFTER this one (`services/key-scope.ts`): a key always belongs to its owner,
 * so it passes here by ownership, and the key-scope gate then narrows what that
 * key may do. There is no cross-account "allowed-branch" here — a restricted
 * key restricts its own account, it never grants a foreign one access.
 */
export function assertAgentRunnableOrThrow(
  agent: Agent | null,
  user: UserContext,
  requestedNs: string,
  requestedName: string,
): asserts agent is Agent {
  if (agent && agent.visibility === "public") return;
  assertAgentVisibleOrThrow(agent, user, requestedNs, requestedName);
}
