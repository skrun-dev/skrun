import { randomUUID } from "node:crypto";
import {
  type AccountUsage,
  admissionIsBounded,
  admissionVerdict,
  type DbAdapter,
  type FinalRunWrite,
  fastRunsSince,
  RUN_CONTENT_FIELDS,
  type RunAdmission,
  type RunAdmissionResult,
  type RunWrite,
  releasingFastRunOffset,
  SHUTDOWN_RUN_ERROR,
} from "./adapter.js";
import {
  derivedNamespace,
  NAMESPACE_MAX_ATTEMPTS,
  NamespaceUnavailableError,
  namespaceBase,
} from "./namespace.js";
import { MissingRunReferenceError } from "./reference-errors.js";
import {
  type Agent,
  type AgentLlmKeyInfo,
  type AgentLlmKeyPolicy,
  type AgentLlmKeyRecord,
  type AgentVersion,
  API_KEY_DEFAULT_SCOPES,
  type ApiKey,
  type ApiKeyScopeKind,
  type DeviceCode,
  type Environment,
  type Run,
  type RunStatus,
  type Session,
  type StatePartition,
  type StoredState,
  type User,
  type UserDeletionPlan,
  type UserDeletionResult,
} from "./schema.js";
import { MissingStateReferenceError } from "./state-errors.js";

/** One stored notebook: the row the SQL backends keep in `agent_state`. */
interface StateRow {
  agent_id: string;
  caller_user_id: string | null;
  caller_key_id: string | null;
  state: Record<string, unknown>;
  updated_at: string;
  expires_at: string;
}

/**
 * The partition's key, in the form the SQL backends compute in SQL:
 * `shared`, `account:<user id>`, `key:<key id>`.
 */
function partitionKey(partition: StatePartition): string {
  if (partition.kind === "account") return `account:${partition.userId}`;
  if (partition.kind === "key") return `key:${partition.keyId}`;
  return "shared";
}

/**
 * The time a run counts against its account's compute at `nowMs`, by the
 * expression the SQL backends compute: finished, its `charged_ms`, or the time
 * from its creation to its end when that is null; in flight before its
 * deadline, the time from its creation to now; in flight past its deadline —
 * its process died before writing its status — or without one, 0. Never
 * negative.
 */
function chargedTimeMs(run: Run, nowMs: number): number {
  const createdMs = Date.parse(run.created_at);
  if (run.status !== "running") {
    if (run.charged_ms != null) return run.charged_ms;
    if (run.completed_at == null) return 0;
    return Math.max(0, Date.parse(run.completed_at) - createdMs);
  }
  if (run.deadline_at == null) return 0;
  const deadlineMs = Date.parse(run.deadline_at);
  if (deadlineMs <= nowMs) return 0;
  return Math.max(0, nowMs - createdMs);
}

export class MemoryDb implements DbAdapter {
  private agents = new Map<string, Agent>();
  private versions = new Map<string, AgentVersion[]>();
  /** `<agent id>\u0000<partition key>` -> notebook. */
  private states = new Map<string, StateRow>();
  private users = new Map<string, User>();
  private usersByGithubId = new Map<string, string>();
  private apiKeys = new Map<string, ApiKey>();
  private apiKeysByHash = new Map<string, string>();
  /** keyId -> granted agent ids (only for scope_kind === 'agents' keys). */
  private apiKeyAgents = new Map<string, string[]>();
  /** agentId -> creator-attached encrypted LLM keys (one row per provider). */
  private agentLlmKeys = new Map<string, (AgentLlmKeyRecord & { updated_at: string })[]>();
  /** device_code_hash -> in-flight CLI device-login code (RFC 8628). */
  private deviceCodes = new Map<string, DeviceCode>();
  /** id_hash -> browser session row. The raw id lives only in the cookie. */
  private sessions = new Map<string, Session>();
  private runs = new Map<string, Run>();
  private environments = new Map<string, Environment>();

  private agentKey(namespace: string, name: string): string {
    return `${namespace}/${name}`;
  }

  // --- Agents ---

  async createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
    visibility?: "private" | "public";
  }): Promise<Agent> {
    const key = this.agentKey(data.namespace, data.name);
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      ...data,
      visibility: data.visibility ?? "private",
      llm_key_policy: "open",
      created_at: now,
      updated_at: now,
    };
    this.agents.set(key, agent);
    this.versions.set(agent.id, []);
    return agent;
  }

  async getAgent(namespace: string, name: string): Promise<Agent | null> {
    return this.agents.get(this.agentKey(namespace, name)) ?? null;
  }

  async listAgents(opts: { page: number; limit: number; userId?: string }): Promise<{
    agents: (Agent & { run_count: number; token_count: number; cost_total: number })[];
    total: number;
  }> {
    const { page, limit, userId } = opts;
    const all = [...this.agents.values()];
    const filtered = userId ? all.filter((a) => a.owner_id === userId) : all;
    const start = (page - 1) * limit;

    // Compute per-agent run_count, token_count, cost_total
    const agentCounts = new Map<string, { runs: number; tokens: number; cost: number }>();
    for (const run of this.runs.values()) {
      if (!run.agent_id) continue;
      const counts = agentCounts.get(run.agent_id) ?? { runs: 0, tokens: 0, cost: 0 };
      counts.runs++;
      counts.tokens += run.usage_total_tokens;
      counts.cost += run.usage_estimated_cost ?? 0;
      agentCounts.set(run.agent_id, counts);
    }

    const agents = filtered.slice(start, start + limit).map((agent) => {
      const counts = agentCounts.get(agent.id) ?? { runs: 0, tokens: 0, cost: 0 };
      return {
        ...agent,
        run_count: counts.runs,
        token_count: counts.tokens,
        cost_total: counts.cost,
      };
    });

    return { agents, total: filtered.length };
  }

  async setVersionVerified(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<AgentVersion | null> {
    const agent = await this.getAgent(namespace, name);
    if (!agent) return null;
    const versions = this.versions.get(agent.id);
    if (!versions) return null;
    const target = versions.find((v) => v.version === version);
    if (!target) return null;
    target.verified = verified;
    return target;
  }

  async setVisibility(
    namespace: string,
    name: string,
    visibility: "private" | "public",
  ): Promise<Agent | null> {
    const agent = this.agents.get(this.agentKey(namespace, name));
    if (!agent) return null;
    agent.visibility = visibility;
    agent.updated_at = new Date().toISOString();
    return agent;
  }

  async setLlmKeyPolicy(
    namespace: string,
    name: string,
    policy: AgentLlmKeyPolicy,
  ): Promise<Agent | null> {
    const agent = this.agents.get(this.agentKey(namespace, name));
    if (!agent) return null;
    agent.llm_key_policy = policy;
    agent.updated_at = new Date().toISOString();
    return agent;
  }

  async deleteAgent(namespace: string, name: string): Promise<boolean> {
    const agent = this.agents.get(this.agentKey(namespace, name));
    if (!agent) return false;
    this.removeAgent(agent);
    return true;
  }

  /** Delete an agent and everything its foreign keys take with it. */
  private removeAgent(agent: Agent): void {
    this.versions.delete(agent.id);
    this.agents.delete(this.agentKey(agent.namespace, agent.name));
    // Cascade: drop this agent from any scoped-key grants (mirrors the
    // api_key_agents FK ON DELETE CASCADE — keeps a now-grantless 'agents'
    // key fail-closed = deny-all rather than dangling).
    for (const [keyId, ids] of this.apiKeyAgents) {
      if (ids.includes(agent.id)) {
        const next = ids.filter((aid) => aid !== agent.id);
        if (next.length === 0) this.apiKeyAgents.delete(keyId);
        else this.apiKeyAgents.set(keyId, next);
      }
    }
    // Cascade: drop this agent's creator LLM keys (mirrors the agent_llm_keys
    // FK ON DELETE CASCADE).
    this.agentLlmKeys.delete(agent.id);
    // Cascade: drop every notebook of this agent, every partition (mirrors the
    // agent_state.agent_id FK ON DELETE CASCADE).
    for (const [stateKey, row] of this.states) {
      if (row.agent_id === agent.id) this.states.delete(stateKey);
    }
    // Detach: the agent's runs survive with a null agent_id (mirrors the
    // runs.agent_id FK ON DELETE SET NULL).
    for (const run of this.runs.values()) {
      if (run.agent_id === agent.id) run.agent_id = null;
    }
  }

  // --- Agent Versions ---

  async createVersion(
    agentId: string,
    data: {
      version: string;
      size: number;
      bundle_key: string;
      bundle_sha256?: string | null;
      config_snapshot?: Record<string, unknown>;
      notes?: string | null;
    },
  ): Promise<AgentVersion> {
    const version: AgentVersion = {
      id: randomUUID(),
      agent_id: agentId,
      version: data.version,
      size: data.size,
      bundle_key: data.bundle_key,
      bundle_sha256: data.bundle_sha256 ?? null,
      config_snapshot: data.config_snapshot,
      notes: data.notes ?? null,
      pushed_at: new Date().toISOString(),
      verified: false,
    };
    const versions = this.versions.get(agentId) ?? [];
    versions.push(version);
    this.versions.set(agentId, versions);

    for (const agent of this.agents.values()) {
      if (agent.id === agentId) {
        agent.updated_at = version.pushed_at;
        break;
      }
    }

    return version;
  }

  /**
   * Never unknown: the memory store writes in this process, so a write that
   * throws has done all it will do. What it wrote before failing, if anything,
   * is there to be read: the caller's read decides.
   */
  writeOutcomeUnknown(_err: unknown): boolean {
    return false;
  }

  async getVersions(agentId: string): Promise<AgentVersion[]> {
    return this.versions.get(agentId) ?? [];
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | null> {
    const versions = await this.getVersions(agentId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  async getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null> {
    const versions = await this.getVersions(agentId);
    return versions.find((v) => v.version === version) ?? null;
  }

  async deleteVersion(agentId: string, version: string): Promise<void> {
    const versions = this.versions.get(agentId);
    if (!versions) return;
    const filtered = versions.filter((v) => v.version !== version);
    this.versions.set(agentId, filtered);
  }

  async sumBundleBytesByOwner(ownerId: string): Promise<number> {
    let total = 0;
    for (const agent of this.agents.values()) {
      if (agent.owner_id !== ownerId) continue;
      for (const v of this.versions.get(agent.id) ?? []) total += v.size;
    }
    return total;
  }

  async listVersionsMissingHash(): Promise<Array<{ id: string; bundle_key: string }>> {
    const missing: Array<{ id: string; bundle_key: string }> = [];
    for (const versions of this.versions.values()) {
      for (const v of versions) {
        if (v.bundle_sha256 == null) missing.push({ id: v.id, bundle_key: v.bundle_key });
      }
    }
    return missing;
  }

  async setVersionBundleHash(versionId: string, bundleSha256: string): Promise<void> {
    for (const versions of this.versions.values()) {
      for (const v of versions) {
        if (v.id === versionId) {
          v.bundle_sha256 = bundleSha256;
          return;
        }
      }
    }
  }

  // --- Agent State ---

  private stateKey(agentId: string, partition: StatePartition): string {
    return `${agentId}\u0000${partitionKey(partition)}`;
  }

  async getState(agentId: string, partition: StatePartition): Promise<StoredState | null> {
    const row = this.states.get(this.stateKey(agentId, partition));
    return row ? { state: structuredClone(row.state), expires_at: row.expires_at } : null;
  }

  async setState(
    agentId: string,
    partition: StatePartition,
    state: Record<string, unknown>,
    expiresAt: string,
  ): Promise<void> {
    // Refuse what the SQL backends' foreign keys refuse: a notebook for an
    // agent, an account or a key that does not exist — with the error that
    // says so, as their foreign key violations do.
    if (![...this.agents.values()].some((a) => a.id === agentId)) {
      throw new MissingStateReferenceError("agent", agentId);
    }
    if (partition.kind === "account" && !this.users.has(partition.userId)) {
      throw new MissingStateReferenceError("account", partition.userId);
    }
    if (partition.kind === "key" && !this.apiKeys.has(partition.keyId)) {
      throw new MissingStateReferenceError("key", partition.keyId);
    }
    this.states.set(this.stateKey(agentId, partition), {
      agent_id: agentId,
      caller_user_id: partition.kind === "account" ? partition.userId : null,
      caller_key_id: partition.kind === "key" ? partition.keyId : null,
      state: structuredClone(state),
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    });
  }

  async purgeExpiredState(): Promise<void> {
    // `expires_at < now` on two toISOString() strings, as SQLite compares them;
    // Postgres compares the same instants as timestamptz.
    const now = new Date().toISOString();
    for (const [stateKey, row] of this.states) {
      if (row.expires_at < now) this.states.delete(stateKey);
    }
  }

  /** Mirror the agent_state.caller_key_id FK ON DELETE CASCADE when a key is revoked. */
  private deleteStatesOfKey(keyId: string): void {
    for (const [stateKey, row] of this.states) {
      if (row.caller_key_id === keyId) this.states.delete(stateKey);
    }
  }

  // --- Users ---

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const id = this.usersByGithubId.get(githubId);
    if (!id) return null;
    return this.users.get(id) ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User> {
    return this.insertUser(data);
  }

  async createOAuthUser(data: {
    github_id: string;
    login: string;
    email?: string;
    avatar_url?: string;
  }): Promise<{ user: User; derived: number | null }> {
    // One synchronous body: nothing can run between the read of a name and
    // the insert that takes it.
    const existingId = this.usersByGithubId.get(data.github_id);
    const existing = existingId ? this.users.get(existingId) : undefined;
    if (existing) return { user: existing, derived: null };

    const base = namespaceBase(data.login);
    for (let n = 1; n <= NAMESPACE_MAX_ATTEMPTS; n++) {
      const username = derivedNamespace(base, n);
      if (this.isUsernameTaken(username)) continue;
      const user = this.insertUser({
        github_id: data.github_id,
        username,
        email: data.email,
        avatar_url: data.avatar_url,
      });
      return { user, derived: n === 1 ? null : n };
    }
    throw new NamespaceUnavailableError(NAMESPACE_MAX_ATTEMPTS);
  }

  private isUsernameTaken(username: string): boolean {
    for (const user of this.users.values()) {
      if (user.username === username) return true;
    }
    return false;
  }

  private insertUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): User {
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      github_id: data.github_id,
      username: data.username,
      email: data.email ?? "",
      avatar_url: data.avatar_url ?? "",
      plan: "free",
      role: "user",
      created_at: now,
      updated_at: now,
    };
    this.users.set(user.id, user);
    this.usersByGithubId.set(user.github_id, user.id);
    return user;
  }

  async updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;
    Object.assign(user, data, { updated_at: new Date().toISOString() });
    return user;
  }

  // --- Account deletion ---

  private agentsOwnedBy(userId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.owner_id === userId);
  }

  /**
   * The runs the account launched, every run of one of its agents, and — when
   * `leftBehindPrefix` is given (`<namespace>/`, the namespace being the
   * account's alone) — the runs left without an agent whose version starts
   * with it: runs of an agent the account deleted earlier.
   */
  private runsInDeletionScope(
    userId: string,
    agentIds: Set<string>,
    leftBehindPrefix: string | null,
  ): Run[] {
    return [...this.runs.values()].filter(
      (r) =>
        r.user_id === userId ||
        (r.agent_id !== null && agentIds.has(r.agent_id)) ||
        (leftBehindPrefix !== null &&
          r.agent_id === null &&
          r.agent_version.startsWith(leftBehindPrefix)),
    );
  }

  /** Another account carries `username`, or owns an agent under it. */
  private namespaceShared(userId: string, username: string): boolean {
    return (
      [...this.users.values()].some((u) => u.id !== userId && u.username === username) ||
      [...this.agents.values()].some((a) => a.namespace === username && a.owner_id !== userId)
    );
  }

  /** `<username>/` when the namespace is the account's alone; `null` when it is shared. */
  private leftBehindPrefix(userId: string, username: string): string | null {
    return this.namespaceShared(userId, username) ? null : `${username}/`;
  }

  private bundleKeysOf(agents: Agent[]): string[] {
    return agents.flatMap((a) => (this.versions.get(a.id) ?? []).map((v) => v.bundle_key));
  }

  async planUserDeletion(userId: string): Promise<UserDeletionPlan | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    const agents = this.agentsOwnedBy(userId);
    const agentIds = new Set(agents.map((a) => a.id));
    return {
      username: user.username,
      bundle_keys: this.bundleKeysOf(agents),
      pending_outputs: this.runsInDeletionScope(
        userId,
        agentIds,
        this.leftBehindPrefix(userId, user.username),
      )
        .filter((r) => r.purge_after != null && r.outputs_purged_at == null)
        .map((r) => ({ id: r.id, files: r.files })),
      namespace_shared: this.namespaceShared(userId, user.username),
    };
  }

  async deleteUser(
    userId: string,
    opts: { purged_output_run_ids: string[]; at: string },
  ): Promise<UserDeletionResult | null> {
    // One synchronous body: nothing can run between the reads and the writes.
    const user = this.users.get(userId);
    if (!user) return null;
    const agents = this.agentsOwnedBy(userId);
    const agentIds = new Set(agents.map((a) => a.id));
    const keys = [...this.apiKeys.values()].filter((k) => k.user_id === userId);
    const purged = new Set(opts.purged_output_run_ids);
    const scope = this.runsInDeletionScope(
      userId,
      agentIds,
      this.leftBehindPrefix(userId, user.username),
    );
    const bundleKeys = this.bundleKeysOf(agents);
    const lateOutputs = scope
      .filter((r) => r.purge_after != null && r.outputs_purged_at == null && !purged.has(r.id))
      .map((r) => ({ id: r.id, files: r.files }));

    // Clear and mark the runs of the scope read above: removing the agents and
    // the account below changes nothing of which runs are cleared.
    const namespacePrefix = `${user.username}/`;
    for (const run of scope) {
      run.input = null;
      run.output = null;
      run.error = null;
      run.files = [];
      run.content_cleared_at = opts.at;
      if (
        run.agent_version.startsWith(namespacePrefix) &&
        (run.agent_id === null || agentIds.has(run.agent_id))
      ) {
        const at = run.agent_version.indexOf("@");
        run.agent_version = at >= 0 ? `@${run.agent_version.slice(at + 1)}` : "@";
      }
    }
    for (const id of purged) {
      const run = this.runs.get(id);
      if (run && run.outputs_purged_at == null) run.outputs_purged_at = opts.at;
    }

    // What the foreign keys of the SQL backends do when the account row goes.
    for (const agent of agents) this.removeAgent(agent);
    for (const key of keys) this.removeApiKey(key);
    for (const [envId, env] of this.environments) {
      if (env.owner_id !== userId) continue;
      this.environments.delete(envId);
      for (const run of this.runs.values()) {
        if (run.environment_id === envId) run.environment_id = null;
      }
    }
    for (const [hash, dc] of this.deviceCodes) {
      if (dc.user_id === userId) this.deviceCodes.delete(hash);
    }
    for (const [hash, s] of this.sessions) {
      if (s.user_id === userId) this.sessions.delete(hash);
    }
    for (const [stateKey, row] of this.states) {
      if (row.caller_user_id === userId) this.states.delete(stateKey);
    }
    for (const run of this.runs.values()) {
      if (run.user_id === userId) run.user_id = null;
    }
    if (this.usersByGithubId.get(user.github_id) === userId) {
      this.usersByGithubId.delete(user.github_id);
    }
    this.users.delete(userId);

    return {
      agents: agents.length,
      versions: bundleKeys.length,
      api_keys: keys.length,
      cleared_run_ids: scope.map((r) => r.id),
      late_outputs: lateOutputs,
      bundle_keys: bundleKeys,
    };
  }

  async namespaceInUse(namespace: string): Promise<boolean> {
    return (
      this.isUsernameTaken(namespace) ||
      [...this.agents.values()].some((a) => a.namespace === namespace)
    );
  }

  async referencedBundleKeys(keys: string[], exceptOwnerId?: string): Promise<string[]> {
    const wanted = new Set(keys);
    const excepted = new Set(
      [...this.agents.values()].filter((a) => a.owner_id === exceptOwnerId).map((a) => a.id),
    );
    const found = new Set<string>();
    for (const [agentId, versions] of this.versions) {
      if (excepted.has(agentId)) continue;
      for (const v of versions) if (wanted.has(v.bundle_key)) found.add(v.bundle_key);
    }
    return [...found];
  }

  // --- API Keys ---

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const id = this.apiKeysByHash.get(keyHash);
    if (!id) return null;
    return this.apiKeys.get(id) ?? null;
  }

  async createApiKey(data: {
    user_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    scopes?: string[];
    scope_kind?: ApiKeyScopeKind;
    agents?: string[];
    expires_at?: string;
  }): Promise<ApiKey> {
    const apiKey: ApiKey = {
      id: randomUUID(),
      user_id: data.user_id,
      key_hash: data.key_hash,
      key_prefix: data.key_prefix,
      name: data.name,
      scopes: data.scopes ?? [...API_KEY_DEFAULT_SCOPES],
      scope_kind: data.scope_kind ?? "account",
      last_used_at: null,
      expires_at: data.expires_at ?? null,
      created_at: new Date().toISOString(),
    };
    this.apiKeys.set(apiKey.id, apiKey);
    this.apiKeysByHash.set(apiKey.key_hash, apiKey.id);
    if (data.agents && data.agents.length > 0) {
      this.apiKeyAgents.set(apiKey.id, [...data.agents]);
    }
    return apiKey;
  }

  /** Mirror `runs.api_key_id` FK ON DELETE SET NULL when a key is revoked. */
  private nullifyApiKeyOnRuns(keyId: string): void {
    for (const run of this.runs.values()) {
      if (run.api_key_id === keyId) run.api_key_id = null;
    }
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key) return false;
    this.removeApiKey(key);
    return true;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.user_id !== userId) return false;
    this.removeApiKey(key);
    return true;
  }

  /** Delete a key and everything its foreign keys take with it. */
  private removeApiKey(key: ApiKey): void {
    this.apiKeysByHash.delete(key.key_hash);
    this.apiKeys.delete(key.id);
    this.apiKeyAgents.delete(key.id);
    this.nullifyApiKeyOnRuns(key.id);
    this.deleteStatesOfKey(key.id);
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    return [...this.apiKeys.values()].filter((k) => k.user_id === userId);
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) {
      key.last_used_at = new Date().toISOString();
    }
  }

  async getApiKeyAgentIds(keyId: string): Promise<string[]> {
    return [...(this.apiKeyAgents.get(keyId) ?? [])];
  }

  // --- Device codes (CLI device-login flow, RFC 8628) ---

  async createDeviceCode(data: {
    device_code_hash: string;
    user_code_hash: string;
    code_challenge: string;
    expires_at: string;
    current_interval?: number;
  }): Promise<void> {
    this.deviceCodes.set(data.device_code_hash, {
      device_code_hash: data.device_code_hash,
      user_code_hash: data.user_code_hash,
      code_challenge: data.code_challenge,
      status: "pending",
      user_id: null,
      current_interval: data.current_interval ?? 5,
      attempt_count: 0,
      created_at: new Date().toISOString(),
      expires_at: data.expires_at,
      last_polled_at: null,
    });
  }

  async getDeviceCodeByDeviceHash(deviceCodeHash: string): Promise<DeviceCode | null> {
    return this.deviceCodes.get(deviceCodeHash) ?? null;
  }

  async getDeviceCodeByUserHash(userCodeHash: string): Promise<DeviceCode | null> {
    for (const dc of this.deviceCodes.values()) {
      if (dc.user_code_hash === userCodeHash) return dc;
    }
    return null;
  }

  async authorizeDeviceCode(userCodeHash: string, userId: string): Promise<boolean> {
    for (const dc of this.deviceCodes.values()) {
      if (dc.user_code_hash === userCodeHash && dc.status === "pending") {
        dc.status = "authorized";
        dc.user_id = userId;
        return true;
      }
    }
    return false;
  }

  async recordDeviceCodePoll(deviceCodeHash: string, slowDown: boolean): Promise<void> {
    const dc = this.deviceCodes.get(deviceCodeHash);
    if (!dc) return;
    dc.last_polled_at = new Date().toISOString();
    if (slowDown) dc.current_interval += 5;
  }

  async incrementDeviceCodeAttempts(deviceCodeHash: string): Promise<number> {
    const dc = this.deviceCodes.get(deviceCodeHash);
    if (!dc) return 0;
    dc.attempt_count += 1;
    return dc.attempt_count;
  }

  async consumeDeviceCode(deviceCodeHash: string): Promise<void> {
    this.deviceCodes.delete(deviceCodeHash);
  }

  async purgeExpiredDeviceCodes(): Promise<void> {
    const now = Date.now();
    for (const [hash, dc] of this.deviceCodes) {
      if (new Date(dc.expires_at).getTime() < now) this.deviceCodes.delete(hash);
    }
  }

  // --- Sessions (the browser session cookie store) ---

  async createSession(data: {
    id_hash: string;
    user_id: string;
    expires_at: string;
  }): Promise<void> {
    this.sessions.set(data.id_hash, {
      id_hash: data.id_hash,
      user_id: data.user_id,
      created_at: new Date().toISOString(),
      expires_at: data.expires_at,
    });
  }

  /**
   * The row or null. Does NOT filter on expiry: validateSession decides that
   * once, for all three backends, and deletes the row it found expired.
   */
  async getSession(idHash: string): Promise<Session | null> {
    return this.sessions.get(idHash) ?? null;
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async purgeExpiredSessions(): Promise<void> {
    const now = Date.now();
    for (const [hash, s] of this.sessions) {
      if (new Date(s.expires_at).getTime() < now) this.sessions.delete(hash);
    }
  }

  // --- Agent LLM keys (creator-attached, encrypted) ---

  async setAgentLlmKey(
    agentId: string,
    provider: string,
    ciphertext: string,
    last4: string,
    keyVersion: number,
  ): Promise<void> {
    const next = (this.agentLlmKeys.get(agentId) ?? []).filter((r) => r.provider !== provider);
    next.push({
      agent_id: agentId,
      provider,
      ciphertext,
      last4,
      key_version: keyVersion,
      updated_at: new Date().toISOString(),
    });
    this.agentLlmKeys.set(agentId, next);
  }

  async deleteAgentLlmKey(agentId: string, provider: string): Promise<void> {
    const rows = this.agentLlmKeys.get(agentId);
    if (!rows) return;
    const next = rows.filter((r) => r.provider !== provider);
    if (next.length === 0) this.agentLlmKeys.delete(agentId);
    else this.agentLlmKeys.set(agentId, next);
  }

  async listAgentLlmKeys(agentId: string): Promise<AgentLlmKeyInfo[]> {
    return (this.agentLlmKeys.get(agentId) ?? []).map((r) => ({
      provider: r.provider,
      last4: r.last4,
      updated_at: r.updated_at,
    }));
  }

  async getAgentLlmKeySecrets(agentId: string): Promise<AgentLlmKeyRecord[]> {
    return (this.agentLlmKeys.get(agentId) ?? []).map((r) => ({
      agent_id: r.agent_id,
      provider: r.provider,
      ciphertext: r.ciphertext,
      last4: r.last4,
      key_version: r.key_version,
    }));
  }

  // --- Runs ---

  async createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    api_key_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
    created_at?: string;
  }): Promise<Run> {
    return this.insertRun(data, { deadline_at: null, pool_entitled: false });
  }

  async admitRun(admission: RunAdmission): Promise<RunAdmissionResult> {
    // One synchronous body, from the first read to the write: no other
    // admission can slip between them.
    const insert = (poolEntitled: boolean): Run =>
      this.insertRun(
        { ...admission.run, status: "running", created_at: admission.now },
        { deadline_at: admission.deadlineAt, pool_entitled: poolEntitled },
      );
    if (!admissionIsBounded(admission)) {
      const poolEntitled = admission.poolRunning;
      return { admitted: true, run: insert(poolEntitled), poolEntitled, usage: null };
    }
    // Synchronous from here to the write: no `await`.
    const usage = this.usageOf(admission.run.user_id ?? null, {
      nowMs: Date.parse(admission.now),
      windowStartMs: admission.windowStart === null ? null : Date.parse(admission.windowStart),
      fastSinceMs: Date.parse(fastRunsSince(admission.now)),
      instance: admission.limits.instanceCap !== null,
    });
    const verdict = admissionVerdict(admission, usage);
    if (!verdict.admitted) return { admitted: false, reason: verdict.reason, usage };
    return {
      admitted: true,
      run: insert(verdict.poolEntitled),
      poolEntitled: verdict.poolEntitled,
      usage,
    };
  }

  async returnPoolRight(id: string): Promise<boolean> {
    // The condition is read in the same synchronous body as the write.
    const run = this.runs.get(id);
    if (run?.pool_entitled !== true) return false;
    run.pool_entitled = false;
    return true;
  }

  async getAccountUsage(
    userId: string | null,
    at: {
      now: string;
      windowStart: string | null;
      fastSince: string | null;
      instance?: boolean;
      fastLimit?: number;
    },
  ): Promise<AccountUsage> {
    const usage = this.usageOf(userId, {
      nowMs: Date.parse(at.now),
      windowStartMs: at.windowStart === null ? null : Date.parse(at.windowStart),
      fastSinceMs: at.fastSince === null ? null : Date.parse(at.fastSince),
      instance: at.instance === true,
    });
    if (at.fastLimit !== undefined) {
      usage.releasingFastRunAt = this.releasingFastRunAt(
        userId,
        at.fastSince,
        releasingFastRunOffset(usage.fastRunsUsed, at.fastLimit),
      );
    }
    return usage;
  }

  /**
   * The creation of the account's run with the right to a pooled machine,
   * created strictly after `fastSince`, that `offset` others precede, oldest
   * first — `null` when there is none.
   */
  private releasingFastRunAt(
    userId: string | null,
    fastSince: string | null,
    offset: number,
  ): string | null {
    // A null `userId` would match the runs without an account: none is read.
    if (userId === null || fastSince === null) return null;
    const sinceMs = Date.parse(fastSince);
    const created: string[] = [];
    for (const run of this.runs.values()) {
      if (run.user_id === userId && run.pool_entitled && Date.parse(run.created_at) > sinceMs) {
        created.push(run.created_at);
      }
    }
    created.sort((a, b) => Date.parse(a) - Date.parse(b));
    return created[offset] ?? null;
  }

  /** The sums an admission reads, over the stored rows — in one synchronous body. */
  private usageOf(
    userId: string | null,
    at: {
      nowMs: number;
      windowStartMs: number | null;
      fastSinceMs: number | null;
      instance: boolean;
    },
  ): AccountUsage {
    const holdsSeat = (run: Run): boolean =>
      run.status === "running" && run.deadline_at != null && Date.parse(run.deadline_at) > at.nowMs;
    const usage: AccountUsage = {
      seatsInUse: 0,
      computeUsedMs: 0,
      fastRunsUsed: 0,
      // Read apart, and only when asked (`getAccountUsage`).
      releasingFastRunAt: null,
      instanceSeatsInUse: null,
    };
    let instanceSeats = 0;
    for (const run of this.runs.values()) {
      if (at.instance && holdsSeat(run)) instanceSeats += 1;
      if (userId === null || run.user_id !== userId) continue;
      if (holdsSeat(run)) usage.seatsInUse += 1;
      const createdMs = Date.parse(run.created_at);
      if (at.windowStartMs !== null && createdMs >= at.windowStartMs) {
        usage.computeUsedMs += chargedTimeMs(run, at.nowMs);
      }
      if (at.fastSinceMs !== null && run.pool_entitled && createdMs > at.fastSinceMs) {
        usage.fastRunsUsed += 1;
      }
    }
    if (at.instance) usage.instanceSeatsInUse = instanceSeats;
    return usage;
  }

  /** Write a new run row, refused as the SQL backends' foreign keys refuse it. */
  private insertRun(
    data: {
      id: string;
      agent_id: string | null;
      agent_version: string;
      model?: string | null;
      environment_id?: string | null;
      user_id?: string | null;
      api_key_id?: string | null;
      status: RunStatus;
      input?: Record<string, unknown>;
      created_at?: string;
    },
    admitted: Pick<Run, "deadline_at" | "pool_entitled">,
  ): Run {
    // Refuse what the SQL backends' foreign keys refuse: a run naming an
    // account, an agent or a key that does not exist.
    if (data.user_id != null && !this.users.has(data.user_id)) {
      throw new MissingRunReferenceError("account", data.user_id);
    }
    if (data.agent_id != null && ![...this.agents.values()].some((a) => a.id === data.agent_id)) {
      throw new MissingRunReferenceError("agent", data.agent_id);
    }
    if (data.api_key_id != null && !this.apiKeys.has(data.api_key_id)) {
      throw new MissingRunReferenceError("key", data.api_key_id);
    }
    const run: Run = {
      id: data.id,
      agent_id: data.agent_id,
      agent_version: data.agent_version,
      model: data.model ?? null,
      environment_id: data.environment_id ?? null,
      user_id: data.user_id ?? null,
      api_key_id: data.api_key_id ?? null,
      status: data.status,
      input: data.input ?? null,
      output: null,
      error: null,
      usage_prompt_tokens: 0,
      usage_completion_tokens: 0,
      usage_total_tokens: 0,
      usage_estimated_cost: 0,
      usage_cache_read_tokens: 0,
      usage_cache_write_tokens: 0,
      usage_cache_savings_usd: 0,
      duration_ms: null,
      machine_id: null,
      private_ip: null,
      phase_timings: null,
      files: null,
      created_at: data.created_at ?? new Date().toISOString(),
      completed_at: null,
      purge_after: null,
      outputs_purged_at: null,
      content_cleared_at: null,
      deadline_at: admitted.deadline_at,
      charged_ms: null,
      pool_entitled: admitted.pool_entitled,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(id: string, data: RunWrite): Promise<Run | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    return this.writeRunRow(run, data);
  }

  async finishRun(
    id: string,
    data: FinalRunWrite,
    options?: { replaceShutdownProvisional?: boolean },
  ): Promise<Run | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    // Only a completion replaces the stop's provisional failure, and only when it asks.
    const replaceProvisional =
      options?.replaceShutdownProvisional === true && data.status === "completed";
    // The condition is read in the same synchronous body as the write.
    const finishable =
      run.status === "running" ||
      (replaceProvisional && run.status === "failed" && run.error === SHUTDOWN_RUN_ERROR);
    if (!finishable) return null;
    return this.writeRunRow(run, data);
  }

  /** The write of a run row that `updateRun` and `finishRun` share. */
  private writeRunRow(run: Run, data: RunWrite): Run {
    // A cleared run keeps its content; the mark is read in the same
    // synchronous body as the write.
    const writes =
      run.content_cleared_at == null
        ? data
        : Object.fromEntries(Object.entries(data).filter(([key]) => !RUN_CONTENT_FIELDS.has(key)));
    Object.assign(run, writes);
    return run;
  }

  async getRun(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]> {
    let results = [...this.runs.values()];
    if (filters?.agent_id) {
      results = results.filter((r) => r.agent_id === filters.agent_id);
    }
    if (filters?.user_id) {
      results = results.filter((r) => r.user_id === filters.user_id);
    }
    if (filters?.status) {
      results = results.filter((r) => r.status === filters.status);
    }
    results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (filters?.limit) {
      results = results.slice(0, filters.limit);
    }
    return results;
  }

  async getAgentRunTotals(agentId: string): Promise<{ run_count: number; token_count: number }> {
    let run_count = 0;
    let token_count = 0;
    for (const run of this.runs.values()) {
      if (run.agent_id !== agentId) continue;
      run_count++;
      token_count += run.usage_total_tokens ?? 0;
    }
    return { run_count, token_count };
  }

  async listRunsDueForOutputPurge(
    now: string,
    limit: number,
  ): Promise<Array<Pick<Run, "id" | "files">>> {
    const cutoff = new Date(now).getTime();
    const deadline = (r: Run) => new Date(r.purge_after as string).getTime();
    return [...this.runs.values()]
      .filter((r) => r.purge_after != null && r.outputs_purged_at == null && deadline(r) <= cutoff)
      .sort((a, b) => deadline(a) - deadline(b))
      .slice(0, limit)
      .map((r) => ({ id: r.id, files: r.files }));
  }

  async markRunOutputsPurged(id: string, at: string): Promise<void> {
    const run = this.runs.get(id);
    if (run && run.outputs_purged_at == null) run.outputs_purged_at = at;
  }

  // --- Stats ---

  async getStats(opts?: { userId?: string }) {
    // Per-user multi-tenancy: count only the caller's own agents (owner_id),
    // matching the user_id filter applied to the run aggregates below.
    const agents_count = opts?.userId
      ? [...this.agents.values()].filter((a) => a.owner_id === opts.userId).length
      : this.agents.size;

    const now = new Date();
    // Calendar-day anchor — for the per-day sparkline buckets only.
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    // Rolling windows — headline today/yesterday tiles are trailing 24h / prior
    // 24h (not UTC calendar days). Field names kept for wire compatibility.
    const last24hISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const prev24hISO = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyCacheSavings = new Array<number>(7).fill(0);
    const dailyCost = new Array<number>(7).fill(0);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    let runs_today = 0;
    let tokens_today = 0;
    let failed_today = 0;
    let runs_yesterday = 0;
    let tokens_yesterday = 0;
    let failed_yesterday = 0;
    let cache_savings_today = 0;
    let cache_savings_yesterday = 0;
    let cost_today = 0;
    let cost_yesterday = 0;

    for (const run of this.runs.values()) {
      // Multi-tenancy filter: when userId provided, skip runs from other users
      if (opts?.userId && run.user_id !== opts.userId) continue;

      const isFailed = run.status === "failed";
      const cacheSavings = run.usage_cache_savings_usd ?? 0;
      const cost = run.usage_estimated_cost ?? 0;
      if (run.created_at >= last24hISO) {
        runs_today++;
        tokens_today += run.usage_total_tokens;
        cache_savings_today += cacheSavings;
        cost_today += cost;
        if (isFailed) failed_today++;
      } else if (run.created_at >= prev24hISO) {
        runs_yesterday++;
        tokens_yesterday += run.usage_total_tokens;
        cache_savings_yesterday += cacheSavings;
        cost_yesterday += cost;
        if (isFailed) failed_yesterday++;
      }

      if (run.created_at >= sevenDaysAgoISO) {
        const runDate = new Date(run.created_at);
        const dayIndex = Math.floor(
          (runDate.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyRuns[dayIndex]++;
          dailyTokens[dayIndex] += run.usage_total_tokens;
          dailyCacheSavings[dayIndex] += cacheSavings;
          dailyCost[dayIndex] += cost;
          if (isFailed) dailyFailed[dayIndex]++;
        }
      }
    }

    return {
      agents_count,
      runs_today,
      tokens_today,
      failed_today,
      runs_yesterday,
      tokens_yesterday,
      failed_yesterday,
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      cache_savings_today,
      cache_savings_yesterday,
      daily_cache_savings: dailyCacheSavings,
      cost_today,
      cost_yesterday,
      daily_cost: dailyCost,
    };
  }

  async getAgentStats(agentId: string, days = 7) {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const periodStart = new Date(todayStart);
    periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);
    const periodISO = periodStart.toISOString();

    const prevStart = new Date(periodStart);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);
    const prevISO = prevStart.toISOString();

    let runs = 0;
    let tokens = 0;
    let failed = 0;
    let totalDuration = 0;
    let cacheSavings = 0;
    let cost = 0;
    let prevRuns = 0;
    let prevTokens = 0;
    let prevFailed = 0;
    let prevTotalDuration = 0;
    let prevCacheSavings = 0;
    let prevCost = 0;

    // Existing daily arrays remain hardcoded to 7 for sparkline UX consistency
    // (matches the home page's 7-day sparkline contract).
    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyDurTotal = new Array<number>(7).fill(0);
    const dailyDurCount = new Array<number>(7).fill(0);

    // daily_cache_savings + daily_cost array lengths match the `days` parameter
    // (window starts `days` back from today). Other daily arrays remain at
    // 7 for sparkline UX consistency on the home page.
    const dailyCacheSavings = new Array<number>(days).fill(0);
    const dailyCost = new Array<number>(days).fill(0);

    // 7-day window for the existing daily arrays (independent of the main period)
    const dailyStart = new Date(todayStart);
    dailyStart.setUTCDate(dailyStart.getUTCDate() - 6);

    for (const run of this.runs.values()) {
      if (run.agent_id !== agentId) continue;
      const isFailed = run.status === "failed";
      const runCacheSavings = run.usage_cache_savings_usd ?? 0;
      const runCost = run.usage_estimated_cost ?? 0;

      if (run.created_at >= periodISO) {
        runs++;
        tokens += run.usage_total_tokens;
        cacheSavings += runCacheSavings;
        cost += runCost;
        if (isFailed) failed++;
        if (run.duration_ms !== null) totalDuration += run.duration_ms;
      } else if (run.created_at >= prevISO) {
        prevRuns++;
        prevTokens += run.usage_total_tokens;
        prevCacheSavings += runCacheSavings;
        prevCost += runCost;
        if (isFailed) prevFailed++;
        if (run.duration_ms !== null) prevTotalDuration += run.duration_ms;
      }

      // Populate existing daily arrays from 7-day window
      if (run.created_at >= dailyStart.toISOString()) {
        const runDate = new Date(run.created_at);
        const dayIndex = Math.floor(
          (runDate.getTime() - dailyStart.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyRuns[dayIndex]++;
          dailyTokens[dayIndex] += run.usage_total_tokens;
          if (isFailed) dailyFailed[dayIndex]++;
          if (run.duration_ms !== null) {
            dailyDurTotal[dayIndex] += run.duration_ms;
            dailyDurCount[dayIndex]++;
          }
        }
      }

      // Populate daily_cache_savings + daily_cost using the parameterized window
      if (run.created_at >= periodISO) {
        const runDate = new Date(run.created_at);
        const periodDayIndex = Math.floor(
          (runDate.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (periodDayIndex >= 0 && periodDayIndex < days) {
          dailyCacheSavings[periodDayIndex] += runCacheSavings;
          dailyCost[periodDayIndex] += runCost;
        }
      }
    }

    return {
      runs,
      tokens,
      failed,
      avg_duration_ms: runs > 0 ? Math.round(totalDuration / runs) : 0,
      prev_runs: prevRuns,
      prev_tokens: prevTokens,
      prev_failed: prevFailed,
      prev_avg_duration_ms: prevRuns > 0 ? Math.round(prevTotalDuration / prevRuns) : 0,
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      daily_avg_duration_ms: dailyDurCount.map((c, i) =>
        c > 0 ? Math.round(dailyDurTotal[i] / c) : 0,
      ),
      cache_savings: cacheSavings,
      prev_cache_savings: prevCacheSavings,
      daily_cache_savings: dailyCacheSavings,
      cost,
      prev_cost: prevCost,
      daily_cost: dailyCost,
    };
  }

  // --- Environments ---

  async getEnvironment(id: string): Promise<Environment | null> {
    return this.environments.get(id) ?? null;
  }

  async createEnvironment(data: {
    name: string;
    owner_id: string;
    config: Record<string, unknown>;
  }): Promise<Environment> {
    const now = new Date().toISOString();
    const env: Environment = {
      id: randomUUID(),
      name: data.name,
      owner_id: data.owner_id,
      config: data.config,
      created_at: now,
      updated_at: now,
    };
    this.environments.set(env.id, env);
    return env;
  }

  async listEnvironments(ownerId: string): Promise<Environment[]> {
    return [...this.environments.values()].filter((e) => e.owner_id === ownerId);
  }

  // --- Utility ---

  clear(): void {
    this.agents.clear();
    this.versions.clear();
    this.states.clear();
    this.users.clear();
    this.usersByGithubId.clear();
    this.apiKeys.clear();
    this.apiKeysByHash.clear();
    this.agentLlmKeys.clear();
    this.deviceCodes.clear();
    this.sessions.clear();
    this.runs.clear();
    this.environments.clear();
  }
}
