import { Socket } from "node:net";
import {
  RUN_OUTPUTS_PREFIX,
  runOutputKey,
  runOutputsArchiveKey,
  isSafeOutputName as runtimeIsSafeOutputName,
  outputNameRefusal as runtimeOutputNameRefusal,
} from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { FILE_CACHE_SWEEP_INTERVAL_MS } from "../cache/file-cache-sweep.js";
import type { DbAdapter } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import {
  type FakeRunScript,
  fakeFlyioDeps,
  parseSseEvents,
  pushRunnableAgent,
  runFlyio,
  settledRun,
} from "../routes/flyio-run-harness.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  isSafeOutputName,
  OUTPUT_PURGE_MAX_FAILED_RUNS,
  OUTPUT_PURGE_MAX_KEYS,
  OUTPUT_PURGE_MAX_ROWS,
  OUTPUT_PURGE_STALLED_AFTER_SKIPS,
  outputNameRefusal,
  purgeDueRunOutputs,
  runOutputDeletes,
  startRunOutputPurge,
} from "./output-purge.js";

// Every line the purge logs is an assertion target, and pino writes to fd 1
// directly, so the logger factory is replaced (same shape as index.test.ts). The
// cloud adapter is replaced too, for the end-to-end case — the route harness says
// why and how. vi.mock is hoisted above every import: what its factory reads is
// declared with vi.hoisted, and the harness is imported inside it, lazily.
const { log, script } = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  script: {
    next: { outcome: "error", code: "UNSCRIPTED", message: "no script set" } as FakeRunScript,
  },
}));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const { makeFakeFlyioAdapterClass } = await import("../routes/flyio-run-harness.shared.js");
  const logger = {
    ...log,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: "info",
    child: () => logger,
  };
  return {
    ...actual,
    FlyioAdapter: makeFakeFlyioAdapterClass(actual, script),
    createLogger: () => logger,
  };
});

const NOW = new Date("2026-09-25T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

/** The instant `seconds` away from `NOW`, in the form a deadline is stored in. */
function at(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

/** A run's file list: these names, one byte each. */
function named(...names: string[]): Array<Record<string, unknown>> {
  return names.map((name) => ({ name, size: 1 }));
}

/** `count` distinct plain file names. */
function fileNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `f-${i}.txt`);
}

/**
 * A completed cloud run with `files` and the deadline `purgeAfter`, and an
 * object in `storage` for each of its string names, at the key the runtime
 * defines. `archive` also puts an object at the run's archive key.
 */
async function seedRun(
  db: MemoryDb,
  storage: MemoryStorage,
  id: string,
  opts: { files: Array<Record<string, unknown>>; purgeAfter: string; archive?: boolean },
): Promise<void> {
  await db.createRun({ id, agent_id: null, agent_version: "1.0.0", status: "running" });
  await db.updateRun(id, {
    status: "completed",
    files: opts.files,
    completed_at: at(-3600),
    purge_after: opts.purgeAfter,
  });
  for (const file of opts.files) {
    if (typeof file.name === "string") {
      await storage.put(runOutputKey(id, file.name), Buffer.from("x"));
    }
  }
  if (opts.archive) await storage.put(runOutputsArchiveKey(id), Buffer.from("archive"));
}

/** The fields of every line logged at `level` for `event`, in order. */
function logged(level: "info" | "warn" | "error", event: string): Array<Record<string, unknown>> {
  return log[level].mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((fields) => fields.event === event);
}

/** Everything logged, as one string — to check what it never contains. */
function everythingLogged(): string {
  return JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
}

function clearLog(): void {
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
}

// The one definition of a run's output keys, shared by the purge and by an
// account deletion: every name the check accepts, then the archive.
describe("the keys a run's outputs are stored under", () => {
  it("rebuilds one key per accepted name, then the archive, and refuses the rest by position", () => {
    const planned = runOutputDeletes({ id: "r1", files: named("a.txt", "../x", "d/b.csv") });

    expect(planned.keys).toEqual([
      { key: runOutputKey("r1", "a.txt"), fileIndex: 0 },
      { key: runOutputKey("r1", "d/b.csv"), fileIndex: 2 },
      { key: runOutputsArchiveKey("r1"), fileIndex: null },
    ]);
    expect(planned.refusals).toEqual([{ fileIndex: 1, reason: "dot_segment" }]);
  });

  it("refuses with the runtime's rule: a name past 512 bytes, or with a control character, gets no delete either", () => {
    const planned = runOutputDeletes({
      id: "r3",
      files: named("a".repeat(513), "x\u0007y", "ok.txt"),
    });

    expect(planned.keys).toEqual([
      { key: runOutputKey("r3", "ok.txt"), fileIndex: 2 },
      { key: runOutputsArchiveKey("r3"), fileIndex: null },
    ]);
    expect(planned.refusals).toEqual([
      { fileIndex: 0, reason: "too_long" },
      { fileIndex: 1, reason: "control_char" },
    ]);
    // One definition: what the purge exports is the runtime's rule, not a copy.
    expect(outputNameRefusal).toBe(runtimeOutputNameRefusal);
    expect(isSafeOutputName).toBe(runtimeIsSafeOutputName);
  });

  it("a run with no file list still has its archive key", () => {
    expect(runOutputDeletes({ id: "r2", files: null }).keys).toEqual([
      { key: runOutputsArchiveKey("r2"), fileIndex: null },
    ]);
  });
});

describe("output purge — one pass", () => {
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    db = new MemoryDb();
    storage = new MemoryStorage();
    clearLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a due run loses its output files and its archive, then is marked; a run not yet due keeps everything", async () => {
    await seedRun(db, storage, "run-due", {
      files: named("a.txt", "d/b.csv"),
      purgeAfter: at(-60),
      archive: true,
    });
    await seedRun(db, storage, "run-later", {
      files: named("a.txt"),
      purgeAfter: at(60),
      archive: true,
    });

    const result = await purgeDueRunOutputs(db, storage, NOW);

    expect(await storage.exists(runOutputKey("run-due", "a.txt"))).toBe(false);
    expect(await storage.exists(runOutputKey("run-due", "d/b.csv"))).toBe(false);
    expect(await storage.exists(runOutputsArchiveKey("run-due"))).toBe(false);
    const purged = await db.getRun("run-due");
    expect(purged?.outputs_purged_at).toBe(NOW_ISO);
    // The names and sizes stay in the run's history.
    expect(purged?.files).toEqual(named("a.txt", "d/b.csv"));

    expect(await storage.exists(runOutputKey("run-later", "a.txt"))).toBe(true);
    expect(await storage.exists(runOutputsArchiveKey("run-later"))).toBe(true);
    expect((await db.getRun("run-later"))?.outputs_purged_at).toBeNull();

    expect(result).toEqual({ rows: 1, deleted: 3, refused: 0, failed: 0 });
    expect(logged("info", "run_outputs_purged")).toEqual([
      { event: "run_outputs_purged", run_id: "run-due", deleted: 3, refused: 0 },
    ]);
    expect(log.error).not.toHaveBeenCalled();
    expect(everythingLogged()).not.toContain("a.txt");
    expect(everythingLogged()).not.toContain(RUN_OUTPUTS_PREFIX);
  });

  it("a delete that fails leaves the run unmarked and says so; the next pass deletes and marks it", async () => {
    await seedRun(db, storage, "run-retry", {
      files: named("a.txt", "b.txt"),
      purgeAfter: at(-60),
    });
    // A storage error can quote the key it failed on — a local disk's does.
    const key = runOutputKey("run-retry", "a.txt");
    const failure = Object.assign(new Error(`EACCES: permission denied, unlink '${key}'`), {
      code: "EACCES",
    });
    vi.spyOn(storage, "delete").mockRejectedValueOnce(failure);

    const first = await purgeDueRunOutputs(db, storage, NOW);
    expect((await db.getRun("run-retry"))?.outputs_purged_at).toBeNull();
    expect(first.rows).toBe(0);
    expect(first.failed).toBe(1);
    expect(logged("error", "run_output_purge_failed")).toEqual([
      {
        event: "run_output_purge_failed",
        run_id: "run-retry",
        step: "delete",
        object: "output_file",
        file_index: 0,
        error_name: "Error",
        error_code: "EACCES",
      },
    ]);
    // Neither the name nor the key reaches the log, though the error carried both.
    expect(everythingLogged()).not.toContain("a.txt");
    expect(everythingLogged()).not.toContain(RUN_OUTPUTS_PREFIX);

    const second = await purgeDueRunOutputs(db, storage, NOW);
    expect(await storage.exists(runOutputKey("run-retry", "a.txt"))).toBe(false);
    expect(await storage.exists(runOutputKey("run-retry", "b.txt"))).toBe(false);
    expect((await db.getRun("run-retry"))?.outputs_purged_at).toBe(NOW_ISO);
    expect(second.rows).toBe(1);
    expect(second.failed).toBe(0);
  });

  it("a pass takes at most OUTPUT_PURGE_MAX_ROWS runs, oldest deadline first; the rest are the next pass's", async () => {
    const count = OUTPUT_PURGE_MAX_ROWS + 3;
    // Created newest deadline first, so the order a pass takes them in is its own.
    for (let i = count - 1; i >= 0; i--) {
      await seedRun(db, storage, `run-${i}`, { files: named("a.txt"), purgeAfter: at(i - count) });
    }

    const first = await purgeDueRunOutputs(db, storage, NOW);
    expect(first.rows).toBe(OUTPUT_PURGE_MAX_ROWS);
    const left = await db.listRunsDueForOutputPurge(NOW_ISO, count);
    expect(left.map((run) => run.id)).toEqual([
      `run-${count - 3}`,
      `run-${count - 2}`,
      `run-${count - 1}`,
    ]);

    const second = await purgeDueRunOutputs(db, storage, NOW);
    expect(second.rows).toBe(3);
    expect(await db.listRunsDueForOutputPurge(NOW_ISO, count)).toEqual([]);
  });

  it("a run whose deletes do not fit in what is left of the pass is not started — it heads the next pass", async () => {
    // Two such runs cannot both fit in one pass.
    const names = fileNames(Math.floor(OUTPUT_PURGE_MAX_KEYS * 0.6));
    await seedRun(db, storage, "run-big-1", { files: named(...names), purgeAfter: at(-2) });
    await seedRun(db, storage, "run-big-2", { files: named(...names), purgeAfter: at(-1) });
    const deleteSpy = vi.spyOn(storage, "delete");
    const secondRunKeys = new Set([
      ...names.map((name) => runOutputKey("run-big-2", name)),
      runOutputsArchiveKey("run-big-2"),
    ]);

    const first = await purgeDueRunOutputs(db, storage, NOW);
    expect((await db.getRun("run-big-1"))?.outputs_purged_at).toBe(NOW_ISO);
    expect((await db.getRun("run-big-2"))?.outputs_purged_at).toBeNull();
    // Not started at all: not one of its keys was a target.
    expect(deleteSpy.mock.calls.filter(([key]) => secondRunKeys.has(key))).toEqual([]);
    expect(first.rows).toBe(1);

    const second = await purgeDueRunOutputs(db, storage, NOW);
    expect((await db.getRun("run-big-2"))?.outputs_purged_at).toBe(NOW_ISO);
    expect(second.rows).toBe(1);
  });

  it("a pass stops after OUTPUT_PURGE_MAX_FAILED_RUNS failed runs, says so once, and leaves the runs after them for the next pass", async () => {
    const count = OUTPUT_PURGE_MAX_FAILED_RUNS + 2;
    for (let i = 0; i < count; i++) {
      await seedRun(db, storage, `run-${i}`, { files: named("a.txt"), purgeAfter: at(i - count) });
    }
    // A store that fails every call, with an error that quotes the key.
    const deleteSpy = vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      throw Object.assign(new Error(`no answer for ${key}`), { name: "TimeoutError" });
    });

    const result = await purgeDueRunOutputs(db, storage, NOW);

    expect(result.failed).toBe(OUTPUT_PURGE_MAX_FAILED_RUNS);
    expect(result.rows).toBe(0);
    // One attempt per failed run, oldest deadline first; the runs after them were not started.
    expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual(
      Array.from({ length: OUTPUT_PURGE_MAX_FAILED_RUNS }, (_, i) =>
        runOutputKey(`run-${i}`, "a.txt"),
      ),
    );
    expect(logged("error", "run_output_purge_failed")).toHaveLength(OUTPUT_PURGE_MAX_FAILED_RUNS);
    expect(logged("warn", "run_output_purge_pass_stopped")).toEqual([
      {
        event: "run_output_purge_pass_stopped",
        failed_runs: OUTPUT_PURGE_MAX_FAILED_RUNS,
        runs_left: 2,
      },
    ]);
    expect(everythingLogged()).not.toContain("a.txt");
    expect(everythingLogged()).not.toContain(RUN_OUTPUTS_PREFIX);
    // Nothing is marked: every run comes back at the next pass.
    expect(await db.listRunsDueForOutputPurge(NOW_ISO, count)).toHaveLength(count);
  });

  it("one run whose deletes keep failing does not hold back the others: the pass goes on past it", async () => {
    await seedRun(db, storage, "run-stuck", { files: named("a.txt"), purgeAfter: at(-3) });
    await seedRun(db, storage, "run-ok-1", { files: named("a.txt"), purgeAfter: at(-2) });
    await seedRun(db, storage, "run-ok-2", { files: named("a.txt"), purgeAfter: at(-1) });
    const stuckKey = runOutputKey("run-stuck", "a.txt");
    const deleteKey = storage.delete.bind(storage);
    vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      if (key === stuckKey) throw new Error("access denied");
      return deleteKey(key);
    });

    const first = await purgeDueRunOutputs(db, storage, NOW);
    expect(first).toMatchObject({ rows: 2, failed: 1 });
    expect((await db.getRun("run-ok-1"))?.outputs_purged_at).toBe(NOW_ISO);
    expect((await db.getRun("run-ok-2"))?.outputs_purged_at).toBe(NOW_ISO);
    expect((await db.getRun("run-stuck"))?.outputs_purged_at).toBeNull();

    // It heads every pass from now on, and still holds nothing back.
    const second = await purgeDueRunOutputs(db, storage, NOW);
    expect(second).toMatchObject({ rows: 0, failed: 1 });
    expect(logged("warn", "run_output_purge_pass_stopped")).toEqual([]);
  });

  it("the first run of a pass is finished even when it alone exceeds the key budget", async () => {
    await seedRun(db, storage, "run-huge", {
      files: named(...fileNames(OUTPUT_PURGE_MAX_KEYS + 5)),
      purgeAfter: at(-1),
    });
    await seedRun(db, storage, "run-small", { files: named("a.txt"), purgeAfter: at(0) });

    const result = await purgeDueRunOutputs(db, storage, NOW);
    expect((await db.getRun("run-huge"))?.outputs_purged_at).toBe(NOW_ISO);
    // The budget is spent: the next run waits for the next pass.
    expect((await db.getRun("run-small"))?.outputs_purged_at).toBeNull();
    expect(result.rows).toBe(1);
    expect(result.failed).toBe(0);
  });

  describe("names from a run's file list", () => {
    const REFUSED = ["../../ns/a/1.0.0.agent", "./x", "a//b", "\\x", "/abs"];

    /** A due run listing the refused names, one plain name, an empty name and no name. */
    async function seedNamesRun(): Promise<void> {
      await seedRun(db, storage, "run-names", {
        files: [...named(...REFUSED, "ok.txt"), { name: "", size: 1 }, { size: 1 }],
        purgeAfter: at(-60),
      });
    }

    it("a name that is not a plain relative path gets no delete, and one log line that gives its position and reason, never the name", async () => {
      await seedNamesRun();
      const deleteSpy = vi.spyOn(storage, "delete");

      const result = await purgeDueRunOutputs(db, storage, NOW);

      const refusedKeys = [...REFUSED, ""].map((name) => runOutputKey("run-names", name));
      const deleted = deleteSpy.mock.calls.map(([key]) => key);
      expect(deleted.filter((key) => refusedKeys.includes(key))).toEqual([]);
      const refusal = (reason: string, file_index: number) => ({
        event: "run_output_name_refused",
        run_id: "run-names",
        reason,
        file_index,
      });
      expect(logged("warn", "run_output_name_refused")).toEqual([
        refusal("dot_segment", 0),
        refusal("dot_segment", 1),
        refusal("empty_segment", 2),
        refusal("backslash", 3),
        refusal("absolute", 4),
        refusal("empty", 6),
        refusal("not_a_string", 7),
      ]);
      expect(result.refused).toBe(7);
      for (const name of [...REFUSED, "ok.txt"]) expect(everythingLogged()).not.toContain(name);
      expect(everythingLogged()).not.toContain(RUN_OUTPUTS_PREFIX);
    });

    it("the run's other names are purged, and the run is marked", async () => {
      await seedNamesRun();
      const deleteSpy = vi.spyOn(storage, "delete");

      await purgeDueRunOutputs(db, storage, NOW);

      expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([
        runOutputKey("run-names", "ok.txt"),
        runOutputsArchiveKey("run-names"),
      ]);
      expect((await db.getRun("run-names"))?.outputs_purged_at).toBe(NOW_ISO);
    });

    it("names that only look like a path step are ordinary names, and are purged", async () => {
      const names = [".hidden", "a..b", "..x", "x.", "dir/.env.out"];
      await seedRun(db, storage, "run-dots", { files: named(...names), purgeAfter: at(-60) });
      const deleteSpy = vi.spyOn(storage, "delete");

      await purgeDueRunOutputs(db, storage, NOW);

      expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([
        ...names.map((name) => runOutputKey("run-dots", name)),
        runOutputsArchiveKey("run-dots"),
      ]);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  it("two passes at once over the same run both succeed, and the run is marked", async () => {
    await seedRun(db, storage, "run-twice", {
      files: named("a.txt", "b.txt"),
      purgeAfter: at(-60),
      archive: true,
    });

    const [one, two] = await Promise.all([
      purgeDueRunOutputs(db, storage, NOW),
      purgeDueRunOutputs(db, storage, NOW),
    ]);

    expect(one.failed + two.failed).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
    expect((await db.getRun("run-twice"))?.outputs_purged_at).toBe(NOW_ISO);
  });
});

describe("output purge — at startup, then on an interval", () => {
  let db: MemoryDb;
  let storage: MemoryStorage;
  let timer: NodeJS.Timeout | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db = new MemoryDb();
    storage = new MemoryStorage();
    clearLog();
    timer = undefined;
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a run that fell due before startup is purged at startup, without waiting for the interval", async () => {
    await seedRun(db, storage, "run-due-at-boot", { files: named("a.txt"), purgeAfter: at(-60) });

    timer = startRunOutputPurge(db, storage);
    // The pass is asynchronous inside a synchronous start: advancing the clock
    // by nothing still drains it, so what follows reads after the delete.
    await vi.advanceTimersByTimeAsync(0);

    expect(await storage.exists(runOutputKey("run-due-at-boot", "a.txt"))).toBe(false);
    expect((await db.getRun("run-due-at-boot"))?.outputs_purged_at).toBe(NOW_ISO);
  });

  it("the next pass comes one fixed interval later — the file sweep's — and the environment is never read for it", async () => {
    const listSpy = vi.spyOn(db, "listRunsDueForOutputPurge");
    // Every environment read made while the purge starts is recorded.
    const env = process.env;
    const reads: string[] = [];
    process.env = new Proxy(env, {
      get(target, key, receiver) {
        if (typeof key === "string") reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      timer = startRunOutputPurge(db, storage);
    } finally {
      process.env = env;
    }
    expect(reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);

    // A run that falls due after startup is taken by the first tick, not before.
    await seedRun(db, storage, "run-due-later", { files: named("a.txt"), purgeAfter: at(60) });
    const passes = listSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS - 1);
    expect(listSpy.mock.calls.length).toBe(passes);
    expect((await db.getRun("run-due-later"))?.outputs_purged_at).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(listSpy.mock.calls.length).toBe(passes + 1);
    expect((await db.getRun("run-due-later"))?.outputs_purged_at).not.toBeNull();

    // Last, so a regression above is not hidden behind it: the timer never
    // keeps a process alive on its own.
    expect(timer?.hasRef()).toBe(false);
  });

  it("a tick that falls while a pass is still running is skipped, and says so — one pass at a time in a process", async () => {
    const listSpy = vi.spyOn(db, "listRunsDueForOutputPurge");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next pass, whichever it is, waits on the database until released.
    listSpy.mockImplementationOnce(async (now, limit) => {
      await held;
      return MemoryDb.prototype.listRunsDueForOutputPurge.call(db, now, limit);
    });

    timer = startRunOutputPurge(db, storage);
    await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledOnce();
    expect(logged("warn", "run_output_purge_pass_skipped")).not.toEqual([]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("a pass still running OUTPUT_PURGE_STALLED_AFTER_SKIPS ticks later is an error, once per stall; the other skipped ticks stay warnings", async () => {
    const listSpy = vi.spyOn(db, "listRunsDueForOutputPurge");
    const releases: Array<() => void> = [];
    // The next pass, whichever it is, hangs on the database until released —
    // as a query would with no statement timeout.
    const hangNextPass = () =>
      listSpy.mockImplementationOnce(async (now, limit) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return MemoryDb.prototype.listRunsDueForOutputPurge.call(db, now, limit);
      });
    const stalled = {
      event: "run_output_purge_pass_stalled",
      skipped_ticks: OUTPUT_PURGE_STALLED_AFTER_SKIPS,
    };

    hangNextPass();
    timer = startRunOutputPurge(db, storage);
    for (let tick = 0; tick < OUTPUT_PURGE_STALLED_AFTER_SKIPS + 2; tick++) {
      await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    }
    expect(listSpy).toHaveBeenCalledOnce();
    expect(logged("error", "run_output_purge_pass_stalled")).toEqual([stalled]);
    const warned = logged("warn", "run_output_purge_pass_skipped").map((f) => f.skipped_ticks);
    expect(warned.slice(0, OUTPUT_PURGE_STALLED_AFTER_SKIPS - 1)).toEqual(
      Array.from({ length: OUTPUT_PURGE_STALLED_AFTER_SKIPS - 1 }, (_, i) => i + 1),
    );
    expect(warned).not.toContain(OUTPUT_PURGE_STALLED_AFTER_SKIPS);

    // Released, the pass ends; a new one starts at the next tick, and the count starts over.
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    hangNextPass();
    for (let tick = 0; tick < OUTPUT_PURGE_STALLED_AFTER_SKIPS + 1; tick++) {
      await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    }
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(logged("error", "run_output_purge_pass_stalled")).toEqual([stalled, stalled]);
    releases[1]?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("a pass that fails is a log line with the error's class, not its message, and the next pass runs", async () => {
    const listSpy = vi.spyOn(db, "listRunsDueForOutputPurge");
    // A parse error can quote the text it choked on — here, a file name.
    listSpy.mockRejectedValueOnce(
      new SyntaxError('Unexpected token, "report.txt" is not valid JSON'),
    );

    timer = startRunOutputPurge(db, storage);
    await vi.advanceTimersByTimeAsync(0);
    expect(logged("error", "run_output_purge_pass_failed")).toEqual([
      { event: "run_output_purge_pass_failed", error_name: "SyntaxError" },
    ]);
    expect(everythingLogged()).not.toContain("report.txt");

    await vi.advanceTimersByTimeAsync(FILE_CACHE_SWEEP_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("without an object store — any runtime but the cloud one — nothing starts: no timer, and the database is never touched", () => {
    const untouchable = new Proxy(
      {},
      {
        get(_target, key) {
          throw new Error(`the purge touched the database (${String(key)})`);
        },
      },
    ) as DbAdapter;

    expect(startRunOutputPurge(untouchable, undefined)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("output purge — after a cloud run completed through the route", () => {
  const RETENTION_S = 60;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let deps: ReturnType<typeof fakeFlyioDeps>;
  let app: ReturnType<typeof createApp>;
  let fetchSpy: MockInstance<typeof fetch>;
  let connectSpy: MockInstance;

  beforeEach(() => {
    vi.stubEnv("FILES_RETENTION_S", String(RETENTION_S));
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access in a hermetic test"));
    connectSpy = vi.spyOn(Socket.prototype, "connect");
    clearLog();
    // One store for bundles and outputs, as in production: one bucket.
    storage = new MemoryStorage();
    db = new MemoryDb();
    deps = fakeFlyioDeps(storage);
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: deps });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("end to end — what a streamed cloud run left in the store is gone once its deadline has passed, and the run is marked", async () => {
    await pushRunnableAgent(app, db, "dev", "purge-end-to-end");
    script.next = {
      outcome: "complete",
      files: [
        { name: "report.txt", content: "hello" },
        { name: "data/table.csv", content: "a,b\n1,2\n" },
      ],
    };
    const res = await runFlyio(app, "dev", "purge-end-to-end", { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const runId = (events[0]?.data as { run_id: string }).run_id;
    const run = await settledRun(db, runId);
    expect(run.status).toBe("completed");
    const outputKeys = [runOutputKey(runId, "report.txt"), runOutputKey(runId, "data/table.csv")];
    for (const key of outputKeys) expect(await storage.exists(key)).toBe(true);
    const deadline = Date.parse(run.completed_at ?? "") + RETENTION_S * 1000;

    // A second before the deadline, nothing is due.
    const early = await purgeDueRunOutputs(db, deps.storage, new Date(deadline - 1000));
    expect(early.rows).toBe(0);
    for (const key of outputKeys) expect(await storage.exists(key)).toBe(true);

    // A second after it, the run's objects go — through the store the cloud runtime was given.
    const deleteSpy = vi.spyOn(storage, "delete");
    const due = new Date(deadline + 1000);
    const result = await purgeDueRunOutputs(db, deps.storage, due);
    for (const key of outputKeys) expect(await storage.exists(key)).toBe(false);
    expect((await db.getRun(runId))?.outputs_purged_at).toBe(due.toISOString());
    expect(result.rows).toBe(1);
    // Only this run's keys: the bundle in the same store was never a target.
    const runKeys = new Set([...outputKeys, runOutputsArchiveKey(runId)]);
    expect(deleteSpy.mock.calls.filter(([key]) => !runKeys.has(key))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
