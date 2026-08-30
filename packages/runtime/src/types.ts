import type { AgentConfig } from "@skrun-dev/schema";
import type { SkrunPart } from "./llm/parts.js";
import type { ToolDefinition } from "./tools/types.js";

export interface FileInfo {
  name: string;
  size: number;
  /**
   * Unified-namespace file_id (`fil_<32 hex>`) assigned at collection time.
   * Used by `GET /api/files/:id/content` for output retrieval.
   */
  file_id?: string;
  /**
   * Presigned GET URL for cloud-mode (`FlyioAdapter`) outputs — the file
   * lives in R2 / MinIO and is fetched directly by the caller. Unset for
   * `LocalAdapter` outputs (those live on the harness filesystem and are
   * served via `/api/files/:id/content`). Short TTL (~15 minutes); caller
   * should download or re-request before the URL expires.
   */
  url?: string;
}

export interface RunRequest {
  agentConfig: AgentConfig;
  skillContent: string;
  agentsMdContent?: string;
  input: Record<string, unknown>;
  runId: string;
  state?: Record<string, unknown>;
  /** Caller-provided LLM API keys (provider name → API key). Overrides server-side env keys. */
  callerKeys?: Record<string, string>;
  /**
   * Creator-attached LLM keys (provider name → API key), decrypted harness-side.
   * Consulted AFTER callerKeys and BEFORE the server env key in the resolution
   * chain (caller > creator > server). Like callerKeys, never forwarded to the
   * sandbox — used only by the harness LLMRouter.
   */
  creatorKeys?: Record<string, string>;
  /** Resolved agent version (semver) actually being executed. Echoed in run_start and final results. */
  agent_version?: string;
  /** Directory where tool scripts can write output files. Set by the runtime. */
  outputDir?: string;
  /**
   * Resolved file-typed inputs as SkrunPart[] per field name. Set by the API
   * layer after validating + resolving wire-format file inputs (id/data/url).
   * Consumed by the adapter to build LLMCallRequest.userContent.
   */
  resolvedInputs?: Map<string, SkrunPart[]>;
  /**
   * Environment identifier for prompt-cache routing. Combined with agent
   * name + version to derive a stable cache key. Defaults to `"default"`
   * when the API doesn't have persistent environment records keyed by ID
   * — caching is then per (agent, version) only. Refine with a hash of the
   * environment override shape in a future feature for per-environment-shape
   * isolation.
   */
  environmentId?: string;
  /**
   * Storage key of the agent's bundle archive (e.g.
   * `tarcroi/email-drafter/1.0.0.agent`). Used by the cloud `FlyioAdapter`
   * to generate a presigned download URL that the spawned runner uses to
   * fetch the bundle. Unused by `LocalAdapter` (which mounts the bundle
   * from the host filesystem).
   */
  bundleKey?: string;
  /**
   * Optional `AbortSignal` to interrupt a running execution. The cloud
   * `FlyioAdapter` listens for abort to guarantee the spawned machine is
   * destroyed even when the caller closes the SSE stream / the harness
   * shuts down mid-run. Wired in route handlers (e.g. `c.req.raw.signal`
   * in Hono). `LocalAdapter` ignores it for now.
   */
  abortSignal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed";
  output: Record<string, unknown>;
  newState?: Record<string, unknown>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
    /** Tokens served from provider-side cache. Optional — undefined when no cache activity. */
    cacheReadTokens?: number;
    /** Tokens written to provider-side cache. Anthropic only. Optional. */
    cacheWriteTokens?: number;
  };
  durationMs: number;
  error?: string;
  files?: FileInfo[];
}

// --- Streaming event types ---

interface BaseRunEvent {
  run_id: string;
  timestamp: string;
}

export interface RunStartEvent extends BaseRunEvent {
  type: "run_start";
  agent: string;
  /** Resolved version of the agent being executed. Fallback: "unknown" if the runtime is invoked outside the API (e.g., unit tests). */
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
 *
 * Emitted BEFORE the matching `tool_result` event. The tool_result content
 * still flows back to the LLM normally — the LLM decides what to do
 * (retry, fallback, give up gracefully). This event exists only to make
 * tool failures visible in the SSE stream and the dashboard event timeline
 * (rendered in red) without changing the LLM-recovery contract.
 *
 * Aligned with CMA/Bedrock/Vertex industry default (permissive tool error
 * handling). Strict-by-default abort was considered and deliberately rejected
 * for v0.9.0.
 */
export interface ToolCallErrorEvent extends BaseRunEvent {
  type: "tool_call_error";
  tool: string;
  message: string;
  /** Optional machine-readable error code surfaced by the tool. */
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
    /** Tokens served from provider-side cache. Snake_case wire format. */
    cache_read_tokens?: number;
    /** Tokens written to provider-side cache. Anthropic only. */
    cache_write_tokens?: number;
  };
  cost: { estimated: number };
  duration_ms: number;
  files: FileInfo[];
}

/**
 * Informational event emitted when the LLM's final output fails Zod validation
 * against the agent's declared `outputs` schema (e.g., missing required key,
 * wrong type at top level). Emitted BEFORE the retry attempt — if the retry
 * succeeds the run terminates with `run_complete`, otherwise with `run_error`
 * (code `OUTPUT_SCHEMA_INVALID`). The `errors` field carries the Zod issues
 * for diagnostics; shape is intentionally `unknown[]` since Zod's issue type
 * is not part of the public wire contract.
 */
export interface OutputValidationWarningEvent extends BaseRunEvent {
  type: "output_validation_warning";
  errors: unknown[];
}

/**
 * Periodic informational event emitted during long waits to keep the SSE
 * stream alive + signal what the harness is doing right now. The runtime
 * fires one every ~30s during LLM calls, tool dispatch, and outputs
 * upload. Existing SSE consumers MUST ignore unknown event types so this
 * is backward-compatible.
 *
 * Known `stage` values:
 *  - `"waiting_llm"` — awaiting an LLM provider response
 *  - `"waiting_tool"` — awaiting a tool's `callTool` result (script or MCP)
 *  - `"uploading_outputs"` — cloud adapter sync-uploading outputs to R2
 */
export interface RunHeartbeatEvent extends BaseRunEvent {
  type: "run_heartbeat";
  stage: "waiting_llm" | "waiting_tool" | "uploading_outputs";
}

/**
 * Terminus event for an unrecoverable run failure.
 *
 * Known `error.code` values:
 *  - `OUTPUT_SCHEMA_INVALID` — final LLM output failed validation against the
 *    declared `outputs` schema, and the auto-repair retry also failed.
 *  - `COST_EXCEEDED` — the run's aggregate estimated cost exceeded the agent's
 *    declared `environment.max_cost`; the run is aborted before completing.
 *  - any provider/runtime-specific code (LLM error, timeout, etc.) — the field
 *    is intentionally typed as `string` to accommodate future codes without a
 *    coordinated SDK release.
 */
export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

/**
 * Per-phase cold-start timing for a cloud (Fly) runner spawn, in milliseconds.
 * Only `create_api_ms` is always present (harness-measured); the derived and
 * in-VM fields are OPTIONAL because the runner image and the harness deploy
 * independently — an older runner may not report them, and the harness must
 * degrade rather than fail.
 */
export interface SpawnPhases {
  /**
   * The Fly Machines API round-trip that produced a runner (harness-measured).
   * Normally `create`; on a pool-served run it is the `start` that woke a
   * pre-created machine — the same role in the sequence, a different verb.
   */
  create_api_ms: number;
  /**
   * Whether this run was served by a pre-created machine rather than one created
   * for it. Present only when a pool is configured, so its absence means "no pool"
   * rather than "pool missed".
   */
  pool_hit?: boolean;
  /** Time to wake a pre-created machine and see it answer (pool-served runs only). */
  pool_resume_ms?: number;
  /** Time to hand a woken machine its run credential and egress rules. */
  pool_claim_ms?: number;
  /**
   * Whether the woken machine genuinely resumed from its snapshot, or silently
   * cold-booted instead — the platform documents the resume as an attempt, not a
   * guarantee. Recorded because a pool whose machines all cold-boot still "works"
   * while quietly delivering a fraction of the benefit, and averaging the two
   * together would hide it.
   */
  pool_resumed_from_snapshot?: boolean;
  /**
   * Host-side schedule + image pull, DERIVED as (create->healthz) minus
   * vm_boot_ms. The harness cannot observe the image pull directly; this is the
   * residual once the runner's own boot time is subtracted. Omitted when the
   * runner did not report vm_boot_ms.
   */
  host_schedule_pull_ms?: number;
  /** In-VM kernel-boot -> runner-listening (runner reads /proc/uptime at listen). */
  vm_boot_ms?: number;
  /** In-VM entrypoint egress/iptables setup (a sub-part of vm_boot_ms). */
  entrypoint_egress_ms?: number;
  /**
   * In-VM time spent loading the runner program's modules (a sub-part of
   * vm_boot_ms). With entrypoint_egress_ms this splits vm_boot into its parts,
   * so start-up work is attributed rather than inferred by subtraction.
   */
  module_load_ms?: number;
  /** In-VM /init: agent bundle download. */
  init_bundle_ms?: number;
  /** In-VM /init: bundle extract. */
  init_extract_ms?: number;
  /** In-VM /init: MCP server connect (0 when the agent declares no MCP servers). */
  init_mcp_ms?: number;
}

/**
 * Informational event emitted once, right after the cloud runner is ready
 * (post-/init), carrying the per-phase cold-start breakdown. Fills the
 * otherwise-silent gap between `run_start` and the first agent-loop event so
 * consumers can see where a slow first run spends its time.
 *
 * Carries DURATIONS ONLY. The machine id and private IP are operator-internal
 * and travel via the adapter's `onRunnerSpawned` callback, never over the event
 * stream. LocalAdapter runs (no VM) do not emit this event. Existing SSE
 * consumers ignore unknown event types, so this is backward-compatible.
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

/**
 * The runner's `POST /init` response contract, shared by the runner
 * (infra/runtime-image) and the FlyioAdapter. `phases`/`boot` are OPTIONAL: the
 * runner image and the harness deploy independently, so a newer harness may
 * receive an older runner's `{ ok, tools }` response and MUST degrade rather
 * than throw.
 */
export interface InitResult {
  ok: true;
  tools: ToolDefinition[];
  phases?: {
    bundle_ms: number;
    extract_ms: number;
    mcp_ms: number;
  };
  boot?: {
    vm_boot_ms?: number;
    entrypoint_egress_ms?: number;
    module_load_ms?: number;
  };
}

/**
 * Operator-only spawn telemetry delivered to the api layer via the FlyioAdapter
 * `onRunnerSpawned` callback (NOT the event stream — the api sees only events,
 * and machine_id/private_ip must stay off the tenant-facing surface). Persisted
 * to operator-only columns on the run record.
 */
export interface RunnerSpawnedInfo {
  machineId: string;
  privateIp: string;
  phases: SpawnPhases;
}

/** Callback signature for `FlyioAdapterOptions.onRunnerSpawned`. */
export type OnRunnerSpawned = (info: RunnerSpawnedInfo) => void;
