import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LocalAdapter,
  type RunRequest,
  type RunResult,
  runOutputKey,
  runOutputsArchiveKey,
} from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOutputDir } from "../cache/output-cache.js";
import { MemoryDb } from "../db/memory.js";
import type { Run } from "../db/schema.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  DEV_TOKEN,
  type FakeRunScript,
  fakeFlyioDeps,
  pushRunnableAgent,
  type RunResponseMode,
  runFlyio,
  settledRun,
} from "./flyio-run-harness.shared.js";

// A run still going when its account is deleted. The deletion clears the run's
// row and marks it; the run then ends, and whatever path it ends by, its end is
// recorded without its content: no output, no error message, no files, no
// purge date — and the objects or the directory it produced are removed.

// The run route builds its model router once, when the app is built
// (`createApp`), from the process environment: no server key, so the caller's
// key is the one used.
vi.hoisted(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

// The cloud adapter is replaced by the harness's scripted one; the webhook's
// delivery sends nothing, and its call says the background run is over.
const { script, deliverWebhook } = vi.hoisted(() => ({
  script: {
    next: { outcome: "error", code: "UNSCRIPTED", message: "no script set" } as FakeRunScript,
  },
  deliverWebhook: vi.fn(async (_url: string, _payload: object) => {}),
}));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const { makeFakeFlyioAdapterClass } = await import("./flyio-run-harness.shared.js");
  return { ...actual, FlyioAdapter: makeFakeFlyioAdapterClass(actual, script) };
});

vi.mock("../utils/webhook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/webhook.js")>()),
  deliverWebhook,
}));

const NS = "dev";
const AUTH = { Authorization: `Bearer ${DEV_TOKEN}` };

/** A promise the test resolves when the run may end. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The one run of the store, once the route has recorded it. */
async function theRun(db: MemoryDb): Promise<Run> {
  await vi.waitFor(async () => expect(await db.listRuns()).toHaveLength(1));
  const [run] = await db.listRuns();
  if (!run) throw new Error("no run");
  return run;
}

type App = ReturnType<typeof createApp>;

/** The dev token's account deletes itself; the answer does not wait for the run. */
async function deleteTheAccount(app: App): Promise<void> {
  const res = await app.request("/api/account", {
    method: "DELETE",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: NS }),
  });
  expect(res.status).toBe(200);
}

/** What a run that ended after its account was deleted holds. */
function expectNoContent(run: Run, status: "completed" | "failed"): void {
  expect(run).toMatchObject({
    status,
    output: null,
    error: null,
    files: [],
    purge_after: null,
    user_id: null,
    agent_id: null,
  });
  expect(run.content_cleared_at).not.toBeNull();
  expect(run.completed_at).not.toBeNull();
}

/** Start a run in `mode`; return how to wait for its end, from the caller's side. */
async function startRun(
  app: App,
  name: string,
  mode: RunResponseMode,
): Promise<() => Promise<void>> {
  const res = runFlyio(app, NS, name, { mode });
  if (mode === "sync") {
    return async () => {
      await res;
    };
  }
  const response = await res;
  if (mode === "sse") {
    // Read as it comes, so that nothing the stream writes waits on a reader.
    const body = response.text();
    return async () => {
      await body;
    };
  }
  expect(response.status).toBe(202);
  return async () => {
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
  };
}

describe("a cloud run still going when its account is deleted", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: App;

  beforeEach(() => {
    deliverWebhook.mockClear();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const mode of ["sse", "webhook"] as const) {
    it(`${mode}: completes without its output, and the objects it wrote are deleted — never under a refused name`, async () => {
      const name = `cleared-${mode}-complete`;
      await pushRunnableAgent(app, db, NS, name);
      const held = gate();
      script.next = {
        outcome: "complete",
        files: [
          { name: "report.txt", content: "hello" },
          { name: "data/table.csv", content: "a,b\n1,2\n" },
          { name: "../escape.txt", content: "outside" },
        ],
        held: held.promise,
      };

      const ended = await startRun(app, name, mode);
      const { id: runId } = await theRun(db);
      // Nothing writes the archive today; one is put there to see it go.
      await storage.put(runOutputsArchiveKey(runId), Buffer.from("archive"));
      await deleteTheAccount(app);
      const deletes = vi.spyOn(storage, "delete");

      held.release();
      await ended();
      const run = await settledRun(db, runId);
      expectNoContent(run, "completed");
      // What is not content is written: the scripted duration.
      expect(run.duration_ms).toBe(1);

      await vi.waitFor(async () => {
        expect(await storage.exists(runOutputKey(runId, "report.txt"))).toBe(false);
        expect(await storage.exists(runOutputKey(runId, "data/table.csv"))).toBe(false);
        expect(await storage.exists(runOutputsArchiveKey(runId))).toBe(false);
      });
      const deletedKeys = deletes.mock.calls.map(([key]) => key);
      expect(deletedKeys.filter((key) => key.includes(".."))).toEqual([]);
    });

    it(`${mode}: fails without its error message`, async () => {
      const name = `cleared-${mode}-error`;
      await pushRunnableAgent(app, db, NS, name);
      const held = gate();
      script.next = {
        outcome: "error",
        code: "MACHINE_SPAWN_FAILED",
        message: "a late failure",
        held: held.promise,
      };

      const ended = await startRun(app, name, mode);
      const { id: runId } = await theRun(db);
      await deleteTheAccount(app);

      held.release();
      await ended();
      expectNoContent(await settledRun(db, runId), "failed");
    });
  }
});

describe("a local run still going when its account is deleted", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: App;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "local" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The local adapter, held until `held` resolves, then ending as `end` says. */
  function holdExecute(
    held: Promise<void>,
    end: (request: RunRequest) => RunResult,
  ): { outputDirs: string[] } {
    const outputDirs: string[] = [];
    vi.spyOn(LocalAdapter.prototype, "execute").mockImplementation(async (request) => {
      if (request.outputDir) outputDirs.push(request.outputDir);
      await held;
      return end(request);
    });
    return { outputDirs };
  }

  const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 };

  it("sync: completes without its output; its output directory is not kept, and is gone", async () => {
    await pushRunnableAgent(app, db, NS, "cleared-sync-complete");
    const held = gate();
    const { outputDirs } = holdExecute(held.promise, (request) => {
      writeFileSync(join(request.outputDir as string, "out.txt"), "hello");
      return {
        runId: request.runId,
        status: "completed",
        output: { answer: "ok" },
        usage: USAGE,
        durationMs: 7,
        files: [{ name: "out.txt", size: 5 }],
      };
    });

    const ended = await startRun(app, "cleared-sync-complete", "sync");
    const { id: runId } = await theRun(db);
    await deleteTheAccount(app);
    held.release();
    await ended();

    const run = await settledRun(db, runId);
    expectNoContent(run, "completed");
    expect(run.duration_ms).toBe(7);
    expect(getOutputDir(runId)).toBeUndefined();
    expect(outputDirs).toHaveLength(1);
    expect(existsSync(outputDirs[0] as string)).toBe(false);
  });

  it("sync: a result that failed is recorded without its error message; its output directory is not kept, and is gone", async () => {
    await pushRunnableAgent(app, db, NS, "cleared-sync-failed");
    const held = gate();
    const { outputDirs } = holdExecute(held.promise, (request) => {
      // A run can fail after writing a file: the directory is registered all the same.
      writeFileSync(join(request.outputDir as string, "partial.txt"), "half");
      return {
        runId: request.runId,
        status: "failed",
        output: {},
        usage: USAGE,
        durationMs: 3,
        files: [{ name: "partial.txt", size: 4 }],
        error: "a late failure",
      };
    });

    const ended = await startRun(app, "cleared-sync-failed", "sync");
    const { id: runId } = await theRun(db);
    await deleteTheAccount(app);
    held.release();
    await ended();
    expectNoContent(await settledRun(db, runId), "failed");
    expect(getOutputDir(runId)).toBeUndefined();
    expect(outputDirs).toHaveLength(1);
    expect(existsSync(outputDirs[0] as string)).toBe(false);
  });

  it("sync: an execution that throws is recorded without its error message", async () => {
    await pushRunnableAgent(app, db, NS, "cleared-sync-throws");
    const held = gate();
    holdExecute(held.promise, () => {
      throw new Error("a late failure");
    });

    const ended = await startRun(app, "cleared-sync-throws", "sync");
    const { id: runId } = await theRun(db);
    await deleteTheAccount(app);
    held.release();
    await ended();
    expectNoContent(await settledRun(db, runId), "failed");
  });
});
