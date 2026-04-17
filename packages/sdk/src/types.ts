// --- Client options ---

export interface SkrunClientOptions {
  /** Base URL of the Skrun registry (e.g., "http://localhost:4000") */
  baseUrl: string;
  /** Bearer token for authentication */
  token: string;
  /** Default timeout in milliseconds (default: 60000) */
  timeout?: number;
}

/** Agent identifier: "namespace/name" string or { namespace, name } object */
export type AgentIdentifier = string | { namespace: string; name: string };

/** Partial environment override — all fields optional, shallow-merged on agent.yaml defaults. */
export interface EnvironmentOverride {
  networking?: { allowed_hosts?: string[] };
  filesystem?: "none" | "read-only" | "read-write";
  secrets?: string[];
  timeout?: string;
  max_cost?: number;
  sandbox?: "strict" | "permissive";
}

export interface RunOptions {
  /** Caller-provided LLM API keys (provider → key). Maps to X-LLM-API-Key header. */
  llmKeys?: Record<string, string>;
  /** Request timeout in milliseconds (overrides client default) */
  timeout?: number;
  /** Pin a specific agent version (strict semver, e.g. "1.2.0"). Omit to target latest. */
  version?: string;
  /** Environment override — shallow-merged on top of agent.yaml environment defaults. */
  environment?: EnvironmentOverride;
}

/** File produced by an agent during execution. */
export interface SdkFileInfo {
  name: string;
  size: number;
  url: string;
}

// --- API response types (snake_case to match JSON) ---

export interface SdkRunResult {
  run_id: string;
  status: "completed" | "failed";
  /** Resolved agent version (semver) that was executed. */
  agent_version: string;
  output: Record<string, unknown>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Files produced by the agent during execution. */
  files?: SdkFileInfo[];
  warnings?: string[];
  cost: { estimated: number };
  duration_ms: number;
  error?: string;
}

export interface AsyncRunResult {
  run_id: string;
  /** Resolved agent version (semver) that will be executed. */
  agent_version: string;
}

export interface AgentMetadata {
  name: string;
  namespace: string;
  verified: boolean;
  latest_version: string;
  created_at: string;
  updated_at: string;
}

export interface PaginatedList {
  agents: AgentMetadata[];
  total: number;
  page: number;
  limit: number;
}

export interface PushResult {
  name: string;
  namespace: string;
  latest_version: string;
}

export interface ListOptions {
  page?: number;
  limit?: number;
}

// --- SSE event types (re-defined for standalone package, no workspace deps) ---

interface BaseRunEvent {
  run_id: string;
  timestamp: string;
}

export interface RunStartEvent extends BaseRunEvent {
  type: "run_start";
  agent: string;
  /** Resolved version of the agent being executed. */
  agent_version: string;
}

export interface ToolCallEvent extends BaseRunEvent {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseRunEvent {
  type: "tool_result";
  tool: string;
  result: string;
  is_error: boolean;
}

export interface LlmCompleteEvent extends BaseRunEvent {
  type: "llm_complete";
  provider: string;
  model: string;
  tokens: number;
}

export interface RunCompleteEvent extends BaseRunEvent {
  type: "run_complete";
  output: Record<string, unknown>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost: { estimated: number };
  duration_ms: number;
  files?: SdkFileInfo[];
}

export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

export type RunEvent =
  | RunStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | LlmCompleteEvent
  | RunCompleteEvent
  | RunErrorEvent;
