import { createLogger } from "@skrun-dev/runtime";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { DbAdapter } from "./adapter.js";
import type { Agent, AgentVersion, ApiKey, Environment, Run, RunStatus, User } from "./schema.js";

const logger = createLogger("db");

export class SupabaseDb implements DbAdapter {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
    logger.info({ event: "db_connected", url: supabaseUrl }, "Connected to Supabase");
  }

  // --- Agents ---

  async getAgent(namespace: string, name: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select("*")
      .eq("namespace", namespace)
      .eq("name", name)
      .maybeSingle();
    if (error) throw new Error(`getAgent failed: ${error.message}`);
    return data;
  }

  async createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
  }): Promise<Agent> {
    const { data: agent, error } = await this.client
      .from("agents")
      .insert({ ...data, verified: false })
      .select()
      .single();
    if (error) throw new Error(`createAgent failed: ${error.message}`);
    return agent;
  }

  async listAgents(
    page: number,
    limit: number,
  ): Promise<{ agents: (Agent & { run_count: number; token_count: number })[]; total: number }> {
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data, error, count } = await this.client
      .from("agents")
      .select("*", { count: "exact" })
      .range(from, to);
    if (error) throw new Error(`listAgents failed: ${error.message}`);

    const agents = data ?? [];
    const enriched = await Promise.all(
      agents.map(async (agent) => {
        const { data: runs, error: runsErr } = await this.client
          .from("runs")
          .select("usage_total_tokens")
          .eq("agent_id", agent.id);
        if (runsErr) return { ...agent, run_count: 0, token_count: 0 };
        const token_count = (runs ?? []).reduce((sum, r) => sum + (r.usage_total_tokens ?? 0), 0);
        return { ...agent, run_count: runs?.length ?? 0, token_count };
      }),
    );

    return { agents: enriched, total: count ?? 0 };
  }

  async deleteAgent(namespace: string, name: string): Promise<boolean> {
    const { error, count } = await this.client
      .from("agents")
      .delete({ count: "exact" })
      .eq("namespace", namespace)
      .eq("name", name);
    if (error) throw new Error(`deleteAgent failed: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async setVerified(namespace: string, name: string, verified: boolean): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .update({ verified, updated_at: new Date().toISOString() })
      .eq("namespace", namespace)
      .eq("name", name)
      .select()
      .maybeSingle();
    if (error) throw new Error(`setVerified failed: ${error.message}`);
    return data;
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
    const { data: version, error } = await this.client
      .from("agent_versions")
      .insert({ agent_id: agentId, ...data, notes: data.notes ?? null })
      .select()
      .single();
    if (error) throw new Error(`createVersion failed: ${error.message}`);

    // Update agent's updated_at
    await this.client
      .from("agents")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", agentId);

    return version;
  }

  async getVersions(agentId: string): Promise<AgentVersion[]> {
    const { data, error } = await this.client
      .from("agent_versions")
      .select("*")
      .eq("agent_id", agentId)
      .order("pushed_at", { ascending: true });
    if (error) throw new Error(`getVersions failed: ${error.message}`);
    return data ?? [];
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | null> {
    const { data, error } = await this.client
      .from("agent_versions")
      .select("*")
      .eq("agent_id", agentId)
      .order("pushed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`getLatestVersion failed: ${error.message}`);
    return data;
  }

  async getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null> {
    const { data, error } = await this.client
      .from("agent_versions")
      .select("*")
      .eq("agent_id", agentId)
      .eq("version", version)
      .maybeSingle();
    if (error) throw new Error(`getVersionByNumber failed: ${error.message}`);
    return data;
  }

  // --- Agent State ---

  async getState(agentName: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client
      .from("agent_state")
      .select("state")
      .eq("agent_id", agentName)
      .maybeSingle();
    if (error) throw new Error(`getState failed: ${error.message}`);
    return data?.state ?? null;
  }

  async setState(agentName: string, state: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from("agent_state").upsert(
      {
        agent_id: agentName,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" },
    );
    if (error) throw new Error(`setState failed: ${error.message}`);
  }

  async deleteState(agentName: string): Promise<void> {
    const { error } = await this.client.from("agent_state").delete().eq("agent_id", agentName);
    if (error) throw new Error(`deleteState failed: ${error.message}`);
  }

  // --- Users ---

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("github_id", githubId)
      .maybeSingle();
    if (error) throw new Error(`getUserByGithubId failed: ${error.message}`);
    return data;
  }

  async getUserById(id: string): Promise<User | null> {
    const { data, error } = await this.client.from("users").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getUserById failed: ${error.message}`);
    return data;
  }

  async createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User> {
    const { data: user, error } = await this.client
      .from("users")
      .insert({
        github_id: data.github_id,
        username: data.username,
        email: data.email ?? "",
        avatar_url: data.avatar_url ?? "",
        plan: "free",
      })
      .select()
      .single();
    if (error) throw new Error(`createUser failed: ${error.message}`);
    return user;
  }

  async updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null> {
    const { data: user, error } = await this.client
      .from("users")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`updateUser failed: ${error.message}`);
    return user;
  }

  // --- API Keys ---

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const { data, error } = await this.client
      .from("api_keys")
      .select("*")
      .eq("key_hash", keyHash)
      .maybeSingle();
    if (error) throw new Error(`getApiKeyByHash failed: ${error.message}`);
    return data;
  }

  async createApiKey(data: {
    user_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    scopes?: string[];
    expires_at?: string;
  }): Promise<ApiKey> {
    const { data: key, error } = await this.client
      .from("api_keys")
      .insert({
        user_id: data.user_id,
        key_hash: data.key_hash,
        key_prefix: data.key_prefix,
        name: data.name,
        scopes: data.scopes ?? [],
        expires_at: data.expires_at ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`createApiKey failed: ${error.message}`);
    return key;
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const { error, count } = await this.client
      .from("api_keys")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw new Error(`deleteApiKey failed: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const { error, count } = await this.client
      .from("api_keys")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("user_id", userId);
    if (error) throw new Error(`deleteApiKeyByOwner failed: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const { data, error } = await this.client
      .from("api_keys")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listApiKeys failed: ${error.message}`);
    return data ?? [];
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    const { error } = await this.client
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`updateApiKeyLastUsed failed: ${error.message}`);
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
    const { data: run, error } = await this.client
      .from("runs")
      .insert({
        id: data.id,
        agent_id: data.agent_id,
        agent_version: data.agent_version,
        model: data.model ?? null,
        environment_id: data.environment_id ?? null,
        user_id: data.user_id ?? null,
        status: data.status,
        input: data.input ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`createRun failed: ${error.message}`);
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
    const { data: run, error } = await this.client
      .from("runs")
      .update(data)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`updateRun failed: ${error.message}`);
    return run;
  }

  async getRun(id: string): Promise<Run | null> {
    const { data, error } = await this.client.from("runs").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getRun failed: ${error.message}`);
    return data;
  }

  async listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]> {
    let query = this.client.from("runs").select("*").order("created_at", { ascending: false });

    if (filters?.agent_id) query = query.eq("agent_id", filters.agent_id);
    if (filters?.user_id) query = query.eq("user_id", filters.user_id);
    if (filters?.status) query = query.eq("status", filters.status);
    if (filters?.limit) query = query.limit(filters.limit);

    const { data, error } = await query;
    if (error) throw new Error(`listRuns failed: ${error.message}`);
    return data ?? [];
  }

  // --- Stats ---

  async getStats() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    const [agentsResult, runsResult] = await Promise.all([
      this.client.from("agents").select("id", { count: "exact", head: true }),
      this.client
        .from("runs")
        .select("status, usage_total_tokens, created_at")
        .gte("created_at", sevenDaysAgoISO),
    ]);

    if (agentsResult.error)
      throw new Error(`getStats agents failed: ${agentsResult.error.message}`);
    if (runsResult.error) throw new Error(`getStats runs failed: ${runsResult.error.message}`);

    const agents_count = agentsResult.count ?? 0;
    const allRuns = runsResult.data ?? [];

    let runs_today = 0;
    let tokens_today = 0;
    let failed_today = 0;

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const yesterdayISO = yesterdayStart.toISOString();
    let runs_yesterday = 0;
    let tokens_yesterday = 0;
    let failed_yesterday = 0;

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);

    for (const run of allRuns) {
      const tokens = run.usage_total_tokens ?? 0;
      const isFailed = run.status === "failed";

      if (run.created_at >= todayISO) {
        runs_today++;
        tokens_today += tokens;
        if (isFailed) failed_today++;
      } else if (run.created_at >= yesterdayISO) {
        runs_yesterday++;
        tokens_yesterday += tokens;
        if (isFailed) failed_yesterday++;
      }

      const runDate = new Date(run.created_at);
      const dayIndex = Math.floor(
        (runDate.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex]++;
        dailyTokens[dayIndex] += tokens;
        if (isFailed) dailyFailed[dayIndex]++;
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

    const prevStart = new Date(periodStart);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);

    const { data, error } = await this.client
      .from("runs")
      .select("status, usage_total_tokens, duration_ms, created_at")
      .eq("agent_id", agentId)
      .gte("created_at", prevStart.toISOString());

    if (error) throw new Error(`getAgentStats failed: ${error.message}`);

    const allRuns = data ?? [];
    const periodISO = periodStart.toISOString();

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

    for (const run of allRuns) {
      const tok = run.usage_total_tokens ?? 0;
      const dur = run.duration_ms ?? 0;
      const isFailed = run.status === "failed";

      if (run.created_at >= periodISO) {
        runs++;
        tokens += tok;
        if (isFailed) failed++;
        if (dur > 0) totalDuration += dur;
      } else {
        prevRuns++;
        prevTokens += tok;
        if (isFailed) prevFailed++;
        if (dur > 0) prevTotalDuration += dur;
      }

      // Populate daily arrays from 7-day window
      if (run.created_at >= dailyStart.toISOString()) {
        const runDate = new Date(run.created_at);
        const dayIndex = Math.floor(
          (runDate.getTime() - dailyStart.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyRuns[dayIndex]++;
          dailyTokens[dayIndex] += tok;
          if (isFailed) dailyFailed[dayIndex]++;
          if (dur > 0) {
            dailyDurTotal[dayIndex] += dur;
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
    const { data, error } = await this.client
      .from("environments")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getEnvironment failed: ${error.message}`);
    return data;
  }

  async createEnvironment(data: {
    name: string;
    owner_id: string;
    config: Record<string, unknown>;
  }): Promise<Environment> {
    const { data: env, error } = await this.client
      .from("environments")
      .insert(data)
      .select()
      .single();
    if (error) throw new Error(`createEnvironment failed: ${error.message}`);
    return env;
  }

  async listEnvironments(ownerId: string): Promise<Environment[]> {
    const { data, error } = await this.client
      .from("environments")
      .select("*")
      .eq("owner_id", ownerId);
    if (error) throw new Error(`listEnvironments failed: ${error.message}`);
    return data ?? [];
  }
}
