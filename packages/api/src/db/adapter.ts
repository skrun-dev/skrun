import type { Agent, AgentVersion, ApiKey, Environment, Run, RunStatus, User } from "./schema.js";

export interface DbAdapter {
  // --- Agents ---
  getAgent(namespace: string, name: string): Promise<Agent | null>;
  createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
  }): Promise<Agent>;
  listAgents(
    page: number,
    limit: number,
  ): Promise<{
    agents: (Agent & { run_count: number; token_count: number; cost_total: number })[];
    total: number;
  }>;
  setVerified(namespace: string, name: string, verified: boolean): Promise<Agent | null>;
  deleteAgent(namespace: string, name: string): Promise<boolean>;

  // --- Agent Versions ---
  createVersion(
    agentId: string,
    data: {
      version: string;
      size: number;
      bundle_key: string;
      config_snapshot?: Record<string, unknown>;
      notes?: string | null;
    },
  ): Promise<AgentVersion>;
  getVersions(agentId: string): Promise<AgentVersion[]>;
  getLatestVersion(agentId: string): Promise<AgentVersion | null>;
  getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null>;
  deleteVersion(agentId: string, version: string): Promise<void>;

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
    expires_at?: string;
  }): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<boolean>;
  deleteApiKeyByOwner(id: string, userId: string): Promise<boolean>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
  updateApiKeyLastUsed(id: string): Promise<void>;

  // --- Runs ---
  createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
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
