import { existsSync } from "node:fs";
import {
  FlyioAdapter,
  FlyMachinesApi,
  LLMRouter,
  LocalAdapter,
  type Logger,
  type RunCompleteEvent,
  type RunErrorEvent,
  type RunEvent,
  RunnerPool,
  type RunRequest,
  TimeoutError,
  ToolRegistry,
} from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { outputCache } from "../cache/output-cache.js";
import { SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import type { Run } from "../db/schema.js";
import { createApp } from "../index.js";
import {
  FINAL_WRITE_RETRY_DELAYS_MS,
  failureToTell,
  finalEventFor,
  finalizeRun,
  RUN_DEADLINE_ERROR,
  RUN_DEADLINE_ERROR_CODE,
  SERVER_STOPPING_REFUSAL,
} from "../routes/_helpers.js";
import { parseSseEvents } from "../routes/flyio-run-harness.shared.js";
import { FINAL_WRITE_WAIT_MS } from "../routes/run.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  _resetShutdownForTests,
  admissionCount,
  backgroundCleanupCount,
  beginAdmission,
  DEADLINE_STREAM_GRACE_MS,
  type InFlightRun,
  inFlightRunIds,
  installShutdownHandlers,
  MAX_TIMER_DELAY_MS,
  RunDeadlineReached,
  registerInFlightRun,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_GRACE_MS,
  type ShutdownProcess,
  type ShutdownSummary,
  shutdownInFlightRuns,
  trackBackgroundCleanup,
} from "./in-flight-runs.js";

const { deliverWebhook, routeLines, heldOutputDirs } = vi.hoisted(() => ({
  /** A webhook run started from this file delivers nothing: the case reads what it would have. */
  deliverWebhook: vi.fn(async (_url: string, _payload: object) => {}),
  /** Every line the API's own loggers write, parsed, oldest first: a case clears it. */
  routeLines: [] as Array<Record<string, unknown>>,
  /** Every run output directory the route held, in order: a case clears it. */
  heldOutputDirs: [] as string[],
}));

vi.mock("../utils/webhook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/webhook.js")>()),
  deliverWebhook,
}));

// The output cache as it is, save that the directory a run holds is noted for
// the case to look at.
vi.mock("../cache/output-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cache/output-cache.js")>();
  return {
    ...actual,
    holdOutputDir: (dir: string) => {
      heldOutputDirs.push(dir);
      return actual.holdOutputDir(dir);
    },
  };
});

// The API's loggers are the runtime's, written to a destination that keeps
// each line for the cases to read. Nothing else of the runtime is replaced:
// its adapter class is the one the cases spy on.
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const destination = {
    write(line: string) {
      routeLines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { ...actual, createLogger: (name: string) => actual.createLogger(name, destination) };
});

/** What the cloud adapter's loop yields once the signal it was handed is aborted. */
const ABANDONED = "Run aborted by caller mid-iteration";
/** The code a caller is told a run the server's stop ended with. */
const STOPPED_CODE = "SERVER_STOPPED";

type FinalEvent = RunCompleteEvent | RunErrorEvent;

/** A logger whose lines the case reads: the first argument of each call. */
function logger() {
  const lines: Array<Record<string, unknown>> = [];
  const record = (line: Record<string, unknown>) => {
    lines.push(line);
  };
  const log = { info: vi.fn(record), warn: vi.fn(record), error: vi.fn(record) };
  return { lines, log: log as unknown as Logger };
}

function completion(runId: string): RunCompleteEvent {
  return {
    type: "run_complete",
    run_id: runId,
    timestamp: new Date().toISOString(),
    output: { answer: "ok" },
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cost: { estimated: 0 },
    duration_ms: 1,
    files: [],
    files_excluded: {},
  };
}

function failure(runId: string, code: string, message: string): RunErrorEvent {
  return {
    type: "run_error",
    run_id: runId,
    timestamp: new Date().toISOString(),
    error: { code, message },
  };
}

// The stop, called as the signal handlers call it: every run in flight is
// abandoned, a short drain lets the ones that answer end by themselves, every
// run still going gets the stop's failure — provisional, which only a
// completion replaces — and the stop then waits, within its grace, for the
// runs to settle and for the clean-ups they handed over. Every case runs on
// the test's clock, with the real final write on an in-memory store; nothing
// waits for real, and nothing is left armed or registered at its end.
describe("the server's stop, called directly", () => {
  let db: MemoryDb;
  let lines: Array<Record<string, unknown>>;
  let log: Logger;
  let registered: InFlightRun[];
  /** What each run's caller was sent, by run. */
  let received: Map<string, FinalEvent[]>;
  let t0: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    db = new MemoryDb();
    ({ lines, log } = logger());
    registered = [];
    received = new Map();
    t0 = Date.now();
  });

  afterEach(async () => {
    try {
      // A case that failed half-way gives its entries back, and its clock runs
      // out — a clean-up still waiting on it ends: the next case starts empty.
      for (const run of registered) run.settle();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      // A stop stays for the process's life: the next case is a new process.
      // Last: it throws on a stop still under way, and skips nothing then.
      _resetShutdownForTests();
    }
  });

  /** A run in flight: its row `running`, its entry registered, as the run route registers one. */
  async function runInFlight(runId: string): Promise<InFlightRun> {
    await db.createRun({
      id: runId,
      agent_id: null,
      agent_version: "dev/agent@1.0.0",
      status: "running",
      input: {},
    });
    const run = registerInFlightRun({ runId, db, log, mode: "sse", runtimeMode: "local" });
    registered.push(run);
    return run;
  }

  /**
   * A run's final event, as the run route's stream handles it: the final
   * write, then the event the caller is sent — the one the row's word makes it.
   */
  async function ends(run: InFlightRun, event: FinalEvent): Promise<void> {
    const at = { now: new Date(), mode: "sse" as const, runtimeMode: "local" as const };
    const written =
      event.type === "run_complete"
        ? await finalizeRun(db, log, run.runId, run, {
            ...at,
            status: "completed",
            completion: {
              output: event.output,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0,
              durationMs: event.duration_ms,
              files: [],
            },
            modelForCostLookup: "claude-x",
          })
        : await finalizeRun(db, log, run.runId, run, {
            ...at,
            status: "failed",
            error: event.error.message,
          });
    received.set(run.runId, [...(received.get(run.runId) ?? []), finalEventFor(event, written)]);
  }

  /** `then`, once the stop has aborted `run`, `ms` later: a run that answers the stop. */
  function answersTheStop(run: InFlightRun, ms: number, then: () => Promise<void> | void): void {
    run.controller.signal.addEventListener(
      "abort",
      () => {
        setTimeout(() => void then(), ms);
      },
      { once: true },
    );
  }

  /** The stop, from now on the case's clock; `done()` says whether it has returned. */
  function stop(): { summary: Promise<ShutdownSummary>; done: () => boolean } {
    t0 = Date.now();
    let returned = false;
    const summary = shutdownInFlightRuns({
      drainMs: SHUTDOWN_DRAIN_MS,
      graceMs: SHUTDOWN_GRACE_MS,
    });
    void summary.then(() => {
      returned = true;
    });
    return { summary, done: () => returned };
  }

  /** Move the case's clock to `ms` after the stop's signal. */
  async function at(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(t0 + ms - Date.now());
  }

  function iso(ms: number): string {
    return new Date(t0 + ms).toISOString();
  }

  function skips(): Array<Record<string, unknown>> {
    return lines.filter((line) => line.event === "run_finalize_skipped");
  }

  /** Nothing of the case outlives it: no run registered, no admission or clean-up held, no timer armed. */
  function expectNothingLeft(): void {
    expect(inFlightRunIds()).toEqual([]);
    expect(admissionCount()).toBe(0);
    expect(backgroundCleanupCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("the stop's bounds: a drain of 3 s, a grace of 20 s in all", () => {
    expect(SHUTDOWN_DRAIN_MS).toBe(3_000);
    expect(SHUTDOWN_GRACE_MS).toBe(20_000);
  });

  it("a run that answers the stop during the drain ends failed with the stop's phrase, for good, and its caller is told that phrase", async () => {
    const run = await runInFlight("run-a");
    answersTheStop(run, 500, async () => {
      await ends(run, failure(run.runId, "ABORTED", ABANDONED));
      run.settle();
    });

    const stopping = stop();
    await at(600);

    expect(await db.getRun("run-a")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: iso(500),
    });
    expect(run.claim).toBe("final");
    expect(received.get("run-a")).toEqual([
      expect.objectContaining({
        type: "run_error",
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      }),
    ]);
    expect(JSON.stringify(received.get("run-a"))).not.toContain(ABANDONED);
    // Nothing else to wait for: the stop returned once the run had settled.
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toEqual({
      in_flight: 1,
      admitting: 0,
      abandoned: 1,
      finalized: 0,
      drained_ms: 500,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expectNothingLeft();
  });

  it("a run that ignores it gets the stop's provisional failure as the drain ends: the row is right within 3.5 s of the signal", async () => {
    const run = await runInFlight("run-b");

    const stopping = stop();
    await at(SHUTDOWN_DRAIN_MS - 1);
    expect((await db.getRun("run-b"))?.status).toBe("running");
    expect(run.controller.signal.aborted).toBe(true);

    await at(3_500);
    expect(await db.getRun("run-b")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: iso(SHUTDOWN_DRAIN_MS),
    });
    expect(run.claim).toBe("shutdown-provisional");
    // The stop still waits for the run.
    expect(stopping.done()).toBe(false);

    run.settle();
    expect(await stopping.summary).toEqual({
      in_flight: 1,
      admitting: 0,
      abandoned: 1,
      finalized: 1,
      drained_ms: SHUTDOWN_DRAIN_MS,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expectNothingLeft();
  });

  it("that run succeeding 8 s after the signal replaces its provisional failure: the row is completed, its caller told so, and the stop returns then, not at the drain's end", async () => {
    const run = await runInFlight("run-c");
    setTimeout(async () => {
      await ends(run, completion(run.runId));
      run.settle();
    }, 8_000);

    const stopping = stop();
    await at(7_999);
    expect(await db.getRun("run-c")).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(stopping.done()).toBe(false);

    await at(8_000);
    expect(await db.getRun("run-c")).toMatchObject({
      status: "completed",
      error: null,
      output: { answer: "ok" },
      completed_at: iso(8_000),
    });
    expect(run.claim).toBe("final");
    expect(received.get("run-c")).toEqual([expect.objectContaining({ type: "run_complete" })]);
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toMatchObject({
      in_flight: 1,
      abandoned: 1,
      finalized: 1,
      unsettled: 0,
    });
    expectNothingLeft();
  });

  it.each([
    ["its abandoned loop's", "ABORTED", ABANDONED],
    ["a real error's", "EXECUTION_FAILED", "the model refused"],
  ])("a run at the provisional failure whose loop then ends in %s failure changes nothing: the row keeps the stop's, and its caller is told the stop's", async (_what, code, message) => {
    const run = await runInFlight("run-c2");
    setTimeout(async () => {
      await ends(run, failure(run.runId, code, message));
      run.settle();
    }, 5_000);
    const finishRun = vi.spyOn(db, "finishRun");

    const stopping = stop();
    await at(5_000);
    await stopping.summary;

    expect(await db.getRun("run-c2")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: iso(SHUTDOWN_DRAIN_MS),
    });
    // The provisional failure's write, and nothing after it.
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(skips()).toEqual([
      { event: "run_finalize_skipped", run_id: "run-c2", status: "failed" },
    ]);
    expect(received.get("run-c2")).toEqual([
      expect.objectContaining({
        type: "run_error",
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      }),
    ]);
    expect(run.claim).toBe("shutdown-provisional");
    expectNothingLeft();
  });

  it("a run whose final status is written, but which has not settled yet, is not abandoned: its signal stays, and nothing is written for it", async () => {
    const run = await runInFlight("run-n");
    // Its completion written; its machine, say, still being destroyed.
    await ends(run, completion(run.runId));
    const finishRun = vi.spyOn(db, "finishRun");

    const stopping = stop();
    expect(run.controller.signal.aborted).toBe(false);
    expect(run.reason).toBeUndefined();

    run.settle();
    expect(await stopping.summary).toEqual({
      in_flight: 1,
      admitting: 0,
      abandoned: 0,
      finalized: 0,
      drained_ms: 0,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expect(finishRun).not.toHaveBeenCalled();
    expect(await db.getRun("run-n")).toMatchObject({ status: "completed" });
    expectNothingLeft();
  });

  it("a natural end after a run's final one is ignored: nothing is written again, and a line says so", async () => {
    const run = await runInFlight("run-d");
    answersTheStop(run, 500, async () => {
      await ends(run, failure(run.runId, "ABORTED", ABANDONED));
      // One more end from the loop, late: a completion.
      await ends(run, completion(run.runId));
      run.settle();
    });
    const finishRun = vi.spyOn(db, "finishRun");

    const stopping = stop();
    await at(600);
    await stopping.summary;

    expect(await db.getRun("run-d")).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(skips()).toEqual([
      { event: "run_finalize_skipped", run_id: "run-d", status: "completed" },
    ]);
    expect(run.claim).toBe("final");
    expectNothingLeft();
  });

  it("a run nothing more comes from keeps its provisional failure, and the stop returns at its grace's end, 20 s after its signal", async () => {
    const run = await runInFlight("run-e");

    const stopping = stop();
    await at(SHUTDOWN_GRACE_MS - 1);
    expect(stopping.done()).toBe(false);

    await at(SHUTDOWN_GRACE_MS);
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toEqual({
      in_flight: 1,
      admitting: 0,
      abandoned: 1,
      finalized: 1,
      drained_ms: SHUTDOWN_DRAIN_MS,
      unsettled: 1,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expect(await db.getRun("run-e")).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(run.claim).toBe("shutdown-provisional");
    // Its process would exit here; the case gives its entry back.
    run.settle();
    expectNothingLeft();
  });

  it("a detached clean-up handed over before the stop is waited for within its grace — one that rejects too", async () => {
    const run = await runInFlight("run-f");
    answersTheStop(run, 500, async () => {
      await ends(run, failure(run.runId, "ABORTED", ABANDONED));
      run.settle();
    });
    trackBackgroundCleanup(new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
    trackBackgroundCleanup(
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error("a machine could not be destroyed")), 4_000),
      ),
    );
    expect(backgroundCleanupCount()).toBe(2);

    const stopping = stop();
    await at(5_999);
    expect(stopping.done()).toBe(false);
    expect(backgroundCleanupCount()).toBe(1);

    await at(6_000);
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toMatchObject({ unsettled: 0, cleanups_pending: 0 });
    expectNothingLeft();
  });

  it("a clean-up a run hands over as it settles, while the stop already waits, is waited for too", async () => {
    const run = await runInFlight("run-g");
    setTimeout(() => {
      // As a cloud run whose creation was abandoned: its clean-up begins after
      // its end, then the run settles.
      trackBackgroundCleanup(new Promise<void>((resolve) => setTimeout(resolve, 4_000)));
      run.settle();
    }, 5_000);

    const stopping = stop();
    await at(8_999);
    expect(stopping.done()).toBe(false);
    expect(backgroundCleanupCount()).toBe(1);

    await at(9_000);
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toMatchObject({ unsettled: 0, cleanups_pending: 0 });
    expectNothingLeft();
  });

  it("a run at the provisional failure, on a row whose content was cleared, that then succeeds: the row stays failed, and its caller is told the stop's failure", async () => {
    const run = await runInFlight("run-h");
    const row = await db.getRun("run-h");
    // As an account deletion marks a run of the account: the in-memory store hands back the row it keeps.
    if (row) row.content_cleared_at = "2026-03-04T05:06:07.890Z";
    setTimeout(async () => {
      await ends(run, completion(run.runId));
      run.settle();
    }, 6_000);

    const stopping = stop();
    await at(6_000);
    await stopping.summary;

    expect(await db.getRun("run-h")).toMatchObject({
      status: "failed",
      error: null,
      output: null,
      completed_at: iso(SHUTDOWN_DRAIN_MS),
    });
    expect(received.get("run-h")).toEqual([
      expect.objectContaining({
        type: "run_error",
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      }),
    ]);
    expectNothingLeft();
  });

  it("a provisional failure whose write throws is one line, with the error's class and code, never its message: the stop goes on", async () => {
    const witness = "witness-7d20b5";
    const run = await runInFlight("run-i");
    const row = await db.getRun("run-i");
    // A run whose account was deleted while it ran: its final write drops the
    // run's local output, here made to throw.
    if (row) row.content_cleared_at = "2026-03-04T05:06:07.890Z";
    vi.spyOn(outputCache, "delete").mockImplementation(() => {
      throw Object.assign(new Error(`could not remove "${witness}"`), { code: "EBUSY" });
    });

    const stopping = stop();
    await at(SHUTDOWN_DRAIN_MS);

    expect(lines.filter((line) => line.event === "shutdown_provisional_write_failed")).toEqual([
      {
        event: "shutdown_provisional_write_failed",
        run_id: "run-i",
        error_name: "Error",
        error_code: "EBUSY",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(witness);
    run.settle();
    expect(await stopping.summary).toMatchObject({ in_flight: 1, finalized: 0, unsettled: 0 });
    expectNothingLeft();
  });

  it("a run admitted while the stop is under way is abandoned at once", async () => {
    const first = await runInFlight("run-j1");
    const stopping = stop();
    await at(1_000);

    const late = await runInFlight("run-j2");
    expect(late.controller.signal.aborted).toBe(true);
    expect(late.reason).toBe("shutdown");

    first.settle();
    late.settle();
    await stopping.summary;
    expectNothingLeft();
  });

  // A run whose row was being written as the stop began — the route refuses
  // any later one before its row — can reach the registry past the drain.
  it("a run registered once the stop has written its provisional failures gets its own at once", async () => {
    const first = await runInFlight("run-l1");
    const stopping = stop();
    await at(4_000);
    expect(await db.getRun("run-l1")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
    });

    const late = await runInFlight("run-l2");
    await at(4_000);
    expect(late.controller.signal.aborted).toBe(true);
    expect(late.claim).toBe("shutdown-provisional");
    expect(await db.getRun("run-l2")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: iso(4_000),
    });
    // The stop waits for it as for the others.
    first.settle();
    await at(4_001);
    expect(stopping.done()).toBe(false);
    late.settle();
    expect(await stopping.summary).toEqual({
      in_flight: 1,
      admitting: 0,
      abandoned: 1,
      finalized: 2,
      drained_ms: SHUTDOWN_DRAIN_MS,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expectNothingLeft();
  });

  it("a stop lasts until the process exits: a run registered after it returned is abandoned, and gets the stop's failure", async () => {
    const stopping = stop();
    await at(0);
    expect(stopping.done()).toBe(true);

    const late = await runInFlight("run-m");
    await at(0);
    expect(late.controller.signal.aborted).toBe(true);
    expect(late.reason).toBe("shutdown");
    expect(await db.getRun("run-m")).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    // The same stop, still: a second call hands back what it did.
    expect(await shutdownInFlightRuns()).toEqual(await stopping.summary);
    late.settle();
    expectNothingLeft();
  });

  it("the reset between cases refuses a stop still under way: left running, it would write its provisional failures on the next case's runs", async () => {
    const run = await runInFlight("run-r");
    const stopping = stop();
    await at(1_000);

    expect(() => _resetShutdownForTests()).toThrow(/still under way/);

    run.settle();
    await stopping.summary;
    expect(() => _resetShutdownForTests()).not.toThrow();
    expectNothingLeft();
  });

  it("a second call while the stop is under way is the same stop", async () => {
    const run = await runInFlight("run-k");
    const stopping = stop();
    const again = shutdownInFlightRuns();
    await at(1_000);
    run.settle();
    expect(await again).toEqual(await stopping.summary);
    expectNothingLeft();
  });

  it("with nothing in flight, the stop returns at once", async () => {
    const stopping = stop();
    await at(0);
    expect(stopping.done()).toBe(true);
    expect(await stopping.summary).toEqual({
      in_flight: 0,
      admitting: 0,
      abandoned: 0,
      finalized: 0,
      drained_ms: 0,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    expectNothingLeft();
  });

  it("an admission still under way at the grace's end: the stop returns then, and says so", async () => {
    const endAdmission = beginAdmission();
    try {
      const stopping = stop();
      await at(SHUTDOWN_GRACE_MS - 1);
      expect(stopping.done()).toBe(false);

      await at(SHUTDOWN_GRACE_MS);
      expect(await stopping.summary).toEqual({
        in_flight: 0,
        admitting: 1,
        abandoned: 0,
        finalized: 0,
        drained_ms: 0,
        unsettled: 0,
        admissions_pending: 1,
        cleanups_pending: 0,
      });
    } finally {
      endAdmission();
    }
    // Its end, once, leaves nothing counted; a second does nothing.
    endAdmission();
    expectNothingLeft();
  });

  // On the cloud runtime the stop holds the pool too: its maintenance stops at
  // the signal — no pass, no fill, no top-up after it —, and once the runs and
  // the clean-ups are done, within what is left of the grace, the ready machines
  // this process holds are destroyed: they serve no one after it, and paused
  // they bill their storage until another process's reconciliation judges them.
  // A machine still being filled is left to the next process.
  describe("with a pool", () => {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

    /** A pool of two ready machines and one being filled; its maintenance's stop and each destruction noted in `order`. */
    function poolOfTwoReady(
      order: string[],
      destroy: (id: string) => Promise<void> = async () => {},
    ) {
      const heldWhenDestroyed: unknown[] = [];
      const flyApi = {
        list: async () => [],
        destroy: vi.fn(async (id: string, _opts?: { signal?: AbortSignal }) => {
          heldWhenDestroyed.push(pool.get(id) ?? null);
          order.push(`destroy:${id}`);
          await destroy(id);
        }),
      } as unknown as FlyMachinesApi;
      const pool = new RunnerPool(
        flyApi,
        { size: 2, imageTag: "registry.example/runner:v1", maintenanceIntervalMs: 60_000 },
        quiet,
      );
      for (const machineId of ["ready-1", "ready-2", "filling-1"]) {
        pool.register({
          machineId,
          privateIp: "fdaa::1",
          claimToken: "c".repeat(64),
          imageTag: "registry.example/runner:v1",
        });
      }
      pool.markReady("ready-1");
      pool.markReady("ready-2");
      const stopMaintenance = pool.stop.bind(pool);
      vi.spyOn(pool, "stop").mockImplementation(() => {
        order.push("maintenance stopped");
        stopMaintenance();
      });
      return { pool, flyApi, heldWhenDestroyed };
    }

    it("its maintenance stopped first, then the run, then its two ready machines destroyed — each out of the inventory first —, the one being filled left; the summary counts them", async () => {
      const order: string[] = [];
      const { pool, flyApi, heldWhenDestroyed } = poolOfTwoReady(order);
      pool.start();
      const run = await runInFlight("run-p");
      run.controller.signal.addEventListener("abort", () => order.push("run abandoned"), {
        once: true,
      });
      answersTheStop(run, 500, async () => {
        await ends(run, failure(run.runId, "ABORTED", ABANDONED));
        order.push("run settled");
        run.settle();
      });

      t0 = Date.now();
      const summary = shutdownInFlightRuns({
        drainMs: SHUTDOWN_DRAIN_MS,
        graceMs: SHUTDOWN_GRACE_MS,
        pool,
      });
      await at(600);

      expect(order).toEqual([
        "maintenance stopped",
        "run abandoned",
        "run settled",
        "destroy:ready-1",
        "destroy:ready-2",
      ]);
      expect(heldWhenDestroyed).toEqual([null, null]);
      expect(vi.mocked(flyApi.destroy).mock.calls.map(([, opts]) => opts?.signal)).toEqual([
        expect.any(AbortSignal),
        expect.any(AbortSignal),
      ]);
      expect(await summary).toMatchObject({
        in_flight: 1,
        abandoned: 1,
        unsettled: 0,
        pool_destroyed: 2,
        pool_destroy_failed: 0,
      });
      expect(pool.stats()).toMatchObject({ ready: 0, filling: 1, draining: 0, destroyFailures: 0 });
      expect((pool as unknown as { maintenanceTimer: unknown }).maintenanceTimer).toBeNull();
      expectNothingLeft();
    });

    it("half a second of grace left: a destruction refused and one the grace's end cuts are both counted failed, and the stop returns at its grace's end — no timer left", async () => {
      const order: string[] = [];
      const { pool } = poolOfTwoReady(order, async (id) => {
        if (id === "ready-1") throw new Error("refused");
        // Never answers, whatever its signal says.
        await new Promise<void>(() => {});
      });
      const run = await runInFlight("run-q");
      // A run that ignores the stop and settles 19.5 s after its signal.
      setTimeout(() => run.settle(), 19_500);

      t0 = Date.now();
      let returned = false;
      const summary = shutdownInFlightRuns({
        drainMs: SHUTDOWN_DRAIN_MS,
        graceMs: SHUTDOWN_GRACE_MS,
        pool,
      });
      void summary.then(() => {
        returned = true;
      });
      await at(SHUTDOWN_GRACE_MS - 1);
      expect(order).toEqual(["maintenance stopped", "destroy:ready-1", "destroy:ready-2"]);
      expect(returned).toBe(false);

      await at(SHUTDOWN_GRACE_MS);
      expect(returned).toBe(true);
      expect(await summary).toMatchObject({
        unsettled: 0,
        pool_destroyed: 0,
        pool_destroy_failed: 2,
      });
      expect(pool.stats()).toMatchObject({ ready: 0, filling: 1, destroyFailures: 2 });
      expectNothingLeft();
    });
  });
});

// A run's seat expires at its deadline — its timeout, plus the margin for its
// machine and its outputs —, past which it holds no seat and charges nothing:
// the process must not serve it any longer. A run still in flight then is
// stopped by the registry: the deadline's failure written if it has none yet,
// charged from its admission, its controller aborted, its stream closed. Every
// case runs on the test's clock, with the real final write on an in-memory
// store; nothing is left armed or registered at its end.
describe("a run still in flight at its seat's deadline", () => {
  const HOLD_MS = 5_000;
  let db: MemoryDb;
  let lines: Array<Record<string, unknown>>;
  let log: Logger;
  let registered: InFlightRun[];
  let t0: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    db = new MemoryDb();
    ({ lines, log } = logger());
    registered = [];
    t0 = Date.now();
  });

  afterEach(async () => {
    try {
      for (const run of registered) run.settle();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      _resetShutdownForTests();
    }
  });

  /** A run in flight, admitted now, its seat held `holdMs`: registered as the run route registers one. */
  async function runInFlight(runId: string, holdMs = HOLD_MS): Promise<InFlightRun> {
    await db.createRun({
      id: runId,
      agent_id: null,
      agent_version: "dev/agent@1.0.0",
      status: "running",
      input: {},
    });
    const run = registerInFlightRun({
      runId,
      db,
      log,
      mode: "sse",
      runtimeMode: "flyio",
      admittedAt: new Date(t0),
      deadlineAt: new Date(t0 + holdMs),
    });
    registered.push(run);
    return run;
  }

  /** Move the case's clock to `ms` after the run's admission. */
  async function at(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(t0 + ms - Date.now());
  }

  function deadlineLines(): Array<Record<string, unknown>> {
    return lines.filter((line) => line.event === "run_deadline_reached");
  }

  it("a run without a final status is ended failed at its deadline, with the deadline's phrase, charged from its admission, and its controller aborted with the deadline's reason — not a millisecond before; its stream is closed 10 s later, unless it has settled", async () => {
    const run = await runInFlight("deadline-a");
    const close = vi.fn();
    run.closeAtDeadline(close);

    await at(HOLD_MS - 1);
    expect(await db.getRun("deadline-a")).toMatchObject({ status: "running" });
    expect(run.controller.signal.aborted).toBe(false);

    await at(HOLD_MS);
    expect(await db.getRun("deadline-a")).toMatchObject({
      status: "failed",
      error: RUN_DEADLINE_ERROR,
      completed_at: new Date(t0 + HOLD_MS).toISOString(),
      charged_ms: HOLD_MS,
    });
    expect(run.controller.signal.aborted).toBe(true);
    expect(run.controller.signal.reason).toBeInstanceOf(RunDeadlineReached);
    expect(run.reason).toBe("deadline");
    expect(deadlineLines()).toEqual([
      { event: "run_deadline_reached", run_id: "deadline-a", claim: "none", written: true },
    ]);

    expect(DEADLINE_STREAM_GRACE_MS).toBe(10_000);
    await at(HOLD_MS + DEADLINE_STREAM_GRACE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await at(HOLD_MS + DEADLINE_STREAM_GRACE_MS);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a run that settles within the grace after its deadline — its adapter answered the abort — has its stream left as it is, and no timer armed", async () => {
    const run = await runInFlight("deadline-h");
    const close = vi.fn();
    run.closeAtDeadline(close);
    await at(HOLD_MS);

    run.settle();
    expect(vi.getTimerCount()).toBe(0);
    await at(HOLD_MS + DEADLINE_STREAM_GRACE_MS * 2);
    expect(close).not.toHaveBeenCalled();
  });

  it("the end its stopped adapter comes to writes nothing, and is told as the deadline's failure, under its own code", async () => {
    const run = await runInFlight("deadline-b");
    await at(HOLD_MS);
    const finishRun = vi.spyOn(db, "finishRun");

    const ended = await finalizeRun(db, log, run.runId, run, {
      status: "failed",
      error: "Run aborted by caller mid-iteration",
      now: new Date(),
      mode: "sse",
      runtimeMode: "flyio",
    });

    expect(finishRun).not.toHaveBeenCalled();
    expect(RUN_DEADLINE_ERROR_CODE).toBe("DEADLINE_EXCEEDED");
    expect(failureToTell(ended)).toEqual({
      code: RUN_DEADLINE_ERROR_CODE,
      message: RUN_DEADLINE_ERROR,
    });
    expect(
      finalEventFor(failure(run.runId, "ABORTED", "Run aborted by caller mid-iteration"), ended),
    ).toMatchObject({
      type: "run_error",
      error: { code: RUN_DEADLINE_ERROR_CODE, message: RUN_DEADLINE_ERROR },
    });
    expect(await db.getRun("deadline-b")).toMatchObject({ error: RUN_DEADLINE_ERROR });
  });

  it("a run whose final status is written, but which has not settled at its deadline — its final event waiting on a caller who stopped reading: nothing is written, its controller is aborted, and its stream closed after the grace", async () => {
    const run = await runInFlight("deadline-c");
    await finalizeRun(db, log, run.runId, run, {
      status: "completed",
      completion: {
        output: { answer: "ok" },
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        durationMs: 1,
        files: [],
      },
      modelForCostLookup: "claude-x",
      now: new Date(t0 + 1_000),
      mode: "sse",
      runtimeMode: "flyio",
    });
    const close = vi.fn();
    run.closeAtDeadline(close);
    const finishRun = vi.spyOn(db, "finishRun");

    await at(HOLD_MS + DEADLINE_STREAM_GRACE_MS);

    expect(finishRun).not.toHaveBeenCalled();
    expect(await db.getRun("deadline-c")).toMatchObject({ status: "completed", charged_ms: 1_000 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(run.controller.signal.reason).toBeInstanceOf(RunDeadlineReached);
    expect(run.reason).toBeUndefined();
    expect(deadlineLines()).toEqual([
      { event: "run_deadline_reached", run_id: "deadline-c", claim: "final", written: false },
    ]);
  });

  it("a run that settles before its deadline leaves no timer armed, and nothing happens at the deadline", async () => {
    const run = await runInFlight("deadline-d");
    const close = vi.fn();
    run.closeAtDeadline(close);
    expect(vi.getTimerCount()).toBe(1);

    run.settle();
    expect(vi.getTimerCount()).toBe(0);
    await at(HOLD_MS * 2);

    expect(await db.getRun("deadline-d")).toMatchObject({ status: "running" });
    expect(close).not.toHaveBeenCalled();
    expect(run.controller.signal.aborted).toBe(false);
    expect(deadlineLines()).toEqual([]);
    expect(inFlightRunIds()).toEqual([]);
  });

  it("a deadline further than the longest timer, 2^31 − 1 ms — which Node would arm for 1 ms —, is reached by a chain of two links: the run is stopped at it, and not before", async () => {
    const hold = MAX_TIMER_DELAY_MS + 600_000;
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const run = await runInFlight("deadline-e", hold);

    await at(1);
    await at(MAX_TIMER_DELAY_MS);
    await at(hold - 1);
    expect(await db.getRun("deadline-e")).toMatchObject({ status: "running" });
    expect(run.controller.signal.aborted).toBe(false);

    await at(hold);
    expect(await db.getRun("deadline-e")).toMatchObject({
      status: "failed",
      error: RUN_DEADLINE_ERROR,
      charged_ms: hold,
    });
    // The longest timer, then the rest — never a delay Node would cut to 1 ms,
    // which would wake the process every millisecond up to the second link —,
    // then the stream's grace.
    expect(timers.mock.calls.map(([, ms]) => ms)).toEqual([
      MAX_TIMER_DELAY_MS,
      600_000,
      DEADLINE_STREAM_GRACE_MS,
    ]);
  });

  it("a run the server's stop abandoned keeps the stop's failure at its deadline: nothing more is written", async () => {
    const run = await runInFlight("deadline-f");
    const stopping = shutdownInFlightRuns({ drainMs: 100, graceMs: HOLD_MS * 2 });
    await at(100);
    expect(await db.getRun("deadline-f")).toMatchObject({ error: SHUTDOWN_RUN_ERROR });
    const finishRun = vi.spyOn(db, "finishRun");

    await at(HOLD_MS);
    expect(finishRun).not.toHaveBeenCalled();
    expect(await db.getRun("deadline-f")).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      charged_ms: 0,
    });
    expect(deadlineLines()).toEqual([
      {
        event: "run_deadline_reached",
        run_id: "deadline-f",
        claim: "shutdown-provisional",
        written: false,
      },
    ]);
    run.settle();
    await stopping;
  });

  it("a stream handed over once the grace after the deadline has passed is closed at once", async () => {
    const run = await runInFlight("deadline-g");
    await at(HOLD_MS + DEADLINE_STREAM_GRACE_MS);
    const close = vi.fn();

    run.closeAtDeadline(close);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

// The signal handlers both entry points install, on a process and a server the
// case hands them: what a signal sets off, in order, and how the process exits.
// That a real signal reaches them is shutdown-signal.test.ts's.
describe("the stop's signal handlers", () => {
  /** A process: its signal listeners, and the exits asked of it. */
  function fakeProcess() {
    const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
    const exits: number[] = [];
    const proc: ShutdownProcess = {
      on(signal, listener) {
        listeners.set(signal, listener);
      },
      exit(code) {
        exits.push(code);
      },
    };
    return {
      proc,
      exits,
      send: (signal: NodeJS.Signals) => listeners.get(signal)?.(signal),
      listeners,
    };
  }

  /** A server: its close, called back when the case says (at once by default), and its idle connections dropped. */
  function fakeServer(closesAtOnce = true) {
    const order: string[] = [];
    let closed: (() => void) | undefined;
    const server = {
      close(callback?: (err?: Error) => void) {
        order.push("close");
        closed = () => callback?.();
        if (closesAtOnce) closed();
      },
      closeIdleConnections() {
        order.push("closeIdleConnections");
      },
    };
    return { server, order, finishClosing: () => closed?.() };
  }

  /** A logger whose lines the case reads, and whose flush it sees. */
  function flushingLogger() {
    const { lines, log } = logger();
    const flushes: number[] = [];
    (log as unknown as { flush: (cb: () => void) => void }).flush = (cb) => {
      flushes.push(lines.length);
      cb();
    };
    return { lines, log, flushes };
  }

  let registered: InFlightRun[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    registered = [];
  });

  afterEach(async () => {
    try {
      for (const run of registered) run.settle();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      // Last: it throws on a stop still under way, and skips nothing then.
      _resetShutdownForTests();
    }
  });

  async function runInFlight(db: MemoryDb, log: Logger, runId: string): Promise<InFlightRun> {
    await db.createRun({
      id: runId,
      agent_id: null,
      agent_version: "dev/agent@1.0.0",
      status: "running",
      input: {},
    });
    const run = registerInFlightRun({ runId, db, log, mode: "sse", runtimeMode: "local" });
    registered.push(run);
    return run;
  }

  it("listens for SIGTERM and SIGINT, and nothing else", () => {
    const { proc, listeners } = fakeProcess();
    installShutdownHandlers({ server: fakeServer().server, log: flushingLogger().log, proc });
    expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it.each([
    "SIGTERM",
    "SIGINT",
  ] as const)("on %s: no new connection first, the runs in flight stopped, a line saying what the stop did, the log flushed, then exit 0", async (signal) => {
    const db = new MemoryDb();
    const { lines, log, flushes } = flushingLogger();
    const run = await runInFlight(db, log, "run-s");
    const { proc, exits, send } = fakeProcess();
    const { server, order } = fakeServer();
    installShutdownHandlers({ server, log, proc });

    send(signal);
    // The server takes no new connection before anything else happens.
    expect(order).toEqual(["close"]);
    expect(run.controller.signal.aborted).toBe(true);
    expect(lines.find((line) => line.event === "server_stopping")).toEqual({
      event: "server_stopping",
      signal,
      in_flight: 1,
    });

    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS);
    expect(await db.getRun("run-s")).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(exits).toEqual([]);

    run.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.find((line) => line.event === "server_shutdown")).toEqual({
      event: "server_shutdown",
      signal,
      in_flight: 1,
      admitting: 0,
      abandoned: 1,
      finalized: 1,
      drained_ms: SHUTDOWN_DRAIN_MS,
      unsettled: 0,
      admissions_pending: 0,
      cleanups_pending: 0,
    });
    // Flushed once, after that line; then the exit.
    expect(flushes).toEqual([lines.length]);
    expect(exits).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handed the cloud runtime's pool, the stop stops its maintenance at the signal and destroys its ready machines, and its line says so", async () => {
    const { lines, log } = flushingLogger();
    const order: string[] = [];
    const pool = {
      stop: vi.fn(() => {
        order.push("maintenance stopped");
      }),
      destroyOwnReady: vi.fn(async (_signal?: AbortSignal) => {
        order.push("ready destroyed");
        return { destroyed: 2, failed: 1 };
      }),
    };
    const { proc, exits, send } = fakeProcess();
    const { server, order: closes } = fakeServer();
    installShutdownHandlers({ server, log, proc, pool });

    send("SIGTERM");
    expect(closes).toEqual(["close"]);
    expect(order).toEqual(["maintenance stopped"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["maintenance stopped", "ready destroyed"]);
    expect(pool.destroyOwnReady).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(lines.find((line) => line.event === "server_shutdown")).toMatchObject({
      pool_destroyed: 2,
      pool_destroy_failed: 1,
    });
    expect(exits).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second signal during the stop exits at once, 1", async () => {
    const db = new MemoryDb();
    const { lines, log } = flushingLogger();
    await runInFlight(db, log, "run-t");
    const { proc, exits, send } = fakeProcess();
    installShutdownHandlers({ server: fakeServer().server, log, proc });

    send("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toEqual([]);
    send("SIGINT");
    expect(exits).toEqual([1]);
    expect(lines.filter((line) => line.event === "server_shutdown_forced")).toEqual([
      { event: "server_shutdown_forced", signal: "SIGINT" },
    ]);
  });

  it("the last responses get what is left of the grace: the idle connections dropped, the server's close waited for, then exit 0", async () => {
    const { log } = flushingLogger();
    const { proc, exits, send } = fakeProcess();
    const { server, order, finishClosing } = fakeServer(false);
    installShutdownHandlers({ server, log, proc });

    send("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(["close", "closeIdleConnections"]);
    expect(exits).toEqual([]);

    finishClosing();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a server that never closes: the exit comes at the grace's end, 20 s after the signal", async () => {
    const { log } = flushingLogger();
    const { proc, exits, send } = fakeProcess();
    installShutdownHandlers({ server: fakeServer(false).server, log, proc });

    send("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --- Through the run route: what the route registers, and how its stream ends ---

const DEV_AUTH = { Authorization: "Bearer dev-token" };

async function pushLocalAgent(app: ReturnType<typeof createApp>, name: string): Promise<void> {
  const agentYaml = [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: google",
    "  name: gemini-2.5-flash",
    "inputs:",
    "  - name: q",
    "    type: string",
    "outputs:",
    "  - name: answer",
    "    type: string",
  ].join("\n");
  const bundle = await packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
  ]);
  const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
    method: "POST",
    headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bundle),
  });
  expect(res.status).toBe(200);
}

function startRun(
  app: ReturnType<typeof createApp>,
  mode: "sync" | "sse" | "webhook",
  name: string,
): Promise<Response> {
  const body: Record<string, unknown> = { input: { q: "hello" } };
  if (mode === "webhook") body.webhook_url = "https://hooks.example.com/x";
  return app.request(`/api/agents/dev/${name}/run`, {
    method: "POST",
    headers: {
      ...DEV_AUTH,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      ...(mode === "sse" && { Accept: "text/event-stream" }),
    },
    body: JSON.stringify(body),
  });
}

/** A stream's events, read one at a time; null once it has ended. */
function streamedEvents(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async (): Promise<{ event: string; data: Record<string, unknown> } | null> => {
    while (true) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [parsed] = parseSseEvents(block);
        if (parsed) return parsed as { event: string; data: Record<string, unknown> };
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** The timer the case's clock does not replace: what a wait in real time is made of. */
const realSetTimeout = globalThis.setTimeout;

/** Wait in real time — the case's clock untouched — until `done` holds, five seconds at most. */
async function untilReally(done: () => boolean): Promise<void> {
  const giveUpAt = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > giveUpAt) throw new Error("the condition did not hold within 5 s");
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
}

/**
 * A final write's three attempts, the store refusing each for anything but
 * its data: each attempt awaited in real time, the case's clock then moved on
 * by exactly the wait before the next — one second, then four more.
 */
async function throughTheSpacedAttempts(finishRun: MockInstance): Promise<void> {
  const [second, third] = FINAL_WRITE_RETRY_DELAYS_MS;
  await untilReally(() => finishRun.mock.calls.length >= 1);
  await vi.advanceTimersByTimeAsync(second);
  await untilReally(() => finishRun.mock.calls.length >= 2);
  await vi.advanceTimersByTimeAsync(third);
  await untilReally(() => finishRun.mock.calls.length >= 3);
}

describe("the server's stop, through the run route", () => {
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;

  beforeEach(async () => {
    routeLines.length = 0;
    heldOutputDirs.length = 0;
    deliverWebhook.mockClear();
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    await pushLocalAgent(app, "stops");
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    bundleCache.clear();
    // Last: it throws on a stop still under way, and skips nothing then.
    _resetShutdownForTests();
  });

  /** The adapter's run: run_start; once the signal it was handed is aborted, the abort's failure, as the cloud adapter's. */
  function stopsOnItsSignal(started?: () => void): void {
    scriptRun(async function* (request) {
      started?.();
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) resolve();
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield failure(request.runId, "ABORTED", ABANDONED);
    });
  }

  /** The adapter's run: run_start, then what `rest` yields — or throws. */
  function scriptRun(rest: (request: RunRequest) => AsyncGenerator<RunEvent>): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      yield* rest(request);
    });
  }

  /** Start a streamed run and read its run_start: the run is in flight. */
  async function inFlight() {
    const res = await startRun(app, "sse", "stops");
    expect(res.status).toBe(200);
    const next = streamedEvents(res);
    const start = await next();
    expect(start?.event).toBe("run_start");
    const runId = String(start?.data.run_id);
    expect(inFlightRunIds()).toEqual([runId]);
    return { next, runId };
  }

  it("a streamed run whose adapter stops on the stop's signal, as the cloud one does: its caller is told the stop's failure, its row says it, and it leaves the registry", async () => {
    stopsOnItsSignal();
    const { next, runId } = await inFlight();

    const stopping = shutdownInFlightRuns();
    expect(await next()).toMatchObject({
      event: "run_error",
      data: { error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR } },
    });
    expect(await next()).toBeNull();

    expect(await stopping).toMatchObject({ in_flight: 1, abandoned: 1, finalized: 0 });
    expect(await db.getRun(runId)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(inFlightRunIds()).toEqual([]);
  });

  it("a streamed run that ignores the stop and then completes: the provisional failure is replaced, and its caller gets the completion", async () => {
    const finish = gate();
    scriptRun(async function* (request) {
      await finish.opened;
      yield completion(request.runId);
    });
    const { next, runId } = await inFlight();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const stopping = shutdownInFlightRuns();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS);
    expect(await db.getRun(runId)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });

    finish.open();
    expect(await next()).toMatchObject({
      event: "run_complete",
      data: { output: { answer: "ok" } },
    });
    expect(await next()).toBeNull();
    expect(await stopping).toMatchObject({
      in_flight: 1,
      abandoned: 1,
      finalized: 1,
      unsettled: 0,
    });
    expect(await db.getRun(runId)).toMatchObject({ status: "completed", error: null });
    expect(inFlightRunIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a streamed run at the provisional failure whose stream then throws: the net under an unexpected end writes nothing", async () => {
    const broken = gate();
    scriptRun(async function* () {
      yield* [];
      await broken.opened;
      throw new Error("the adapter broke after the stop");
    });
    const { next, runId } = await inFlight();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const stopping = shutdownInFlightRuns();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS);
    const provisional = await db.getRun(runId);
    expect(provisional).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    const provisionalAt = provisional?.completed_at;
    const finishRun = vi.spyOn(db, "finishRun");

    broken.open();
    // The stream ends, with no final event of its own.
    expect(await next()).toBeNull();
    expect(await stopping).toMatchObject({ in_flight: 1, finalized: 1, unsettled: 0 });

    expect(finishRun).not.toHaveBeenCalled();
    expect(await db.getRun(runId)).toMatchObject({
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: provisionalAt,
    });
    // The net counted the provisional failure as taken: it did not even try.
    expect(routeLines.filter((line) => line.event === "run_finalize_skipped")).toEqual([]);
    expect(routeLines.filter((line) => line.event === "sse_stream_failed")).toHaveLength(1);
    expect(inFlightRunIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a webhook run whose adapter stops on the stop's signal: its delivery carries the stop's failure, as its row does", async () => {
    const started = gate();
    stopsOnItsSignal(started.open);
    const res = await startRun(app, "webhook", "stops");
    expect(res.status).toBe(202);
    const { run_id: runId } = (await res.json()) as { run_id: string };
    await started.opened;

    expect(await shutdownInFlightRuns()).toMatchObject({
      in_flight: 1,
      abandoned: 1,
      finalized: 0,
    });

    expect(deliverWebhook).toHaveBeenCalledOnce();
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({
      run_id: runId,
      status: "failed",
      error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
    });
    expect(await db.getRun(runId)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(inFlightRunIds()).toEqual([]);
  });

  it("a synchronous run whose adapter stops on the stop's signal is answered 503 SERVER_STOPPED, as its row says", async () => {
    const started = gate();
    stopsOnItsSignal(started.open);
    const response = startRun(app, "sync", "stops");
    await started.opened;

    const stopping = shutdownInFlightRuns();
    const res = await response;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
    });
    expect(await stopping).toMatchObject({
      in_flight: 1,
      abandoned: 1,
      finalized: 0,
      unsettled: 0,
    });
    const [run] = await db.listRuns();
    expect(run).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(inFlightRunIds()).toEqual([]);
  });

  it("a synchronous run whose execution throws once the stop abandoned it is answered 503 SERVER_STOPPED too", async () => {
    const started = gate();
    scriptRun(async function* (request) {
      started.open();
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) resolve();
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("the adapter broke as the server stopped");
    });
    const response = startRun(app, "sync", "stops");
    await started.opened;

    const stopping = shutdownInFlightRuns();
    const res = await response;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
    });
    await stopping;
    const [run] = await db.listRuns();
    expect(run).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
  });

  // The cloud adapter's acquisition, for real — its platform and its runner
  // played by fakes: the stop's signal reaches it through the run's, ends the
  // wait for the machine where it stands, and the run takes the stop's path.
  it("a streamed run whose machine is still being acquired when the stop comes ends on the stop's path, its machine destroyed", async () => {
    const sent: string[] = [];
    let probing: () => void = () => {};
    const probed = new Promise<void>((resolve) => {
      probing = resolve;
    });
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const method = init?.method ?? "GET";
        sent.push(`${method} ${new URL(String(input)).pathname}`);
        if (method === "POST") {
          return new Response(
            JSON.stringify({
              id: "m-acq",
              name: "skrun-run-x",
              state: "started",
              private_ip: "fdaa::5",
            }),
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      }) as typeof fetch,
      logger: logger().log,
    });
    // The runner never answers its probe, but gives up when its request's signal does.
    const runnerFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      probing();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const cloud = new FlyioAdapter(
      flyApi,
      {
        put: async () => {},
        getPresignedDownloadUrl: async () => "https://objects.invalid/get",
        getPresignedUploadUrl: async () => "https://objects.invalid/put",
      },
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl: runnerFetch, runtimeImage: "img" },
      logger().log,
    );
    executeStream.mockImplementation((request: RunRequest) =>
      cloud.executeStream({ ...request, bundleKey: "dev/stops/1.0.0.agent" }),
    );
    const { next, runId } = await inFlight();
    await probed;

    const stopping = shutdownInFlightRuns();
    expect(await next()).toMatchObject({
      event: "run_error",
      data: { error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR } },
    });
    expect(await next()).toBeNull();

    expect(await stopping).toMatchObject({ in_flight: 1, abandoned: 1, finalized: 0 });
    expect(await db.getRun(runId)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(sent).toEqual(["POST /v1/apps/app/machines", "DELETE /v1/apps/app/machines/m-acq"]);
    expect(inFlightRunIds()).toEqual([]);
  });

  // A run sent once the stop has begun is refused before anything of it is
  // written. Through a real connection kept alive across the signal:
  // in-flight-runs.server.test.ts.
  it("a run sent once the stop has begun is refused 503 SERVER_STOPPED before its body is even read, and its connection closed", async () => {
    await shutdownInFlightRuns();

    const res = await app.request("/api/agents/dev/stops/run", {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.json()).toEqual({
      error: { code: STOPPED_CODE, message: SERVER_STOPPING_REFUSAL },
    });
    expect(await db.listRuns()).toEqual([]);
    expect(executeStream).not.toHaveBeenCalled();
  });

  // Between the route's last look at the stop and the run's registration
  // there is only the write of its row — its admission, which the stop waits
  // for: a stop that begins then finds the run registered abandoned. It is not
  // started — no agent, on a runtime that does not listen to the stop either —
  // and it ends on the stop's path.
  describe("a run whose row is being written as the stop begins", () => {
    /** The row's write held until the case lets it go; whether the agent started. */
    function heldRowWrite() {
      const inWrite = gate();
      const release = gate();
      const admitRun = db.admitRun.bind(db);
      vi.spyOn(db, "admitRun").mockImplementation(async (admission) => {
        inWrite.open();
        await release.opened;
        return admitRun(admission);
      });
      const started = { value: false };
      scriptRun(async function* (request) {
        started.value = true;
        yield completion(request.runId);
      });
      return { inWrite, release, started };
    }

    it.each([
      "sync",
      "sse",
      "webhook",
    ] as const)("%s: it is never started, its row reads the stop's failure, and it is answered 503 SERVER_STOPPED", async (mode) => {
      const { inWrite, release, started } = heldRowWrite();
      const response = startRun(app, mode, "stops");
      await inWrite.opened;

      const stopping = shutdownInFlightRuns();
      release.open();
      const res = await response;
      // Read to its end, and the stop waited for, whatever the answer: nothing outlives the case.
      const body = await res.text();
      const summary = await stopping;

      expect(started.value).toBe(false);
      expect(executeStream).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(JSON.parse(body)).toEqual({
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      });
      expect(deliverWebhook).not.toHaveBeenCalled();
      const [row] = await db.listRuns();
      expect(row).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
      // In flight at the signal: none — its admission was under way, and the
      // stop waited for it, then for its run to settle, once answered.
      expect(summary).toMatchObject({ in_flight: 0, admitting: 1, unsettled: 0 });
      expect(inFlightRunIds()).toEqual([]);
      // Nothing of it is left on disk: its output directory, made before its row, is gone.
      expect(heldOutputDirs).toHaveLength(1);
      expect(existsSync(String(heldOutputDirs[0]))).toBe(false);
    });

    it("once the drain is over: never started either, its provisional failure is its row's, and it is answered 503 SERVER_STOPPED", async () => {
      const { inWrite, release, started } = heldRowWrite();
      const response = startRun(app, "sync", "stops");
      await inWrite.opened;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const stopping = shutdownInFlightRuns();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS);
      release.open();
      const res = await response;
      const body = await res.text();
      const summary = await stopping;

      expect(started.value).toBe(false);
      expect(res.status).toBe(503);
      expect(JSON.parse(body)).toEqual({
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      });
      const [row] = await db.listRuns();
      expect(row).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
      // Nothing was in flight at the signal, an admission was under way: the
      // stop waited past its drain for it, and the registry gave its run the
      // stop's provisional failure at once — the stop's write, counted.
      expect(summary).toMatchObject({ in_flight: 0, admitting: 1, finalized: 1, unsettled: 0 });
      expect(inFlightRunIds()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(heldOutputDirs).toHaveLength(1);
      expect(existsSync(String(heldOutputDirs[0]))).toBe(false);
      // Its row holds the stop's failure already: the route writes nothing more, nor says it skipped a write.
      expect(routeLines.filter((line) => line.event === "run_finalize_skipped")).toEqual([]);
    });

    // Nothing else in flight: without its wait for the admission, the stop
    // would return at once, the process exit, and the row, written after,
    // stay `running`.
    it("the stop waits for its admission: held half the grace, the stop has not returned; let go, its run is registered abandoned, its row failed with the stop's phrase and charged nothing, and the stop returns with nothing left", async () => {
      const { inWrite, release, started } = heldRowWrite();
      try {
        const response = startRun(app, "sync", "stops");
        await inWrite.opened;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        let returned = false;
        const stopping = shutdownInFlightRuns().then((summary) => {
          returned = true;
          return summary;
        });
        // Past the drain, half the grace: the admission is still held, and so is the stop.
        await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS / 2);
        expect(returned).toBe(false);
        expect(admissionCount()).toBe(1);
        expect(await db.listRuns()).toEqual([]);

        release.open();
        const res = await response;
        const body = await res.text();
        const summary = await stopping;

        expect(started.value).toBe(false);
        expect(res.status).toBe(503);
        expect(JSON.parse(body)).toEqual({
          error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
        });
        const [row] = await db.listRuns();
        expect(row).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR, charged_ms: 0 });
        expect(summary).toMatchObject({
          in_flight: 0,
          admitting: 1,
          abandoned: 0,
          finalized: 1,
          unsettled: 0,
          admissions_pending: 0,
          cleanups_pending: 0,
        });
        expect(admissionCount()).toBe(0);
        expect(inFlightRunIds()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        // A case that failed half-way lets its admission end: the next case starts with none.
        release.open();
      }
    });
  });

  // An admission that writes no row ends all the same: left counted, it would
  // hold every later stop for its whole grace.
  it.each([
    [
      "refused",
      503,
      async () => ({ admitted: false as const, reason: "busy" as const, usage: null }),
    ],
    [
      "whose write fails",
      500,
      async (): Promise<never> => {
        throw new Error("the database is unreachable");
      },
    ],
  ] as const)("an admission %s is no longer under way: a stop then has none to wait for", async (_label, status, admit) => {
    vi.spyOn(db, "admitRun").mockImplementation(admit);

    const res = await startRun(app, "sync", "stops");
    await res.text();

    expect(res.status).toBe(status);
    expect(await db.listRuns()).toEqual([]);
    expect(admissionCount()).toBe(0);
    expect(await shutdownInFlightRuns()).toMatchObject({
      in_flight: 0,
      admitting: 0,
      admissions_pending: 0,
    });
  });

  it("a run whose preparation the stop begins during is still refused before its row is written", async () => {
    // A run started here would end at once: what is read is whether it starts.
    scriptRun(async function* (request) {
      yield completion(request.runId);
    });
    // The body arrives in two parts: the route asks for the second once it is
    // past its first look at the stop, reading the body.
    const reading = gate();
    const rest = gate();
    let sentFirst = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentFirst) {
          sentFirst = true;
          controller.enqueue(new TextEncoder().encode('{"input":'));
          return;
        }
        reading.open();
        await rest.opened;
        controller.enqueue(new TextEncoder().encode('{"q":"hello"}}'));
        controller.close();
      },
    });
    const response = app.request("/api/agents/dev/stops/run", {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body,
      duplex: "half",
    } as RequestInit);
    await reading.opened;

    const stopping = shutdownInFlightRuns();
    rest.open();
    const res = await response;

    expect(await db.listRuns()).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: STOPPED_CODE, message: SERVER_STOPPING_REFUSAL },
    });
    expect(executeStream).not.toHaveBeenCalled();
    expect(await stopping).toMatchObject({ in_flight: 0, abandoned: 0, finalized: 0 });
    expect(inFlightRunIds()).toEqual([]);
    // Its output directory, made while it was prepared, is gone too.
    expect(heldOutputDirs).toHaveLength(1);
    expect(existsSync(String(heldOutputDirs[0]))).toBe(false);
  });

  it("a synchronous run that fails on its own, with no stop, is still answered with its failed result", async () => {
    scriptRun(async function* (request) {
      yield failure(request.runId, "EXECUTION_FAILED", "the model refused");
    });

    const res = await startRun(app, "sync", "stops");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "failed", error: "the model refused" });
  });

  // The database is slow, not down, as the server stops: the stop's final
  // write is still going when the stream's bound comes. The caller is told
  // the stop's failure all the same — the claim says so, whatever the write
  // does —, never the abandon its adapter ended on. The run has not settled
  // while its write goes on: the stop waits for it, to the end of its grace.
  it("a streamed run whose final write on the stop's path outlasts the stream's bound: its caller is told SERVER_STOPPED and the stop's phrase, at the bound; the stop waits for the write to its grace's end", async () => {
    const realFinishRun = db.finishRun.bind(db);
    const held = gate();
    const finishRun = vi.spyOn(db, "finishRun").mockImplementation(async (...args) => {
      await held.opened;
      return realFinishRun(...args);
    });
    stopsOnItsSignal();
    const { next, runId } = await inFlight();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const stopping = shutdownInFlightRuns();
    let event: Awaited<ReturnType<typeof next>> | undefined;
    const received = next().then((value) => {
      event = value;
    });
    await vi.advanceTimersByTimeAsync(FINAL_WRITE_WAIT_MS - 1);
    expect(event).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await received;

    expect(event).toMatchObject({
      event: "run_error",
      data: { error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR } },
    });
    expect(JSON.stringify(event)).not.toContain(ABANDONED);
    expect(routeLines.filter((line) => line.event === "final_write_slow")).toHaveLength(1);
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(await next()).toBeNull();

    // The stream has ended, the write has not: the run is still in flight, and
    // the stop waits for it until its grace is over.
    expect(inFlightRunIds()).toEqual([runId]);
    let summary: ShutdownSummary | undefined;
    void stopping.then((value) => {
      summary = value;
    });
    // The grace counts from the signal on the process's own clock, which this
    // case does not hold: a second short of it, the stop is still waiting.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - FINAL_WRITE_WAIT_MS - 1_000);
    expect(summary).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stopping).toMatchObject({ in_flight: 1, abandoned: 1, unsettled: 1 });
    expect((await db.getRun(runId))?.status).toBe("running");

    // The write lands at last: the run settles, and leaves the registry.
    held.open();
    await vi.waitFor(() => expect(inFlightRunIds()).toEqual([]));
    expect((await db.getRun(runId))?.status).toBe("failed");
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The database is down as the server stops: the row cannot be written and
  // stays running — its three attempts, spaced, all refused — but the caller
  // is still told the stop's failure, never the abandon its adapter ended on.
  // The case's clock drives the spacing and the stop's own timers.
  describe("a final write that fails on the stop's path", () => {
    let finishRun: MockInstance;

    beforeEach(() => {
      finishRun = vi.spyOn(db, "finishRun").mockRejectedValue(new Error("the database is down"));
    });

    it("a streamed run: its caller is told SERVER_STOPPED and the stop's phrase", async () => {
      stopsOnItsSignal();
      const { next, runId } = await inFlight();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const stopping = shutdownInFlightRuns();
      const final = next();
      await throughTheSpacedAttempts(finishRun);
      expect(await final).toMatchObject({
        event: "run_error",
        data: { error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR } },
      });
      await stopping;
      expect((await db.getRun(runId))?.status).toBe("running");
      expect(finishRun).toHaveBeenCalledTimes(3);
    });

    it("a webhook run: its delivery carries SERVER_STOPPED and the stop's phrase", async () => {
      const started = gate();
      stopsOnItsSignal(started.open);
      const res = await startRun(app, "webhook", "stops");
      const { run_id: runId } = (await res.json()) as { run_id: string };
      await started.opened;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const stopping = shutdownInFlightRuns();
      await throughTheSpacedAttempts(finishRun);
      await stopping;
      expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({
        status: "failed",
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      });
      expect((await db.getRun(runId))?.status).toBe("running");
      expect(finishRun).toHaveBeenCalledTimes(3);
    });

    it("a synchronous run: answered 503 SERVER_STOPPED", async () => {
      const started = gate();
      stopsOnItsSignal(started.open);
      const response = startRun(app, "sync", "stops");
      await started.opened;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const stopping = shutdownInFlightRuns();
      await throughTheSpacedAttempts(finishRun);
      const res = await response;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: STOPPED_CODE, message: SHUTDOWN_RUN_ERROR },
      });
      await stopping;
      const [run] = await db.listRuns();
      expect(run?.status).toBe("running");
      expect(finishRun).toHaveBeenCalledTimes(3);
    });
  });
});

// The deadline the admission writes, through the run route: a run still in
// flight at its seat's deadline is stopped there, in every mode. The case's
// clock drives the admission, the registry's timer and the run's own timeout;
// no case waits for real time.
describe("a run still in flight at its seat's deadline, through the run route", () => {
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;

  beforeEach(async () => {
    routeLines.length = 0;
    deliverWebhook.mockClear();
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    await pushLocalAgent(app, "deadline");
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    bundleCache.clear();
    _resetShutdownForTests();
  });

  function toolResult(runId: string, i: number): RunEvent {
    return {
      type: "tool_result",
      run_id: runId,
      timestamp: new Date().toISOString(),
      tool: "big",
      result: `result ${i} ${"x".repeat(1024)}`,
      is_error: false,
    };
  }

  /**
   * The adapter's run, as the cloud adapter's goes: run_start, then up to 50
   * tool results, each pull watching the run's signal — aborted, the abort's
   * failure —, its machine "destroyed" once its run is over.
   */
  function cloudShaped(): { yielded: () => number; destroyed: () => boolean } {
    let yielded = 0;
    let destroyed = false;
    executeStream.mockImplementation(async function* (request: RunRequest) {
      try {
        yield {
          type: "run_start",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          agent: request.agentConfig.name,
          agent_version: request.agent_version ?? "unknown",
        } satisfies RunEvent;
        for (let i = 0; i < 50; i++) {
          if (request.abortSignal?.aborted) throw new Error(ABANDONED);
          yielded++;
          yield toolResult(request.runId, i);
        }
        await new Promise<void>((resolve) => {
          if (request.abortSignal?.aborted) resolve();
          request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield failure(request.runId, "ABORTED", ABANDONED);
      } catch {
        yield failure(request.runId, "ABORTED", ABANDONED);
      } finally {
        destroyed = true;
      }
    });
    return { yielded: () => yielded, destroyed: () => destroyed };
  }

  /** The run's row once written, and its seat's deadline and admission, in ms. */
  async function admittedRow(): Promise<{ id: string; deadlineMs: number; createdMs: number }> {
    let row: Run | undefined;
    await vi.waitFor(async () => {
      [row] = await db.listRuns();
      expect(row).toBeDefined();
    });
    const written = row as Run;
    return {
      id: written.id,
      deadlineMs: Date.parse(String(written.deadline_at)),
      createdMs: Date.parse(written.created_at),
    };
  }

  async function until(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms - Date.now());
  }

  it("a streamed run whose caller stops reading after run_start: its route waits on a write until the deadline; its row is failed then, with the deadline's phrase, charged from its admission to its deadline; 10 s later its stream is closed and its adapter stopped — its machine destroyed", async () => {
    const adapter = cloudShaped();
    const res = await startRun(app, "sse", "deadline");
    expect(res.status).toBe(200);
    const next = streamedEvents(res);
    expect((await next())?.event).toBe("run_start");
    const { id, deadlineMs, createdMs } = await admittedRow();
    await vi.advanceTimersByTimeAsync(0);
    const waitedAt = adapter.yielded();

    // Nothing moves while the caller reads nothing: not its events, not its timers.
    await until(deadlineMs - 1);
    expect(adapter.yielded()).toBe(waitedAt);
    expect(waitedAt).toBeLessThan(50);
    expect(adapter.destroyed()).toBe(false);
    expect(await db.getRun(id)).toMatchObject({ status: "running" });

    await until(deadlineMs);
    await vi.waitFor(async () =>
      expect(await db.getRun(id)).toMatchObject({
        status: "failed",
        error: RUN_DEADLINE_ERROR,
        completed_at: new Date(deadlineMs).toISOString(),
        charged_ms: deadlineMs - createdMs,
      }),
    );
    // The aborted signal cannot reach an adapter held at an event the route has not taken.
    await until(deadlineMs + DEADLINE_STREAM_GRACE_MS - 1);
    expect(adapter.destroyed()).toBe(false);
    expect(adapter.yielded()).toBe(waitedAt);

    await until(deadlineMs + DEADLINE_STREAM_GRACE_MS);
    await vi.waitFor(() => expect(adapter.destroyed()).toBe(true));
    // The stream ends: what the stream held already, then nothing.
    const rest: string[] = [];
    for (let event = await next(); event !== null; event = await next()) rest.push(event.event);
    expect(rest.length).toBeLessThan(5);
    expect(rest.every((event) => event === "tool_result")).toBe(true);
    await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(id));
  });

  it("a streamed run whose caller still reads at its deadline — its adapter waiting on its loop: its caller is told the deadline's failure, under its code, as its final event, and its stream ends, the grace unused", async () => {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      yield toolResult(request.runId, 0);
      await new Promise<void>((resolve) => {
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield failure(request.runId, "ABORTED", ABANDONED);
    });
    const res = await startRun(app, "sse", "deadline");
    const next = streamedEvents(res);
    expect((await next())?.event).toBe("run_start");
    expect((await next())?.event).toBe("tool_result");
    const { id, deadlineMs } = await admittedRow();
    let told: unknown;
    void next().then((event) => {
      told = event;
    });

    await until(deadlineMs);
    await vi.waitFor(() =>
      expect(told).toMatchObject({
        event: "run_error",
        data: { error: { code: RUN_DEADLINE_ERROR_CODE, message: RUN_DEADLINE_ERROR } },
      }),
    );
    expect(await next()).toBeNull();
    await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(id));
    expect(Date.now()).toBeLessThan(deadlineMs + DEADLINE_STREAM_GRACE_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(await db.getRun(id)).toMatchObject({ status: "failed", error: RUN_DEADLINE_ERROR });
  });

  it("a streamed run on the local runtime, whose adapter does not listen to its signal, and whose caller stopped reading: its row reads the deadline's failure; its stream closed after the grace, the route reads on, and the run's own timeout ends it at once", async () => {
    let timedOut = false;
    executeStream.mockImplementation(async function* (request: RunRequest) {
      // As the local adapter goes: its timeout checked each time the loop is pulled, its signal never read.
      const startedAt = Date.now();
      const timeoutMs = 300_000;
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      try {
        for (let i = 0; i < 50; i++) {
          if (Date.now() - startedAt >= timeoutMs) throw new TimeoutError(timeoutMs);
          yield toolResult(request.runId, i);
        }
        yield completion(request.runId);
      } catch (err) {
        timedOut = err instanceof TimeoutError;
        yield failure(request.runId, "TIMEOUT", (err as Error).message);
      }
    });
    const res = await startRun(app, "sse", "deadline");
    const next = streamedEvents(res);
    expect((await next())?.event).toBe("run_start");
    const { id, deadlineMs } = await admittedRow();

    await until(deadlineMs - 1);
    expect(timedOut).toBe(false);
    expect(await db.getRun(id)).toMatchObject({ status: "running" });

    await until(deadlineMs);
    await vi.waitFor(async () =>
      expect(await db.getRun(id)).toMatchObject({ status: "failed", error: RUN_DEADLINE_ERROR }),
    );
    expect(timedOut).toBe(false);

    await until(deadlineMs + DEADLINE_STREAM_GRACE_MS);
    await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(id));
    expect(timedOut).toBe(true);
    for (let event = await next(); event !== null; event = await next()) {
      expect(event.event).toBe("tool_result");
    }
  });

  it("a synchronous run still going at its deadline is answered 504 DEADLINE_EXCEEDED, as its row says", async () => {
    const adapter = cloudShaped();
    let answered: Response | undefined;
    void startRun(app, "sync", "deadline").then((res) => {
      answered = res;
    });
    const { id, deadlineMs, createdMs } = await admittedRow();

    await until(deadlineMs - 1);
    expect(answered).toBeUndefined();
    await until(deadlineMs);
    await vi.waitFor(() => expect(answered?.status).toBe(504));
    const res = answered as Response;
    expect(await res.json()).toEqual({
      error: { code: RUN_DEADLINE_ERROR_CODE, message: RUN_DEADLINE_ERROR },
    });
    expect(adapter.destroyed()).toBe(true);
    expect(await db.getRun(id)).toMatchObject({
      status: "failed",
      error: RUN_DEADLINE_ERROR,
      charged_ms: deadlineMs - createdMs,
    });
  });

  it("a webhook run still going at its deadline is delivered as the deadline's failure, as its row says", async () => {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      await new Promise<void>((resolve) => {
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield failure(request.runId, "ABORTED", ABANDONED);
    });
    const res = await startRun(app, "webhook", "deadline");
    expect(res.status).toBe(202);
    const { id, deadlineMs } = await admittedRow();

    await until(deadlineMs);
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
      error: { code: RUN_DEADLINE_ERROR_CODE, message: RUN_DEADLINE_ERROR },
    });
    expect(await db.getRun(id)).toMatchObject({ status: "failed", error: RUN_DEADLINE_ERROR });
  });
});
