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
  User,
} from "./schema.js";

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
   * existing key for that pair. `ciphertext` is the opaque AES-256-GCM envelope;
   * `last4` is display-only. Never returned by a read endpoint.
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
  getVersions(agentId: string): Promise<AgentVersion[]>;
  getLatestVersion(agentId: string): Promise<AgentVersion | null>;
  getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null>;
  deleteVersion(agentId: string, version: string): Promise<void>;
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
  getState(agentName: string): Promise<Record<string, unknown> | null>;
  setState(agentName: string, state: Record<string, unknown>): Promise<void>;
  deleteState(agentName: string): Promise<void>;

  // --- Users ---
  getUserByGithubId(githubId: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User>;
  updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null>;

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
   * No token is stored: the `sk_live` is minted at poll-success (mint-at-poll).
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
  updateRun(
    id: string,
    data: Partial<
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
      >
    >,
  ): Promise<Run | null>;
  getRun(id: string): Promise<Run | null>;
  listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]>;

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
