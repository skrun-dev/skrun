/**
 * Test-support module, not a test file: a hermetic harness that drives
 * `POST /api/agents/:namespace/:name/run` through the real route with the cloud
 * runtime selected — without a network, a machine, an object store or a model.
 *
 * What is fake, and why only that:
 *
 * - The cloud adapter. A test file replaces the one `FlyioAdapter` export of
 *   `@skrun-dev/runtime` with the subclass `makeFakeFlyioAdapterClass` builds.
 *   Its `executeStream` plays a script instead of creating a machine and driving
 *   a model; everything else is inherited, the one-shot `execute` included —
 *   which no request reaches through the route: the route refuses a synchronous
 *   request itself, before anything of its run is read or written.
 *   The subclass is built from the real module the mock factory hands over
 *   (`importOriginal`), so it extends the production adapter whatever order a
 *   test file imports things in. A test file loads this module from inside that
 *   factory, with a dynamic import: a static binding the factory reads is not
 *   initialised yet when the first import of the runtime runs the factory. And
 *   nothing this module imports as a value reaches the runtime, so loading it
 *   there never re-enters the module being mocked.
 * - The cloud dependencies. `fakeFlyioDeps` fronts an in-memory store and adds
 *   the one thing such a store cannot do, presigning; the URLs point at a
 *   reserved domain and nothing fetches them. The machines API is an empty
 *   object: any call to it would throw; so is the output bytes budget.
 *
 * What is real: the route and its checks, the registry push and pull, the run
 * row and every write to it, and the bundle, packed by `packAgentTar`.
 *
 * For each scripted output file, the fake writes the bytes to the store at
 * `runOutputKey(runId, name)`, as the production upload does, so a test can
 * follow a run's objects once the route is done with them.
 */
import type {
  FileInfo,
  FlyioAdapterOptions,
  InitStage,
  MachineSpawnPhase,
  RunEvent,
  RunRequest,
  SpawnPhases,
} from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import type { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { Run } from "../db/schema.js";
import type { FlyioRuntimeDeps } from "../runtime/adapter-selection.js";
import type { StorageAdapter } from "../storage/adapter.js";

type RuntimeModule = typeof import("@skrun-dev/runtime");

/** One output file a scripted run leaves behind. */
export interface FakeOutputFile {
  name: string;
  content: string;
}

/**
 * What the next cloud run does: complete with these files, fail with a
 * `run_error` event, or break — throw `error` once `run_start` is out, as an
 * adapter that crashes mid-stream would. With `held`, the run waits on that
 * promise once `run_start` is out, before anything else — a run in flight
 * until the test lets it end; with `untilAborted`, it waits for the run's
 * signal to abort — the caller who hangs up, the server's stop. `beforeEnd`
 * runs then, just before the run's final event (a test moves its clock
 * there). With `cleanup`, a failed run hands that promise to the route's
 * `onBackgroundCleanup` once its `run_error` is out, as the production adapter
 * hands the search for a creation it abandoned.
 *
 * With `spawned`, a completing run announces its machine ready as the
 * production adapter does: a `runner_spawned` event right after `run_start`,
 * before `held`, carrying these pool indicators (`poolHit` → `pool_hit`,
 * `poolHandoffsFailed` → `pool_handoffs_failed`, `resumedFromSnapshot` →
 * `pool_resumed_from_snapshot`); then, once the consumer pulls again, the
 * telemetry callback (`onRunnerSpawned`) with the same phases. Without it, no
 * `runner_spawned` at all.
 *
 * `spawn-failed` is the one script the production adapter plays itself: its
 * `executeStream` runs as written, and only the acquisition of its machine is
 * replaced — it fails at `phase` (on the machine `machineId`, if one was
 * made, named `machineName` — the run's machine name by default —, with the
 * HTTP status `httpStatus`, none by default, and at `init-rpc` the step
 * `stage` the runner named, none by default), after `held` and
 * `untilAborted` and once `beforeEnd` has run. What
 * the adapter does with a failed start — its log, the phase it names to the
 * route (`onSpawnFailed`), the destruction of the machine, its `run_error` —
 * is the production code's. The destruction touches no platform: it waits on
 * `destroyHeld`, when given, and is noted.
 */
export type FakeRunScript = (
  | {
      outcome: "complete";
      files: FakeOutputFile[];
      spawned?: { poolHit?: true; poolHandoffsFailed?: number; resumedFromSnapshot?: boolean };
    }
  | { outcome: "error"; code: string; message: string; cleanup?: Promise<void> }
  | { outcome: "break"; error: Error }
  | {
      outcome: "spawn-failed";
      phase: MachineSpawnPhase;
      machineId?: string;
      machineName?: string;
      httpStatus?: number;
      stage?: InitStage;
      destroyHeld?: Promise<void>;
    }
) & { held?: Promise<void>; untilAborted?: true; beforeEnd?: () => void };

/** Resolved once `signal` has aborted — at once if it already has. */
function abortOf(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Where the fake adapter reads its script when a run starts. A holder rather
 * than a value: the mock factory runs once, before any test, and each test then
 * sets `next` for its own run.
 */
export interface FakeRunScriptHolder {
  next: FakeRunScript;
  /** The options the route built the last cloud adapter with, noted when its run starts. */
  adapterOptions?: FlyioAdapterOptions;
  /** The request the route handed the last cloud adapter, noted when its run starts. */
  lastRequest?: RunRequest;
  /** The machines a `spawn-failed` run destroyed, in order. */
  destroyed?: string[];
}

/** Version every bundle this harness pushes is published at. */
export const FAKE_AGENT_VERSION = "1.0.0";

/** The credential the api test process accepts as its local operator; it owns namespace `dev`. */
export const DEV_TOKEN = "dev-token";

/** Where a webhook run reports; the test replaces the delivery, nothing is sent. */
export const FAKE_WEBHOOK_URL = "https://hooks.example.com/x";

/**
 * The cloud adapter with its machine and its model replaced by `script`. The
 * explicit return type is what lets the declaration emit describe a class
 * expression whose base has protected members.
 */
export function makeFakeFlyioAdapterClass(
  actual: RuntimeModule,
  script: FakeRunScriptHolder,
): RuntimeModule["FlyioAdapter"] {
  return class FakeFlyioAdapter extends actual.FlyioAdapter {
    /** The `spawn-failed` script this adapter's run plays, if any. */
    private spawnStep?: Extract<FakeRunScript, { outcome: "spawn-failed" }>;

    override async *executeStream(request: RunRequest): AsyncGenerator<RunEvent> {
      const step = script.next;
      script.adapterOptions = this.options;
      script.lastRequest = request;
      if (step.outcome === "spawn-failed") {
        this.spawnStep = step;
        yield* super.executeStream(request);
        return;
      }
      const now = () => new Date().toISOString();
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: now(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      };
      if (step.outcome === "complete" && step.spawned) {
        const { poolHit, poolHandoffsFailed, resumedFromSnapshot } = step.spawned;
        const phases: SpawnPhases = {
          create_api_ms: 1,
          ...(poolHit && { pool_hit: true }),
          ...(poolHandoffsFailed !== undefined && { pool_handoffs_failed: poolHandoffsFailed }),
          ...(resumedFromSnapshot !== undefined && {
            pool_resumed_from_snapshot: resumedFromSnapshot,
          }),
        };
        yield { type: "runner_spawned", run_id: request.runId, timestamp: now(), phases };
        // After the yield, as the production adapter calls it: at the consumer's next pull.
        this.options.onRunnerSpawned?.({ machineId: "fake-machine", privateIp: "fdaa::f", phases });
      }
      if (step.held) await step.held;
      if (step.untilAborted) await abortOf(request.abortSignal);
      step.beforeEnd?.();
      if (step.outcome === "error") {
        // Handed in a `finally`, as the production adapter hands its clean-up:
        // a consumer that closes the run at its run_error, without pulling
        // again, still sets it off.
        try {
          yield {
            type: "run_error",
            run_id: request.runId,
            timestamp: now(),
            error: { code: step.code, message: step.message },
          };
        } finally {
          if (step.cleanup) this.options.onBackgroundCleanup?.(step.cleanup);
        }
        return;
      }
      if (step.outcome === "break") throw step.error;
      const files: FileInfo[] = [];
      for (const file of step.files) {
        const bytes = Buffer.from(file.content);
        const key = actual.runOutputKey(request.runId, file.name);
        await this.storage.put(key, bytes);
        const url = await this.storage.getPresignedDownloadUrl(key, 15 * 60);
        files.push({ name: file.name, size: bytes.length, url });
      }
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: now(),
        output: { answer: "scripted" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files,
        // Every scripted file is kept: nothing is left out.
        files_excluded: {},
      };
    }

    /** The acquisition of a `spawn-failed` run: it fails where its script says. */
    protected override async acquireRunner(request: RunRequest): Promise<never> {
      const step = this.spawnStep;
      if (!step) throw new Error("only a spawn-failed script acquires a machine here");
      if (step.held) await step.held;
      if (step.untilAborted) await abortOf(request.abortSignal);
      step.beforeEnd?.();
      throw new actual.MachineSpawnError(
        {
          machineName: step.machineName ?? `skrun-run-${request.runId}`,
          machineId: step.machineId ?? null,
          phase: step.phase,
          httpStatus: step.httpStatus ?? null,
          ...(step.stage !== undefined && { stage: step.stage }),
        },
        new Error("scripted failed start"),
      );
    }

    /** No platform to destroy on: noted, once `destroyHeld` lets it. */
    protected override async destroyMachineSafely(machineId: string): Promise<void> {
      if (this.spawnStep?.destroyHeld) await this.spawnStep.destroyHeld;
      script.destroyed = [...(script.destroyed ?? []), machineId];
    }
  };
}

function fakePresignedUrl(verb: "get" | "put", key: string, expiresIn: number): string {
  return `https://objects.invalid/${encodeURIComponent(key)}?op=${verb}&expires=${expiresIn}`;
}

/**
 * Cloud dependencies around `storage`: reads, writes and deletes go straight to
 * it, so a test observes (or spies on) the very store the run wrote to.
 */
export function fakeFlyioDeps(storage: StorageAdapter): FlyioRuntimeDeps {
  const presigning: StorageAdapter = {
    put: (key, data, opts) => storage.put(key, data, opts),
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    exists: (key) => storage.exists(key),
    list: (prefix) => storage.list(prefix),
    getPresignedDownloadUrl: async (key, expiresIn) => fakePresignedUrl("get", key, expiresIn),
    getPresignedUploadUrl: async (key, expiresIn) => fakePresignedUrl("put", key, expiresIn),
  };
  return {
    flyApi: {} as FlyioRuntimeDeps["flyApi"],
    storage: presigning as FlyioRuntimeDeps["storage"],
    runtimeImageTag: "fake-runner-image",
    // The fake adapter uploads nothing: a budget of its own, which a test can
    // tell from any other, and that any reservation would throw on.
    outputsBudget: {} as FlyioRuntimeDeps["outputsBudget"],
  };
}

/**
 * Push a bundle that parses and runs (`agent.yaml` + `SKILL.md`) at
 * `FAKE_AGENT_VERSION`, then mark that version verified. `namespace` must be
 * one `token` may push to. Give every test its own `name`, so each test's
 * agent is its own (the name is part of the bundle's bytes, which key the
 * extracted-bundle cache).
 */
export async function pushRunnableAgent(
  app: Hono,
  db: DbAdapter,
  namespace: string,
  name: string,
  token: string = DEV_TOKEN,
): Promise<void> {
  const agentYaml = [
    `name: ${name}`,
    `version: ${FAKE_AGENT_VERSION}`,
    "model:",
    "  provider: anthropic",
    "  name: claude-sonnet-4-6",
    "inputs:",
    "  - name: q",
    "    type: string",
    "    required: true",
    "outputs:",
    "  - name: answer",
    "    type: string",
  ].join("\n");
  const bundle = await packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
  ]);
  const res = await app.request(
    `/api/agents/${namespace}/${name}/push?version=${FAKE_AGENT_VERSION}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    },
  );
  if (res.status !== 200) {
    throw new Error(`push of ${namespace}/${name} answered ${res.status}: ${await res.text()}`);
  }
  await db.setVersionVerified(namespace, name, FAKE_AGENT_VERSION, true);
}

/** The three response shapes of `POST /run`. */
export type RunResponseMode = "sse" | "webhook" | "sync";

/**
 * `POST /run` in the given response shape: `sse` asks for an event stream,
 * `webhook` names `FAKE_WEBHOOK_URL`, `sync` asks for neither. The request
 * carries a caller model key, as a cloud caller's does; no model is ever called.
 */
export async function runFlyio(
  app: Hono,
  namespace: string,
  name: string,
  opts: { mode: RunResponseMode; token?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token ?? DEV_TOKEN}`,
    "Content-Type": "application/json",
    "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
  };
  if (opts.mode === "sse") headers.Accept = "text/event-stream";
  const body: Record<string, unknown> = { input: { q: "hello" } };
  if (opts.mode === "webhook") body.webhook_url = FAKE_WEBHOOK_URL;
  return app.request(`/api/agents/${namespace}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** The events of an SSE body, in order, each with its parsed `data`. */
export function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

/**
 * The run's row once the route is done writing it. A streamed run's final event
 * waits for that write, but for 10 s at most; a webhook run is answered `202`
 * before it even starts. Either way the row can still read `running` when the
 * body ends: this polls the store for a bounded time rather than trusting the
 * order.
 */
export async function settledRun(db: DbAdapter, runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await db.getRun(runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} was still running a second after the route answered`);
}
