import { randomBytes } from "node:crypto";
import { MachineSpawnError } from "../../errors.js";
import type { LLMRouter } from "../../llm/router.js";
import type { Logger } from "../../logger.js";
import { createLogger } from "../../logger.js";
import { parseTimeout, withGeneratorTimeout } from "../../security/timeout.js";
import { ToolRegistry } from "../../tools/registry.js";
import { INSTALL_REGISTRY_ALLOWLIST } from "../../tools/script-deps-installers.js";
import type { ToolDefinition } from "../../tools/types.js";
import type {
  OnRunnerSpawned,
  RunCompleteEvent,
  RunEvent,
  RunRequest,
  RunResult,
  SpawnPhases,
} from "../../types.js";
import type { RuntimeAdapter } from "../adapter.js";
import { runAgentLoop, withHeartbeats } from "../agent-loop.js";
import type { StateCallbacks } from "../local.js";
import type { FlyMachinesApi, Machine } from "./fly-api.js";
import { buildMachineConfig } from "./machine-config.js";
import { uploadOutputs } from "./outputs-upload.js";
import type { PooledMachine, RunnerPool } from "./pool.js";
import { RpcMcpToolProvider } from "./rpc-mcp-provider.js";
import { RpcScriptToolProvider } from "./rpc-script-provider.js";
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
   */
  put(key: string, data: Buffer): Promise<void>;
  getPresignedDownloadUrl(key: string, expiresIn: number): Promise<string>;
  getPresignedUploadUrl(key: string, expiresIn: number): Promise<string>;
}

export interface FlyioAdapterOptions {
  /** Tag of the multi-runtime image (defaults to `ghcr.io/skrun-dev/skrun-runtime:latest`). */
  runtimeImage?: string;
  /** Fly.io region for spawned machines. Falls back to the app's default. */
  region?: string;
  /** Port the in-machine runner listens on. Default 9000. */
  runnerPort?: number;
  /** Per-run timeout in ms — propagated to the runner. Default 300_000. */
  maxRunTimeoutMs?: number;
  /** Override DNS re-resolve interval in seconds for short-TTL hosts. */
  dnsResolveIntervalSeconds?: number;
  /** Max time to wait for the runner's `/healthz` to return 200 after machine create. Default 30_000. */
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
   * `runner_spawned` event carries phase durations only).
   */
  onRunnerSpawned?: OnRunnerSpawned;
  /**
   * Pre-warm pool. When present and enabled, a run wakes a machine that was
   * created and booted ahead of time instead of creating one. Absent or disabled
   * (the default), every run takes the create-per-run path unchanged — which is
   * what keeps that path the default everywhere but our own cloud, and therefore
   * exercised rather than rotting.
   */
  pool?: RunnerPool;
}

const DEFAULT_RUNTIME_IMAGE = "ghcr.io/skrun-dev/skrun-runtime:latest";
const DEFAULT_RUNNER_PORT = 9000;
// Bumped from 30s to 90s on 2026-05-25 after real-cloud
// measurement revealed the bimodal cold-start
// distribution: cache-hit spawns boot in ~5s, but cache-miss spawns
// (Fly schedules a machine onto a host that doesn't yet have the
// 750MB multi-runtime image) take ~50s for the pull + boot. 30s was
// the wrong default — it failed every cache-miss spawn. 90s gives
// margin while staying well under the run-timeout. Override via
// SKRUN_MAX_BOOT_TIME_MS in adapter-selection if needed (a warm pool and a
// smaller image are the proper fix, tracked separately).
const DEFAULT_MAX_BOOT_TIME_MS = 90_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_RUN_TIMEOUT_MS = 300_000;
/** Margin added to the bundle-presigned-URL TTL so a slow boot doesn't expire the URL before /init runs. */
const PRESIGNED_TTL_MARGIN_S = 30;

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
  /** Per-phase cold-start timing captured during the spawn. */
  phases: SpawnPhases;
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
    // only streaming is wired. Point the caller at a working path instead of a
    // cryptic internal message. (Implementing one-shot on flyio is tracked
    // separately as a local/cloud parity follow-up.)
    throw new Error(
      "One-shot execution is not supported on the flyio runtime — use streaming instead: " +
        "the dashboard Run button, SDK.stream(), or an HTTP request with the " +
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

    let spawn: SpawnResult | null = null;
    try {
      spawn = await this.acquireRunner(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof MachineSpawnError ? err.code : "MACHINE_SPAWN_FAILED";
      // Surface the underlying cause + structured phase/status in the LOG.
      // `message` alone is the opaque "... (HTTP 400) — no machine"; the real
      // reason (e.g. the Fly.io Machines API response body "manifest unknown"
      // for a deleted/missing runner image tag) lives on `err.cause` and was
      // otherwise dropped — making spawn failures undiagnosable from logs.
      // Kept OUT of the caller-facing run_error below: Fly internals are
      // operator diagnostics, not marketplace-consumer surface.
      const cause =
        err instanceof MachineSpawnError && err.cause instanceof Error
          ? err.cause.message
          : undefined;
      const phase = err instanceof MachineSpawnError ? err.details.phase : undefined;
      const httpStatus = err instanceof MachineSpawnError ? err.details.httpStatus : undefined;
      this.logger.error(
        { event: "spawn_failed", run_id: request.runId, error: message, cause, phase, httpStatus },
        "FlyioAdapter spawn failed",
      );
      // If the failure happened AFTER create (boot-probe or init-rpc
      // phase), the machine exists and would leak — destroy it.
      if (err instanceof MachineSpawnError && err.details.machineId) {
        await this.destroyMachineSafely(err.details.machineId, `spawn_failed_${err.details.phase}`);
      }
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code, message },
      };
      return;
    }

    // Cold-start telemetry: emit the per-phase breakdown (durations only) so
    // consumers see where the spawn spent its time, and hand the operator-only
    // machine id + private IP to the telemetry sink — never the event stream.
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

    const registry = new ToolRegistry();
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

    let destroyReason = "run_complete";
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
        stateCallbacks: this.stateCallbacks,
        logger: this.logger,
        startMs,
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
          yield event;
        }
      }
      if (runComplete) {
        // Sync-upload outputs to R2 before emitting run_complete. The
        // upload itself can be slow (10s of seconds for big artifacts)
        // so heartbeats fire during the wait via withHeartbeats.
        const uploadPromise = uploadOutputs({
          runId: request.runId,
          runnerBaseUrl: spawn.runnerBaseUrl,
          storage: this.storage,
          fetchImpl: this.options.fetchImpl,
          // SEC-2026-002: the outputs pull (/outputs/collect + /outputs/file) is
          // RPC to the runner and must carry the per-run Bearer, same as /init +
          // /tool. Omitting it 401s once the runner enforces the token (L5 catch).
          token: spawn.rpcToken,
        });
        const files = yield* withHeartbeats(uploadPromise, "uploading_outputs", request.runId);
        yield { ...runComplete, files };
      } else {
        destroyReason = "run_error";
      }
    } catch (err) {
      const errName = (err as Error).name;
      const isTimeout = errName === "TimeoutError";
      const isAbort = errName === "AbortError";
      destroyReason = isAbort ? "aborted" : isTimeout ? "timeout" : "run_failed";
      const code = isAbort ? "ABORTED" : isTimeout ? "TIMEOUT" : "EXECUTION_FAILED";
      this.logger.error(
        {
          event: destroyReason,
          run_id: request.runId,
          agent: config.name,
          error: err instanceof Error ? err.message : String(err),
        },
        `FlyioAdapter run ${destroyReason}`,
      );
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code, message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      await registry.disconnectAll().catch(() => {});
      await this.destroyMachineSafely(spawn.machineId, destroyReason);
    }
  }

  /**
   * Spawn the runner machine end-to-end:
   *  1. Presigned bundle GET URL + outputs PUT URL (TTL covers worst boot).
   *  2. `flyApi.create(machineConfig)` → machine record with private IPv6.
   *  3. Poll `GET <baseUrl>/healthz` until 200 or boot-time budget exhausted.
   *  4. `POST <baseUrl>/init` with bundle URL, outputs URL, tools, mcp servers, allowed hosts.
   *
   * On any failure: a `MachineSpawnError` is thrown with the failing phase
   * recorded; the machine (if created) is destroyed by `executeStream`'s
   * catch path so we don't leak Fly.io resources.
   */
  protected async spawnRunner(request: RunRequest): Promise<SpawnResult> {
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

    const port = this.options.runnerPort ?? DEFAULT_RUNNER_PORT;
    const maxBootTimeMs = this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS;
    const ttlSeconds = Math.ceil(maxBootTimeMs / 1000) + PRESIGNED_TTL_MARGIN_S;
    const allowedHosts = request.agentConfig.environment.networking.allowed_hosts ?? [];

    // 1. Presigned URLs — the sandbox never sees credentials.
    const { bundleUrl, outputsPutUrl } = await this.presignRunUrls(
      request.bundleKey,
      request.runId,
      ttlSeconds,
    );

    // Infra egress the runner needs that the agent's allowed_hosts don't cover:
    // the object-storage host and the install-time package registries. The
    // runner's ONLY object-store egress is the bundle GET at /init — outputs are
    // harness-pulled (GET /outputs/file), never pushed by the runner — so the
    // outputsPutUrl host is included only as forward-compat / harmless dedup
    // (same R2 host). The entrypoint allowlists these on both families; without
    // them every cloud run dies at /init (bundle fetch) now that the ip6tables
    // policy closes the previously-open IPv6 they rode on.
    const infraHostSet = new Set<string>(INSTALL_REGISTRY_ALLOWLIST);
    for (const u of [bundleUrl, outputsPutUrl]) {
      try {
        infraHostSet.add(new URL(u).hostname);
      } catch {
        // presigned URLs are always valid; ignore a malformed one defensively
      }
    }
    const infraHosts = [...infraHostSet];

    // 2. Build machine config + create. Mint a per-run RPC token: it goes into
    // the machine env (so the runner verifies inbound RPC) AND is sent as a
    // Bearer on every RPC from here (so the runner accepts ours).
    const rpcToken = randomBytes(32).toString("hex");
    const machineRequest = buildMachineConfig({
      runId: request.runId,
      image: this.options.runtimeImage ?? DEFAULT_RUNTIME_IMAGE,
      bundleUrl,
      outputsPutUrl,
      allowedHosts,
      region: this.options.region,
      runnerPort: port,
      maxRunTimeoutMs: this.options.maxRunTimeoutMs ?? DEFAULT_MAX_RUN_TIMEOUT_MS,
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
      machine = await this.flyApi.create(machineRequest);
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

    // 3. Boot probe — keep polling /healthz until 200 or budget exhausted.
    // This interval is the opaque host-side blob (schedule + image pull + VM
    // boot + entrypoint egress + Node listening); the runner's own boot clock
    // (below) lets us subtract the in-VM part to isolate the schedule + pull.
    const bootProbeStartMs = Date.now();
    await this.pollHealthz(
      runnerBaseUrl,
      maxBootTimeMs,
      machineId,
      machineRequest.name ?? "(unnamed)",
    );
    const createToHealthzMs = Date.now() - bootProbeStartMs;

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
      },
      rpcToken,
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
      init_mcp_ms: initResult.phases?.mcp_ms,
    };

    // Operator-only consistency guard: the harness-measured healthz->init should
    // roughly track the sum of the in-VM /init phases the runner reported.
    if (initResult.phases) {
      const inVmInitMs =
        (initResult.phases.bundle_ms ?? 0) +
        (initResult.phases.extract_ms ?? 0) +
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
   * Presign the two URLs the sandbox needs. Shared by both acquisition paths so
   * the outputs-key convention has one definition rather than two that can drift.
   */
  protected async presignRunUrls(
    bundleKey: string,
    runId: string,
    ttlSeconds: number,
  ): Promise<{ bundleUrl: string; outputsPutUrl: string }> {
    const outputsKey = `runs/${runId}/outputs.tar.gz`;
    const [bundleUrl, outputsPutUrl] = await Promise.all([
      this.storage.getPresignedDownloadUrl(bundleKey, ttlSeconds),
      this.storage.getPresignedUploadUrl(outputsKey, ttlSeconds),
    ]);
    return { bundleUrl, outputsPutUrl };
  }

  /**
   * Get a runner for this run: wake a pre-created one if the pool has one, and
   * otherwise create one the way we always have.
   *
   * The fall-back is not an error path. With the pool disabled — the default
   * outside our own cloud — every run comes through here and lands on
   * {@link spawnRunner} unchanged, which is what keeps that path exercised rather
   * than slowly rotting behind a feature nobody turns off.
   */
  protected async acquireRunner(request: RunRequest): Promise<SpawnResult> {
    const pool = this.options.pool;
    if (pool?.enabled) {
      const hadCandidates = pool.stats().ready > 0;
      const pooled = await this.tryPooledRunner(request, pool);
      if (pooled) {
        pool.recordHit();
        return pooled;
      }
      // Distinguish "nothing to give" from "something, but none of it worked":
      // a pool full of unusable machines otherwise reads exactly like a busy one.
      pool.recordMiss(hadCandidates ? "unusable" : "empty");
    }
    return this.spawnRunner(request);
  }

  /**
   * Try to serve this run from the pool. Returns `null` when it cannot, so the
   * caller falls back to creating a machine.
   *
   * Every failure mode destroys the machine it touched and moves on rather than
   * retrying it. A machine that would not wake, or would not accept its
   * assignment, is spent: its assignment is single-use by design, so a retry
   * could only fail again — and a machine left behind bills silently.
   *
   * The distinct failure phases matter here. "The pool was empty" and "the pool
   * was full but nothing in it would wake" both end up on the cold path, and
   * without separate counters the second is invisible: a completely broken pool
   * would look exactly like a busy one.
   */
  protected async tryPooledRunner(
    request: RunRequest,
    pool: RunnerPool,
  ): Promise<SpawnResult | null> {
    if (!request.bundleKey) return null;
    const port = this.options.runnerPort ?? DEFAULT_RUNNER_PORT;

    // Bounded: one pass over what the pool believes it has. Without a bound, a
    // pool full of unwakeable machines would stall the request while it chewed
    // through all of them instead of falling back promptly.
    const attempts = pool.stats().ready;
    for (let i = 0; i < attempts; i++) {
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

      try {
        return await this.claimPooledRunner(request, pool, machine, port);
      } catch (err) {
        const phase = err instanceof MachineSpawnError ? err.details.phase : "pool-claim";
        this.logger.warn(
          {
            event: "pool_claim_failed",
            run_id: request.runId,
            machine_id: machine.machineId,
            phase,
            error: err instanceof Error ? err.message : String(err),
          },
          "pooled runner could not be assigned — discarding it",
        );
        await this.discardPooledMachine(pool, machine, phase);
      }
    }
    return null;
  }

  /** Wake one pooled machine and assign it to this run. */
  protected async claimPooledRunner(
    request: RunRequest,
    pool: RunnerPool,
    machine: PooledMachine,
    port: number,
  ): Promise<SpawnResult> {
    const machineName = machine.machineId;
    const allowedHosts = request.agentConfig.environment.networking.allowed_hosts ?? [];
    const runnerBaseUrl = buildRunnerBaseUrl(machine.privateIp, port);

    // Wake it. The platform documents this as an attempt rather than a guarantee:
    // it may cold-boot instead, which costs the machine's start-up time but is
    // otherwise correct — it comes back holding the same assignment credential,
    // having still never served anything.
    const resumeStartMs = Date.now();
    try {
      await this.flyApi.start(machine.machineId);
    } catch (err) {
      throw new MachineSpawnError(
        { machineName, machineId: machine.machineId, phase: "pool-resume", httpStatus: null },
        err,
      );
    }
    const maxBootTimeMs = this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS;
    await this.pollHealthz(runnerBaseUrl, maxBootTimeMs, machine.machineId, machineName);
    const poolResumeMs = Date.now() - resumeStartMs;

    // Presigned now rather than at fill: the URLs only have to survive a wake and
    // an assignment, not a cold start, so their lifetime tightens accordingly.
    const ttlSeconds = Math.ceil(maxBootTimeMs / 1000) + PRESIGNED_TTL_MARGIN_S;
    const { bundleUrl, outputsPutUrl } = await this.presignRunUrls(
      request.bundleKey as string,
      request.runId,
      ttlSeconds,
    );

    const rpcToken = randomBytes(32).toString("hex");
    const claimStartMs = Date.now();
    const { processId } = await this.assignPooledRunner(runnerBaseUrl, machine, {
      rpcToken,
      allowedHosts,
    });
    const poolClaimMs = Date.now() - claimStartMs;

    // Did it actually resume, or did it quietly cold-boot? The platform treats the
    // resume as an attempt rather than a guarantee, and the two look identical from
    // outside — so the machine says which process answered. Unchanged since it was
    // paused means it is the same one; a cold boot would be a new process.
    //
    // Asked of the pool rather than compared here: the pool holds what the machine
    // reported when it was built, and that is the only half this side is missing.
    const resumedFromSnapshot = pool.classifyResume(machine, processId);

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
      },
      rpcToken,
    );

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
        init_mcp_ms: initResult.phases?.mcp_ms,
        // vm_boot_ms / host_schedule_pull_ms / module_load_ms are deliberately
        // absent: on a resumed machine they describe when the POOL was filled,
        // not this run, and reporting them would produce a precise, meaningless
        // number.
      },
    };
  }

  /** Hand a woken machine its run credential and egress rules. */
  private async assignPooledRunner(
    baseUrl: string,
    machine: PooledMachine,
    body: { rpcToken: string; allowedHosts: string[] },
  ): Promise<{ processId: string | undefined }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${machine.claimToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new MachineSpawnError(
        {
          machineName: machine.machineId,
          machineId: machine.machineId,
          phase: "pool-claim",
          httpStatus: null,
        },
        err,
      );
    }
    if (!response.ok) {
      throw new MachineSpawnError(
        {
          machineName: machine.machineId,
          machineId: machine.machineId,
          phase: "pool-claim",
          httpStatus: response.status,
        },
        // 409 means someone else already assigned it — discard, never retry.
        new Error(`/claim returned HTTP ${response.status} ${await safeReadText(response)}`.trim()),
      );
    }
    // Optional: an older runner image does not report it, and the classification
    // simply degrades to unknown rather than failing the assignment.
    const parsed = (await response.json().catch(() => null)) as { process_id?: unknown } | null;
    return {
      processId: typeof parsed?.process_id === "string" ? parsed.process_id : undefined,
    };
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

  private async pollHealthz(
    baseUrl: string,
    timeoutMs: number,
    machineId: string,
    machineName: string,
  ): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const pollInterval = this.options.bootPollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;

    while (Date.now() < deadline) {
      try {
        const res = await fetchImpl(`${baseUrl}/healthz`, { method: "GET" });
        if (res.ok) return;
        lastErr = new Error(`/healthz returned HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(pollInterval);
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
    body: {
      bundleUrl: string;
      outputsPutUrl: string;
      tools: unknown[];
      mcpServers: unknown[];
      allowedHosts: string[];
    },
    rpcToken: string,
  ): Promise<{
    tools: ToolDefinition[];
    phases?: { bundle_ms?: number; extract_ms?: number; mcp_ms?: number };
    boot?: { vm_boot_ms?: number; entrypoint_egress_ms?: number; module_load_ms?: number };
  }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rpcToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: null },
        err,
      );
    }

    if (!response.ok) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: response.status },
        new Error(`/init returned HTTP ${response.status} ${await safeReadText(response)}`.trim()),
      );
    }

    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      tools?: ToolDefinition[];
      // Optional cold-start telemetry — absent when talking to an older runner
      // image (the harness and the runner deploy independently), so read them
      // defensively and never fail the spawn on their absence.
      phases?: { bundle_ms?: number; extract_ms?: number; mcp_ms?: number };
      boot?: { vm_boot_ms?: number; entrypoint_egress_ms?: number; module_load_ms?: number };
    } | null;
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.tools)) {
      throw new MachineSpawnError(
        { machineName, machineId, phase: "init-rpc", httpStatus: response.status },
        new Error("Runner /init returned a malformed response body"),
      );
    }
    return { tools: parsed.tools, phases: parsed.phases, boot: parsed.boot };
  }

  /**
   * Best-effort destroy used by failure paths and the post-run finally
   * block. Logs `event=machine_destroy reason=<reason>` per spec D-7 +
   * does not rethrow on Fly.io API failure so the surrounding finally
   * can complete (a leaked machine is logged and surfaced for the
   * admin cleanup-machines CLI to pick up).
   */
  protected async destroyMachineSafely(machineId: string, reason: string): Promise<void> {
    try {
      await this.flyApi.destroy(machineId);
      this.logger.info(
        { event: "machine_destroy", machine_id: machineId, reason },
        "FlyioAdapter machine destroyed",
      );
    } catch (err) {
      this.logger.warn(
        {
          event: "machine_destroy_failed",
          machine_id: machineId,
          reason,
          error: err instanceof Error ? err.message : String(err),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
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
