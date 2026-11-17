import { randomBytes } from "node:crypto";
import {
  MachineSpawnError,
  type MachineSpawnErrorDetails,
  type MachineSpawnPhase,
} from "../../errors.js";
import { reportedExclusions } from "../../files/output-rules.js";
import type { LLMRouter } from "../../llm/router.js";
import type { Logger } from "../../logger.js";
import { createLogger } from "../../logger.js";
import {
  type ClaimRequest,
  ClaimResultSchema,
  classifyInitFailure,
  type InfraHostsCheck,
  type InitErrorBody,
  InitErrorBodySchema,
  type InitRequest,
  type InitResult,
  InitResultSchema,
} from "../../runner-contract.js";
import { parseTimeout, withGeneratorTimeout } from "../../security/timeout.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolDefinition } from "../../tools/types.js";
import type {
  OnRunnerSpawned,
  OnSpawnFailed,
  RunCompleteEvent,
  RunEvent,
  RunRequest,
  RunResult,
  SpawnPhases,
} from "../../types.js";
import { errorFields } from "../../utils/error-fields.js";
import type { RuntimeAdapter } from "../adapter.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, runAgentLoop, withHeartbeats } from "../agent-loop.js";
import { deferStateWrites } from "../deferred-state.js";
import type { StateCallbacks } from "../local.js";
import { acquisitionBudgetMs, seatDeadlineMarginMs } from "./acquisition-budget.js";
import { searchCutCreation } from "./cut-creation-search.js";
import {
  type CreateProgress,
  FLY_APP_ACTION_BURST,
  type FlyMachinesApi,
  type Machine,
  RUN_LABEL_KEY,
} from "./fly-api.js";
import { storageInfraHosts } from "./infra-hosts.js";
import { buildMachineConfig, machineNameForRun } from "./machine-config.js";
import {
  LIFETIME_END_KEY,
  lifetimeEndValue,
  MAX_TIMER_DELAY_MS,
  machineLifetimeSeconds,
} from "./machine-lifetime.js";
import type { OutputBytesBudget } from "./output-bytes-budget.js";
import { runOutputsArchiveKey } from "./output-keys.js";
import { uploadOutputs } from "./outputs-upload.js";
import type { PooledMachine, RunnerPool } from "./pool.js";
import { RpcMcpToolProvider } from "./rpc-mcp-provider.js";
import { RpcScriptToolProvider } from "./rpc-script-provider.js";
import {
  callRunner,
  discardRunnerBody,
  RUNNER_CALL_BOUNDS,
  RunnerBodyTimeout,
  RunnerResponseTooLarge,
  readRunnerErrorText,
  readRunnerJson,
} from "./runner-call.js";
import { buildRunnerBaseUrl } from "./runner-url.js";

/**
 * Minimal storage contract `FlyioAdapter` depends on. Defined locally to
 * avoid a circular package dep on `@skrun-dev/api` (which itself imports
 * the runtime). The full `StorageAdapter` interface in the API package is
 * a structural superset, so passing an `R2Storage` / `MemoryStorage` /
 * `LocalStorage` here type-checks via duck typing.
 */
export interface PresignedStorageAdapter {
  /**
   * Write an object to storage. Used by `FlyioAdapter` to sync-upload
   * pulled outputs to R2 / MinIO. The full `StorageAdapter` interface in
   * `@skrun-dev/api` is a structural superset so any concrete impl works.
   *
   * `opts.signal` interrupts the write: the call rejects, and whether the
   * object was stored is unknown. The outputs upload passes the signal of its
   * time budget. A store that cannot interrupt a write may ignore it.
   */
  put(key: string, data: Buffer, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * Delete an object; a key that does not exist is not an error. Optional: the
   * outputs upload uses it, when present, to remove what an interrupted write
   * may have stored — absent, such an object is left to the store's lifecycle
   * rule on the runs' prefix.
   */
  delete?(key: string): Promise<void>;
  /**
   * `contentDisposition`, when given, is signed into the URL: the store answers
   * the GET with it. The outputs upload passes an attachment disposition.
   */
  getPresignedDownloadUrl(
    key: string,
    expiresIn: number,
    opts?: { contentDisposition?: string },
  ): Promise<string>;
  getPresignedUploadUrl(key: string, expiresIn: number): Promise<string>;
}

export interface FlyioAdapterOptions {
  /** Tag of the multi-runtime image (defaults to `ghcr.io/skrun-dev/skrun-runtime:latest`). */
  runtimeImage?: string;
  /** Fly.io region for spawned machines. Falls back to the app's default. */
  region?: string;
  /** Port the in-machine runner listens on. Default 9000. */
  runnerPort?: number;
  /** Override DNS re-resolve interval in seconds for short-TTL hosts. */
  dnsResolveIntervalSeconds?: number;
  /**
   * Max time to wait for the runner's `/healthz` to return 200 after machine
   * create. Default `DEFAULT_MAX_BOOT_TIME_MS` (90_000).
   */
  maxBootTimeMs?: number;
  /** Interval between `/healthz` polls during boot. Default 500. */
  bootPollIntervalMs?: number;
  /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Operator-only spawn-telemetry sink. Invoked once per run after the runner
   * is ready, with the machine id, private IP, and per-phase cold-start
   * breakdown. The api layer wires this to persist the operator-only fields to
   * the run record — they never travel over the RunEvent stream (the public
   * `runner_spawned` event carries the phases only: durations and the pool's
   * indicators).
   */
  onRunnerSpawned?: OnRunnerSpawned;
  /**
   * Told that this run's machine never got ready, with the phase its
   * acquisition stopped at — once, and before the run's `run_error` is handed
   * out: whoever ends the run on that event already knows the phase. The API
   * charges a run nothing for a machine that never got ready.
   */
  onSpawnFailed?: OnSpawnFailed;
  /**
   * Pre-warm pool. When present and enabled, a run wakes a machine that was
   * created and booted ahead of time instead of creating one. Absent or disabled
   * (the default), every run takes the create-per-run path unchanged — which is
   * what keeps that path the default everywhere but our own cloud, and therefore
   * exercised rather than rotting.
   */
  pool?: RunnerPool;
  /**
   * The budget the outputs upload reserves each file's buffer on. An adapter is
   * built for each run, so this is one for the whole process — the API passes the
   * one its cloud dependencies carry. Default: the process's
   * (`processOutputBytesBudget`), never one of this adapter's own.
   */
  outputsBudget?: OutputBytesBudget;
  /**
   * Cadence of the `run_heartbeat` events of a run's long waits — acquiring
   * the runner, the agent loop's model and tool calls, the outputs upload.
   * Default `DEFAULT_HEARTBEAT_INTERVAL_MS`; tests pass a smaller value.
   */
  heartbeatIntervalMs?: number;
  /**
   * The longest this run may spend acquiring its machine, in ms — the pool's
   * claims and the cold path together, up to the runner's answer to `/init`. A
   * hard bound: every call of the acquisition is aborted once it is spent, and
   * the run fails `MACHINE_SPAWN_FAILED` at the phase it reached. Default:
   * `acquisitionBudgetMs` for the platform's burst of creations, on this
   * adapter's boot budget. The API passes the value its seat margin derives from.
   */
  acquisitionBudgetMs?: number;
  /**
   * How long this run's seat is held, in ms — its timeout, capped at the longest
   * timer a process can arm, plus the margin the seat keeps for the acquisition
   * of its machine and the upload of its outputs. The machine created for the run
   * carries a lifetime of this plus a grace (`machineLifetimeSeconds`), counted
   * from its creation — a pooled machine is handed the same at its assignment,
   * counted from there: past it, the machine is judged abandoned. The API passes
   * the hold its admission wrote — the same value, never a copy. Default: the
   * run's timeout capped the same way, plus `seatDeadlineMarginMs` for the
   * platform's burst of creations, on this adapter's boot budget.
   */
  seatHoldMs?: number;
  /**
   * Handed the work a run leaves going once it has ended: the search, by its
   * label, for the machine a creation abandoned mid-flight may have made, and its
   * destruction. Never awaited by the run; the promise never rejects. The API
   * hands it to its stop, which waits for it within its grace.
   */
  onBackgroundCleanup?: (cleanup: Promise<void>) => void;
}

const DEFAULT_RUNTIME_IMAGE = "ghcr.io/skrun-dev/skrun-runtime:latest";
const DEFAULT_RUNNER_PORT = 9000;
// Bumped from 30s to 90s on 2026-05-25 after real-cloud
// measurement revealed the bimodal cold-start
// distribution: cache-hit spawns boot in ~5s, but cache-miss spawns
// (Fly schedules a machine onto a host that doesn't yet have the
// 750MB multi-runtime image) take ~50s for the pull + boot. 30s was
// the wrong default — it failed every cache-miss spawn. 90s gives
// margin while staying well under the run-timeout. Not a setting: the
// adapter's `maxBootTimeMs` option overrides it, and no variable sets that
// option (a warm pool and a smaller image are the proper fix, tracked
// separately).
/**
 * How long a runner may take to answer its `/healthz` once its machine exists,
 * unless the adapter is given `maxBootTimeMs`. Exported: the acquisition budget
 * derives from it (acquisition-budget.ts).
 */
export const DEFAULT_MAX_BOOT_TIME_MS = 90_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 500;
/**
 * How long the harness waits for a runner's `/init` answer — the bound its HTTP
 * client already put on that request before the response headers, made explicit
 * so that its end is named (phase `init-rpc`, a timeout) and lifted once the
 * answer arrives. `/init` holds the dependency install, stopped at
 * `SCRIPT_DEPS_INSTALL_TIMEOUT_MS` (180 s, tools/script-deps-resolver.ts), then
 * the connection of each MCP server, up to 120 s by default
 * (tools/mcp-provider.ts): 180 + 120 = 300. A test compares the three.
 *
 * Not a setting, nor an option of this adapter: the bound's mechanism is tested
 * on `fetchWithDeadline` itself (runner-call.ts), with a bound of milliseconds;
 * this value, on a simulated clock.
 */
export const INIT_RPC_TIMEOUT_MS = 300_000;
/**
 * Margin added to the boot budget for the lifetime of a run's presigned `/init`
 * URLs. Both paths sign them once their machine answers, so the lifetime only
 * has to cover `/init` itself; it keeps the boot budget plus this margin.
 */
const PRESIGNED_TTL_MARGIN_S = 30;

/**
 * Whether spawn_failed keeps the cause of a failed start — the text one level
 * down. The rule: a cause is kept as long as no answer of the runner went into
 * it, since that answer is made of what the agent declares. Decided by the
 * phase the start failed at and, where the phase is not enough, by how the error
 * was built — never by reading the text. Exhaustive on purpose: a new phase does
 * not compile until it is decided here.
 */
const SPAWN_FAILED_KEEPS_CAUSE: Record<
  MachineSpawnPhase,
  (details: MachineSpawnErrorDetails) => boolean
> = {
  // The platform's API answered: a body it wrote about our infrastructure — a
  // runner image tag that is gone, a quota.
  create: () => true,
  // Our own boot probe: "/healthz returned HTTP n", or a network error. A
  // status our code writes, never a body.
  "boot-probe": () => true,
  // The signing of the run's /init URLs, or of the probe of the store's host
  // before the creation: our storage client's error, about our own store. No
  // answer of the runner goes into it.
  presign: () => true,
  // /init. Built with no HTTP status, the error says no answer was read: its
  // cause is the wait that ran out, worded by our code, or the request's own
  // network error — kept. Built with one, an answer was read: its cause holds
  // the runner's body, its own error message (a server's URL, say), or says the
  // body could not be read — not kept. A pooled machine's /init that failed for
  // the run's own fault reaches spawn_failed the same way, with its status.
  "init-rpc": (details) => details.httpStatus === null,
  // A claim of a pooled machine that fails at these steps is caught by the
  // claim, which logs pool_claim_failed and goes on — to the next machine, or
  // to the cold path. It reaches spawn_failed only when the acquisition was
  // abandoned there, its cause the abandon's reason.
  "pool-resume": () => false,
  "pool-claim": () => false,
};

/** Outcome of the spawn phase — passed to the LLM-loop phase by a later commit. */
export interface SpawnResult {
  machineId: string;
  /** The runner machine's private 6PN address (operator-only telemetry). */
  privateIp: string;
  /** HTTP base URL of the runner on the machine's private 6PN address. */
  runnerBaseUrl: string;
  /** Tool definitions the runner reported during `/init`. */
  tools: ToolDefinition[];
  /** Per-run RPC bearer token minted at spawn — sent on every runner RPC. */
  rpcToken: string;
  /** Per-phase cold-start timing and the pool's indicators, captured during the spawn. */
  phases: SpawnPhases;
}

/** How far the claim of a pooled machine has gone: the step it is at, or failed at. */
export interface ClaimProgress {
  phase: MachineSpawnPhase;
}

/**
 * The pooled machines an acquisition took for its run and lost after the run's
 * handoff began — its URLs, credential and allowed hosts on their way, or its
 * `/init` —, counted as the claims go, for the run's phases.
 */
export interface PoolHandoffs {
  failed: number;
}

/**
 * A spawn's result with the pooled machines its run lost after its handoff
 * began, in its phases (`pool_handoffs_failed`) — absent when it lost none,
 * never `0`.
 */
function withHandoffs(spawn: SpawnResult, handoffs: PoolHandoffs): SpawnResult {
  if (handoffs.failed === 0) return spawn;
  return { ...spawn, phases: { ...spawn.phases, pool_handoffs_failed: handoffs.failed } };
}

/** How an acquisition ended, for the run that asked for it. */
export interface AcquisitionOutcome {
  /** Abandoned: its budget spent, or the run's signal aborted. */
  abandoned: boolean;
}

/**
 * `FlyioAdapter` — runs each `POST /run` inside a dedicated Fly.io Machine
 * spawned from the multi-runtime image. The LLM loop drives from the
 * harness (which holds caller LLM keys); tool calls are forwarded to the
 * machine via HTTP RPC over Fly.io's 6PN private network.
 *
 * **Partial implementation.** This commit lands the spawn → boot probe →
 * /init RPC orchestration (`spawnRunner`) and an `executeStream` that
 * emits `run_start`, performs the spawn, and yields a placeholder
 * `run_error` (the LLM loop + outputs collect + destroy land in
 * follow-up commits).
 */
export class FlyioAdapter implements RuntimeAdapter {
  protected readonly logger: Logger;

  /**
   * The label writes in flight ({@link labelAssignedMachine}), by machine: one
   * entry while a machine's writes are under way, removed once they settle —
   * never a record of the machines destroyed. `retired` once this adapter has
   * asked for that machine's destruction ({@link destroyMachineSafely}).
   */
  private readonly labelling = new Map<string, { retired: boolean }>();

  constructor(
    protected readonly flyApi: FlyMachinesApi,
    protected readonly storage: PresignedStorageAdapter,
    protected readonly llmRouter: LLMRouter,
    protected readonly tools: ToolRegistry,
    protected readonly stateCallbacks?: StateCallbacks,
    protected readonly options: FlyioAdapterOptions = {},
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("flyio-adapter");
  }

  async execute(_request: RunRequest): Promise<RunResult> {
    // The one-shot (non-streaming) path is not implemented on the flyio runtime;
    // only streaming is wired. Point the caller at the paths that work — the
    // CLI and the SDK's run() read the stream and hand back the one-shot
    // result — instead of a cryptic internal message.
    throw new Error(
      "One-shot execution is not supported on the flyio runtime — read the run's event stream " +
        "instead: `skrun run` or the SDK's client.run() (both return the one-shot result), " +
        "client.stream(), the dashboard Run button, or an HTTP request with the " +
        "'Accept: text/event-stream' header.",
    );
  }

  async *executeStream(request: RunRequest): AsyncGenerator<RunEvent> {
    const config = request.agentConfig;
    const timeoutMs = parseTimeout(config.environment.timeout);
    const startMs = Date.now();

    yield {
      type: "run_start",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      agent: config.name,
      agent_version: request.agent_version ?? "unknown",
    };

    // Acquiring the runner — waking a pooled machine or creating one, up to its
    // /init — is the longest wait of a cold run, and nothing else is emitted
    // during it: it beats like the others, or the stream stays silent from
    // run_start to runner_spawned, long enough for a proxy to close it. A
    // failure is rethrown by the wrapper and lands in the catch below.
    const hb = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    // How the creation of this run's machine went, filled in by the platform
    // client: one sent a second time may have left a second machine of the run's
    // label, which the end of the run — or a failed start — destroys.
    const creation: CreateProgress = { resent: false, adopted: false };
    // Whether the acquisition was abandoned — its budget spent, its caller gone.
    const acquisition: AcquisitionOutcome = { abandoned: false };
    // Aborted when the stream ends while the acquisition is still this run's to
    // take — a consumer that closes the run on one of its heartbeats: joined to
    // the acquisition's signal, it cuts the acquisition where it stands.
    const closed = new AbortController();
    let acquiring: Promise<SpawnResult> | undefined;
    // Whether the acquisition's failure was taken in hand below.
    let acquisitionFailed = false;
    let spawn: SpawnResult | null = null;
    let registry: ToolRegistry | undefined;
    // Until the loop starts, a run that ends is one its consumer closed — or
    // one a step before the loop threw in (the catch at the end says so).
    let destroyReason = "consumer_closed";
    // From the acquisition to the end of the run, one `finally` lets the run's
    // machine go: destroyed once the run holds it, cut and cleaned up in the
    // background while it is still being acquired.
    try {
      acquiring = this.acquireRunner(request, creation, acquisition, closed.signal);
      // What the acquisition failed with, once it has — told apart, by identity,
      // from an error its consumer throws into the stream on a heartbeat.
      const failure: { of?: { error: unknown } } = {};
      acquiring.catch((error: unknown) => {
        failure.of = { error };
      });
      try {
        spawn = yield* withHeartbeats(acquiring, "acquiring_runner", request.runId, hb);
      } catch (err) {
        // Not the acquisition's failure — whether it is still under way, ready,
        // or failed with another error: an error the consumer threw in (throw()
        // on its generator). The run ends as one its consumer closed — the
        // acquisition cut, what it made let go in the background (the finally
        // below) —, no run_error, and the error goes back to the consumer.
        if (failure.of === undefined || failure.of.error !== err) throw err;
        acquisitionFailed = true;
        // An acquisition its budget ended is told in those words; a failed
        // start, in the fixed words its error builds — the phase and a failed
        // /init's step, never the machine nor the runner's text
        // (MachineSpawnError); any other failure keeps its own.
        const message =
          err instanceof MachineSpawnError && err.cause instanceof AcquisitionBudgetSpent
            ? err.cause.message
            : err instanceof Error
              ? err.message
              : String(err);
        const code = err instanceof MachineSpawnError ? err.code : "MACHINE_SPAWN_FAILED";
        // The LOG says the error by its class, code and status, with the phase
        // and the machine, and keeps the underlying cause where it describes our
        // infrastructure: the fixed '... (phase "create", HTTP 400).' cannot say
        // that a runner image tag is gone, the platform's answer ("manifest
        // unknown") can. Which causes are kept is decided by phase and by how
        // the error was built, never by reading the text
        // (SPAWN_FAILED_KEEPS_CAUSE). Kept OUT of the caller-facing run_error
        // below: Fly internals — the machine's id among them — are operator
        // diagnostics, not marketplace-consumer surface.
        const spawnError = err instanceof MachineSpawnError ? err : undefined;
        const cause =
          spawnError !== undefined &&
          SPAWN_FAILED_KEEPS_CAUSE[spawnError.details.phase](spawnError.details) &&
          spawnError.cause instanceof Error
            ? spawnError.cause.message
            : undefined;
        this.logger.error(
          {
            event: "spawn_failed",
            run_id: request.runId,
            ...errorFields(err),
            ...(cause === undefined ? {} : { cause }),
            phase: spawnError?.details.phase,
            // The step a failed /init named — a word of the contract's.
            stage: spawnError?.details.stage,
            httpStatus: spawnError?.details.httpStatus,
            machine_id: spawnError?.details.machineId,
          },
          "FlyioAdapter spawn failed",
        );
        // The phase goes to the API before anything is yielded: the consumer
        // ends the run on the run_error below, and by then it must know whether
        // the run's machine ever got ready.
        this.options.onSpawnFailed?.({ phase: spawnError?.details.phase });
        // If the failure happened AFTER create (boot-probe or init-rpc
        // phase), the machine exists and would leak — destroy it.
        if (err instanceof MachineSpawnError && err.details.machineId) {
          await this.destroyMachineSafely(
            err.details.machineId,
            `spawn_failed_${err.details.phase}`,
          );
        }
        // A creation abandoned mid-flight: the platform may have made a machine it
        // never answered for, and the client sent nothing more for it. Looked for
        // by its label once the run's error is out — its own search covers a
        // creation sent twice.
        const abandonedCreation =
          acquisition.abandoned &&
          spawnError?.details.phase === "create" &&
          spawnError.details.machineId === null;
        if (creation.resent && !abandonedCreation) {
          await this.destroyLabelledDuplicates(
            request.runId,
            err instanceof MachineSpawnError ? err.details.machineId : null,
          );
        }
        const runError: RunEvent = {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code, message },
        };
        if (!abandonedCreation) {
          yield runError;
          return;
        }
        // Started once the consumer has the error — and has written the run's end
        // — and never awaited: it holds back neither the error, nor the stream's
        // end, nor the seat.
        try {
          yield runError;
        } finally {
          this.cleanUpAbandonedCreation(request.runId, creation.lastSentAt);
        }
        return;
      }

      // Cold-start telemetry: emit the per-phase breakdown (durations and the
      // pool's indicators) so consumers see where the spawn spent its time, and
      // hand the operator-only machine id + private IP to the telemetry sink —
      // never the event stream.
      yield {
        type: "runner_spawned",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        phases: spawn.phases,
      };
      this.options.onRunnerSpawned?.({
        machineId: spawn.machineId,
        privateIp: spawn.privateIp,
        phases: spawn.phases,
      });

      // Per-request ToolRegistry: the runner reported the full tool list at
      // /init, so we partition by name against the script tools declared in
      // agent.yaml — anything not in that set must be an MCP-provided tool.
      // 5.1 may extract this into a `buildToolRegistryForAdapter` helper.
      const scriptToolNames = new Set((config.tools ?? []).map((t) => t.name));
      const scriptTools: ToolDefinition[] = spawn.tools.filter((t) => scriptToolNames.has(t.name));
      const mcpTools: ToolDefinition[] = spawn.tools.filter((t) => !scriptToolNames.has(t.name));

      registry = new ToolRegistry();
      const scriptProvider = new RpcScriptToolProvider(spawn.runnerBaseUrl, scriptTools, {
        fetchImpl: this.options.fetchImpl,
        token: spawn.rpcToken,
      });
      const mcpProvider = new RpcMcpToolProvider(spawn.runnerBaseUrl, mcpTools, {
        fetchImpl: this.options.fetchImpl,
        token: spawn.rpcToken,
      });
      await registry.addProvider(scriptProvider);
      await registry.addProvider(mcpProvider);

      destroyReason = "run_complete";
      // The loop's state write is held until the outputs are uploaded.
      const state = this.stateCallbacks ? deferStateWrites(this.stateCallbacks) : undefined;
      try {
        // Stream events from the agent loop AS THEY HAPPEN so heartbeats
        // (and tool_call / tool_result) reach the SSE consumer in real
        // time. Caller AbortSignal is honoured via withAbort wrapper;
        // timeout via withGeneratorTimeout. LLM-call cancellation itself
        // is not yet wired (LLMRouter has no signal plumbing); the
        // in-flight request resolves naturally — the race just short-
        // circuits the harness side so the machine can be destroyed.
        const loop = runAgentLoop({
          request,
          router: this.llmRouter,
          tools: registry,
          stateCallbacks: state?.callbacks,
          logger: this.logger,
          startMs,
          heartbeatIntervalMs: hb,
        });
        const timeoutWrapped = withGeneratorTimeout(loop, timeoutMs);
        const abortWrapped = wrapWithAbort(timeoutWrapped, request.abortSignal);

        let runComplete: RunCompleteEvent | null = null;
        for await (const event of abortWrapped) {
          if (event.type === "run_complete") {
            // Buffer run_complete — emit it only after the file manifest
            // is in R2 so the event carries presigned GET URLs.
            runComplete = event;
          } else {
            // A run_error is the loop's last event, and its consumer may close
            // this generator there, without pulling again: the machine is
            // destroyed under that reason, whichever way the run ends.
            if (event.type === "run_error") destroyReason = "run_error";
            yield event;
          }
        }
        if (runComplete) {
          // Sync-upload outputs to R2 before emitting run_complete. The
          // upload itself can be slow (10s of seconds for big artifacts)
          // so heartbeats fire during the wait via withHeartbeats. It keeps a
          // time budget of its own: past it, it returns what it stored and the run
          // succeeds with fewer files. A failure before it is an OutputsUploadError,
          // of its own name — the catch below never reads it as an abort or a
          // timeout of the run.
          const uploadPromise = uploadOutputs({
            runId: request.runId,
            runnerBaseUrl: spawn.runnerBaseUrl,
            storage: this.storage,
            fetchImpl: this.options.fetchImpl,
            // The outputs pull (/outputs/collect + /outputs/file) is
            // RPC to the runner and must carry the per-run Bearer, same as /init +
            // /tool. Omitting it 401s once the runner enforces the token (L5 catch).
            token: spawn.rpcToken,
            logger: this.logger,
            // Absent, the upload reserves on the process's budget.
            bytesBudget: this.options.outputsBudget,
          });
          // What it left out is counted, by reason, in `uploaded.excluded`: the
          // caller is told those counts, never a name.
          const uploaded = yield* withHeartbeats(
            uploadPromise,
            "uploading_outputs",
            request.runId,
            hb,
          );
          // The outputs are in place: the run has succeeded, its state is written.
          // A failed write is thrown, and ends the run like any error above.
          await state?.commit();
          yield {
            ...runComplete,
            files: uploaded.files,
            files_excluded: reportedExclusions(uploaded.excluded),
          };
        } else {
          destroyReason = "run_error";
        }
      } catch (err) {
        const errName = (err as Error).name;
        const isTimeout = errName === "TimeoutError";
        const isAbort = errName === "AbortError";
        destroyReason = isAbort ? "aborted" : isTimeout ? "timeout" : "run_failed";
        const code = isAbort ? "ABORTED" : isTimeout ? "TIMEOUT" : "EXECUTION_FAILED";
        // An error that wraps another — an OutputsUploadError, whose code names
        // the step that failed — is told by the class of what it wraps too: its
        // name, read through errorFields, never its message, which can quote a
        // storage key.
        const cause = err instanceof Error ? err.cause : undefined;
        const causeName = cause === undefined ? undefined : errorFields(cause).error_name;
        this.logger.error(
          {
            event: destroyReason,
            run_id: request.runId,
            agent: config.name,
            ...errorFields(err),
            ...(causeName === undefined ? {} : { cause_name: causeName }),
          },
          `FlyioAdapter run ${destroyReason}`,
        );
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code, message: err instanceof Error ? err.message : String(err) },
        };
      }
    } catch (err) {
      // A step between the acquisition and the loop threw — a tool provider
      // that would not register, the telemetry sink —, or the consumer threw an
      // error into the stream during the acquisition: the run ends there, its
      // machine let go below, and the error is the consumer's.
      destroyReason = "run_failed";
      throw err;
    } finally {
      if (spawn !== null) {
        await registry?.disconnectAll().catch(() => {});
        await this.releaseRunMachine(spawn.machineId, destroyReason);
        if (creation.resent) await this.destroyLabelledDuplicates(request.runId, spawn.machineId);
      } else if (acquiring !== undefined && !acquisitionFailed) {
        // The stream ended — closed, or thrown into by its consumer — while the
        // acquisition was still under way, or before its machine was taken in
        // hand here: the acquisition is cut, and what it made is let go in the
        // background — the consumer is gone.
        closed.abort(new RunClosedDuringAcquisition());
        this.cleanUpClosedAcquisition(acquiring, request.runId, creation, acquisition);
      }
    }
  }

  /**
   * Spawn the runner machine end-to-end:
   *  1. `flyApi.create(machineConfig)` → machine record with private IPv6. The
   *     configuration holds no URL of the run.
   *  2. Poll `GET <baseUrl>/healthz` until 200 or boot-time budget exhausted.
   *  3. Presigned bundle GET URL + outputs PUT URL, their lifetime counted from
   *     here — as on the pool's path, once its machine wakes. Signed before the
   *     creation, they would have to outlast its wait for a slot, its patience
   *     with a refusal, a search by its label: a URL that expired before `/init`
   *     read it would fail the run there.
   *  4. `POST <baseUrl>/init` with bundle URL, outputs URL, tools, mcp servers, allowed hosts.
   *
   * On any failure: a `MachineSpawnError` is thrown with the failing phase
   * recorded; the machine (if created) is destroyed by `executeStream`'s
   * catch path so we don't leak Fly.io resources — a store that will not sign
   * the URLs included (phase `presign`). A store that will not sign the probe of
   * its host, before the creation, fails at `presign` too, with no machine.
   *
   * `creation`, when given, is filled in by the platform client as the creation
   * goes — see {@link CreateProgress}.
   */
  protected async spawnRunner(
    request: RunRequest,
    creation?: CreateProgress,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    if (!request.bundleKey) {
      throw new MachineSpawnError(
        {
          machineName: `skrun-run-${request.runId}`,
          machineId: null,
          phase: "create",
          httpStatus: null,
        },
        new Error("RunRequest.bundleKey is required for FlyioAdapter (not set by the harness)."),
      );
    }

    const bundleKey = request.bundleKey;
    const port = this.options.runnerPort ?? DEFAULT_RUNNER_PORT;
    const maxBootTimeMs = this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS;
    const ttlSeconds = Math.ceil(maxBootTimeMs / 1000) + PRESIGNED_TTL_MARGIN_S;
    const allowedHosts = request.agentConfig.environment.networking.allowed_hosts ?? [];

    // Infra egress the runner needs that the agent's allowed_hosts don't cover:
    // the install-time package registries and the object store — its ONLY
    // object-store egress is the bundle GET at /init (outputs are harness-pulled,
    // never pushed by the runner). The entrypoint allowlists these on both
    // families; without them every cloud run dies at /init (bundle fetch) now that
    // the ip6tables policy closes the previously-open IPv6 they rode on. The
    // definition the pool uses too: the store's host read from a probe URL.
    // A store that will not sign that probe fails the start at `presign`, before
    // any machine: its error can quote the store's endpoint, so it is the cause,
    // for the log — the caller reads the phase alone.
    let infraHosts: string[];
    try {
      infraHosts = await storageInfraHosts(this.storage);
    } catch (err) {
      throw new MachineSpawnError(
        {
          machineName: machineNameForRun(request.runId),
          machineId: null,
          phase: "presign",
          httpStatus: null,
        },
        err,
      );
    }

    // 1. Build machine config + create. Mint a per-run RPC token: it goes into
    // the machine env (so the runner verifies inbound RPC) AND is sent as a
    // Bearer on every RPC from here (so the runner accepts ours).
    const rpcToken = randomBytes(32).toString("hex");
    const machineRequest = buildMachineConfig({
      runId: request.runId,
      image: this.options.runtimeImage ?? DEFAULT_RUNTIME_IMAGE,
      allowedHosts,
      region: this.options.region,
      runnerPort: port,
      // What ends a machine nobody destroyed: the hold of its run's seat plus a
      // grace, counted from now.
      lifetimeSeconds: machineLifetimeSeconds({ seatHoldMs: this.seatHoldMs(request) }),
      dnsResolveIntervalSeconds: this.options.dnsResolveIntervalSeconds,
      rpcToken,
      infraHosts,
      // The harness's own 6PN — the runner's ip6tables ACCEPTs the RPC reply
      // path to it (defense-in-depth behind ESTABLISHED,RELATED). Fly sets
      // FLY_PRIVATE_IP on every machine; unset off-Fly → the rule is omitted.
      harness6pn: process.env.FLY_PRIVATE_IP,
    });

    const createStartMs = Date.now();
    let machine: Machine;
    try {
      machine = await this.flyApi.create(machineRequest, creation, { signal });
    } catch (err) {
      if (err instanceof MachineSpawnError) throw err;
      throw new MachineSpawnError(
        {
          machineName: machineRequest.name ?? "(unnamed)",
          machineId: null,
          phase: "create",
          httpStatus: null,
        },
        err,
      );
    }
    const createApiMs = Date.now() - createStartMs;

    const machineId = machine.id;
    const privateIp = machine.private_ip;
    if (!privateIp) {
      throw new MachineSpawnError(
        {
          machineName: machineRequest.name ?? "(unnamed)",
          machineId,
          phase: "create",
          httpStatus: null,
        },
        new Error("Fly.io create response missing private_ip — runner cannot be reached"),
      );
    }

    const runnerBaseUrl = buildRunnerBaseUrl(privateIp, port);

    // 2. Boot probe — keep polling /healthz until 200 or budget exhausted.
    // This interval is the opaque host-side blob (schedule + image pull + VM
    // boot + entrypoint egress + Node listening); the runner's own boot clock
    // (below) lets us subtract the in-VM part to isolate the schedule + pull.
    const bootProbeStartMs = Date.now();
    await this.pollHealthz(
      runnerBaseUrl,
      maxBootTimeMs,
      machineId,
      machineRequest.name ?? "(unnamed)",
      signal,
    );
    const createToHealthzMs = Date.now() - bootProbeStartMs;

    // 3. Presigned URLs — the sandbox never sees credentials. Signed now, their
    // lifetime counted from here; a store that will not sign them fails the start
    // with the machine's id, so the machine is destroyed rather than left to bill.
    let bundleUrl: string;
    let outputsPutUrl: string;
    try {
      ({ bundleUrl, outputsPutUrl } = await this.presignRunUrls(
        bundleKey,
        request.runId,
        ttlSeconds,
      ));
    } catch (err) {
      throw new MachineSpawnError(
        {
          machineName: machineRequest.name ?? "(unnamed)",
          machineId,
          phase: "presign",
          httpStatus: null,
        },
        err,
      );
    }
    // The signing takes no signal: an abandon during it ends the start here.
    if (signal?.aborted) {
      throw new MachineSpawnError(
        {
          machineName: machineRequest.name ?? "(unnamed)",
          machineId,
          phase: "presign",
          httpStatus: null,
        },
        signal.reason,
      );
    }

    // 4. /init RPC — pass parsed config so the runner has zero parsing burden.
    const initStartMs = Date.now();
    const initResult = await this.initRunner(
      runnerBaseUrl,
      machineId,
      machineRequest.name ?? "(unnamed)",
      {
        bundleUrl,
        outputsPutUrl,
        tools: request.agentConfig.tools ?? [],
        mcpServers: request.agentConfig.mcp_servers ?? [],
        allowedHosts,
        // The URL above and this checksum belong together: the runner downloads
        // its own copy of the bundle, and this is what it checks that copy
        // against before extracting. Undefined for a bundle with nothing on
        // record — the runner then extracts and says so.
        bundleSha256: request.bundleSha256,
      },
      rpcToken,
      signal,
    );
    const healthzToInitMs = Date.now() - initStartMs;

    // Assemble the per-phase cold-start breakdown. The runner's phases/boot are
    // OPTIONAL (an older runner image omits them) — degrade, never throw. The
    // image pull is DERIVED: create->healthz minus the runner's in-VM boot time.
    const vmBootMs = initResult.boot?.vm_boot_ms;
    const phases: SpawnPhases = {
      create_api_ms: createApiMs,
      host_schedule_pull_ms:
        vmBootMs != null ? Math.max(0, createToHealthzMs - vmBootMs) : undefined,
      vm_boot_ms: vmBootMs,
      entrypoint_egress_ms: initResult.boot?.entrypoint_egress_ms,
      module_load_ms: initResult.boot?.module_load_ms,
      init_bundle_ms: initResult.phases?.bundle_ms,
      init_extract_ms: initResult.phases?.extract_ms,
      init_deps_ms: initResult.phases?.deps_ms,
      init_mcp_ms: initResult.phases?.mcp_ms,
    };

    // Operator-only consistency guard: the harness-measured healthz->init should
    // roughly track the sum of the in-VM /init phases the runner reported.
    if (initResult.phases) {
      const inVmInitMs =
        (initResult.phases.bundle_ms ?? 0) +
        (initResult.phases.extract_ms ?? 0) +
        (initResult.phases.deps_ms ?? 0) +
        (initResult.phases.mcp_ms ?? 0);
      if (Math.abs(healthzToInitMs - inVmInitMs) > 2000) {
        this.logger.debug(
          {
            event: "spawn_phase_mismatch",
            run_id: request.runId,
            healthz_to_init_ms: healthzToInitMs,
            in_vm_init_ms: inVmInitMs,
          },
          "FlyioAdapter /init wall time differs from the runner's reported phases",
        );
      }
    }

    this.logger.info(
      {
        event: "spawn_ready",
        run_id: request.runId,
        machine_id: machineId,
        tool_count: initResult.tools.length,
        // The image the platform created this machine with, digest included.
        image: describeImageRef(machine.image_ref),
      },
      "FlyioAdapter runner ready",
    );

    return {
      machineId,
      privateIp,
      runnerBaseUrl,
      tools: initResult.tools,
      rpcToken,
      phases,
    };
  }

  /**
   * How long this run's seat is held, in ms — the hold the API handed over
   * (`options.seatHoldMs`), or, handed none, the run's timeout capped at the
   * longest timer plus the seat's margin for the platform's burst of creations on
   * this adapter's boot budget. A timeout nothing bounds counted raw would give a
   * lifetime no clock can reach.
   */
  protected seatHoldMs(request: RunRequest): number {
    if (this.options.seatHoldMs !== undefined) return this.options.seatHoldMs;
    const timeoutMs = Math.min(
      parseTimeout(request.agentConfig.environment.timeout),
      MAX_TIMER_DELAY_MS,
    );
    return (
      timeoutMs +
      seatDeadlineMarginMs({
        concurrentCreates: FLY_APP_ACTION_BURST,
        maxBootTimeMs: this.options.maxBootTimeMs,
      })
    );
  }

  /**
   * Presign the two URLs the sandbox needs. Shared by both acquisition paths so
   * the outputs-key convention has one definition rather than two that can drift.
   */
  protected async presignRunUrls(
    bundleKey: string,
    runId: string,
    ttlSeconds: number,
  ): Promise<Required<Pick<InitRequest, "bundleUrl" | "outputsPutUrl">>> {
    const outputsKey = runOutputsArchiveKey(runId);
    const [bundleUrl, outputsPutUrl] = await Promise.all([
      this.storage.getPresignedDownloadUrl(bundleKey, ttlSeconds),
      this.storage.getPresignedUploadUrl(outputsKey, ttlSeconds),
    ]);
    return { bundleUrl, outputsPutUrl };
  }

  /**
   * Get a runner for this run: wake a pre-created one if the pool has one, and
   * otherwise create one the way we always have. A run not entitled to the pool
   * (`request.poolEligible === false`) goes straight to the creation, past the
   * pool, counted as a skip.
   *
   * The fall-back is not an error path. With the pool disabled — the default
   * outside our own cloud — every run comes through here and lands on
   * {@link spawnRunner} unchanged, which is what keeps that path exercised rather
   * than slowly rotting behind a feature nobody turns off.
   *
   * One budget bounds it all, the pool's claims and the cold path together
   * (`options.acquisitionBudgetMs`): a timer aborts a signal once it is spent,
   * and that signal — joined to the caller's (`request.abortSignal`: a caller
   * who hangs up, a server that stops) and to `closed` (the run's stream ending
   * before the acquisition is over) — is handed to every call of the
   * acquisition. Whatever aborts it ends the acquisition where it stands, as a
   * `MachineSpawnError` of the phase reached, its cause the signal's reason: no
   * other pooled machine is tried, nor the cold path. The timer is cleared
   * however it ends.
   */
  protected async acquireRunner(
    request: RunRequest,
    creation?: CreateProgress,
    outcome?: AcquisitionOutcome,
    closed?: AbortSignal,
  ): Promise<SpawnResult> {
    const budgetMs =
      this.options.acquisitionBudgetMs ??
      acquisitionBudgetMs({
        concurrentCreates: FLY_APP_ACTION_BURST,
        maxBootTimeMs: this.options.maxBootTimeMs,
      });
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new AcquisitionBudgetSpent(budgetMs)), budgetMs);
    const joined = [budget.signal, request.abortSignal, closed].filter(
      (each): each is AbortSignal => each !== undefined,
    );
    const signal = joined.length === 1 ? budget.signal : AbortSignal.any(joined);
    try {
      return await this.acquireWithin(request, signal, creation);
    } catch (err) {
      if (!signal.aborted) throw err;
      if (outcome) outcome.abandoned = true;
      // Ended by an abandon: told by its reason, at the phase it reached.
      const details: MachineSpawnErrorDetails =
        err instanceof MachineSpawnError
          ? err.details
          : {
              machineName: machineNameForRun(request.runId),
              machineId: null,
              phase: "create",
              httpStatus: null,
            };
      throw new MachineSpawnError(details, signal.reason);
    } finally {
      clearTimeout(timer);
    }
  }

  private async acquireWithin(
    request: RunRequest,
    signal: AbortSignal,
    creation?: CreateProgress,
  ): Promise<SpawnResult> {
    const pool = this.options.pool;
    // The pooled machines this run takes and loses after its handoff began,
    // told in its phases whichever machine it ends up with.
    const handoffs: PoolHandoffs = { failed: 0 };
    if (pool?.enabled && request.poolEligible === false) {
      // A run not entitled to a pooled machine leaves the pool alone — no
      // counter read, no machine taken, no refill asked — and is counted apart
      // from a miss: a pool passed over on purpose is not a pool that failed.
      pool.recordSkip();
    } else if (pool?.enabled) {
      const hadCandidates = pool.stats().ready > 0;
      // Distinguish "nothing to give" from "something, but none of it worked":
      // a pool full of unusable machines otherwise reads exactly like a busy one.
      // A claim the signal cut counts as a miss too: the pool did not serve.
      const miss = () => pool.recordMiss(hadCandidates ? "unusable" : "empty");
      let pooled: SpawnResult | null;
      try {
        pooled = await this.tryPooledRunner(request, pool, signal, handoffs);
      } catch (err) {
        miss();
        throw err;
      }
      if (pooled) {
        pool.recordHit();
        return withHandoffs(pooled, handoffs);
      }
      miss();
    }
    // Once the signal is up, no machine is created.
    if (signal.aborted) {
      throw new MachineSpawnError(
        {
          machineName: machineNameForRun(request.runId),
          machineId: null,
          phase: "create",
          httpStatus: null,
        },
        signal.reason,
      );
    }
    return withHandoffs(await this.spawnRunner(request, creation, signal), handoffs);
  }

  /**
   * Try to serve this run from the pool. Returns `null` when it cannot, so the
   * caller falls back to creating a machine; throws when the run itself cannot
   * start (below).
   *
   * Every failure mode destroys the machine it touched rather than retrying
   * it. A machine that would not wake, or would not accept its
   * assignment, is spent: its assignment is single-use by design, so a retry
   * could only fail again — and a machine left behind bills silently.
   *
   * The distinct failure phases matter here. "The pool was empty" and "the pool
   * was full but nothing in it would wake" both end up on the cold path, and
   * without separate counters the second is invisible: a completely broken pool
   * would look exactly like a busy one.
   *
   * A claim that fails because `signal` aborted — the acquisition's budget spent,
   * its caller gone — still discards its machine, then ends the acquisition
   * there: a `MachineSpawnError` of the step the claim reached, with no machine
   * left to destroy. No other machine is taken once the signal is up.
   *
   * A run hands its agent to one pooled machine at most. One that would not
   * wake (`pool-resume`) or answer its health check (`boot-probe`) had nothing
   * of the run, nor had a stale one: the next ready machine is tried, and they
   * are not counted. A machine whose claim failed once the run's handoff
   * began — at the assignment (`pool-claim`: its URLs signed, then its
   * credential and allowed hosts) or at its `/init` (`init-rpc`) — was taken for
   * the run: counted in `handoffs`, and the loop stops there. An `/init` the
   * runner failed at a step any other machine would meet again — the contract
   * judges it (`classifyInitFailure`) — fails the run: a `MachineSpawnError` at
   * `init-rpc`, no machine left to destroy, no machine created. Any other
   * failure after the handoff began — a refused assignment (a 409 included: the
   * machine taken by another instance), an `/init` with no answer, one whose
   * step may not be the run's or that names none — returns `null`, and the run
   * takes the cold path within what is left of its budget. An abandoned claim
   * ends the acquisition, and is not counted.
   */
  protected async tryPooledRunner(
    request: RunRequest,
    pool: RunnerPool,
    signal?: AbortSignal,
    handoffs: PoolHandoffs = { failed: 0 },
  ): Promise<SpawnResult | null> {
    if (!request.bundleKey) return null;
    const port = this.options.runnerPort ?? DEFAULT_RUNNER_PORT;

    // Bounded: one pass over what the pool believes it has. Without a bound, a
    // pool full of unwakeable machines would stall the request while it chewed
    // through all of them instead of falling back promptly.
    const attempts = pool.stats().ready;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) break;
      const machine = pool.takeReady();
      if (!machine) break;
      // Taking a machine reopens the deficit. Ask for it to be refilled now
      // rather than at the next maintenance tick, so a burst of runs does not
      // drain the pool and leave later ones on the cold path for a whole
      // interval. Never awaited — this run does not pay for the next one's
      // machine.
      pool.requestTopUp();

      // Staleness is checked at the moment of use, not only in the background:
      // an image or harness change since this machine was built means it would
      // run superseded code, or could not be reached at all.
      if (pool.isStale(machine)) {
        await this.discardPooledMachine(pool, machine, "stale");
        continue;
      }

      // The step the claim has reached, kept here as the claim goes rather than
      // read from the error: what failed is where the claim stood.
      const claim: ClaimProgress = { phase: "pool-resume" };
      try {
        return await this.claimPooledRunner(request, pool, machine, port, claim, signal);
      } catch (err) {
        // A machine that will not wake: the platform's answer, one level down,
        // says why, and it describes our infrastructure, not a run. Any later
        // step's cause is the runner's answer, made of what the agent declares —
        // never written. Chosen by the step the claim reached, not by the error.
        const cause =
          claim.phase === "pool-resume" &&
          err instanceof MachineSpawnError &&
          err.cause instanceof Error
            ? err.cause.message
            : undefined;
        this.logger.warn(
          {
            event: "pool_claim_failed",
            run_id: request.runId,
            machine_id: machine.machineId,
            phase: claim.phase,
            ...errorFields(err),
            ...(cause === undefined ? {} : { cause }),
          },
          "pooled runner could not be assigned — discarding it",
        );
        // An /init the runner answered with a failure says, too, what the machine
        // measured of its infrastructure hosts: counted as a served run's is.
        if (
          claim.phase === "init-rpc" &&
          err instanceof MachineSpawnError &&
          err.cause instanceof RunnerInitFailed
        ) {
          this.countInfraHosts(
            pool,
            request.runId,
            machine.machineId,
            err.cause.failure.infra_hosts,
            "init-rpc",
          );
        }
        await this.discardPooledMachine(pool, machine, claim.phase);
        if (signal?.aborted) {
          throw new MachineSpawnError(
            {
              machineName: machine.machineId,
              // Discarded already: nothing is left for the run's end to destroy.
              machineId: null,
              phase: claim.phase,
              httpStatus: null,
            },
            signal.reason,
          );
        }
        // A failed wake or health check had nothing of the run: the next ready
        // machine is tried.
        if (claim.phase !== "pool-claim" && claim.phase !== "init-rpc") continue;
        // Taken for the run once its handoff began — and the run's last pooled
        // machine: the loop stops here. A failure any other machine would meet
        // again fails the run, with no machine created; anything else — a
        // refused assignment, an /init that got no answer, one whose step may
        // not be the run's — sends it to a machine of its own.
        handoffs.failed += 1;
        if (isRunsOwnInitFailure(err)) {
          throw new MachineSpawnError(
            {
              ...err.details,
              // Discarded already: nothing is left for the run's end to destroy.
              machineId: null,
            },
            err.cause,
          );
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Wake one pooled machine and assign it to this run. `claim` follows the step
   * reached — wake, boot probe, assignment, then init — for the caller to say
   * where a failed claim stood.
   */
  protected async claimPooledRunner(
    request: RunRequest,
    pool: RunnerPool,
    machine: PooledMachine,
    port: number,
    claim: ClaimProgress = { phase: "pool-resume" },
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const machineName = machine.machineId;
    const allowedHosts = request.agentConfig.environment.networking.allowed_hosts ?? [];
    const runnerBaseUrl = buildRunnerBaseUrl(machine.privateIp, port);

    // Wake it. The platform documents this as an attempt rather than a guarantee:
    // it may cold-boot instead, which costs the machine's start-up time but is
    // otherwise correct — it comes back holding the same assignment credential,
    // having still never served anything.
    const resumeStartMs = Date.now();
    claim.phase = "pool-resume";
    try {
      await this.flyApi.start(machine.machineId, { signal });
    } catch (err) {
      // The API client raises its own spawn error, the platform's answer one
      // level down under a synthetic message. The wrapper takes that answer and
      // its status, so the cause sits one level down as on the cold path; it
      // never rethrows the client's error, whose phase is not this step's.
      const platform = err instanceof MachineSpawnError ? err : undefined;
      throw new MachineSpawnError(
        {
          machineName,
          machineId: machine.machineId,
          phase: "pool-resume",
          httpStatus: platform ? platform.details.httpStatus : null,
        },
        platform ? platform.cause : err,
      );
    }
    const maxBootTimeMs = this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS;
    claim.phase = "boot-probe";
    await this.pollHealthz(runnerBaseUrl, maxBootTimeMs, machine.machineId, machineName, signal);
    const poolResumeMs = Date.now() - resumeStartMs;

    // The assignment: its URLs, then the credential and egress rules.
    claim.phase = "pool-claim";

    // Presigned now rather than at fill: the URLs only have to survive a wake and
    // an assignment, not a cold start, so their lifetime tightens accordingly.
    const ttlSeconds = Math.ceil(maxBootTimeMs / 1000) + PRESIGNED_TTL_MARGIN_S;
    const { bundleUrl, outputsPutUrl } = await this.presignRunUrls(
      request.bundleKey as string,
      request.runId,
      ttlSeconds,
    );

    const rpcToken = randomBytes(32).toString("hex");
    // What ends this machine if nobody destroys it: the hold of its run's seat
    // plus a grace, counted from its assignment — a pooled machine waits for its
    // run with none. The runner hands it to the machine's guardian.
    const lifetimeS = machineLifetimeSeconds({ seatHoldMs: this.seatHoldMs(request) });
    const claimStartMs = Date.now();
    const { processId } = await this.assignPooledRunner(
      runnerBaseUrl,
      machine,
      { rpcToken, allowedHosts, lifetimeS },
      signal,
    );
    const assignedAt = Date.now();
    const poolClaimMs = assignedAt - claimStartMs;
    // Its runner has answered the assignment — never before: from here the
    // machine is the run's, and carries it for whoever lists the app.
    void this.labelAssignedMachine(machine.machineId, request.runId, assignedAt + lifetimeS * 1000);

    // Did it actually resume, or did it quietly cold-boot? The platform treats the
    // resume as an attempt rather than a guarantee, and the two look identical from
    // outside — so the machine says which process answered. Unchanged since it was
    // paused means it is the same one; a cold boot would be a new process.
    //
    // Asked of the pool rather than compared here: the pool holds what the machine
    // reported when it was built, and that is the only half this side is missing.
    const resumedFromSnapshot = pool.classifyResume(machine, processId);

    claim.phase = "init-rpc";
    const initResult = await this.initRunner(
      runnerBaseUrl,
      machine.machineId,
      machineName,
      {
        bundleUrl,
        outputsPutUrl,
        tools: request.agentConfig.tools ?? [],
        mcpServers: request.agentConfig.mcp_servers ?? [],
        allowedHosts,
        // Same as the cold-spawn path above, and it has to be here too: a warm
        // machine is the faster path, so it is the one most runs take once the
        // pool is on. Omitting it here would leave the check covering only the
        // path nobody hits.
        bundleSha256: request.bundleSha256,
      },
      rpcToken,
      signal,
    );
    this.countInfraHosts(pool, request.runId, machine.machineId, initResult.infra_hosts, "ready");

    this.logger.info(
      {
        event: "spawn_ready",
        run_id: request.runId,
        machine_id: machine.machineId,
        pool_hit: true,
        tool_count: initResult.tools.length,
      },
      "FlyioAdapter runner ready from the pool",
    );

    return {
      machineId: machine.machineId,
      privateIp: machine.privateIp,
      runnerBaseUrl,
      tools: initResult.tools,
      rpcToken,
      phases: {
        // On this path the create call is the wake call — same role, different verb.
        create_api_ms: poolResumeMs,
        pool_hit: true,
        pool_resume_ms: poolResumeMs,
        pool_claim_ms: poolClaimMs,
        pool_resumed_from_snapshot: resumedFromSnapshot,
        init_bundle_ms: initResult.phases?.bundle_ms,
        init_extract_ms: initResult.phases?.extract_ms,
        init_deps_ms: initResult.phases?.deps_ms,
        init_mcp_ms: initResult.phases?.mcp_ms,
        // vm_boot_ms / host_schedule_pull_ms / module_load_ms are deliberately
        // absent: on a resumed machine they describe when the POOL was filled,
        // not this run, and reporting them would produce a precise, meaningless
        // number.
      },
    };
  }

  /**
   * Count what a pooled machine's runner reported at `/init` of its
   * infrastructure hosts — the object store, the package registries its boot
   * opened, long before this run: a moved address, or nothing to say, from the
   * answer of a served run or the body of a failed `/init`. A moved address is a
   * rule gone stale while the machine slept: a machine that reports one — one
   * word, however many of its hosts moved — is also one `warn` line under a
   * name an operator searches for, with where the run stood — its machine
   * ready, or its claim failed at `init-rpc`. Nothing else follows: no
   * rule moves, the run goes on as it would have.
   */
  private countInfraHosts(
    pool: RunnerPool,
    runId: string,
    machineId: string,
    check: InfraHostsCheck | undefined,
    phase: "ready" | "init-rpc",
  ): void {
    if (pool.recordInfraHosts(check) !== "changed") return;
    this.logger.warn(
      { event: "pool_infra_hosts_changed", run_id: runId, machine_id: machineId, phase },
      "a pooled machine resolves an infrastructure host to an address its boot opened no rule for",
    );
  }

  /** Hand a woken machine its run credential and egress rules. */
  private async assignPooledRunner(
    baseUrl: string,
    machine: PooledMachine,
    body: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<{ processId: string | undefined }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const bounds = RUNNER_CALL_BOUNDS.claim;
    const details = (httpStatus: number | null) => ({
      machineName: machine.machineId,
      machineId: machine.machineId,
      phase: "pool-claim" as const,
      httpStatus,
    });
    let response: Response;
    try {
      response = await callRunner(
        fetchImpl,
        `${baseUrl}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${machine.claimToken}`,
          },
          body: JSON.stringify(body),
        },
        { headersTimeoutMs: bounds.headersTimeoutMs, signal },
      );
    } catch (err) {
      throw new MachineSpawnError(details(null), err);
    }
    if (!response.ok) {
      const text = await readRunnerErrorText(response, {
        deadlineMs: bounds.bodyTimeoutMs,
        what: "/claim",
        signal,
      });
      throw new MachineSpawnError(
        details(response.status),
        // 409 means someone else already assigned it — discard, never retry.
        new Error(`/claim returned HTTP ${response.status} ${text}`.trim()),
      );
    }
    // Read within its bounds: an answer past them — too large, or still coming
    // at its deadline — drops the claim, like any other failed assignment. Any
    // other failure of the read does not, nor an answer that cannot be parsed or
    // that breaks the contract: the runner has accepted the assignment, the
    // process id is optional — an older runner image does not report it — and
    // the classification simply degrades to unknown.
    let parsed: unknown = null;
    try {
      parsed = await readRunnerJson(response, {
        maxBytes: bounds.maxBytes,
        deadlineMs: bounds.bodyTimeoutMs,
        what: "/claim",
        signal,
      });
    } catch (err) {
      if (err instanceof RunnerResponseTooLarge || err instanceof RunnerBodyTimeout) {
        throw new MachineSpawnError(details(response.status), err);
      }
      // A read the acquisition's signal cut drops the claim as well.
      if (signal?.aborted) throw new MachineSpawnError(details(response.status), signal.reason);
    }
    const claimed = ClaimResultSchema.safeParse(parsed);
    return { processId: claimed.success ? claimed.data.process_id : undefined };
  }

  /**
   * Label a pooled machine with the run it was assigned to and the end of its
   * life — `RUN_LABEL_KEY` and `LIFETIME_END_KEY` in its metadata, two writes
   * at once — once its runner has answered the assignment: a pooled machine's
   * name says nothing of a run, and whoever lists the app can judge it on these.
   * In the background, never awaited by the run; a write that fails on a
   * machine still in service is logged (`pool_metadata_write_failed`, `warn`,
   * by the error's class) and changes nothing of the assignment — the machine
   * is then judged as one that carries none. Each write is bounded by the
   * client's bound on its attempts, never by the run's signal: a caller who
   * hangs up does not take the label off a machine that may outlive its run.
   * Never rejects.
   *
   * A write races the machine's end: an `/init` that fails fast discards the
   * machine, a run that ends at once destroys it, and the platform then fails
   * a write still under way. One that fails once this adapter has asked for
   * the machine's destruction — answered or still under way — is no labelling
   * failure: the machine is on its way out, and a destruction that fails says
   * so on a line of its own (`machine_destroy_failed`). One `debug` line,
   * `pool_metadata_write_moot`, never a `warn`. Told by {@link labelling},
   * which holds the machine only while its writes are in flight.
   *
   * The run's label is the one a machine created for the run carries from its
   * creation; every search by that label also matches the run's machine name,
   * which a pooled machine never has.
   */
  private async labelAssignedMachine(
    machineId: string,
    runId: string,
    lifetimeEndMs: number,
  ): Promise<void> {
    const writes: Array<[key: string, value: string]> = [
      [RUN_LABEL_KEY, runId],
      [LIFETIME_END_KEY, lifetimeEndValue(lifetimeEndMs)],
    ];
    const writing = { retired: false };
    this.labelling.set(machineId, writing);
    try {
      await Promise.all(
        writes.map(async ([key, value]) => {
          try {
            await this.flyApi.setMetadata(machineId, key, value);
          } catch (err) {
            const fields = { run_id: runId, machine_id: machineId, key, ...errorFields(err) };
            if (writing.retired) {
              this.logger.debug(
                { event: "pool_metadata_write_moot", ...fields },
                "a label write failed on a pooled machine already taken out of service — nothing to label",
              );
              return;
            }
            this.logger.warn(
              { event: "pool_metadata_write_failed", ...fields },
              "an assigned pooled machine could not be labelled — it is judged as one that carries no run",
            );
          }
        }),
      );
    } finally {
      // Only this call's entry: a machine is labelled once, but an entry of
      // another call is never taken away.
      if (this.labelling.get(machineId) === writing) this.labelling.delete(machineId);
    }
  }

  /** Take a pooled machine out of service and destroy it. */
  private async discardPooledMachine(
    pool: RunnerPool,
    machine: PooledMachine,
    reason: string,
  ): Promise<void> {
    pool.markDraining(machine.machineId);
    pool.forget(machine.machineId);
    await this.destroyMachineSafely(machine.machineId, `pool_discard_${reason}`);
  }

  /**
   * Probe the runner until it answers, within `timeoutMs`. A probe that fails is
   * one more try; `signal` aborting is not: it cuts the probe in flight or the
   * pause between two, and ends the wait at once — a `MachineSpawnError` at
   * `boot-probe`, its cause the signal's reason.
   */
  private async pollHealthz(
    baseUrl: string,
    timeoutMs: number,
    machineId: string,
    machineName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const pollInterval = this.options.bootPollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    const abandoned = () =>
      new MachineSpawnError(
        { machineName, machineId, phase: "boot-probe", httpStatus: null },
        signal?.reason,
      );

    while (Date.now() < deadline) {
      if (signal?.aborted) throw abandoned();
      try {
        // Each probe within its own bound; the budget is checked between probes.
        const res = await callRunner(
          fetchImpl,
          `${baseUrl}/healthz`,
          { method: "GET" },
          { headersTimeoutMs: RUNNER_CALL_BOUNDS.healthz.timeoutMs, signal },
        );
        // Its status is the probe's whole result: nothing of the body is read.
        discardRunnerBody(res);
        if (res.ok) return;
        lastErr = new Error(`/healthz returned HTTP ${res.status}`);
      } catch (err) {
        if (signal?.aborted) throw abandoned();
        lastErr = err;
      }
      try {
        await sleep(pollInterval, signal);
      } catch {
        throw abandoned();
      }
    }

    throw new MachineSpawnError(
      { machineName, machineId, phase: "boot-probe", httpStatus: null },
      lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "boot timeout")),
    );
  }

  private async initRunner(
    baseUrl: string,
    machineId: string,
    machineName: string,
    body: InitRequest,
    rpcToken: string,
    signal?: AbortSignal,
  ): Promise<InitResult> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const bounds = RUNNER_CALL_BOUNDS.init;
    let response: Response;
    try {
      response = await callRunner(
        fetchImpl,
        `${baseUrl}/init`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${rpcToken}`,
          },
          body: JSON.stringify(body),
        },
        { headersTimeoutMs: INIT_RPC_TIMEOUT_MS, signal },
      );
    } catch (err) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: null },
        err,
      );
    }

    if (!response.ok) {
      const text = await readRunnerErrorText(response, {
        deadlineMs: bounds.bodyTimeoutMs,
        what: "/init",
        signal,
      });
      // The step the runner named goes to the caller in the harness's own words
      // (MachineSpawnError); its text stays in the cause, never told.
      const refused = new RunnerInitFailed(response.status, text);
      throw new MachineSpawnError(
        {
          machineName,
          machineId,
          phase: "init-rpc",
          httpStatus: response.status,
          ...(refused.failure.stage !== undefined && { stage: refused.failure.stage }),
        },
        refused,
      );
    }

    // Read within its bounds: an answer past them fails the start here, as one
    // that cannot be parsed does below.
    let answer: unknown;
    try {
      answer = await readRunnerJson(response, {
        maxBytes: bounds.maxBytes,
        deadlineMs: bounds.bodyTimeoutMs,
        what: "/init",
        signal,
      });
    } catch (err) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: response.status },
        err,
      );
    }
    // Read against the contract the runner answers with. Its cold-start
    // telemetry (`phases`, `boot`) is optional — an older runner image does not
    // send it (the harness and the runner deploy independently) — so its
    // absence never fails the spawn.
    const parsed = InitResultSchema.safeParse(answer);
    if (!parsed.success) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: response.status },
        new Error("Runner /init returned a malformed response body"),
      );
    }
    return parsed.data;
  }

  /**
   * After a creation sent a second time, destroy every machine of the run's
   * label and name but the one already destroyed. Two requests that cross make
   * two machines of one name and one label, and only the label finds the second
   * — which would bill until someone noticed. Best effort, like every destroy
   * here: a search that fails is logged and the run ends as it would have. Never
   * for a run whose creation went once: it costs a listing.
   */
  protected async destroyLabelledDuplicates(
    runId: string,
    alreadyDestroyed: string | null,
  ): Promise<void> {
    let labelled: Machine[];
    try {
      labelled = await this.flyApi.listByLabel(RUN_LABEL_KEY, runId);
    } catch (err) {
      this.logger.warn(
        { event: "duplicate_search_failed", run_id: runId, ...errorFields(err) },
        "FlyioAdapter could not search for a second machine of this run — manual cleanup may be required",
      );
      return;
    }
    const name = machineNameForRun(runId);
    for (const machine of labelled) {
      if (machine.name !== name || machine.id === alreadyDestroyed) continue;
      if (machine.state === "destroying" || machine.state === "destroyed") continue;
      await this.destroyMachineSafely(machine.id, "duplicate_after_resend");
    }
  }

  /**
   * Look for the machine a creation abandoned mid-flight may have made, and
   * destroy it — in the background: the run never awaits it. A creation whose
   * request never left (`lastSentAt` absent) made nothing: one line, no read.
   * Otherwise the run's label is read a second apart, at least `SEARCH_READS`
   * times and until a read leaves `CUT_CREATE_SEARCH_MS` after the creation's
   * last request — a creation sent again makes its machine with that one —,
   * `CUT_CREATE_MAX_READS` times at most, and every machine of the run's label
   * and name not on its way out is destroyed — two at most, a creation sent
   * twice. Each read, and each destruction, is cut at `CUT_CREATE_STEP_MS`: what
   * is cut is logged, never sent again. A read that fails otherwise ends the
   * search, on a line of its own. The search is the pool's for a fill its bound
   * cut (`searchCutCreation`, cut-creation-search.ts). Best effort: the
   * guarantee that no machine is left billing belongs to the platform-side
   * sweep, not here.
   *
   * The promise is handed to `onBackgroundCleanup`, and returned; it never
   * rejects.
   */
  protected cleanUpAbandonedCreation(
    runId: string,
    lastSentAt: number | undefined,
  ): Promise<void> | undefined {
    const cleanup = this.lookForAbandonedCreation(runId, lastSentAt);
    if (cleanup) this.options.onBackgroundCleanup?.(cleanup);
    return cleanup;
  }

  /**
   * The search of {@link cleanUpAbandonedCreation}, handed to no one: one line
   * and `undefined` when the creation's request never left, else the search,
   * which never rejects.
   */
  private lookForAbandonedCreation(
    runId: string,
    lastSentAt: number | undefined,
  ): Promise<void> | undefined {
    if (lastSentAt === undefined) {
      this.logger.info(
        { event: "abandoned_create_cleanup", run_id: runId, found: 0, destroyed: 0 },
        "FlyioAdapter abandoned a creation before its request left: nothing to look for",
      );
      return undefined;
    }
    return this.searchAbandonedCreation(runId, lastSentAt).catch((err: unknown) => {
      this.logger.warn(
        { event: "abandoned_create_cleanup_failed", run_id: runId, ...errorFields(err) },
        "FlyioAdapter could not finish looking for the machine of an abandoned creation — manual cleanup may be required",
      );
    });
  }

  /**
   * What an acquisition leaves behind once the run's stream ended before its
   * machine was taken in hand — a consumer that closed the run on one of its
   * heartbeats —, cleaned up in the background: nothing awaits it, the consumer
   * is gone. The acquisition, cut by that end, is waited for; a machine it got
   * ready is let go as at a run's end — out of the pool's inventory first —,
   * one it made and failed on is destroyed, and a creation it abandoned
   * mid-flight is looked for by its label; a second machine of a creation sent
   * twice is destroyed too. No run_error: no one reads it.
   *
   * The promise is handed to `onBackgroundCleanup`, and returned; it never
   * rejects.
   */
  protected cleanUpClosedAcquisition(
    acquiring: Promise<SpawnResult>,
    runId: string,
    creation: CreateProgress,
    acquisition: AcquisitionOutcome,
  ): Promise<void> {
    const cleanup = this.letClosedAcquisitionGo(acquiring, runId, creation, acquisition).catch(
      (err: unknown) => {
        this.logger.warn(
          { event: "closed_acquisition_cleanup_failed", run_id: runId, ...errorFields(err) },
          "FlyioAdapter could not finish letting go of an acquisition its run's stream left — manual cleanup may be required",
        );
      },
    );
    this.options.onBackgroundCleanup?.(cleanup);
    return cleanup;
  }

  private async letClosedAcquisitionGo(
    acquiring: Promise<SpawnResult>,
    runId: string,
    creation: CreateProgress,
    acquisition: AcquisitionOutcome,
  ): Promise<void> {
    let spawn: SpawnResult | undefined;
    let failure: unknown;
    try {
      spawn = await acquiring;
    } catch (err) {
      failure = err;
    }
    const spawnError = failure instanceof MachineSpawnError ? failure : undefined;
    this.logger.info(
      {
        event: "acquisition_closed",
        run_id: runId,
        ready: spawn !== undefined,
        ...(spawnError === undefined ? {} : { phase: spawnError.details.phase }),
      },
      "FlyioAdapter: the run's stream ended during its acquisition — what it made is let go",
    );
    if (spawn !== undefined) {
      await this.releaseRunMachine(spawn.machineId, "consumer_closed");
      if (creation.resent) await this.destroyLabelledDuplicates(runId, spawn.machineId);
      return;
    }
    const machineId = spawnError?.details.machineId ?? null;
    if (machineId !== null) await this.destroyMachineSafely(machineId, "consumer_closed");
    const abandonedCreation =
      acquisition.abandoned && spawnError?.details.phase === "create" && machineId === null;
    if (abandonedCreation) {
      // Its own search covers a creation sent twice.
      await this.lookForAbandonedCreation(runId, creation.lastSentAt);
    } else if (creation.resent) {
      await this.destroyLabelledDuplicates(runId, machineId);
    }
  }

  /**
   * Let a run's machine go at the run's end. A pooled machine leaves the pool's
   * inventory before its destruction is asked, as a discarded one does —
   * destroyed or not, it is then the reconciliation's to judge, like any
   * machine this process does not hold: a pooled machine declares no lifetime
   * the reconciliation can read — the one it learned at its assignment is its
   * guardian's, inside it —, and a started one is taken once untouched past the
   * window of a started machine. Kept through a slow destruction, it would be
   * counted as vanished by a reconciliation that no longer lists it.
   */
  private async releaseRunMachine(machineId: string, reason: string): Promise<void> {
    // Forgotten, never set "draining" first: nothing would read that state.
    this.options.pool?.forget(machineId);
    await this.destroyMachineSafely(machineId, reason);
  }

  /**
   * The search of {@link cleanUpAbandonedCreation} — the one the pool runs for a
   * fill its bound cut (`searchCutCreation`), on this run's label and name, the
   * process's clock and a timer. A destruction it fails is counted on the pool's
   * counter of failed destructions, as every other the adapter tries.
   */
  private async searchAbandonedCreation(runId: string, lastSentAt: number): Promise<void> {
    const { found, destroyed } = await searchCutCreation({
      flyApi: this.flyApi,
      label: { key: RUN_LABEL_KEY, value: runId },
      name: machineNameForRun(runId),
      lastSentAt,
      now: Date.now,
      sleep: (ms) => sleep(ms),
      onReadCut: (read) => {
        this.logger.warn(
          { event: "abandoned_create_read_cut", run_id: runId, read },
          "FlyioAdapter cut a read of an abandoned creation's label at its bound",
        );
      },
      onDestroyed: (machineId) => {
        this.logger.info(
          { event: "machine_destroy", machine_id: machineId, reason: "abandoned_create" },
          "FlyioAdapter machine destroyed",
        );
      },
      onDestroyFailed: (machineId, failure) => {
        this.options.pool?.recordDestroyFailure();
        if (failure.cut) {
          this.logger.warn(
            { event: "abandoned_create_destroy_cut", run_id: runId, machine_id: machineId },
            "FlyioAdapter cut the destruction of an abandoned creation's machine at its bound — manual cleanup may be required",
          );
          return;
        }
        this.logger.warn(
          {
            event: "machine_destroy_failed",
            machine_id: machineId,
            reason: "abandoned_create",
            ...errorFields(failure.error),
          },
          "FlyioAdapter destroy failed — manual cleanup may be required",
        );
      },
    });
    this.logger.info(
      { event: "abandoned_create_cleanup", run_id: runId, found, destroyed },
      "FlyioAdapter looked for the machine of an abandoned creation",
    );
  }

  /**
   * Best-effort destroy used by failure paths and the post-run finally
   * block. Logs `event=machine_destroy reason=<reason>`, as the destroy
   * log contract requires, and does not rethrow on Fly.io API failure so
   * the surrounding finally can complete (a leaked machine is logged and
   * surfaced for the admin cleanup-machines CLI to pick up). A destruction
   * that fails is counted on the pool's counter of failed destructions, when
   * the adapter has a pool — whatever its size, and whatever machine it was.
   *
   * Every pooled machine this adapter destroys goes through here — one its
   * claim discarded, a run's at its end, one a closed acquisition leaves; the
   * search for an abandoned creation destroys only machines of the run's name,
   * which a pooled machine never has. A label write still in flight on the
   * machine is marked first, so that its failure from here on is not taken
   * for a labelling failure ({@link labelAssignedMachine}).
   */
  protected async destroyMachineSafely(machineId: string, reason: string): Promise<void> {
    const writing = this.labelling.get(machineId);
    if (writing !== undefined) writing.retired = true;
    try {
      await this.flyApi.destroy(machineId);
      this.logger.info(
        { event: "machine_destroy", machine_id: machineId, reason },
        "FlyioAdapter machine destroyed",
      );
    } catch (err) {
      this.options.pool?.recordDestroyFailure();
      this.logger.warn(
        {
          event: "machine_destroy_failed",
          machine_id: machineId,
          reason,
          ...errorFields(err),
        },
        "FlyioAdapter destroy failed — manual cleanup may be required",
      );
    }
  }
}

// `buildRunnerBaseUrl` moved to ./runner-url.js so the pool can use it without a
// cycle (the adapter drives the pool, so the dependency points one way). Still
// re-exported from here — it was part of this module's surface.
export { buildRunnerBaseUrl } from "./runner-url.js";

/** A timer, cleared — and the wait rejected with its reason — once `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * What the acquisition budget aborts with once it is spent: its message is the
 * one the run's error carries.
 */
class AcquisitionBudgetSpent extends Error {
  constructor(budgetMs: number) {
    super(
      `The machine for this run was not ready within its acquisition budget (${Math.ceil(budgetMs / 1000)}s).`,
    );
    this.name = "AcquisitionBudgetSpent";
  }
}

/**
 * A runner that answered `/init` with an error status: the cause of the start's
 * failure, worded as it always was — the status and what of the body was read —,
 * and what that body says of the failure, read against the contract: the step
 * that failed and what an MCP server answered — and, from a pooled machine, what
 * it measured of its infrastructure hosts. A body without them — an older
 * runner's, a step this side does not know, a body cut at its bound or not the
 * runner's — says nothing, and the failure may not be the run's.
 */
class RunnerInitFailed extends Error {
  readonly failure: Pick<InitErrorBody, "stage" | "mcp" | "infra_hosts">;

  constructor(status: number, text: string) {
    super(`/init returned HTTP ${status} ${text}`.trim());
    this.name = "RunnerInitFailed";
    this.failure = initFailureOf(text);
  }
}

/**
 * What the body of a failed `/init` says of its failure, and of the machine's
 * infrastructure hosts; nothing when it cannot be read.
 */
function initFailureOf(text: string): Pick<InitErrorBody, "stage" | "mcp" | "infra_hosts"> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = InitErrorBodySchema.safeParse(body);
  if (!parsed.success) return {};
  return { stage: parsed.data.stage, mcp: parsed.data.mcp, infra_hosts: parsed.data.infra_hosts };
}

/**
 * Whether a claim's failure is the run's own: an `/init` the runner answered
 * with a step any other machine would meet again — the contract says which
 * (`classifyInitFailure`).
 */
function isRunsOwnInitFailure(err: unknown): err is MachineSpawnError {
  return (
    err instanceof MachineSpawnError &&
    err.cause instanceof RunnerInitFailed &&
    classifyInitFailure(err.cause.failure) === "deterministic"
  );
}

/** What the acquisition is aborted with when the run's stream ends before it is over. */
class RunClosedDuringAcquisition extends Error {
  constructor() {
    super("The run's stream was closed while its machine was being acquired.");
    this.name = "RunClosedDuringAcquisition";
  }
}

// `fetchWithDeadline` moved to ./runner-call.js, the one module that talks to a
// runner. Still re-exported from here — it was part of this module's surface.
export { fetchWithDeadline } from "./runner-call.js";

/**
 * The image a machine was created with, as the platform's create response
 * reports it: `registry/repository:tag@digest`, from whichever parts it returned.
 * Undefined when it returned none — nothing is made up from the requested image.
 * This is what the platform CREATED the machine with; what the runner actually
 * booted is on the runner's own boot line (`image=`), and the two complement
 * each other.
 */
function describeImageRef(ref: Machine["image_ref"]): string | undefined {
  if (!ref) return undefined;
  const name = [ref.registry, ref.repository].filter(Boolean).join("/");
  const tagged = ref.tag ? `${name}:${ref.tag}` : name;
  const described = ref.digest ? `${tagged}@${ref.digest}` : tagged;
  return described || undefined;
}

class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * Wrap a source AsyncGenerator so that an AbortSignal fire causes the
 * iteration to throw `AbortError` at the next race point. Returns the
 * source unchanged when no signal is provided. The source generator is
 * told to clean up via `.return()` on abort (best-effort).
 *
 * Used by FlyioAdapter to race the agent loop against caller disconnect:
 * a closed SSE stream → abort fires → throw → run_error → finally
 * destroys the machine. Live-streaming-safe (works with the generator
 * timeout wrapper).
 */
async function* wrapWithAbort<T>(
  source: AsyncGenerator<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  if (!signal) {
    yield* source;
    return;
  }
  if (signal.aborted) {
    // Fire-and-forget cleanup — source may be blocked.
    source.return(undefined).catch(() => {});
    throw new AbortError("Run aborted by caller before iteration started");
  }
  const abortSentinel = Symbol("abort");
  try {
    while (true) {
      const nextPromise = source.next();
      const abortPromise = new Promise<typeof abortSentinel>((resolve) => {
        signal.addEventListener("abort", () => resolve(abortSentinel), { once: true });
      });
      const winner = await Promise.race([nextPromise, abortPromise]);
      if (winner === abortSentinel) {
        throw new AbortError("Run aborted by caller mid-iteration");
      }
      const { value, done } = winner;
      if (done) return;
      yield value;
    }
  } finally {
    // Fire-and-forget — see withGeneratorTimeout for rationale.
    source.return(undefined).catch(() => {});
  }
}
