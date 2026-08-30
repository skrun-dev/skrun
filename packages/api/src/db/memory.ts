import { randomUUID } from "node:crypto";
import type { DbAdapter } from "./adapter.js";
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
  type User,
} from "./schema.js";

export class MemoryDb implements DbAdapter {
  private agents = new Map<string, Agent>();
  private versions = new Map<string, AgentVersion[]>();
  private states = new Map<string, Record<string, unknown>>();
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
    const key = this.agentKey(namespace, name);
    const agent = this.agents.get(key);
    if (!agent) return false;
    this.versions.delete(agent.id);
    this.agents.delete(key);
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
    return true;
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

  async getState(agentName: string): Promise<Record<string, unknown> | null> {
    const state = this.states.get(agentName);
    return state ? structuredClone(state) : null;
  }

  async setState(agentName: string, state: Record<string, unknown>): Promise<void> {
    this.states.set(agentName, structuredClone(state));
  }

  async deleteState(agentName: string): Promise<void> {
    this.states.delete(agentName);
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
    this.apiKeysByHash.delete(key.key_hash);
    this.apiKeys.delete(id);
    this.apiKeyAgents.delete(id);
    this.nullifyApiKeyOnRuns(id);
    return true;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.user_id !== userId) return false;
    this.apiKeysByHash.delete(key.key_hash);
    this.apiKeys.delete(id);
    this.apiKeyAgents.delete(id);
    this.nullifyApiKeyOnRuns(id);
    return true;
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
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(
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
  ): Promise<Run | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    Object.assign(run, data);
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
    this.runs.clear();
    this.environments.clear();
  }
}
