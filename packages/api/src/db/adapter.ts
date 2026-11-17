import type {
  Agent,
  AgentLlmKeyInfo,
  AgentLlmKeyPolicy,
  AgentLlmKeyRecord,
  AgentVersion,
  ApiKey,
  ApiKeyScopeKind,
  DeviceCode,
  Environment,
  Run,
  RunStatus,
  Session,
  StatePartition,
  StoredState,
  User,
  UserDeletionPlan,
  UserDeletionResult,
} from "./schema.js";

/**
 * The fields of a run that carry its content: `updateRun` never writes them on
 * a run whose content was cleared (`content_cleared_at` set).
 */
export const RUN_CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "output",
  "error",
  "files",
  "purge_after",
]);

/**
 * The error a server's stop writes into a run still going when it stops.
 * `finishRun` reads it too: a `failed` row whose error is exactly this phrase is
 * the only finished row a completion may still replace, and only when it asks.
 */
export const SHUTDOWN_RUN_ERROR = "The server stopped while this run was in progress.";

/** The fields a write of a run row may carry — `updateRun`'s, and `finishRun`'s. */
export type RunWrite = Partial<
  Pick<
    Run,
    | "status"
    | "output"
    | "error"
    | "usage_prompt_tokens"
    | "usage_completion_tokens"
    | "usage_total_tokens"
    | "usage_estimated_cost"
    | "usage_cache_read_tokens"
    | "usage_cache_write_tokens"
    | "usage_cache_savings_usd"
    | "duration_ms"
    | "files"
    | "completed_at"
    | "machine_id"
    | "private_ip"
    | "phase_timings"
    | "purge_after"
  >
>;

/**
 * A run's final write: the status that ends it, and the fields written with
 * it — the time it is charged among them, which only this write carries
 * (`updateRun` never takes it). Absent, `charged_ms` stays null, and the
 * compute sums count the row's end minus its creation.
 */
export type FinalRunWrite = RunWrite & {
  status: "completed" | "failed";
  /** The time the run is charged, in ms (`Run.charged_ms`). */
  charged_ms?: number;
};

/**
 * The rolling hour over which an account's runs entitled to a pooled machine
 * are counted: a run counts while it was created strictly less than this long
 * ago — one admitted exactly an hour ago has left the hour.
 */
export const FAST_RUN_WINDOW_MS = 3_600_000;

/** The row an admission writes: `createRun`'s fields, its status always `running`. */
export interface AdmittedRunData {
  id: string;
  agent_id: string | null;
  agent_version: string;
  model?: string | null;
  environment_id?: string | null;
  user_id?: string | null;
  /** The API key that initiated the run (per-key metering). Null for session/dev-token. */
  api_key_id?: string | null;
  input?: Record<string, unknown>;
}

/** What bounds one admission. A bound left `null` is off. */
export interface AdmissionLimits {
  /** The account's runs holding a seat. */
  concurrentRuns: number | null;
  /** The account's compute in the current window, in milliseconds; needs `windowStart`. */
  computeMs: number | null;
  /**
   * The account's runs per rolling hour entitled to a pooled machine — read
   * only while a pool runs. `null` with a pool running: every run is entitled.
   */
  fastRunsPerHour: number | null;
  /** The runs holding a seat on the whole instance, every account together. */
  instanceCap: number | null;
}

/** One run to admit, at one instant of the process's clock. */
export interface RunAdmission {
  run: AdmittedRunData;
  /**
   * The process's instant, in `toISOString()` form: the row's `created_at` is
   * written from it — never from the database's clock — and every sum is read
   * at it.
   */
  now: string;
  /** The seat's deadline, in `toISOString()` form, written as given. */
  deadlineAt: string;
  /** The start of the current compute window (included), or `null` without one. */
  windowStart: string | null;
  limits: AdmissionLimits;
  /** A runner pool runs: without one, no run is entitled to it, and none is counted. */
  poolRunning: boolean;
}

/** What an account consumes at one instant, read from its own rows of `runs`. */
export interface AccountUsage {
  /** The account's runs still `running` whose deadline is later than now. */
  seatsInUse: number;
  /**
   * The charged time of the account's runs created since the window's start:
   * a finished run its `charged_ms`, or, when that is null, the time from its
   * creation to its end (never 0 for that reason); a run in flight before its
   * deadline the time from its creation to now; a run in flight past its
   * deadline — its process died before writing its status: nothing of it is
   * charged — or without one, 0. Milliseconds; 0 when no window is given.
   */
  computeUsedMs: number;
  /** The account's runs entitled to a pooled machine created strictly after `fastSince`. */
  fastRunsUsed: number;
  /**
   * Read only when asked (`fastLimit`): the creation of the run of those
   * whose leaving the hour gives the account a right back — the
   * `fastRunsUsed − fastLimit + 1`-th oldest, the oldest while `fastRunsUsed`
   * is at most `fastLimit`. An account that holds more of them than its limit
   * (its plan or the limit lowered since) gets no new right until then.
   * `null` when there is none — always for a limit of 0 — and when it was not
   * asked: an admission's usage included. Always set: a store that leaves it
   * out would have the route answer that no right comes back.
   */
  releasingFastRunAt: string | null;
  /**
   * The runs holding a seat on the whole instance, every account together —
   * runs without an account included. `null` when it was not read.
   */
  instanceSeatsInUse: number | null;
}

/**
 * What an admission did. Admitted: the row written, its right to a pooled
 * machine, and the usage read before it was written (it does not count the
 * run just admitted) — `null` when nothing bounded the run and nothing was
 * read. Refused: nothing written, and the usage that refused it — `null` for
 * `busy`, the database not answering the admission in time (a lock, a
 * statement or the transaction left idle past its bound, a silent connection).
 */
export type RunAdmissionResult =
  | { admitted: true; run: Run; poolEntitled: boolean; usage: AccountUsage | null }
  | { admitted: false; reason: "compute" | "concurrency" | "instance"; usage: AccountUsage }
  | { admitted: false; reason: "busy"; usage: null };

/**
 * What the admission rule reads of an admission: the run's account, its
 * bounds, the window's start and whether a pool runs — nothing else of the
 * run. The pre-check reads the same rule before the run's row exists.
 */
export type AdmissionRule = Pick<RunAdmission, "limits" | "poolRunning" | "windowStart"> & {
  run: Pick<AdmittedRunData, "user_id">;
};

/**
 * Whether anything bounds an admission: a bound of its account — none for a
 * run without one; the hourly bound only while a pool runs — or the instance
 * cap. When nothing does, every backend writes the row with no lock and no
 * read, and the run has the right to a pooled machine exactly while a pool
 * runs. Throws on a compute limit without the window's start.
 */
export function admissionIsBounded(admission: AdmissionRule): boolean {
  const { limits } = admission;
  if (limits.computeMs !== null && admission.windowStart === null) {
    throw new Error("admitRun: a compute limit needs the window's start");
  }
  const accountBounded =
    admission.run.user_id != null &&
    (limits.concurrentRuns !== null ||
      limits.computeMs !== null ||
      (admission.poolRunning && limits.fastRunsPerHour !== null));
  return accountBounded || limits.instanceCap !== null;
}

/** The instant from which an admission at `now` counts the fast runs (excluded). */
export function fastRunsSince(now: string): string {
  return new Date(Date.parse(now) - FAST_RUN_WINDOW_MS).toISOString();
}

/**
 * How many of an account's fast runs of the hour, oldest first, come before
 * the one whose leaving gives it a right back (`releasingFastRunAt`): none
 * while it holds at most `fastLimit` of them; past that, every one it holds
 * beyond the limit — they must leave first.
 */
export function releasingFastRunOffset(fastRunsUsed: number, fastLimit: number): number {
  return Math.max(0, fastRunsUsed - fastLimit);
}

/**
 * What a bounded admission comes to once its usage is read under its lock —
 * the same rule on every backend: the first refusal that applies, in order
 * (compute, seats, the instance; an account's bounds only for a run with an
 * account; reaching a limit refuses), or else the run's right to a pooled
 * machine.
 */
export function admissionVerdict(
  admission: AdmissionRule,
  usage: AccountUsage,
):
  | { admitted: false; reason: "compute" | "concurrency" | "instance" }
  | { admitted: true; poolEntitled: boolean } {
  const { limits } = admission;
  const hasAccount = admission.run.user_id != null;
  if (hasAccount) {
    if (limits.computeMs !== null && usage.computeUsedMs >= limits.computeMs) {
      return { admitted: false, reason: "compute" };
    }
    if (limits.concurrentRuns !== null && usage.seatsInUse >= limits.concurrentRuns) {
      return { admitted: false, reason: "concurrency" };
    }
  }
  if (limits.instanceCap !== null && (usage.instanceSeatsInUse ?? 0) >= limits.instanceCap) {
    return { admitted: false, reason: "instance" };
  }
  const poolEntitled =
    admission.poolRunning &&
    (!hasAccount || limits.fastRunsPerHour === null || usage.fastRunsUsed < limits.fastRunsPerHour);
  return { admitted: true, poolEntitled };
}

export interface DbAdapter {
  // --- Agents ---
  getAgent(namespace: string, name: string): Promise<Agent | null>;
  createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
    /** Defaults to `private` when omitted. */
    visibility?: "private" | "public";
  }): Promise<Agent>;
  /**
   * Paginated list of agents. When `userId` is set, filters to agents
   * whose `owner_id === userId` (multi-tenant isolation for OAuth/API-key
   * users with `role === 'user'`). When `userId` is undefined, returns
   * all agents (admin bypass or dev-token single-tenant mode).
   *
   * `total` reflects the FILTERED count when `userId` is set — required
   * for accurate dashboard pagination. Mirrors the dual-mode `getStats({ userId? })`
   * pattern used elsewhere in this adapter.
   */
  listAgents(opts: { page: number; limit: number; userId?: string }): Promise<{
    agents: (Agent & { run_count: number; token_count: number; cost_total: number })[];
    total: number;
  }>;
  /**
   * Per-version verification gate. Flips `agent_versions.verified` for the
   * specified version of the specified agent. Returns the updated row, or
   * null if the agent or version doesn't exist. Admin-only at the route
   * layer (`PATCH /api/agents/:ns/:name/versions/:version/verify`).
   */
  setVersionVerified(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<AgentVersion | null>;
  deleteAgent(namespace: string, name: string): Promise<boolean>;
  /**
   * Per-agent visibility gate. Flips `agents.visibility` between `private`
   * (default) and `public`. Returns the updated row, or null if the agent
   * doesn't exist. Owner/admin-only at the route layer
   * (`PATCH /api/agents/:ns/:name/visibility`).
   */
  setVisibility(
    namespace: string,
    name: string,
    visibility: "private" | "public",
  ): Promise<Agent | null>;
  /**
   * Per-agent caller-key policy gate. Flips `agents.llm_key_policy` between
   * `open` (default) and `creator_only`. Returns the updated row, or null if the
   * agent doesn't exist. Owner/admin + master-credential at the route layer.
   */
  setLlmKeyPolicy(
    namespace: string,
    name: string,
    policy: AgentLlmKeyPolicy,
  ): Promise<Agent | null>;

  // --- Agent LLM keys (creator-attached, encrypted at rest) ---
  /**
   * Upsert a creator's encrypted LLM key for `(agentId, provider)` — replaces any
   * existing key for that pair.
   *
   * `ciphertext` is the opaque AES-256-GCM envelope, and it is **never returned by
   * a read endpoint**.
   *
   * `last4` is display-only and **IS** returned — by `listAgentLlmKeys` below.
   * That exposure is deliberate and load-bearing: the cloud privacy policy states
   * we keep the last four characters *"so you can tell one key from another"*, a
   * sentence that only means anything if they are shown. Removing `last4` from the
   * presence response would make a legal document false without touching the
   * schema, so no migration guard would catch it. The round-trip test in
   * `routes/agent-llm-keys.test.ts` pins the behaviour; this is the reason it is
   * pinned.
   *
   * (This comment used to read "`last4` is display-only. Never returned by a read
   * endpoint." — the second sentence attached to the wrong subject and read as an
   * invitation to remove the very field a published text depends on.)
   */
  setAgentLlmKey(
    agentId: string,
    provider: string,
    ciphertext: string,
    last4: string,
    keyVersion: number,
  ): Promise<void>;
  deleteAgentLlmKey(agentId: string, provider: string): Promise<void>;
  /** Presence view (provider + last4 + updated_at) — NO ciphertext. */
  listAgentLlmKeys(agentId: string): Promise<AgentLlmKeyInfo[]>;
  /**
   * Full records incl. `ciphertext`, for the harness to decrypt at run time via
   * the KeyProvider. Run-path only — never serialised to a client.
   */
  getAgentLlmKeySecrets(agentId: string): Promise<AgentLlmKeyRecord[]>;

  // --- Agent Versions ---
  createVersion(
    agentId: string,
    data: {
      version: string;
      size: number;
      bundle_key: string;
      /**
       * SHA-256 (hex) of the bundle. Optional at the DB layer
       * (nullable column, backfill valve); RegistryService.push() always
       * sets it for new pushes.
       */
      bundle_sha256?: string | null;
      config_snapshot?: Record<string, unknown>;
      notes?: string | null;
    },
  ): Promise<AgentVersion>;
  /**
   * Whether a write that threw with `err` may have been committed all the same
   * — its outcome unknown to the caller, who must then neither take it for
   * written nor for refused. `false` when the failure is final and what the
   * write did is there to be read — not that it wrote nothing: `createVersion`
   * inserts the row, then updates the agent, in two statements, and a failed
   * second leaves the row written; the caller's read decides. Always `false` for
   * the memory store and SQLite, whose writes run in this process; for Postgres,
   * only a refusal the server answered that rolls the statement back
   * (`writeOutcomeUnknown`, `pg-timeouts.ts`). Read by the publication after a
   * version's row failed (`services/registry.ts`).
   */
  writeOutcomeUnknown(err: unknown): boolean;
  getVersions(agentId: string): Promise<AgentVersion[]>;
  getLatestVersion(agentId: string): Promise<AgentVersion | null>;
  getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null>;
  deleteVersion(agentId: string, version: string): Promise<void>;
  /**
   * The bytes of every version bundle the account `ownerId` holds: the sum of
   * `agent_versions.size` over the agents it owns (`agents.owner_id`) — 0 for
   * an account that owns none. A deleted version, or a deleted agent, no
   * longer counts. Read without a lock: a read sees no version still being
   * written — the publication reads it under the account's turn
   * (`services/registry.ts`), which no other push of the account shares.
   */
  sumBundleBytesByOwner(ownerId: string): Promise<number>;
  /**
   * Versions whose `bundle_sha256` is NULL (predate hashing). Drives the
   * one-shot boot backfill. Returns id + bundle_key so the
   * backfill can fetch the blob from storage and hash it.
   */
  listVersionsMissingHash(): Promise<Array<{ id: string; bundle_key: string }>>;
  /**
   * Set `bundle_sha256` for a single version by id. Used only by the boot
   * backfill to populate legacy rows; new pushes set it via createVersion.
   */
  setVersionBundleHash(versionId: string, bundleSha256: string): Promise<void>;

  // --- Agent State ---
  /**
   * The notebook of `partition` for the agent `agentId` (the agent's id, never
   * its name: an agent deleted then re-created under the same name does not
   * inherit it). `null` when there is none. Does not filter on `expires_at`:
   * deciding what an expired row means belongs to the caller of the adapter.
   */
  getState(agentId: string, partition: StatePartition): Promise<StoredState | null>;
  /**
   * Write (or overwrite) the notebook of `partition` for `agentId`, with the
   * deadline `expiresAt` (a `toISOString()` string, computed by the caller).
   * Rejects when the agent, the account or the key the partition names does
   * not exist, with an error `isMissingStateReference` recognises: a foreign key
   * violation (Postgres `23503`, SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`) or, in
   * memory, a `MissingStateReferenceError`. A run absorbs that refusal and no
   * other: any other rejection fails the run. A row goes with what it belongs
   * to: deleting the agent, the key, or the account deletes it (a `shared` row
   * goes with its agent only).
   */
  setState(
    agentId: string,
    partition: StatePartition,
    state: Record<string, unknown>,
    expiresAt: string,
  ): Promise<void>;
  /**
   * Delete every notebook whose deadline has passed — `expires_at` before the
   * current instant, which the process passes as a `toISOString()` string on
   * every backend: Postgres compares it with the stored `timestamptz` as an
   * instant, SQLite and the in-memory backend compare two strings of that same
   * form. Called by the hourly sweep on each instance. Each write moves its
   * notebook's deadline: only a notebook not written for its whole `ttl` goes.
   */
  purgeExpiredState(): Promise<void>;

  // --- Users ---
  getUserByGithubId(githubId: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User>;
  /**
   * Create the account a GitHub sign-in names, choosing its namespace — and
   * never renaming one: when an account already has this `github_id`, it is
   * returned as is (`derived: null`), whatever the login is now.
   *
   * Otherwise the namespace is `namespaceBase(login)` if free, else the first
   * free `<base>--N` (N ≥ 2, `db/namespace.ts`); `derived` is that N, or null
   * for the base itself. Choosing and inserting are one step: every backend
   * reads `users.username` explicitly before it inserts — that read is the
   * guarantee on all three, since SQLite and memory have no uniqueness on the
   * column. Postgres' `UNIQUE` is the net under a concurrent sign-in: after a
   * unique violation the account is looked up by `github_id` again — found,
   * it is returned; absent, the next name is tried. Throws
   * `NamespaceUnavailableError` once `NAMESPACE_MAX_ATTEMPTS` names are taken.
   *
   * `createUser` stays as it is, for callers that bring their own username.
   */
  createOAuthUser(data: {
    github_id: string;
    login: string;
    email?: string;
    avatar_url?: string;
  }): Promise<{ user: User; derived: number | null }>;
  updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null>;
  /**
   * What deleting the account `userId` will have to remove from object
   * storage, read before anything is deleted: its username, the bundle keys of
   * its agents' versions, the runs of the deletion's scope (see `deleteUser`)
   * whose output objects still wait for their purge, and whether the namespace
   * is shared. `null`
   * when there is no such account. Reads only.
   */
  planUserDeletion(userId: string): Promise<UserDeletionPlan | null>;
  /**
   * Delete the account `userId`, in one transaction on the SQL backends (one
   * synchronous body in memory). `null` when there is no such account — a
   * second deletion of the same account is not an error.
   *
   * The scope is every run the account launched (`user_id`), every run of one
   * of its agents, whoever launched it, and — unless the namespace is shared
   * (another account with the same username, or an agent under it another
   * account owns) — every run left without an agent whose `agent_version`
   * starts with `<namespace>/`: the runs of an agent the account deleted
   * before its own deletion, which detached them without clearing them. Those
   * are found by the text of their version, compared exactly, there being no
   * agent left to link them. Before the account row goes, each
   * run of the scope is **cleared**: `input`, `output` and `error` become null,
   * `files` an empty list, `content_cleared_at` is set to `at`, and
   * `agent_version` loses the account's namespace and the agent's name
   * (`<namespace>/<name>@<version>` becomes `@<version>`) when it names the
   * account's namespace and the run's agent is one of the account's agents, or
   * gone — a run of the account on another account's agent keeps it. Runs of
   * `purged_output_run_ids` get `outputs_purged_at = at` (their objects were
   * deleted beforehand). Usage, model, status, durations and timestamps stay.
   *
   * Then the account row is deleted, and with it, as the foreign keys say:
   * its API keys and their agent grants, its agents with their versions,
   * creator LLM keys, grants and notebooks, its environments, its device codes,
   * its sessions, and every notebook written under it or under one of its keys
   * in another account's agent. Runs are **detached**, never deleted: their
   * `user_id`, `agent_id`, `api_key_id`, `environment_id` that named what went
   * become null. A `shared` notebook of another account's agent stays, whoever
   * wrote it. Nothing else is written: no row records that the account existed.
   *
   * Postgres takes its row locks in the order an insert of a run takes its
   * foreign key locks — the account's agents, the account row, then the
   * agents again (one born in between) and the account's keys —, then the runs
   * of the scope, before it reads anything from them: a completion that
   * committed first is read with its files, one that comes after waits and
   * finds the run cleared. It runs the transaction again, at most three times
   * in all, when Postgres reports a deadlock. It sets the runs' references
   * to null itself, before the account row goes: left to the foreign keys'
   * actions, which Postgres runs in the order of their triggers' names, the
   * check of a run it just cleared could come before the action that detaches
   * it from an agent, a key or an environment already deleted, and fail the
   * deletion.
   */
  deleteUser(
    userId: string,
    opts: { purged_output_run_ids: string[]; at: string },
  ): Promise<UserDeletionResult | null>;
  /**
   * True when an account carries `namespace` as its username, or an agent
   * lives under it. Read after a deletion commits: the name is free again
   * from that moment, and a new holder must not lose what it pushed.
   */
  namespaceInUse(namespace: string): Promise<boolean>;
  /**
   * The keys among `keys` that a version row still names, without duplicates —
   * only versions of agents not owned by `exceptOwnerId`, when it is given: an
   * account being deleted still names its own keys, and what matters is whether
   * another account's version names one too (two accounts can share a
   * namespace on the SQLite and in-memory stores, and so a key).
   */
  referencedBundleKeys(keys: string[], exceptOwnerId?: string): Promise<string[]>;

  // --- API Keys ---
  getApiKeyByHash(keyHash: string): Promise<ApiKey | null>;
  createApiKey(data: {
    user_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    scopes?: string[];
    /** Resource binding. Defaults to `account` when omitted. */
    scope_kind?: ApiKeyScopeKind;
    /**
     * Agent ids the key is scoped to. Persisted as `api_key_agents` rows.
     * Only meaningful when `scope_kind === 'agents'`. Ownership is validated
     * at the route layer (a minter can only scope to agents they own).
     */
    agents?: string[];
    expires_at?: string;
  }): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<boolean>;
  deleteApiKeyByOwner(id: string, userId: string): Promise<boolean>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
  updateApiKeyLastUsed(id: string): Promise<void>;
  /**
   * Agent ids a scoped key grants access to (the `api_key_agents` rows).
   * Empty for account-wide keys, or for an `agents` key whose grants were all
   * removed (e.g. the agents were deleted → FK cascade) — the latter is the
   * fail-closed deny-all case.
   */
  getApiKeyAgentIds(keyId: string): Promise<string[]>;

  // --- Device codes (CLI device-login flow, RFC 8628) ---
  /**
   * Create a PENDING device code. The `device_code_hash` / `user_code_hash` are
   * SHA-256 of the raw codes (the caller hashes — the raw codes are never stored).
   * No token is stored: the API key is minted at poll-success (mint-at-poll).
   */
  createDeviceCode(data: {
    device_code_hash: string;
    user_code_hash: string;
    code_challenge: string;
    expires_at: string;
    current_interval?: number;
  }): Promise<void>;
  getDeviceCodeByDeviceHash(deviceCodeHash: string): Promise<DeviceCode | null>;
  getDeviceCodeByUserHash(userCodeHash: string): Promise<DeviceCode | null>;
  /**
   * Bind a PENDING code to the authenticated user (the GitHub-OAuth browser leg),
   * keyed by `user_code_hash` (the browser holds the user_code). Returns true iff a
   * pending code was authorized; false for unknown / already-authorized / consumed.
   */
  authorizeDeviceCode(userCodeHash: string, userId: string): Promise<boolean>;
  /**
   * Record a poll: set `last_polled_at = now`; when `slowDown`, also bump
   * `current_interval` by 5 (RFC 8628 §3.5 back-off, tracked server-side).
   */
  recordDeviceCodePoll(deviceCodeHash: string, slowDown: boolean): Promise<void>;
  /** Increment and return the PKCE-verifier attempt counter (grinding guard). */
  incrementDeviceCodeAttempts(deviceCodeHash: string): Promise<number>;
  /** Delete a code — consumed at token mint, or invalidated past the attempt cap. */
  consumeDeviceCode(deviceCodeHash: string): Promise<void>;
  /** Delete all expired codes (opportunistic sweep; no background job needed). */
  purgeExpiredDeviceCodes(): Promise<void>;

  // --- Sessions (the browser session cookie store) ---
  /**
   * Store a browser session. **The caller hashes**: `id_hash` is the SHA-256 of
   * the raw session id, which lives only in the cookie and never reaches this
   * adapter — so a read of the table yields nothing usable as a credential.
   * `expires_at` is an absolute deadline; using a session never extends it.
   */
  createSession(data: { id_hash: string; user_id: string; expires_at: string }): Promise<void>;
  /**
   * The row, or null when no session carries that hash.
   *
   * **Does NOT filter on expiry.** An expired row is returned like any other:
   * the expiry decision belongs to one caller, taken once for all three
   * backends, which then deletes the row it found expired. A backend filtering
   * here would make that caller's delete unreachable — and the three backends
   * would each be answering a slightly different question.
   */
  getSession(idHash: string): Promise<Session | null>;
  /** Delete one session — logout, or a row found expired on read. */
  deleteSession(idHash: string): Promise<void>;
  /** Delete every expired session (the hourly sweep on each instance). */
  purgeExpiredSessions(): Promise<void>;

  // --- Runs ---
  createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    /** The API key that initiated the run (per-key metering). Null for session/dev-token. */
    api_key_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
    /**
     * Override the row's creation timestamp (ISO 8601). Defaults to "now" when
     * omitted — production always omits it. Exposed for backfill/import and for
     * tests that need to place runs in specific time buckets (stats windows).
     */
    created_at?: string;
  }): Promise<Run>;
  /**
   * Write a run's row only if its account and the instance still have room:
   * the admission and the write are one step. The row is written `running`,
   * `created_at` set to `now`, `deadline_at` to `deadlineAt`, and
   * `pool_entitled` to the right it was given — which only `returnPoolRight`
   * takes back.
   *
   * Refused, in this order — the first that applies: `compute` (the account's
   * compute in the window has reached its limit), `concurrency` (its seats
   * have), `instance` (the instance's have). A run without an account is
   * bounded by the instance alone. Reaching a limit refuses (`used ≥ limit`).
   * A refusal writes nothing.
   *
   * The right to a pooled machine, while a pool runs: a run without an
   * account always has it, an account's run has it while fewer than
   * `fastRunsPerHour` of the account's runs created within the rolling hour
   * (`FAST_RUN_WINDOW_MS`, strictly) hold it — a run that gave it back
   * (`returnPoolRight`) no longer does —, and every run has it when that
   * bound is off. Without a pool, no run has it.
   *
   * When nothing bounds the run — no bound of its account applies and no
   * instance cap is set — the row is written by `createRun`'s plain insert, its
   * deadline and right to the pool set, with no lock and no read. Otherwise the reads and the write are exclusive per
   * account, and per instance when a cap is set: Postgres takes advisory locks
   * in one transaction bounded in time (a lock or statement timeout is `busy`),
   * SQLite an `immediate` transaction, memory one synchronous body.
   *
   * Rejects, writing nothing, when the account, the agent or the key the row
   * names does not exist — the refusal `createRun` makes.
   */
  admitRun(admission: RunAdmission): Promise<RunAdmissionResult>;
  /**
   * Give back the right to a pooled machine that the admission gave the run
   * `id`: its `pool_entitled` set to false, and nothing else of the row —
   * `true` when a right was given back. The condition is in the write itself
   * (in SQL, the `WHERE` of the one statement; in memory, the same synchronous
   * body): a row that does not hold the right — never given, given back
   * already, or no such row — is not written, and `false` comes back. Nothing
   * is asked of the run's status nor of its account: a finished run, or one
   * whose account was deleted, gives its right back as well.
   *
   * No account lock, no transaction: a right given back is one no pooled
   * machine will take any more. An admission of the account that read its
   * sums before the write counts the right still held — it may send its run
   * to the cold path a moment too early, never give a right too many.
   * `admitRun` alone gives the right; this alone takes it back.
   */
  returnPoolRight(id: string): Promise<boolean>;
  /**
   * What the account `userId` consumes at `now` (`AccountUsage`), without a
   * lock: the same sums the admission reads. `windowStart` null → no compute
   * read (0); `fastSince` null → no fast run read (0, `null`). With
   * `instance`, the instance's seats are read too. With `fastLimit`, the
   * account's fast runs per hour, `releasingFastRunAt` too — one more read,
   * of the account's runs created after `fastSince` alone; an admission
   * never asks it. A null `userId` reads no account (zeros, `null`).
   */
  getAccountUsage(
    userId: string | null,
    at: {
      now: string;
      windowStart: string | null;
      fastSince: string | null;
      instance?: boolean;
      fastLimit?: number;
    },
  ): Promise<AccountUsage>;
  /**
   * `purge_after` is written here, in the same update as `files` and
   * `completed_at`, never on its own. The purge mark is not an updatable field:
   * `markRunOutputsPurged` is its only writer.
   *
   * On a run whose content was cleared (`content_cleared_at` set, by an account
   * deletion), the content fields — `output`, `error`, `files`, `purge_after`,
   * `RUN_CONTENT_FIELDS` — keep their stored value; the rest is written. The
   * mark is tested in the write itself (in SQL, a `CASE` in the same `UPDATE`;
   * in memory, the same synchronous body), never read beforehand: a completion
   * that waited on the row while a deletion cleared it sees the cleared row.
   * The row handed back carries the mark.
   *
   * It writes whatever row it is given, whatever its status: a run's final
   * status goes through `finishRun`, which does not.
   */
  updateRun(id: string, data: RunWrite): Promise<Run | null>;
  /**
   * A run's final write: `updateRun`'s, cleared content included, on a row that
   * is still `running` — and on no other, but one: with
   * `replaceShutdownProvisional`, a completion also replaces a `failed` row
   * whose `error` is exactly `SHUTDOWN_RUN_ERROR`, the provisional failure a
   * server's stop writes. Never another failure, never a failure over it (the
   * option on a `failed` write replaces nothing), and never a provisional
   * failure on a cleared row, whose error the clearing kept empty. A finished
   * row is otherwise never written again.
   *
   * The condition is tested in the write itself (in SQL, the `WHERE` of the
   * same `UPDATE`; in memory, the same synchronous body), never read before it:
   * of two final writes racing on one row, one lands. Hands back the row
   * written, or `null` when none was — the row is absent, or already finished.
   */
  finishRun(
    id: string,
    data: FinalRunWrite,
    options?: { replaceShutdownProvisional?: boolean },
  ): Promise<Run | null>;
  getRun(id: string): Promise<Run | null>;
  listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]>;
  /**
   * How many runs an agent has, and the sum of their `usage_total_tokens` (a
   * run without one counts 0): every run of the agent, whatever its status and
   * whoever launched it — what an agent's metadata reports. Counted where the
   * runs are stored, without reading their content: listing them would carry
   * every input and output for two numbers.
   */
  getAgentRunTotals(agentId: string): Promise<{ run_count: number; token_count: number }>;
  /**
   * The runs whose output files in object storage are due for deletion:
   * `purge_after <= now` and no purge mark yet, oldest deadline first, at most
   * `limit` rows. Only `id` and `files` — the object keys are rebuilt from them.
   * `now` is the caller's clock, in `toISOString()` form — the form the deadline
   * is written in (the SQLite store compares them as text).
   */
  listRunsDueForOutputPurge(now: string, limit: number): Promise<Array<Pick<Run, "id" | "files">>>;
  /**
   * Record that a run's output objects are gone. Idempotent: a run already
   * marked keeps its first date, so two instances purging the same run at once
   * both succeed and the first mark written stands. The only writer of
   * `outputs_purged_at`.
   */
  markRunOutputsPurged(id: string, at: string): Promise<void>;

  // --- Stats ---
  getStats(opts?: { userId?: string }): Promise<{
    agents_count: number;
    runs_today: number;
    tokens_today: number;
    failed_today: number;
    runs_yesterday: number;
    tokens_yesterday: number;
    failed_yesterday: number;
    daily_runs: number[];
    daily_tokens: number[];
    daily_failed: number[];
    cache_savings_today: number;
    cache_savings_yesterday: number;
    daily_cache_savings: number[];
    cost_today: number;
    cost_yesterday: number;
    daily_cost: number[];
  }>;

  getAgentStats(
    agentId: string,
    days?: number,
  ): Promise<{
    runs: number;
    tokens: number;
    failed: number;
    avg_duration_ms: number;
    prev_runs: number;
    prev_tokens: number;
    prev_failed: number;
    prev_avg_duration_ms: number;
    daily_runs: number[];
    daily_tokens: number[];
    daily_failed: number[];
    daily_avg_duration_ms: number[];
    cache_savings: number;
    prev_cache_savings: number;
    daily_cache_savings: number[];
    cost: number;
    prev_cost: number;
    daily_cost: number[];
  }>;

  // --- Environments ---
  getEnvironment(id: string): Promise<Environment | null>;
  createEnvironment(data: {
    name: string;
    owner_id: string;
    config: Record<string, unknown>;
  }): Promise<Environment>;
  listEnvironments(ownerId: string): Promise<Environment[]>;
}
