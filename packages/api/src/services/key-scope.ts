/**
 * API-key scope enforcement — the three capability rules of an API key.
 *
 *   R1 operation + resource  — run / push / verify: the key must carry the
 *                              `agent:*` operation AND be allowed to act on the
 *                              target agent.
 *   R2 master credential     — account-management (mint/list/revoke keys,
 *                              visibility, delete): only a session, a dev-token,
 *                              or an account-wide + full-operation key.
 *   R3 read least-privilege  — a delegated (`scope_kind='agents'`) key may read
 *                              only the metadata of its in-scope agents; it gets
 *                              no source (pull), versions, runs, or stats. Run
 *                              history, stats and source take a master
 *                              credential; any other key reads only the files
 *                              of its own runs and uploads.
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
 * A "master credential" = a session, a dev-token, or an API key that is
 * BOTH account-wide AND carries the full operation set. Required for
 * account-management. Operation comparison is **set-equality** (order-independent)
 * so a reordered default mint still counts as master. Keyed on the key, never
 * `role` — an admin presenting a restricted/limited key is NOT a master credential.
 */
export function isMasterCredential(user: Pick<UserContext, "key">): boolean {
  const key = user.key;
  if (key == null) return true; // session / dev-token
  if (key.scope_kind !== "account") return false; // delegated
  // Compare SETS, not list lengths: a list can reach the full length by
  // repeating one operation while omitting another, and every element would
  // still be a member — so a length check accepts a key that is missing a
  // permission. De-duplicate first, then compare size and membership.
  const ops = new Set(key.operations);
  return ops.size === FULL_OPERATION_SET.size && [...ops].every((op) => FULL_OPERATION_SET.has(op));
}

/**
 * Whether the caller acts as the instance administrator: the `admin` role AND a
 * master credential. The reads and the run that widen past the caller's own
 * account for an administrator — the pool view, the agent list, another
 * account's agents, a run of one, an environment override on it, an
 * attestation — ask this, never the role alone. The role belongs to the person;
 * a key that person reduced to fewer operations, or delegated to a client, was
 * handed out for one job and answers as the same key of an ordinary account
 * would (the rule at the top of this module: the key, never the role).
 *
 * Not every widening asks it. The administration routes that act on another
 * account — an agent's visibility, deleting a version or an agent, an agent's
 * model keys (their list as well as their writes), deleting an account —
 * require a master credential (`requireMasterCredential`) and read the role
 * beside it: the same pair, checked in two steps, which a change to this
 * predicate does not reach.
 */
export function isInstanceAdmin(user: Pick<UserContext, "role" | "key">): boolean {
  return user.role === "admin" && isMasterCredential(user);
}

/**
 * Who the caller of a run is. A master credential is the account it belongs to;
 * any other key — reduced, or delegated to a client — is that key. Derived from
 * the authenticated credential alone: nothing in the request (header, body) and
 * nothing the model sees can name or change it.
 */
export type RunCaller = { kind: "account"; userId: string } | { kind: "key"; keyId: string };

export function runCaller(user: UserContext): RunCaller {
  const key = user.key;
  // A null key (session / dev-token) is master: the account.
  if (key == null || isMasterCredential(user)) return { kind: "account", userId: user.id };
  return { kind: "key", keyId: key.id };
}

/**
 * The caller an agent's per-caller state is kept under: `runCaller`, or `null`
 * when the account has no row to attach state to (the dev-token fallback that
 * could not record its account). With `null` the run reads and writes no
 * per-caller state; it still runs.
 */
export function stateCaller(user: UserContext): RunCaller | null {
  if (user.syntheticAccount) return null;
  return runCaller(user);
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

/**
 * R3 (master read) — run history, usage stats and an agent's source are for a
 * master credential only. A delegated key keeps its own refusal, word for word;
 * any other credential that is not master (an account-wide key with fewer than
 * every operation, or with none) is refused with a message that names what the
 * read takes. A reduced key is the key a creator hands out to run an agent: it
 * must not open what every other caller of the account produced.
 */
export function assertMasterReadOrThrow(user: UserContext): void {
  assertNotDelegatedOrThrow(user);
  if (!isMasterCredential(user)) {
    throwKeyScope(
      "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
    );
  }
}

/** The fields of a run that decide who may read its output files. */
export type RunFileOwnership = { user_id: string | null; api_key_id: string | null };

/**
 * Whether the caller may read the output files of `run`. A master credential
 * reads the files of every run of its account; any other key reads only the
 * files of the runs it launched itself. A run whose account was removed
 * (`user_id` null), or whose key was revoked (`api_key_id` null), is read by
 * no key that is not master.
 */
export function mayReadRunFiles(user: UserContext, run: RunFileOwnership): boolean {
  if (run.user_id === null || run.user_id !== user.id) return false;
  const caller = runCaller(user);
  return caller.kind === "account" || run.api_key_id === caller.keyId;
}

/** The fields of an upload that decide who may use it. */
export type UploadOwnership = { owner_id: string; uploaded_by_key_id: string | null };

/**
 * Whether the caller may read, delete, or pass as a run input the file it
 * uploaded through `POST /api/files`. A master credential uses every upload of
 * its account; any other key only the uploads it made itself.
 */
export function mayUseUpload(user: UserContext, upload: UploadOwnership): boolean {
  if (upload.owner_id !== user.id) return false;
  const caller = runCaller(user);
  return caller.kind === "account" || upload.uploaded_by_key_id === caller.keyId;
}
