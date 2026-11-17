import type { AgentConfig } from "@skrun-dev/schema";
import type { MachineSpawnPhase } from "./errors.js";
import type { OutputExclusionReason } from "./files/output-rules.js";
import type { SkrunPart } from "./llm/parts.js";

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
   * Hex sha256 of the bundle archive named by `bundleKey`, as recorded when
   * the version was published. Handed to the sandbox so it can check the copy
   * it downloads for itself before extracting it.
   *
   * Why it has to travel: `agentConfig` and `skillContent` above come from the
   * copy this process fetched and verified, but **the scripts that actually
   * run come from a second read**, performed inside the sandbox against a
   * presigned URL. Without this value that second read is never checked
   * against anything.
   *
   * Undefined for a bundle published before checksums were recorded. The
   * sandbox then extracts as before and says so in its log — an old bundle
   * stays runnable.
   */
  bundleSha256?: string;
  /**
   * Optional `AbortSignal` to interrupt a running execution. The cloud
   * `FlyioAdapter` listens for abort to guarantee the spawned machine is
   * destroyed even when the caller closes the SSE stream / the harness
   * shuts down mid-run. Wired in route handlers (e.g. `c.req.raw.signal`
   * in Hono). `LocalAdapter` ignores it for now.
   */
  abortSignal?: AbortSignal;
  /**
   * Whether this run may take a pre-created machine from the runner pool.
   * Absent means it may — a request that does not say keeps the pool as it
   * always had it. `false`: the cloud `FlyioAdapter` leaves the pool alone —
   * it reads none of its counters, takes no machine and asks for no refill —
   * creates a machine for the run, and counts a skip, never a miss: a pool
   * passed over on purpose is not a pool that failed to serve. `LocalAdapter`
   * has no pool and ignores it.
   */
  poolEligible?: boolean;
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
  /** How many of the run's output files were left out, by reason. Set on a completed run. */
  filesExcluded?: FilesExcluded;
}

/**
 * Why one of a run's output files is not among the files the run returns, in
 * the order a file is judged: its name breaks the output name rule
 * (`name_refused`), it is past the size limit (`too_large`), the count is
 * already reached (`over_count`); on the cloud runtime, its pull from the
 * machine failed (`pull_failed`), or the upload ran out of time before it was
 * stored (`upload_budget`). One reason per file.
 */
export type FileExclusionReason = OutputExclusionReason | "pull_failed" | "upload_budget";

/**
 * How many of a run's output files were left out, by reason — counts only,
 * never a name. A reason that left no file out is omitted: `{}` when every file
 * was kept.
 */
export type FilesExcluded = Partial<Record<FileExclusionReason, number>>;

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
  /**
   * How many of the run's output files are not in `files`, by reason; `{}` when
   * none was left out. Always present.
   */
  files_excluded: FilesExcluded;
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
 * fires one every ~30s while the cloud adapter acquires a runner, and during
 * LLM calls, tool dispatch, and outputs upload. Existing SSE consumers MUST
 * ignore unknown event types, and tolerate unknown `stage` values, so this
 * is backward-compatible.
 *
 * Known `stage` values:
 *  - `"acquiring_runner"` — cloud adapter waking or creating the run's
 *    machine, up to its `/init` (then `runner_spawned`)
 *  - `"waiting_llm"` — awaiting an LLM provider response
 *  - `"waiting_tool"` — awaiting a tool's `callTool` result (script or MCP)
 *  - `"uploading_outputs"` — cloud adapter sync-uploading outputs to R2
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
 *    declared `outputs` schema, and the auto-repair retry also failed.
 *  - `COST_EXCEEDED` — the run's aggregate estimated cost exceeded the agent's
 *    declared `environment.max_cost`; the run is aborted before completing.
 *  - `TOO_MANY_TOOL_CALLS` — one answer of the model asked for more than 128 tool calls; none ran.
 *  - `MODEL_RESPONSE_TOO_LARGE` — a response of the agent's `model.base_url` was over 4 MiB.
 *  - `MODEL_OUTPUT_BUDGET_EXCEEDED` — the model's answers in the run weighed over 4 MiB in all.
 *  - `OUTPUT_TOO_LARGE` — the JSON object of the final answer was over 1 MiB; it was not parsed.
 *  - any provider/runtime-specific code (LLM error, timeout, etc.) — the field
 *    is intentionally typed as `string` to accommodate future codes without a
 *    coordinated SDK release.
 */
export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

/**
 * Per-phase cold-start timing for a cloud (Fly) runner spawn — durations in
 * milliseconds — and the pool's indicators: whether a pooled machine served
 * the run, whether it resumed from its snapshot, and how many pooled machines
 * the run lost after its handoff began (a count).
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
   * `true` when a pre-created machine served this run rather than one created
   * for it. Never `false`: every other run omits it — no pool configured, a pool
   * that missed, or a run not entitled to one (`RunRequest.poolEligible`).
   */
  pool_hit?: boolean;
  /**
   * How many pooled machines were taken for this run and then discarded on a
   * failed handoff, before it had its machine — the run's handoff being its
   * URLs signed for it, then its credential and allowed hosts handed over
   * (the assignment), then its `/init`. A machine that would not wake or
   * answer its health check is not counted, nor one discarded as stale before
   * any claim: the run's handoff had not begun. `1` or absent: a run hands
   * its agent to one pooled machine at most, and one whose handoff failed
   * takes the cold path — so it never comes with `pool_hit`. Never `0`:
   * absent when there is none — no pool, nothing ready, a run not entitled to
   * one.
   */
  pool_handoffs_failed?: number;
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
  /**
   * In-VM /init: agent bundle download, plus the checksum comparison when the
   * run carries one. Both belong to the same phase — the time to obtain a
   * bundle worth extracting — which keeps init_extract_ms the tar alone.
   */
  init_bundle_ms?: number;
  /** In-VM /init: bundle extract. */
  init_extract_ms?: number;
  /**
   * In-VM /init: installing the dependencies the agent's scripts declare (near
   * zero when it declares none). Absent from a runner that predates the install.
   */
  init_deps_ms?: number;
  /** In-VM /init: MCP server connect (0 when the agent declares no MCP servers). */
  init_mcp_ms?: number;
}

/**
 * Informational event emitted once, right after the cloud runner is ready
 * (post-/init), carrying the per-phase cold-start breakdown. Fills the
 * otherwise-silent gap between `run_start` and the first agent-loop event so
 * consumers can see where a slow first run spends its time.
 *
 * Carries the phases only: durations, and the pool's indicators — a count among
 * them, which a cold-started run may carry too (`pool_handoffs_failed`). The
 * machine id and private IP are operator-internal and travel via the adapter's
 * `onRunnerSpawned` callback, never over the event stream. LocalAdapter runs (no
 * VM) do not emit this event. Existing SSE consumers ignore unknown event types,
 * so this is backward-compatible.
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
 * The runner's `POST /init` answer — declared, with the rest of what the harness
 * and the runner say to each other, in `runner-contract.ts`, derived from its
 * schema there, and named here too for the readers of this module.
 */
export type { InitResult } from "./runner-contract.js";

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

/**
 * Callback signature for `FlyioAdapterOptions.onSpawnFailed`: a run's machine
 * never got ready, and `phase` says where its acquisition stopped —
 * `undefined` for a failure that was not a failed start (`MachineSpawnError`).
 * Called before the run's `run_error` is handed out, so that whoever ends the
 * run on that event already knows the phase. Internal, like
 * `onRunnerSpawned`: nothing of it travels on the event stream.
 */
export type OnSpawnFailed = (info: { phase: MachineSpawnPhase | undefined }) => void;
