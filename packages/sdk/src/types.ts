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

/**
 * Run input value: a primitive (string/number/boolean/object/array) OR a binary
 * (Blob/File/Uint8Array) for `type: file` agent inputs. Binary values are
 * automatically uploaded via `POST /api/files` and substituted with a
 * `{type: "file", source: "id", file_id}` reference in the run request body.
 */
export type RunInputValue = unknown | Blob | File | Uint8Array;

/** Run input map. Mix of text/object/array primitives and binary file inputs. */
export type RunInput = Record<string, RunInputValue | RunInputValue[]>;

/** Result of an SDK-side input file upload. */
export interface SdkUploadedFileInfo {
  file_id: string;
  size: number;
  media_type: string;
  purpose: "input";
  expires_at: string;
}

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
  /** Unified-namespace file_id (`fil_<32 hex>`) for `GET /api/files/:id/content`. */
  file_id?: string;
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
    /**
     * Tokens served from the provider's prompt cache. Optional — only
     * present when the provider returned cache activity. Billed at the
     * cached-read rate (typically 0.10× input on Anthropic / GPT-5.x /
     * Gemini, 0.5× on Groq gpt-oss / OpenAI gpt-4o legacy). NOT included in
     * `prompt_tokens` (which is the FULL-RATE residual).
     */
    cache_read_tokens?: number;
    /**
     * Tokens written to the provider's prompt cache. Anthropic only;
     * other providers do not expose a separate cache write surcharge.
     * Optional — undefined for non-Anthropic models or when no cache_control
     * was set.
     */
    cache_write_tokens?: number;
  };
  /** Files produced by the agent during execution. */
  files?: SdkFileInfo[];
  warnings?: string[];
  cost: {
    /** Total cost (USD) for this run, computed from per-token rates. */
    estimated: number;
    /**
     * Dollar savings (USD) produced by prompt-caching on this run, computed
     * from `cacheReadTokens × (full_input_rate - cached_rate)`. Surfaced only
     * when > 0 — omitted when caching produced no savings (e.g., no cache
     * hit, or model has no native caching API). Aligned with the dashboard's
     * NUMERIC(10,6) precision.
     */
    saved?: number;
  };
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

export interface PushOptions {
  /** Attach a note to this version (max 500 characters, plain text only). */
  message?: string;
}

export interface AgentVersionInfo {
  version: string;
  size: number;
  pushed_at: string;
  config_snapshot?: Record<string, unknown>;
  /** Optional note attached to the version at push time (≤ 500 chars, plain text). */
  notes: string | null;
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
    /** Tokens served from provider-side cache. Optional — undefined when no cache activity. */
    cache_read_tokens?: number;
    /** Tokens written to provider-side cache. Anthropic only. Optional. */
    cache_write_tokens?: number;
  };
  cost: {
    /** Total cost (USD) for this run. */
    estimated: number;
    /**
     * Dollar savings (USD) produced by prompt-caching. Surfaced only when
     * > 0. Mirror of `SdkRunResult.cost.saved`.
     */
    saved?: number;
  };
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
