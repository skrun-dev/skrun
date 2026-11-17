// --- Client options ---

export interface SkrunClientOptions {
  /** Base URL of the Skrun registry (e.g., "http://localhost:4000") */
  baseUrl: string;
  /** Bearer token for authentication */
  token: string;
  /**
   * Default timeout in milliseconds (default: 60000). For `run()` and
   * `stream()`, the longest silence allowed — the wait for the answer, then the
   * gap between two chunks of the event stream; for every other call, the whole
   * request.
   */
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

/**
 * Partial environment override — all fields optional, shallow-merged on
 * agent.yaml defaults. Three fields of agent.yaml's environment are not part of
 * it. `sandbox` and `filesystem` were retired: they never had an effect, and
 * the server refuses an override that carries either (400 `RETIRED_FIELD`).
 * `secrets` is not yet supported: no secret is injected into a run.
 */
export interface EnvironmentOverride {
  networking?: { allowed_hosts?: string[] };
  timeout?: string;
  max_cost?: number;
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
   * `CALLER_BASE_URL_NOT_CONSENTED`). Only your key for the provider of the
   * agent's primary model is sent there — a fallback model is always called at
   * its own provider's endpoint — so a key for a fallback on another provider
   * needs no entry here. Every entry you do give, with `llmKeys` or without,
   * must be where that provider's key goes for the agent: its origin for the
   * provider of its primary model when it declares a `model.base_url`, and none
   * for any other provider, or on an agent that declares none — anything else
   * is refused the same way. Declare the origin your key belongs to and the
   * run proceeds; the refusal names the agent's origin so you can decide.
   * Compared by origin — the path need not match.
   */
  llmBaseUrls?: Record<string, string>;
  /**
   * Timeout in milliseconds, overriding the client's. For `run()` and
   * `stream()`, the longest silence allowed; for `runAsync()`, the whole request.
   */
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

/**
 * Why one of a run's output files is not among its `files`, in the order a file
 * is judged: its name is not a plain relative path (`name_refused`), it is past
 * the size limit (`too_large`), the count limit is already reached
 * (`over_count`); on the cloud runtime only, it could not be read from the
 * run's machine (`pull_failed`), or the upload of the run's files ran out of
 * time before it was stored (`upload_budget`). One reason per file.
 */
export type SdkFileExclusionReason =
  | "name_refused"
  | "too_large"
  | "over_count"
  | "pull_failed"
  | "upload_budget";

/**
 * How many of a run's output files were left out, by reason — counts only,
 * never a file name. A reason that left no file out is omitted: `{}` when every
 * file was kept.
 */
export type SdkFilesExcluded = Partial<Record<SdkFileExclusionReason, number>>;

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
  /**
   * How many of the run's output files are not in `files`, by reason; `{}` when
   * none was left out, and on a failed run. Always present.
   */
  files_excluded: SdkFilesExcluded;
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

/**
 * What the caller's account consumes now, against the quotas its plan gives
 * it on the server (`GET /api/usage`, read with a full-access credential).
 */
export interface UsageResponse {
  /**
   * The plan whose quotas apply: `free` for an account without one, for a plan
   * the server's settings do not name, and for the dev token.
   */
  plan: string;
  /**
   * `null` when the server sets no quota. `concurrent_runs` and `compute` are
   * each `null` when the server leaves their bound unset; `fast_runs` only
   * while no pre-warm pool runs.
   */
  quotas: {
    /** The account's runs in progress. */
    concurrent_runs: { limit: number; in_use: number } | null;
    /** The account's compute time in the current window. */
    compute: {
      limit_seconds: number;
      /** Whole seconds, rounded down. Can exceed the limit: a run is checked only when admitted. */
      used_seconds: number;
      /** The current window, fixed and aligned on UTC (ISO 8601): start included, end excluded. */
      window: { start: string; end: string };
    } | null;
    /**
     * The account's runs of the rolling hour that keep the right to a ready
     * machine of the server's pre-warm pool — a run for which no pooled
     * machine was taken gives it back once its machine is ready. `null` while
     * no such pool runs. A run past them is never refused: it starts on a new
     * machine, about a minute slower.
     */
    fast_runs: {
      /** Per rolling hour; `null` when the server sets no such bound; `0` for a plan that includes none. */
      limit: number | null;
      /** Left now, never below 0; `null` when the server sets no such bound. */
      remaining: number | null;
      /**
       * When the next right comes back (ISO 8601): the creation of the oldest
       * run of the hour that keeps the right, plus one hour — or, for an
       * account that holds more of them than its `limit` (its plan or the
       * bound lowered since), the creation of the run whose leaving brings it
       * back under the `limit`, plus one hour. `null` when no run of the hour
       * keeps it, when the bound is unset, and for a plan that includes none.
       */
      resets_at: string | null;
    } | null;
  } | null;
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
  /** The run's output files, each with its download `url` — empty when there are none. */
  files: SdkFileInfo[];
  /**
   * How many of the run's output files are not in `files`, by reason; `{}` when
   * none was left out. Mirror of `SdkRunResult.files_excluded`.
   */
  files_excluded: SdkFilesExcluded;
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
 * Periodic keep-alive emitted every ~30 s while the harness is blocked on a
 * slow wait, so that an idle stream is not closed by a proxy. Carries nothing
 * but what the harness is waiting on. Mirrors `runtime.RunHeartbeatEvent`.
 *
 * Known `stage` values:
 *  - `"acquiring_runner"` — the cloud runtime waking or creating the run's
 *    machine, until `runner_spawned`
 *  - `"waiting_llm"` — awaiting an LLM provider response
 *  - `"waiting_tool"` — awaiting a tool's result (script or MCP)
 *  - `"uploading_outputs"` — the cloud runtime uploading the run's output files
 *
 * A consumer should tolerate a `stage` value it does not know, as it
 * tolerates an event type it does not know.
 */
export interface RunHeartbeatEvent extends BaseRunEvent {
  type: "run_heartbeat";
  stage: "acquiring_runner" | "waiting_llm" | "waiting_tool" | "uploading_outputs";
}

/**
 * Terminus event for an unrecoverable run failure.
 *
 * Known `error.code` values:
 *  - `OUTPUT_SCHEMA_INVALID` — final LLM output failed validation against the
 *    declared `outputs` schema and the auto-repair retry also failed.
 *  - `COST_EXCEEDED` — the run's aggregate estimated cost exceeded the agent's
 *    declared `environment.max_cost`; the run is aborted before completing.
 *  - `SERVER_STOPPED` — the run did not finish because the server stopped
 *    while it was in progress; running it again makes sense, though its tools
 *    may already have run.
 *  - `TOO_MANY_TOOL_CALLS` — one answer of the model asked for more than 128 tool calls; none ran.
 *  - `MODEL_RESPONSE_TOO_LARGE` — a response of the agent's `model.base_url` was over 4 MiB.
 *  - `MODEL_OUTPUT_BUDGET_EXCEEDED` — the model's answers in the run weighed over 4 MiB in all.
 *  - `OUTPUT_TOO_LARGE` — the JSON object of the final answer was over 1 MiB; it was not parsed.
 *  - any provider/runtime-specific code.
 */
export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

/**
 * Per-phase cold-start timing for a cloud runner spawn — durations in
 * milliseconds — and the pre-warm pool's indicators, a count among them.
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
   * `true` when the run was served by a pre-created machine. Never `false`: every
   * other run omits it — no pool configured, a pool that missed, or a run with no
   * right to one under the account's fast runs.
   */
  pool_hit?: boolean;
  /**
   * How many pooled machines were taken for the run and then discarded on a
   * failed handoff, before it had its machine — a pooled machine counts as
   * taken once the run's handoff begins: its URLs signed for it, then its
   * credential and allowed hosts handed over, then its `/init`. One that
   * would not wake or answer its health check is not counted. `1` or absent:
   * a run hands its agent to one pooled machine at most, and one whose handoff
   * failed then starts on a machine of its own — so it never comes with
   * `pool_hit`. Never `0`: absent when there is none.
   */
  pool_handoffs_failed?: number;
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
  /**
   * Installing the dependencies the agent's scripts declare, inside the runner.
   * Absent when the runner predates that install.
   */
  init_deps_ms?: number;
  init_mcp_ms?: number;
}

/**
 * Informational event carrying the cloud runner's per-phase cold-start
 * breakdown, emitted once after the runner is ready (fills the gap between
 * `run_start` and the first work event). Mirrors `runtime.RunnerSpawnedEvent`.
 * Its phases only — durations and the pool's indicators —, never the machine
 * id or private IP.
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
  | RunHeartbeatEvent
  | RunnerSpawnedEvent
  | RunCompleteEvent
  | RunErrorEvent;
