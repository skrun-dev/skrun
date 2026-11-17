/**
 * E2E: every way a run ends writes its final status first, and once.
 *
 * A caller who holds a run's end — the synchronous response, the stream's final
 * event, the webhook delivery — and then reads the run (`GET /api/runs/:id`, or
 * the dashboard) must find it finished, never `running`. Each case below reads
 * the run's row at that very instant: on the response, as soon as the stream's
 * final event arrives (before anything else is read), from inside the delivery.
 * The final write is slowed down on purpose (`finishRun`, 50 ms), so a caller
 * told before the write lands would read `running`.
 *
 * Also held here: a run whose stream or background task throws instead of
 * ending with its own final event, or that throws between the write of its row
 * and its mode, ends `failed`; a streamed run whose caller hangs up right after
 * the final event keeps that final status — and in every case the final status
 * is written exactly once, and the run leaves the server's runs in flight.
 *
 * What is simulated: the model on the local runtime (a spy on the built
 * router's call), the cloud adapter's stream (a spy on the built runtime's
 * `FlyioAdapter`, the module the API resolves) and its cloud dependencies (the
 * in-memory fakes of the route's own cloud tests), the webhook delivery
 * (captured, not sent), and — for one case — the building of a run's state
 * callbacks, broken on purpose. What is real: the route, its three modes, the
 * registry, the in-memory database and every write to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbAdapter } from "../../packages/api/src/db/adapter.js";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import type { Run } from "../../packages/api/src/db/schema.js";
import { createApp } from "../../packages/api/src/index.js";
import {
  FAKE_WEBHOOK_URL,
  fakeFlyioDeps,
  pushRunnableAgent,
} from "../../packages/api/src/routes/flyio-run-harness.shared.js";
import { inFlightRunIds } from "../../packages/api/src/runtime/in-flight-runs.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import {
  FlyioAdapter,
  LLMRouter,
  type RunEvent,
  type RunRequest,
} from "../../packages/runtime/dist/index.js";

const NS = "dev";
const TOKEN = "dev-token";
const CALLER_KEY = "sk-ant-fake-caller-key";
const UNEXPECTED_END = "The run ended unexpectedly.";
/** How long each final write is held back before it lands. */
const FINAL_WRITE_DELAY_MS = 50;

/** The database of the current case, and the deliveries it saw — each with the row as it read then. */
const hooks = vi.hoisted(() => ({
  db: undefined as DbAdapter | undefined,
  deliveries: [] as Array<{ payload: Record<string, unknown>; rowStatus: string | null }>,
  stateCallbacksFault: undefined as Error | undefined,
}));

vi.mock("../../packages/api/src/utils/webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/api/src/utils/webhook.js")>();
  return {
    ...actual,
    deliverWebhook: async (_url: string, payload: object) => {
      const body = payload as Record<string, unknown>;
      const row = hooks.db ? await hooks.db.getRun(String(body.run_id)) : null;
      hooks.deliveries.push({ payload: body, rowStatus: row?.status ?? null });
    },
  };
});

// A run's state callbacks are built with its adapter, after the run's row is
// written and before its mode runs: a fault a case sets breaks that step.
vi.mock("../../packages/api/src/services/agent-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/api/src/services/agent-state.js")>();
  return {
    ...actual,
    createStateCallbacks: (...args: Parameters<typeof actual.createStateCallbacks>) => {
      if (hooks.stateCallbacksFault) throw hooks.stateCallbacksFault;
      return actual.createStateCallbacks(...args);
    },
  };
});

type Mode = "sync" | "sse" | "webhook";

/** One case's server: its own database, its own app, the final writes it saw. */
interface World {
  app: ReturnType<typeof createApp>;
  db: MemoryDb;
  /** The run id of each call of `finishRun`, in order. */
  finalWrites: string[];
}

function world(runtime: "local" | "flyio"): World {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app =
    runtime === "flyio"
      ? createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) })
      : createApp(storage, db, { runtimeMode: "local" });
  const finalWrites: string[] = [];
  const finishRun = db.finishRun.bind(db);
  vi.spyOn(db, "finishRun").mockImplementation(async (id, data, options) => {
    finalWrites.push(id);
    await new Promise((resolve) => setTimeout(resolve, FINAL_WRITE_DELAY_MS));
    return finishRun(id, data, options);
  });
  hooks.db = db;
  return { app, db, finalWrites };
}

function runRequest(name: string, mode: Mode, signal?: AbortSignal): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "X-LLM-API-Key": JSON.stringify({ anthropic: CALLER_KEY }),
  };
  if (mode === "sse") headers.Accept = "text/event-stream";
  const body: Record<string, unknown> = { input: { q: "hello" } };
  if (mode === "webhook") body.webhook_url = FAKE_WEBHOOK_URL;
  return new Request(`http://localhost/api/agents/${NS}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/** The one run of the store. */
async function theRun(db: DbAdapter): Promise<Run> {
  const [run, ...others] = await db.listRuns();
  expect(others).toEqual([]);
  if (!run) throw new Error("no run was recorded");
  return run;
}

/** Until the run has left the server's runs in flight. */
async function settled(runId: string): Promise<void> {
  await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(runId));
}

interface StreamRead {
  events: Array<{ event: string; data: Record<string, unknown> }>;
  /** The row as it read the moment the final event arrived; absent without one. */
  rowAtFinalEvent?: Run | null;
}

/**
 * Read a stream's events as they arrive. At the first final event, the run's
 * row is read before anything more — then `onFinal`, which may hang up.
 */
async function readStream(
  res: Response,
  db: DbAdapter,
  onFinal?: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>,
): Promise<StreamRead> {
  const out: StreamRead = { events: [] };
  if (!res.body) throw new Error("the response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        if (line.startsWith("data: ")) data = line.slice("data: ".length);
      }
      if (!data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      out.events.push({ event, data: parsed });
      const final = event === "run_complete" || event === "run_error";
      if (final && out.rowAtFinalEvent === undefined) {
        out.rowAtFinalEvent = await db.getRun(String(parsed.run_id));
        if (onFinal) {
          await onFinal(reader);
          return out;
        }
      }
    }
  }
}

/**
 * Run the agent in `mode` and hand back the row as it read at the run's end:
 * on the response, at the final event, inside the delivery.
 */
async function runToItsEnd(
  w: World,
  name: string,
  mode: Mode,
): Promise<{ run: Run; rowAtEnd: Run | null; status: number; told: string | undefined }> {
  const res = await w.app.request(runRequest(name, mode));
  if (mode === "sync") {
    const rowAtEnd = await theRun(w.db);
    const body = (await res.json()) as { status?: string; error?: { code: string } };
    await settled(rowAtEnd.id);
    return { run: await theRun(w.db), rowAtEnd, status: res.status, told: body.status };
  }
  if (mode === "sse") {
    const read = await readStream(res, w.db);
    const final = read.events.find((e) => e.event === "run_complete" || e.event === "run_error");
    const run = await theRun(w.db);
    await settled(run.id);
    return {
      run: await theRun(w.db),
      rowAtEnd: read.rowAtFinalEvent ?? null,
      status: res.status,
      told: final?.event === "run_complete" ? "completed" : final ? "failed" : undefined,
    };
  }
  expect(res.status).toBe(202);
  await vi.waitFor(() => expect(hooks.deliveries).toHaveLength(1));
  const [delivery] = hooks.deliveries;
  const run = await theRun(w.db);
  await settled(run.id);
  return {
    run: await theRun(w.db),
    rowAtEnd: delivery ? ({ status: delivery.rowStatus } as Run) : null,
    status: res.status,
    told: delivery ? String(delivery.payload.status) : undefined,
  };
}

/** What the next cloud run's stream does once `run_start` is out. */
type CloudScript =
  | { outcome: "complete" }
  | { outcome: "error" }
  | { outcome: "throw"; thrown: () => unknown }
  | { outcome: "complete, then the caller hangs up" };

const cloud: { script: CloudScript; ended?: () => void; sawHangUp?: boolean } = {
  script: { outcome: "complete" },
};

/** Settles once the caller has hung up — or after `ms`, whichever is first. */
function hungUp(request: RunRequest, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (request.abortSignal?.aborted) done();
    request.abortSignal?.addEventListener("abort", done, { once: true });
  });
}

beforeEach(() => {
  hooks.deliveries.length = 0;
  hooks.stateCallbacksFault = undefined;
  // The local runtime runs the real local adapter; only the model is simulated.
  vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
    content: '{"answer":"local"}',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    estimatedCost: 0.001,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 1,
  }));
  vi.spyOn(FlyioAdapter.prototype, "executeStream").mockImplementation(async function* (
    request: RunRequest,
  ): AsyncGenerator<RunEvent> {
    const at = () => new Date().toISOString();
    const runId = request.runId;
    const script = cloud.script;
    try {
      yield {
        type: "run_start",
        run_id: runId,
        timestamp: at(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      };
      if (script.outcome === "throw") throw script.thrown();
      if (script.outcome === "error") {
        yield {
          type: "run_error",
          run_id: runId,
          timestamp: at(),
          error: { code: "MACHINE_SPAWN_FAILED", message: "The machine could not be started." },
        };
        return;
      }
      yield {
        type: "run_complete",
        run_id: runId,
        timestamp: at(),
        output: { answer: "scripted" },
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        cost: { estimated: 0.001 },
        duration_ms: 7,
        files: [],
        files_excluded: {},
      };
      if (script.outcome === "complete, then the caller hangs up") {
        // Were the cloud adapter to stop on its caller's hang-up after its run
        // completed, and say so: the route closes the adapter at its final
        // event, so this is never reached — its `finally` is.
        await hungUp(request, 5_000);
        cloud.sawHangUp = request.abortSignal?.aborted === true;
        yield {
          type: "run_error",
          run_id: runId,
          timestamp: at(),
          error: { code: "ABORTED", message: "Run aborted by caller mid-iteration" },
        };
      }
    } finally {
      cloud.ended?.();
    }
  });
});

afterEach(() => {
  cloud.script = { outcome: "complete" };
  cloud.ended = undefined;
  cloud.sawHangUp = undefined;
  hooks.db = undefined;
  vi.restoreAllMocks();
});

describe("E2E: a run's end follows the write of its final status, on the local runtime", () => {
  it.each([
    ["sync", "completed"],
    ["sse", "completed"],
    ["webhook", "completed"],
    ["sync", "failed"],
    ["sse", "failed"],
    ["webhook", "failed"],
  ] as const)("%s, %s: the row is final when the caller is told, written once", async (mode, outcome) => {
    const w = world("local");
    const name = `terminus-local-${mode}-${outcome}`;
    await pushRunnableAgent(w.app, w.db, NS, name);
    if (outcome === "failed") {
      vi.mocked(LLMRouter.prototype.call).mockRejectedValue(new Error("The provider refused."));
    }

    const end = await runToItsEnd(w, name, mode);

    expect(end.told).toBe(outcome);
    expect(end.rowAtEnd?.status).toBe(outcome);
    expect(end.run.status).toBe(outcome);
    if (outcome === "failed") expect(end.run.error).toBe("The provider refused.");
    expect(end.run.completed_at).not.toBeNull();
    expect(w.finalWrites).toEqual([end.run.id]);
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an exception after the run's row is written and before its mode runs ends the run failed", async (mode) => {
    const w = world("local");
    const name = `terminus-window-${mode}`;
    await pushRunnableAgent(w.app, w.db, NS, name);
    hooks.stateCallbacksFault = new Error("the run's adapter could not be built");

    const res = await w.app.request(runRequest(name, mode));

    expect(res.status).toBe(500);
    const run = await theRun(w.db);
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(run.completed_at).not.toBeNull();
    expect(w.finalWrites).toEqual([run.id]);
    expect(inFlightRunIds()).not.toContain(run.id);
    expect(hooks.deliveries).toEqual([]);
  });
});

describe("E2E: a run's end follows the write of its final status, on the cloud runtime", () => {
  it.each([
    ["sse", "completed"],
    ["webhook", "completed"],
    ["sse", "failed"],
    ["webhook", "failed"],
  ] as const)("%s, %s: the row is final when the caller is told, written once", async (mode, outcome) => {
    const w = world("flyio");
    const name = `terminus-cloud-${mode}-${outcome}`;
    await pushRunnableAgent(w.app, w.db, NS, name);
    cloud.script = outcome === "completed" ? { outcome: "complete" } : { outcome: "error" };

    const end = await runToItsEnd(w, name, mode);

    expect(end.told).toBe(outcome);
    expect(end.rowAtEnd?.status).toBe(outcome);
    expect(end.run.status).toBe(outcome);
    if (outcome === "failed") expect(end.run.error).toBe("The machine could not be started.");
    expect(w.finalWrites).toEqual([end.run.id]);
  });

  it("sync: the synchronous call is refused before any row is written — no row, so no final write to wait for", async () => {
    const w = world("flyio");
    await pushRunnableAgent(w.app, w.db, NS, "terminus-cloud-sync");

    const res = await w.app.request(runRequest("terminus-cloud-sync", "sync"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SYNC_MODE_UNSUPPORTED");
    expect(await w.db.listRuns()).toEqual([]);
    expect(w.finalWrites).toEqual([]);
  });

  const THROWN = [
    ["an Error", () => new Error("the adapter broke")],
    ["a value that is not an Error", () => "boom"],
  ] as const;

  it.each(
    THROWN,
  )("sse: a stream that throws %s, not a run_error, ends with the row failed", async (what, thrown) => {
    // A value that is not an Error is printed by the streaming helper itself.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world("flyio");
    const name = `terminus-sse-throws-${what.length}`;
    await pushRunnableAgent(w.app, w.db, NS, name);
    cloud.script = { outcome: "throw", thrown };

    const res = await w.app.request(runRequest(name, "sse"));
    const read = await readStream(res, w.db);

    // No final event: the stream ends, and by then the row is failed.
    expect(read.events.map((e) => e.event)).toEqual(["run_start"]);
    const run = await theRun(w.db);
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(run.completed_at).not.toBeNull();
    expect(w.finalWrites).toEqual([run.id]);
    await settled(run.id);
  });

  it.each(
    THROWN,
  )("webhook: a background run that throws %s ends failed, and is not delivered", async (what, thrown) => {
    const w = world("flyio");
    const name = `terminus-webhook-throws-${what.length}`;
    await pushRunnableAgent(w.app, w.db, NS, name);
    cloud.script = { outcome: "throw", thrown };

    const res = await w.app.request(runRequest(name, "webhook"));

    expect(res.status).toBe(202);
    const runId = (await theRun(w.db)).id;
    await settled(runId);
    const run = await theRun(w.db);
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(w.finalWrites).toEqual([runId]);
    expect(hooks.deliveries).toEqual([]);
  });

  it("sse: a caller who hangs up right after run_complete leaves the run completed, written once", async () => {
    const w = world("flyio");
    await pushRunnableAgent(w.app, w.db, NS, "terminus-cloud-hangs-up");
    cloud.script = { outcome: "complete, then the caller hangs up" };
    const ended = new Promise<void>((resolve) => {
      cloud.ended = resolve;
    });
    const caller = new AbortController();

    const res = await w.app.request(runRequest("terminus-cloud-hangs-up", "sse", caller.signal));
    const read = await readStream(res, w.db, async (reader) => {
      caller.abort();
      await reader.cancel();
    });

    expect(read.events.at(-1)?.event).toBe("run_complete");
    expect(read.rowAtFinalEvent?.status).toBe("completed");
    // The adapter was closed at its final event — its `finally` reached —, and
    // the route went to its end.
    await ended;
    const run = await theRun(w.db);
    await settled(run.id);
    // Closed there, the adapter never went on to the caller's hang-up.
    expect(cloud.sawHangUp).toBeUndefined();
    expect(await theRun(w.db)).toMatchObject({ status: "completed", error: null });
    expect(w.finalWrites).toEqual([run.id]);
  });
});
