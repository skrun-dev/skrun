import { randomUUID } from "node:crypto";
import type { DbAdapter } from "./adapter.js";
import type { Agent, AgentVersion, ApiKey, Environment, Run, RunStatus, User } from "./schema.js";

export class MemoryDb implements DbAdapter {
  private agents = new Map<string, Agent>();
  private versions = new Map<string, AgentVersion[]>();
  private states = new Map<string, Record<string, unknown>>();
  private users = new Map<string, User>();
  private usersByGithubId = new Map<string, string>();
  private apiKeys = new Map<string, ApiKey>();
  private apiKeysByHash = new Map<string, string>();
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
  }): Promise<Agent> {
    const key = this.agentKey(data.namespace, data.name);
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      ...data,
      verified: false,
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

  async listAgents(
    page: number,
    limit: number,
  ): Promise<{ agents: (Agent & { run_count: number; token_count: number })[]; total: number }> {
    const all = [...this.agents.values()];
    const start = (page - 1) * limit;

    // Compute per-agent run_count and token_count
    const agentCounts = new Map<string, { runs: number; tokens: number }>();
    for (const run of this.runs.values()) {
      if (!run.agent_id) continue;
      const counts = agentCounts.get(run.agent_id) ?? { runs: 0, tokens: 0 };
      counts.runs++;
      counts.tokens += run.usage_total_tokens;
      agentCounts.set(run.agent_id, counts);
    }

    const agents = all.slice(start, start + limit).map((agent) => {
      const counts = agentCounts.get(agent.id) ?? { runs: 0, tokens: 0 };
      return { ...agent, run_count: counts.runs, token_count: counts.tokens };
    });

    return { agents, total: all.length };
  }

  async setVerified(namespace: string, name: string, verified: boolean): Promise<Agent | null> {
    const agent = await this.getAgent(namespace, name);
    if (!agent) return null;
    agent.verified = verified;
    agent.updated_at = new Date().toISOString();
    return agent;
  }

  async deleteAgent(namespace: string, name: string): Promise<boolean> {
    const key = this.agentKey(namespace, name);
    const agent = this.agents.get(key);
    if (!agent) return false;
    this.versions.delete(agent.id);
    this.agents.delete(key);
    return true;
  }

  // --- Agent Versions ---

  async createVersion(
    agentId: string,
    data: {
      version: string;
      size: number;
      bundle_key: string;
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
      config_snapshot: data.config_snapshot,
      notes: data.notes ?? null,
      pushed_at: new Date().toISOString(),
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
    expires_at?: string;
  }): Promise<ApiKey> {
    const apiKey: ApiKey = {
      id: randomUUID(),
      user_id: data.user_id,
      key_hash: data.key_hash,
      key_prefix: data.key_prefix,
      name: data.name,
      scopes: data.scopes ?? [],
      last_used_at: null,
      expires_at: data.expires_at ?? null,
      created_at: new Date().toISOString(),
    };
    this.apiKeys.set(apiKey.id, apiKey);
    this.apiKeysByHash.set(apiKey.key_hash, apiKey.id);
    return apiKey;
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key) return false;
    this.apiKeysByHash.delete(key.key_hash);
    this.apiKeys.delete(id);
    return true;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.user_id !== userId) return false;
    this.apiKeysByHash.delete(key.key_hash);
    this.apiKeys.delete(id);
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

  // --- Runs ---

  async createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
  }): Promise<Run> {
    const run: Run = {
      id: data.id,
      agent_id: data.agent_id,
      agent_version: data.agent_version,
      model: data.model ?? null,
      environment_id: data.environment_id ?? null,
      user_id: data.user_id ?? null,
      status: data.status,
      input: data.input ?? null,
      output: null,
      error: null,
      usage_prompt_tokens: 0,
      usage_completion_tokens: 0,
      usage_total_tokens: 0,
      usage_estimated_cost: 0,
      duration_ms: null,
      files: null,
      created_at: new Date().toISOString(),
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
        | "duration_ms"
        | "files"
        | "completed_at"
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

  async getStats() {
    const agents_count = this.agents.size;

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const yesterdayISO = yesterdayStart.toISOString();

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    let runs_today = 0;
    let tokens_today = 0;
    let failed_today = 0;
    let runs_yesterday = 0;
    let tokens_yesterday = 0;
    let failed_yesterday = 0;

    for (const run of this.runs.values()) {
      const isFailed = run.status === "failed";
      if (run.created_at >= todayISO) {
        runs_today++;
        tokens_today += run.usage_total_tokens;
        if (isFailed) failed_today++;
      } else if (run.created_at >= yesterdayISO) {
        runs_yesterday++;
        tokens_yesterday += run.usage_total_tokens;
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
    let prevRuns = 0;
    let prevTokens = 0;
    let prevFailed = 0;
    let prevTotalDuration = 0;

    // Daily arrays are always 7 items for sparkline rendering
    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyDurTotal = new Array<number>(7).fill(0);
    const dailyDurCount = new Array<number>(7).fill(0);

    // 7-day window for daily arrays (independent of the main period)
    const dailyStart = new Date(todayStart);
    dailyStart.setUTCDate(dailyStart.getUTCDate() - 6);

    for (const run of this.runs.values()) {
      if (run.agent_id !== agentId) continue;
      const isFailed = run.status === "failed";

      if (run.created_at >= periodISO) {
        runs++;
        tokens += run.usage_total_tokens;
        if (isFailed) failed++;
        if (run.duration_ms !== null) totalDuration += run.duration_ms;
      } else if (run.created_at >= prevISO) {
        prevRuns++;
        prevTokens += run.usage_total_tokens;
        if (isFailed) prevFailed++;
        if (run.duration_ms !== null) prevTotalDuration += run.duration_ms;
      }

      // Populate daily arrays from 7-day window
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
    this.runs.clear();
    this.environments.clear();
  }
}
