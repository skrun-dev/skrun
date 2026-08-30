/**
 * API-key scope enforcement — the three capability rules of an `sk_live` key.
 *
 *   R1 operation + resource  — run / push / verify: the key must carry the
 *                              `agent:*` operation AND be allowed to act on the
 *                              target agent.
 *   R2 master credential     — account-management (mint/list/revoke keys,
 *                              visibility, delete): only a session, a dev-token,
 *                              or an account-wide + full-operation key.
 *   R3 read least-privilege  — a delegated (`scope_kind='agents'`) key may read
 *                              only the metadata of its in-scope agents; it gets
 *                              no source (pull), versions, runs, or stats.
 *
 * Every rule keys off `user.key` — NEVER `user.role`. A restricted or limited
 * key restricts even an admin owner, because the key (not the person) is the
 * delegated credential. A null key (session / dev-token) is the unrestricted
 * "master credential".
 *
 * Pure module (no Hono / no fs) so every branch is unit-testable in isolation,
 * mirroring `verification-policy.ts`. All denials throw the same shape:
 * `RegistryError("KEY_SCOPE_FORBIDDEN", …, 403)`. This is only ever reachable
 * intra-account (the key's owner owns the resource), so — unlike the read-side
 * opaque 404 in `access.ts` — an explicit 403 leaks nothing.
 */

import { type Agent, API_KEY_DEFAULT_SCOPES } from "../db/schema.js";
import type { KeyContext, UserContext } from "../types.js";
import { RegistryError } from "./registry.js";

/** The full operation set — an account-wide key carrying exactly these is master. */
const FULL_OPERATION_SET = new Set<string>(API_KEY_DEFAULT_SCOPES);

function throwKeyScope(message: string): never {
  throw new RegistryError("KEY_SCOPE_FORBIDDEN", message, 403);
}

function agentLabel(agent: Agent): string {
  return `${agent.namespace}/${agent.name}`;
}

/**
 * Whether the key permits an operation. A null key (session / dev-token) permits
 * everything; otherwise the operation must be in the key's scope list. An empty
 * operation list therefore denies every operation (fail-closed).
 */
export function keyAllowsOperation(key: KeyContext | null | undefined, op: string): boolean {
  if (key == null) return true;
  return key.operations.includes(op);
}

/**
 * Whether the key may act on `agent`. A null key or an `account` key → any agent
 * (ownership is enforced separately, upstream, by the run-auth gate). A
 * scoped (`agents`) key → only its granted agents; **0 grants ⇒ false = deny-all**
 * (fail-closed, e.g. after the granted agents were deleted → FK cascade).
 *
 * Note: ownership ("does the caller own this agent?") is enforced separately and
 * upstream by the run-authorization gate; this only narrows within that.
 */
export function keyCanAccessAgent(key: KeyContext | null | undefined, agent: Agent): boolean {
  if (key == null || key.scope_kind === "account") return true;
  return key.agent_ids.includes(agent.id);
}

/** A delegated (resource-scoped) key — handed to a client; read-confined + admin-denied. */
export function isDelegatedKey(user: UserContext): boolean {
  return user.key != null && user.key.scope_kind === "agents";
}

/**
 * A "master credential" = a session, a dev-token, or an `sk_live` key that is
 * BOTH account-wide AND carries the full operation set. Required for
 * account-management. Operation comparison is **set-equality** (order-independent)
 * so a reordered default mint still counts as master. Keyed on the key, never
 * `role` — an admin presenting a restricted/limited key is NOT a master credential.
 */
export function isMasterCredential(user: UserContext): boolean {
  const key = user.key;
  if (key == null) return true; // session / dev-token
  if (key.scope_kind !== "account") return false; // delegated
  return (
    key.operations.length === FULL_OPERATION_SET.size &&
    key.operations.every((op) => FULL_OPERATION_SET.has(op))
  );
}

/** R1 — the key must permit `op` AND be allowed to act on `agent`. */
export function assertKeyScopeOrThrow(user: UserContext, agent: Agent, op: string): void {
  if (!keyAllowsOperation(user.key, op)) {
    throwKeyScope(`API key is not permitted to perform '${op}'.`);
  }
  if (!keyCanAccessAgent(user.key, agent)) {
    throwKeyScope(`API key is not scoped for agent ${agentLabel(agent)}.`);
  }
}

/**
 * R1 for push, which may target a new agent. The key must permit `agent:push`,
 * and: an EXISTING agent must be in scope; a NEW agent (`agent === null`) can be
 * created only by a non-delegated credential — a resource-scoped key cannot
 * create a brand-new agent because no grant can name an agent that doesn't exist
 * yet.
 */
export function assertKeyCanPushOrThrow(user: UserContext, agent: Agent | null): void {
  if (!keyAllowsOperation(user.key, "agent:push")) {
    throwKeyScope("API key is not permitted to perform 'agent:push'.");
  }
  if (agent === null) {
    if (isDelegatedKey(user)) {
      throwKeyScope("A resource-scoped API key cannot create a new agent.");
    }
    return; // account / session / dev-token may create a new agent
  }
  if (!keyCanAccessAgent(user.key, agent)) {
    throwKeyScope(`API key is not scoped for agent ${agentLabel(agent)}.`);
  }
}

/** R2 — account-management requires a master credential. */
export function assertMasterCredentialOrThrow(user: UserContext): void {
  if (!isMasterCredential(user)) {
    throwKeyScope("This action requires an account-wide API key (or a session / dev-token).");
  }
}

/**
 * R3 (metadata) — a delegated key may read only its in-scope agents (to learn
 * the input schema of an agent it can run). Account / session / dev-token read
 * as today.
 */
export function assertKeyCanReadAgentOrThrow(user: UserContext, agent: Agent): void {
  if (isDelegatedKey(user) && !keyCanAccessAgent(user.key, agent)) {
    throwKeyScope(`API key is not scoped for agent ${agentLabel(agent)}.`);
  }
}

/**
 * R3 (source / history) — a delegated key cannot read source (pull), versions,
 * runs, or stats. Account / session / dev-token are unaffected (read as today).
 */
export function assertNotDelegatedOrThrow(user: UserContext): void {
  if (isDelegatedKey(user)) {
    throwKeyScope("This endpoint is not available to a resource-scoped API key.");
  }
}
