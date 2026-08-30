// --- Client options ---

export interface SkrunClientOptions {
  /** Base URL of the Skrun registry (e.g., "http://localhost:4000") */
  baseUrl: string;
  /** Bearer token for authentication */
  token: string;
  /** Default timeout in milliseconds (default: 60000) */
  timeout?: number;
}

/**
 * Agent identifier for SDK calls — the registry-qualified reference
 * `<namespace>/<name>` (e.g., `"acme/seo-audit"`) or the equivalent
 * `{ namespace, name }` object.
 *
 * **This is distinct from `agent.yaml`'s `name` field**, which is slug-only
 * (e.g., `"seo-audit"`). The SDK requires the full `<namespace>/<name>`
 * form because it needs to construct the registry URL
 * (`/api/agents/<namespace>/<name>/run`). The namespace under which an
 * agent was published is recorded by the registry at push time from the
 * publisher's auth context — it does not live in the bundle's yaml.
 */
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
  /**
   * The endpoint your key for each provider belongs to (provider → base URL).
   * Maps to the X-LLM-Base-URL header.
   *
   * Only needed when you send `llmKeys` to an agent you do not own: such an
   * agent may declare its own `model.base_url`, and the server refuses to send
   * your key to an endpoint you did not choose (403
   * `CALLER_BASE_URL_NOT_CONSENTED`). Declare the origin your key belongs to and
   * the run proceeds; the refusal names the agent's origin so you can decide.
   * Compared by origin — the path need not match.
   */
  llmBaseUrls?: Record<string, string>;
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
  /**
   * Verified state of the latest version (by push time). Drives badges in the
   * dashboard listing. Matches `agent_versions.verified` of the most recently
   * pushed version. False when the agent has no versions.
   */
  latest_version_verified: boolean;
  latest_version: string;
  /**
   * Access control. `private` (default) ⇒ only the owner/admin can run the
   * agent; `public` ⇒ any authenticated caller can. Optional for forward
   * compatibility with servers that predate the visibility field.
   */
  visibility?: "private" | "public";
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
  /**
   * Per-version verified state. Gated by
   * `PATCH /api/agents/:ns/:name/versions/:version/verify` (admin only).
   * `POST /run` returns 403 AGENT_NOT_VERIFIED when the resolved version's
   * flag is false.
   */
  verified: boolean;
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

/**
 * Informational event emitted when a tool returns `{is_error: true}`.
 * Mirrors `runtime.ToolCallErrorEvent`. Emitted BEFORE the matching
 * `tool_result`; the LLM still receives the error normally.
 */
export interface ToolCallErrorEvent extends BaseRunEvent {
  type: "tool_call_error";
  tool: string;
  message: string;
  code?: string;
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

/**
 * Informational event emitted when the LLM's final output fails Zod validation
 * against the agent's declared `outputs` schema. Mirrors `runtime.OutputValidationWarningEvent`.
 * Emitted BEFORE the retry attempt. The `errors` field carries the Zod issues
 * for diagnostics; shape is `unknown[]` since Zod's issue type is not part of
 * the public wire contract.
 */
export interface OutputValidationWarningEvent extends BaseRunEvent {
  type: "output_validation_warning";
  errors: unknown[];
}

/**
 * Terminus event for an unrecoverable run failure.
 *
 * Known `error.code` values:
 *  - `OUTPUT_SCHEMA_INVALID` — final LLM output failed validation against the
 *    declared `outputs` schema and the auto-repair retry also failed.
 *  - `COST_EXCEEDED` — the run's aggregate estimated cost exceeded the agent's
 *    declared `environment.max_cost`; the run is aborted before completing.
 *  - any provider/runtime-specific code.
 */
export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

/**
 * Per-phase cold-start timing for a cloud runner spawn, in milliseconds.
 * Mirrors `runtime.SpawnPhases`. Only `create_api_ms` is always present; the
 * derived and in-VM fields are optional (an older runner image may not report
 * them, so consumers must treat them as possibly-absent).
 */
export interface SpawnPhases {
  /**
   * The API round-trip that produced a runner. Normally the machine create; on a
   * run served from a pre-warm pool it is the call that woke a pre-created
   * machine instead.
   */
  create_api_ms: number;
  /**
   * Set when the run was served by a pre-created machine. Absent means no pool is
   * configured; `false` means one is configured and this run missed it.
   */
  pool_hit?: boolean;
  pool_resume_ms?: number;
  pool_claim_ms?: number;
  /**
   * Whether the woken machine resumed from its snapshot or silently cold-booted —
   * the platform treats the resume as an attempt, not a guarantee.
   */
  pool_resumed_from_snapshot?: boolean;
  /**
   * Fill-time phases. Absent on a pool-served run: there they would describe when
   * the pool was filled rather than anything about this run.
   */
  host_schedule_pull_ms?: number;
  vm_boot_ms?: number;
  entrypoint_egress_ms?: number;
  module_load_ms?: number;
  init_bundle_ms?: number;
  init_extract_ms?: number;
  init_mcp_ms?: number;
}

/**
 * Informational event carrying the cloud runner's per-phase cold-start
 * breakdown, emitted once after the runner is ready (fills the gap between
 * `run_start` and the first work event). Mirrors `runtime.RunnerSpawnedEvent`.
 * Durations only — no machine id / private IP.
 */
export interface RunnerSpawnedEvent extends BaseRunEvent {
  type: "runner_spawned";
  phases: SpawnPhases;
}

export type RunEvent =
  | RunStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolCallErrorEvent
  | LlmCompleteEvent
  | OutputValidationWarningEvent
  | RunnerSpawnedEvent
  | RunCompleteEvent
  | RunErrorEvent;
