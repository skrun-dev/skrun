import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileInfo, type Logger, runOutputKey, runOutputsArchiveKey } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearOutputCacheForTests,
  FILES_RETENTION_MAX_S,
  filesRetentionSeconds,
  getOutputDir,
  registerOutput,
} from "../cache/output-cache.js";
import { SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import type { RuntimeMode } from "../runtime/adapter-selection.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  FINAL_WRITE_RETRY_DELAYS_MS,
  type FinalizeRunInput,
  type FinalStatusClaim,
  failureToTell,
  finalizeRun,
  RUN_ERROR_KEPT_BYTES,
  RUN_ERROR_NOT_KEPT,
  RUN_INPUT_KEPT_BYTES,
  RUN_OUTPUT_KEPT_BYTES,
  type RunCompletionFields,
  SHUTDOWN_RUN_ERROR_CODE,
  type TruncatedRunContent,
  truncateRunContent,
} from "./_helpers.js";

const RETENTION_S = 60;
const RUN_ID = "run-1";

const TWO_FILES: FileInfo[] = [
  { name: "report.txt", size: 5, url: "https://objects.invalid/a" },
  { name: "data/table.csv", size: 8, url: "https://objects.invalid/b" },
];

/**
 * `toISOString()` output: fixed width, UTC. The only form a deadline may be
 * written in — the SQLite store selects due runs by comparing it as text.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fields(files: FileInfo[] | undefined): RunCompletionFields {
  return {
    output: { answer: "done" },
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    durationMs: 10,
    files,
  };
}

/** A completion, as a route hands it to finalizeRun. */
function completion(
  files: FileInfo[] | undefined,
  mode: "sse" | "webhook" | "sync",
  runtimeMode: RuntimeMode,
  outputStorage?: Pick<StorageAdapter, "delete">,
): FinalizeRunInput {
  return {
    status: "completed",
    completion: fields(files),
    modelForCostLookup: "claude-x",
    now: new Date(),
    mode,
    runtimeMode,
    outputStorage,
  };
}

/** A failure, as a route hands it to finalizeRun. */
function failure(error: string): FinalizeRunInput {
  return { status: "failed", error, now: new Date(), mode: "sse", runtimeMode: "local" };
}

function claim(): FinalStatusClaim {
  return { claim: "none" };
}

function logger() {
  const error = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  return { error, warn, info, log: { error, warn, info } as unknown as Logger };
}

async function runningRun(db: MemoryDb): Promise<void> {
  await db.createRun({
    id: RUN_ID,
    agent_id: null,
    agent_version: "dev/agent@1.0.0",
    status: "running",
    input: {},
  });
}

describe("finalizeRun — a completion's output purge deadline", () => {
  const { error: logError, log } = logger();

  beforeEach(() => {
    vi.stubEnv("FILES_RETENTION_S", String(RETENTION_S));
    logError.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Complete a fresh running run; return the one final write and the row after it. */
  async function complete(
    mode: "sse" | "webhook" | "sync",
    runtimeMode: RuntimeMode,
    files: FileInfo[] | undefined,
  ) {
    const db = new MemoryDb();
    await runningRun(db);
    const finishRun = vi.spyOn(db, "finishRun");
    await finalizeRun(db, log, RUN_ID, claim(), completion(files, mode, runtimeMode));
    expect(finishRun).toHaveBeenCalledTimes(1);
    const [id, patch] = finishRun.mock.calls[0] ?? [];
    expect(id).toBe(RUN_ID);
    expect(logError).not.toHaveBeenCalled();
    return { patch, run: await db.getRun(RUN_ID) };
  }

  for (const mode of ["sse", "webhook", "sync"] as const) {
    it(`${mode} — a cloud run with two files gets completed_at plus the window, in its one final write`, async () => {
      const { patch, run } = await complete(mode, "flyio", TWO_FILES);

      expect(patch).toMatchObject({
        status: "completed",
        files: [
          { name: "report.txt", size: 5 },
          { name: "data/table.csv", size: 8 },
        ],
      });
      expect(patch?.completed_at).toMatch(ISO_UTC);
      const completedAtMs = Date.parse(patch?.completed_at as string);
      expect(patch?.purge_after).toBe(new Date(completedAtMs + RETENTION_S * 1000).toISOString());
      expect(patch?.purge_after).toMatch(ISO_UTC);
      expect(run?.purge_after).toBe(patch?.purge_after);
    });
  }

  it("a local run with two files gets no deadline", async () => {
    const { patch, run } = await complete("sse", "local", TWO_FILES);
    expect(patch?.files).toHaveLength(2);
    expect(patch).not.toHaveProperty("purge_after");
    expect(run?.purge_after).toBeNull();
  });

  it("a cloud run with an empty file list gets no deadline", async () => {
    const { patch, run } = await complete("sse", "flyio", []);
    expect(patch?.files).toEqual([]);
    expect(patch).not.toHaveProperty("purge_after");
    expect(run?.purge_after).toBeNull();
  });

  it("a cloud run with no file list gets no deadline", async () => {
    const { patch, run } = await complete("sse", "flyio", undefined);
    expect(patch?.files).toBeNull();
    expect(patch).not.toHaveProperty("purge_after");
    expect(run?.purge_after).toBeNull();
  });

  // A "keep forever" value the local cache always accepted. Past year 9999 the
  // date string grows a sign and more digits — a store comparing deadlines as
  // text then finds it already due — and further out it is no date at all.
  for (const huge of ["252000000000", "99999999999999"]) {
    it(`a FILES_RETENTION_S of ${huge} is capped: the deadline stays a four-digit-year ISO date`, async () => {
      vi.stubEnv("FILES_RETENTION_S", huge);

      const { patch, run } = await complete("sse", "flyio", TWO_FILES);

      expect(patch?.purge_after).toMatch(ISO_UTC);
      const completedAtMs = Date.parse(patch?.completed_at as string);
      expect(patch?.purge_after).toBe(
        new Date(completedAtMs + FILES_RETENTION_MAX_S * 1000).toISOString(),
      );
      expect(run?.purge_after).toBe(patch?.purge_after);
      // The one definition caps it for its other reader too, the local cache.
      expect(filesRetentionSeconds()).toBe(FILES_RETENTION_MAX_S);
    });
  }

  it("the row records the instant it is handed, as completed_at", async () => {
    const db = new MemoryDb();
    await runningRun(db);
    const now = new Date("2026-05-06T07:08:09.123Z");

    await finalizeRun(db, log, RUN_ID, claim(), { ...failure("it broke"), now });

    expect(await db.getRun(RUN_ID)).toMatchObject({
      status: "failed",
      error: "it broke",
      completed_at: "2026-05-06T07:08:09.123Z",
    });
  });
});

describe("finalizeRun — a final write that fails", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The response still ships and the run keeps its row; each log line says
  // what failed by the error's class and code. Never by its message, which can
  // quote the row or the value a driver choked on. A lock that is not granted
  // is no refusal of the data: the same write is made again, on the case's clock.
  it("a write the database cannot take, three times: the same write each time, whole — one line each, with the class and code of the error, never its message — and no fourth", async () => {
    const witness = "witness-8b27d0";
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    const finishRun = vi
      .spyOn(db, "finishRun")
      .mockRejectedValue(
        Object.assign(new Error(`could not update run: "${witness}" is locked`), { code: "55P03" }),
      );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = finalizeRun(db, log, RUN_ID, claim(), completion(TWO_FILES, "sse", "flyio"));
    await vi.runAllTimersAsync();
    const result = await pending;

    const [first, ...again] = finishRun.mock.calls.map(([, patch]) => patch);
    expect(first).toMatchObject({ status: "completed", output: { answer: "done" } });
    expect(again).toEqual([first, first]);
    expect(logError.mock.calls.map(([line]) => line)).toEqual([
      { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: "55P03" },
      { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: "55P03" },
      { event: "run_final_write_failed", run_id: RUN_ID, error_name: "Error", error_code: "55P03" },
    ]);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(witness);
    // A write that failed is not a row found finished.
    expect(warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: true, written: false, status: null });
  });

  // A refusal of the data: the next write carries less, at once — down to the
  // last, which carries only what the server computes itself.
  it("a write refused for its data at every step: without its content, then with its status only — one line each, with the class and code of the error, never its message — and no fourth", async () => {
    const witness = "witness-3f91c4";
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    const finishRun = vi
      .spyOn(db, "finishRun")
      .mockRejectedValue(
        Object.assign(new Error(`invalid input: "${witness}"`), { code: "22P05" }),
      );

    const result = await finalizeRun(
      db,
      log,
      RUN_ID,
      claim(),
      completion(TWO_FILES, "sse", "flyio"),
    );

    expect(finishRun).toHaveBeenCalledTimes(3);
    expect(finishRun.mock.calls[0]?.[1]).toMatchObject({ output: { answer: "done" } });
    expect(finishRun.mock.calls[1]?.[1]).toMatchObject({ status: "completed", output: null });
    expect(finishRun.mock.calls[2]?.[1]).toEqual({
      status: "completed",
      completed_at: expect.stringMatching(ISO_UTC),
      error: null,
    });
    expect(logError.mock.calls.map(([line]) => line)).toEqual([
      { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: "22P05" },
      {
        event: "run_final_write_without_content_failed",
        run_id: RUN_ID,
        error_name: "Error",
        error_code: "22P05",
      },
      { event: "run_final_write_failed", run_id: RUN_ID, error_name: "Error", error_code: "22P05" },
    ]);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(witness);
    expect(warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: true, written: false, status: null });
  });

  // A store that refuses the first write for its data — whatever in it — still
  // records how and when the run ended, and what it is charged: a row left
  // running past its deadline would charge its account nothing.
  describe("a write refused once for its data is made again, at once, without its content", () => {
    const ADMITTED = new Date("2026-10-17T10:00:00.000Z");
    const ENDED = new Date("2026-10-17T10:00:42.500Z");

    /** The store refuses the first final write, then writes as it does. */
    function refusedOnce(db: MemoryDb) {
      const real = db.finishRun.bind(db);
      return vi
        .spyOn(db, "finishRun")
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });
        })
        .mockImplementation(real);
    }

    it("a failure: the row reads failed, its end and its charged time, with the phrase that says its error is not recorded; the caller is told the error whole", async () => {
      const { warn, log } = logger();
      const db = new MemoryDb();
      await runningRun(db);
      const finishRun = refusedOnce(db);

      const result = await finalizeRun(
        db,
        log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...failure("Tool failed: the whole story"), now: ENDED },
      );

      expect(finishRun).toHaveBeenCalledTimes(2);
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "failed",
        error: RUN_ERROR_NOT_KEPT,
        completed_at: ENDED.toISOString(),
        charged_ms: 42_500,
      });
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        { event: "run_final_write_without_content", run_id: RUN_ID, status: "failed" },
      ]);
      expect(result).toMatchObject({ written: true, status: "failed" });
      expect(failureToTell(result)).toEqual({ message: "Tool failed: the whole story" });
    });

    it("a completion: the row reads completed, its end, its charged time, its usage and its files, with no output", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      refusedOnce(db);

      const result = await finalizeRun(
        db,
        logger().log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...completion(TWO_FILES, "sync", "flyio"), now: ENDED },
      );

      const row = await db.getRun(RUN_ID);
      expect(row).toMatchObject({
        status: "completed",
        output: null,
        completed_at: ENDED.toISOString(),
        charged_ms: 42_500,
        usage_total_tokens: 3,
        files: [
          { name: "report.txt", size: 5 },
          { name: "data/table.csv", size: 8 },
        ],
      });
      expect(row?.purge_after).toMatch(ISO_UTC);
      expect(result).toMatchObject({ written: true, status: "completed" });
      expect(failureToTell(result)).toBeNull();
    });

    it("on the stop's path, the second write keeps the stop's phrase, which a completion may still replace", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      refusedOnce(db);
      const runClaim: FinalStatusClaim = { claim: "none" };

      await finalizeRun(db, logger().log, RUN_ID, runClaim, {
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        provisional: true,
        now: ENDED,
        mode: "sse",
        runtimeMode: "local",
      });
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
      });

      await finalizeRun(db, logger().log, RUN_ID, runClaim, completion([], "sse", "local"));
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "completed",
        output: { answer: "done" },
      });
    });

    it("a row finished meanwhile is not written again: the next write lands nowhere, and the row says how the run ended", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      const real = db.finishRun.bind(db);
      vi.spyOn(db, "finishRun")
        .mockImplementationOnce(async () => {
          // Another process finishes the row while this write fails.
          await real(RUN_ID, {
            status: "failed",
            error: "ended elsewhere",
            completed_at: "2026-10-17T10:00:01.000Z",
          });
          throw Object.assign(new Error("connection reset"), { code: "08006" });
        })
        .mockImplementation(real);
      // A connection lost is waited out: the same write comes again, on the case's clock.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = finalizeRun(db, logger().log, RUN_ID, claim(), failure("mine"));
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: "ended elsewhere" });
      expect(result).toMatchObject({ written: false, status: "failed", error: "ended elsewhere" });
    });
  });

  // The write without content carries the usage and the file list: a file
  // name the store cannot hold refuses it too. The last write carries only
  // what the server computes itself — the status, its end, the charged time,
  // an error in its own words —, which only the store itself refuses.
  describe("a write refused twice for its data is made a last time with only what the server computes", () => {
    const ADMITTED = new Date("2026-10-17T10:00:00.000Z");
    const ENDED = new Date("2026-10-17T10:00:42.500Z");

    /** The store refuses the first two final writes, then writes as it does. */
    function refusedTwice(db: MemoryDb) {
      const real = db.finishRun.bind(db);
      const refuse = async () => {
        throw Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });
      };
      return vi
        .spyOn(db, "finishRun")
        .mockImplementationOnce(refuse)
        .mockImplementationOnce(refuse)
        .mockImplementation(real);
    }

    it("a failure: the row reads failed, its end and its charged time, with the phrase that says its error is not recorded — and nothing else is written; the caller is told the error whole", async () => {
      const { warn, log } = logger();
      const db = new MemoryDb();
      await runningRun(db);
      const finishRun = refusedTwice(db);

      const result = await finalizeRun(
        db,
        log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...failure("Tool failed: the whole story"), now: ENDED },
      );

      expect(finishRun).toHaveBeenCalledTimes(3);
      expect(finishRun.mock.calls[2]?.[1]).toEqual({
        status: "failed",
        completed_at: ENDED.toISOString(),
        error: RUN_ERROR_NOT_KEPT,
        charged_ms: 42_500,
      });
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "failed",
        error: RUN_ERROR_NOT_KEPT,
        completed_at: ENDED.toISOString(),
        charged_ms: 42_500,
      });
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        { event: "run_final_write_status_only", run_id: RUN_ID, status: "failed" },
      ]);
      expect(result).toMatchObject({ written: true, status: "failed" });
      expect(failureToTell(result)).toEqual({ message: "Tool failed: the whole story" });
    });

    it("a completion: the row reads completed, its end and its charged time — no output, no usage, no file list, no purge deadline", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      const finishRun = refusedTwice(db);

      const result = await finalizeRun(
        db,
        logger().log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...completion(TWO_FILES, "sync", "flyio"), now: ENDED },
      );

      expect(finishRun.mock.calls[2]?.[1]).toEqual({
        status: "completed",
        completed_at: ENDED.toISOString(),
        error: null,
        charged_ms: 42_500,
      });
      const row = await db.getRun(RUN_ID);
      expect(row).toMatchObject({
        status: "completed",
        output: null,
        error: null,
        completed_at: ENDED.toISOString(),
        charged_ms: 42_500,
        usage_total_tokens: 0,
        purge_after: null,
      });
      expect(row?.files ?? []).toEqual([]);
      expect(result).toMatchObject({ written: true, status: "completed" });
      expect(failureToTell(result)).toBeNull();
    });

    it("on the stop's path, the last write keeps the stop's phrase, charged nothing — which a completion may still replace", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      const finishRun = refusedTwice(db);
      const runClaim: FinalStatusClaim = { claim: "none", admittedAt: ADMITTED };

      await finalizeRun(db, logger().log, RUN_ID, runClaim, {
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        provisional: true,
        now: ENDED,
        mode: "sse",
        runtimeMode: "local",
      });
      expect(finishRun.mock.calls[2]?.[1]).toEqual({
        status: "failed",
        completed_at: ENDED.toISOString(),
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });

      await finalizeRun(db, logger().log, RUN_ID, runClaim, completion([], "sse", "local"));
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "completed",
        output: { answer: "done" },
        error: null,
      });
    });

    it("a completion over the stop's provisional failure: the last write replaces it, its phrase cleared, asking the store to", async () => {
      const db = new MemoryDb();
      await runningRun(db);
      const runClaim: FinalStatusClaim = { claim: "none", admittedAt: ADMITTED };
      await finalizeRun(db, logger().log, RUN_ID, runClaim, {
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        provisional: true,
        now: ENDED,
        mode: "sse",
        runtimeMode: "local",
      });
      const finishRun = refusedTwice(db);

      const result = await finalizeRun(db, logger().log, RUN_ID, runClaim, {
        ...completion(TWO_FILES, "sse", "local"),
        now: ENDED,
      });

      expect(finishRun).toHaveBeenCalledTimes(3);
      expect(finishRun.mock.calls[2]?.slice(1)).toEqual([
        { status: "completed", completed_at: ENDED.toISOString(), error: null, charged_ms: 42_500 },
        { replaceShutdownProvisional: true },
      ]);
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "completed",
        error: null,
        charged_ms: 42_500,
      });
      expect(failureToTell(result)).toBeNull();
    });
  });

  // A run's usage comes from its model's provider, which can report what no
  // column holds: the row is written its numbers bounded, on the first write.
  it("the first write carries the run's numbers as the row keeps them — whole counts within an integer, a cost to the millionth within numeric(10,6)", async () => {
    const db = new MemoryDb();
    await runningRun(db);
    const finishRun = vi.spyOn(db, "finishRun");

    await finalizeRun(db, logger().log, RUN_ID, claim(), {
      ...completion([], "sync", "local"),
      completion: {
        ...fields([]),
        promptTokens: 2.5,
        completionTokens: 2 ** 31,
        totalTokens: -1,
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: 7,
        estimatedCost: 0.123_456_789,
        durationMs: Number.POSITIVE_INFINITY,
      },
    });

    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(finishRun.mock.calls[0]?.[1]).toMatchObject({
      usage_prompt_tokens: 3,
      usage_completion_tokens: 2_147_483_647,
      usage_total_tokens: 0,
      usage_cache_read_tokens: 0,
      usage_cache_write_tokens: 7,
      usage_estimated_cost: 0.123457,
      usage_cache_savings_usd: 0,
      duration_ms: null,
    });
  });

  it("a refused write whose row cannot be read back: one line, with the class and code of the read's error, never its message", async () => {
    const witness = "witness-4c1e9a";
    const { warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    // Finished elsewhere, then the read back fails.
    await db.finishRun(RUN_ID, {
      status: "failed",
      error: "ended elsewhere",
      completed_at: "2026-05-06T07:08:09.123Z",
    });
    vi.spyOn(db, "getRun").mockRejectedValue(
      Object.assign(new Error(`could not read run: "${witness}"`), { code: "08006" }),
    );

    const result = await finalizeRun(db, log, RUN_ID, claim(), completion([], "sync", "local"));

    const lines = warn.mock.calls.map(([line]) => line);
    expect(lines).toContainEqual({
      event: "run_final_read_failed",
      run_id: RUN_ID,
      error_name: "Error",
      error_code: "08006",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(witness);
    expect(result).toMatchObject({ claimed: true, written: false, status: null });
  });
});

describe("finalizeRun — once per run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a second call while the first still waits on its write returns at once, writes nothing, and says so", async () => {
    const { info, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    // The first call's write is held until the test lets it go.
    const realFinishRun = db.finishRun.bind(db);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishRun = vi.spyOn(db, "finishRun").mockImplementationOnce(async (...args) => {
      await held;
      return realFinishRun(...args);
    });
    const runClaim = claim();

    const first = finalizeRun(db, log, RUN_ID, runClaim, completion([], "sse", "local"));
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    const second = await finalizeRun(db, log, RUN_ID, runClaim, failure("a late failure"));

    expect(firstSettled).toBe(false);
    expect.soft(second).toEqual({
      claimed: false,
      written: false,
      status: null,
      error: null,
      stopped: false,
      cacheSavingsUsd: 0,
      contentCleared: false,
    });
    expect
      .soft(info.mock.calls.map(([line]) => line))
      .toEqual([{ event: "run_finalize_skipped", run_id: RUN_ID, status: "failed" }]);
    expect.soft(finishRun).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toMatchObject({ claimed: true, written: true, status: "completed" });
    expect((await db.getRun(RUN_ID))?.status).toBe("completed");
  });

  it("a row already finished, not by this process: nothing is written, and the call hands back the status the row holds", async () => {
    const { warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    // Finished elsewhere: written straight to the store, this process's claim untouched.
    await db.finishRun(RUN_ID, {
      status: "failed",
      error: "ended elsewhere",
      completed_at: "2026-05-06T07:08:09.123Z",
    });
    const before = await db.getRun(RUN_ID);

    const result = await finalizeRun(db, log, RUN_ID, claim(), completion([], "sync", "local"));

    // The row's word, its error included: the caller is told that failure.
    expect(result).toMatchObject({
      claimed: true,
      written: false,
      status: "failed",
      error: "ended elsewhere",
      stopped: false,
    });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      {
        event: "run_final_write_refused",
        run_id: RUN_ID,
        status: "completed",
        row_status: "failed",
      },
    ]);
    expect(await db.getRun(RUN_ID)).toEqual(before);
  });
});

// A database unavailable for a moment — a connection it closed, a failover —
// refuses writes made back to back: the same write is made again, whole, one
// second later, then four more — two waits at most for the run. A write the
// database refused for its data is not: the next one, carrying less, goes at
// once. The case's clock drives the waits; nothing here waits for real.
describe("finalizeRun — the final write's attempts, spaced", () => {
  const ADMITTED = new Date("2026-10-17T10:00:00.000Z");
  const ENDED = new Date("2026-10-17T10:00:42.500Z");
  const [SECOND_AFTER_MS, THIRD_AFTER_MS] = FINAL_WRITE_RETRY_DELAYS_MS;
  /** What a driver throws when the database refuses its connection: no SQLSTATE. */
  const unavailable = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  /** What Postgres answers a value its column does not hold: SQLSTATE class 22. */
  const refusedData = () =>
    Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The store refuses the first final writes with `refusals`, one per attempt,
   * then writes as it does; each attempt's instant is kept, on the case's clock.
   */
  function refusing(db: MemoryDb, refusals: Array<() => Error>) {
    const real = db.finishRun.bind(db);
    const startedAt = Date.now();
    const instants: number[] = [];
    const finishRun = vi.spyOn(db, "finishRun").mockImplementation(async (...args) => {
      instants.push(Date.now() - startedAt);
      const refusal = refusals[instants.length - 1];
      if (refusal) throw refusal();
      return real(...args);
    });
    return { finishRun, instants };
  }

  it("the delays: one second before the first write made again, four more before the second", () => {
    expect(FINAL_WRITE_RETRY_DELAYS_MS).toEqual([1_000, 4_000]);
  });

  it("a database unavailable for the first two attempts, which takes the third: the same write each time, one second then four more apart — the row records the run whole, its output and its files included", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, [unavailable, unavailable]);

    let done = false;
    const pending = finalizeRun(
      db,
      log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      { ...completion(TWO_FILES, "sync", "flyio"), now: ENDED },
    ).finally(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(instants).toEqual([0]);
    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS - 1);
    expect(instants).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(instants).toEqual([0, SECOND_AFTER_MS]);
    expect(done).toBe(false);
    expect((await db.getRun(RUN_ID))?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(THIRD_AFTER_MS - 1);
    expect(instants).toEqual([0, SECOND_AFTER_MS]);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(instants).toEqual([0, SECOND_AFTER_MS, SECOND_AFTER_MS + THIRD_AFTER_MS]);
    const [first, ...again] = finishRun.mock.calls.map(([, patch]) => patch);
    expect(again).toEqual([first, first]);
    const row = await db.getRun(RUN_ID);
    expect(row).toMatchObject({
      status: "completed",
      output: { answer: "done" },
      completed_at: ENDED.toISOString(),
      charged_ms: 42_500,
      usage_total_tokens: 3,
      files: [
        { name: "report.txt", size: 5 },
        { name: "data/table.csv", size: 8 },
      ],
    });
    expect(row?.purge_after).toMatch(ISO_UTC);
    expect(result).toMatchObject({ claimed: true, written: true, status: "completed" });
    expect(logError.mock.calls.map(([line]) => line)).toEqual([
      {
        event: "db_update_failed",
        run_id: RUN_ID,
        error_name: "Error",
        error_code: "ECONNREFUSED",
      },
      {
        event: "db_update_failed",
        run_id: RUN_ID,
        error_name: "Error",
        error_code: "ECONNREFUSED",
      },
    ]);
    // Neither the write without content nor the last one was made.
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refusal of the data is neither waited for nor made again as it was: the write without its content goes at once, then the last", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, [refusedData, refusedData]);

    let done = false;
    const pending = finalizeRun(
      db,
      logger().log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      { ...completion(TWO_FILES, "sync", "flyio"), now: ENDED },
    ).finally(() => {
      done = true;
    });

    // The clock not moved: the three attempts are made without a timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(instants).toEqual([0, 0, 0]);
    expect(done).toBe(true);
    const patches = finishRun.mock.calls.map(([, patch]) => patch);
    expect(patches[0]).toMatchObject({ output: { answer: "done" } });
    expect(patches[1]).toMatchObject({ output: null, files: [{ name: "report.txt" }, {}] });
    expect(patches[2]).toEqual({
      status: "completed",
      completed_at: ENDED.toISOString(),
      error: null,
      charged_ms: 42_500,
    });
    const result = await pending;
    expect(result).toMatchObject({ written: true, status: "completed" });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "completed", charged_ms: 42_500 });
    expect(vi.getTimerCount()).toBe(0);
  });

  // An error building the row's copy is thrown before the store: whatever its
  // class and code — here none —, the data caused it, and the same copy would
  // fail again. An output holding a BigInt, which JSON cannot write at all —
  // no output parsed from JSON does; the branch stays the data's all the same.
  // (An output that contains itself is deeper than any bound: the marker.)
  it("a row's copy that cannot be built is a refusal of the data: an output holding a BigInt — the write without its content goes at once, and the row records the run's end and its charged time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, []);
    const output: Record<string, unknown> = { answer: "done", count: 10n };
    // The case's premise: JSON cannot write it.
    expect(() => JSON.stringify(output)).toThrow(TypeError);

    let done = false;
    const pending = finalizeRun(
      db,
      log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      {
        status: "completed",
        completion: { ...fields(TWO_FILES), output },
        modelForCostLookup: "claude-x",
        now: ENDED,
        mode: "sync",
        runtimeMode: "flyio",
      },
    ).finally(() => {
      done = true;
    });

    // The clock not moved: nothing was waited for.
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    // The store reached once, by the write without its content.
    expect(instants).toEqual([0]);
    expect(finishRun.mock.calls[0]?.[1]).toMatchObject({ status: "completed", output: null });
    const result = await pending;
    expect(result).toMatchObject({ claimed: true, written: true, status: "completed" });
    expect(await db.getRun(RUN_ID)).toMatchObject({
      status: "completed",
      output: null,
      completed_at: ENDED.toISOString(),
      charged_ms: 42_500,
      usage_total_tokens: 3,
      files: [
        { name: "report.txt", size: 5 },
        { name: "data/table.csv", size: 8 },
      ],
    });
    expect(logError.mock.calls.map(([line]) => line)).toEqual([
      { event: "db_update_failed", run_id: RUN_ID, error_name: "TypeError" },
    ]);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      { event: "run_final_write_without_content", run_id: RUN_ID, status: "completed" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // An integrity constraint is the data's too: the row the write would leave
  // breaks one of the table's rules, and would again.
  for (const [code, constraint] of [
    ["23514", "a check"],
    ["23502", "a not-null"],
  ] as const) {
    it(`a refusal by ${constraint} constraint (SQLSTATE ${code}, class 23) is a refusal of the data: the write without its content goes at once, never waited for`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { error: logError, log } = logger();
      const db = new MemoryDb();
      await runningRun(db);
      const { finishRun, instants } = refusing(db, [
        () => Object.assign(new Error(`the row breaks ${constraint} constraint`), { code }),
      ]);

      let done = false;
      const pending = finalizeRun(
        db,
        log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...failure("Tool failed: the whole story"), now: ENDED },
      ).finally(() => {
        done = true;
      });

      // The clock not moved: the second attempt is made without a timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(instants).toEqual([0, 0]);
      expect(done).toBe(true);
      expect(finishRun.mock.calls[1]?.[1]).toEqual({
        status: "failed",
        error: RUN_ERROR_NOT_KEPT,
        completed_at: ENDED.toISOString(),
        charged_ms: 42_500,
      });
      expect(logError.mock.calls.map(([line]) => line)).toEqual([
        { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: code },
      ]);
      expect(await pending).toMatchObject({ claimed: true, written: true, status: "failed" });
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "failed",
        error: RUN_ERROR_NOT_KEPT,
        charged_ms: 42_500,
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  // The line's other side: what a database answers while it cannot take a
  // write, under a code of its own, is an outage — not the data's. A primary
  // demoted during a failover refuses writes for a few seconds, the case the
  // spaced attempts are for: read as the data's, the three writes would go at
  // once, each carrying less, each refused, and the row would stay running.
  for (const [code, what] of [
    ["25006", "a read-only transaction, as a primary demoted during a failover answers"],
    ["40001", "a serialization failure"],
    ["57P01", "a connection an administrator shut down"],
  ] as const) {
    it(`${what} (SQLSTATE ${code}) is an outage: the same write, whole, made again a second later — never the write without its content`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { error: logError, warn, log } = logger();
      const db = new MemoryDb();
      await runningRun(db);
      const { finishRun, instants } = refusing(db, [
        () => Object.assign(new Error(`the write was refused: ${what}`), { code }),
      ]);

      let done = false;
      const pending = finalizeRun(
        db,
        log,
        RUN_ID,
        { claim: "none", admittedAt: ADMITTED },
        { ...completion(TWO_FILES, "sync", "flyio"), now: ENDED },
      ).finally(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(instants).toEqual([0]);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS - 1);
      expect(instants).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ claimed: true, written: true, status: "completed" });

      expect(instants).toEqual([0, SECOND_AFTER_MS]);
      const [first, again] = finishRun.mock.calls.map(([, patch]) => patch);
      expect(first).toMatchObject({ output: { answer: "done" } });
      expect(again).toEqual(first);
      expect(logError.mock.calls.map(([line]) => line)).toEqual([
        { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: code },
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(await db.getRun(RUN_ID)).toMatchObject({
        status: "completed",
        output: { answer: "done" },
        charged_ms: 42_500,
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("an outage, then a refusal of the data: the same write a second later, then — at once — the write without its content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, [unavailable, refusedData]);

    const pending = finalizeRun(
      db,
      logger().log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      { ...completion([], "sse", "local"), now: ENDED },
    );
    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS);
    expect(instants).toEqual([0, SECOND_AFTER_MS, SECOND_AFTER_MS]);
    const result = await pending;

    const [first, second, third] = finishRun.mock.calls.map(([, patch]) => patch);
    expect(first).toMatchObject({ output: { answer: "done" } });
    expect(second).toEqual(first);
    expect(third).toMatchObject({ status: "completed", output: null });
    expect(result).toMatchObject({ written: true, status: "completed" });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "completed", output: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("two refusals of the data, then an outage: the last write made again, the same, a second later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, [refusedData, refusedData, unavailable]);

    const pending = finalizeRun(
      db,
      log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      { ...failure("Tool failed: the whole story"), now: ENDED },
    );
    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS);
    const result = await pending;

    expect(instants).toEqual([0, 0, 0, SECOND_AFTER_MS]);
    const patches = finishRun.mock.calls.map(([, patch]) => patch);
    expect(patches[3]).toEqual(patches[2]);
    expect(patches[3]).toEqual({
      status: "failed",
      completed_at: ENDED.toISOString(),
      error: RUN_ERROR_NOT_KEPT,
      charged_ms: 42_500,
    });
    expect(logError.mock.calls.map(([line]) => line)).toEqual([
      { event: "db_update_failed", run_id: RUN_ID, error_name: "Error", error_code: "22P05" },
      {
        event: "run_final_write_without_content_failed",
        run_id: RUN_ID,
        error_name: "Error",
        error_code: "22P05",
      },
      {
        event: "run_final_write_status_only_failed",
        run_id: RUN_ID,
        error_name: "Error",
        error_code: "ECONNREFUSED",
      },
    ]);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      { event: "run_final_write_status_only", run_id: RUN_ID, status: "failed" },
    ]);
    expect(result).toMatchObject({ written: true, status: "failed" });
    expect(failureToTell(result)).toEqual({ message: "Tool failed: the whole story" });
  });

  // The waits are the run's, not each write's: two at most, five seconds in
  // all — and two steps down at most. Five attempts, the most a run makes.
  it("the bound: two waits for the run, whichever write they follow, and two steps down — five attempts at most, five seconds of waits, then none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { error: logError, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun, instants } = refusing(db, [
      unavailable,
      unavailable,
      refusedData,
      refusedData,
      unavailable,
      unavailable,
    ]);

    let done = false;
    const pending = finalizeRun(
      db,
      log,
      RUN_ID,
      { claim: "none", admittedAt: ADMITTED },
      { ...completion([], "sse", "local"), now: ENDED },
    ).finally(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS + THIRD_AFTER_MS);
    expect(done).toBe(true);
    const result = await pending;
    // Nothing armed afterwards, however long the clock runs.
    await vi.advanceTimersByTimeAsync(60_000);

    const total = SECOND_AFTER_MS + THIRD_AFTER_MS;
    expect(instants).toEqual([0, SECOND_AFTER_MS, total, total, total]);
    const patches = finishRun.mock.calls.map(([, patch]) => patch);
    expect(patches.slice(1, 3)).toEqual([patches[0], patches[0]]);
    expect(patches[3]).toMatchObject({ output: null });
    expect(patches[4]).toEqual({
      status: "completed",
      completed_at: ENDED.toISOString(),
      error: null,
      charged_ms: 42_500,
    });
    expect(logError.mock.calls.map(([line]) => (line as { event: string }).event)).toEqual([
      "db_update_failed",
      "db_update_failed",
      "db_update_failed",
      "run_final_write_without_content_failed",
      "run_final_write_failed",
    ]);
    expect(result).toMatchObject({ claimed: true, written: false, status: null });
    expect((await db.getRun(RUN_ID))?.status).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the claim is taken before any wait: a second call while the first waits to try again writes nothing, at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { info, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun } = refusing(db, [unavailable]);
    const runClaim: FinalStatusClaim = { claim: "none", admittedAt: ADMITTED };

    const first = finalizeRun(db, log, RUN_ID, runClaim, { ...failure("mine"), now: ENDED });
    await vi.advanceTimersByTimeAsync(0);
    expect(finishRun).toHaveBeenCalledTimes(1);

    const second = await finalizeRun(db, log, RUN_ID, runClaim, failure("a late failure"));
    expect(second).toMatchObject({ claimed: false, written: false });
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      { event: "run_finalize_skipped", run_id: RUN_ID, status: "failed" },
    ]);
    expect(finishRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS);
    expect(await first).toMatchObject({ claimed: true, written: true, status: "failed" });
    // The same write, made again: the row keeps the run's own error.
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: "mine" });
  });

  it("a completion while the stop's provisional failure waits to try again replaces it; the provisional's next attempt then finds the row finished, and writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const db = new MemoryDb();
    await runningRun(db);
    const { finishRun } = refusing(db, [unavailable]);
    const runClaim: FinalStatusClaim = { claim: "none", admittedAt: ADMITTED };

    const stops = finalizeRun(db, logger().log, RUN_ID, runClaim, {
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      provisional: true,
      now: ENDED,
      mode: "sse",
      runtimeMode: "local",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runClaim.claim).toBe("shutdown-provisional");

    const completes = await finalizeRun(db, logger().log, RUN_ID, runClaim, {
      ...completion([], "sse", "local"),
      now: ENDED,
    });
    expect(completes).toMatchObject({ written: true, status: "completed" });
    expect(finishRun.mock.calls[1]?.[2]).toEqual({ replaceShutdownProvisional: true });

    await vi.advanceTimersByTimeAsync(SECOND_AFTER_MS);
    expect(await stops).toMatchObject({ written: false, status: "completed", stopped: false });
    expect(finishRun).toHaveBeenCalledTimes(3);
    expect(await db.getRun(RUN_ID)).toMatchObject({
      status: "completed",
      output: { answer: "done" },
      error: null,
    });
  });
});

// The claim has three states: none, the server stop's provisional failure, final.
describe("finalizeRun — the server stop's provisional failure, and its rule", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The stop's fallback, as the registry of runs in flight writes it. */
  function provisional(): FinalizeRunInput {
    return { ...failure(SHUTDOWN_RUN_ERROR), provisional: true };
  }

  it("the stop's fallback writes its phrase and leaves the claim provisional", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };

    const result = await finalizeRun(db, log, RUN_ID, runClaim, provisional());

    expect(runClaim.claim).toBe("shutdown-provisional");
    expect(result).toMatchObject({
      claimed: true,
      written: true,
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      stopped: true,
    });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
  });

  it("a completion over it replaces it, asking the store to, once", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };
    await finalizeRun(db, log, RUN_ID, runClaim, provisional());
    const finishRun = vi.spyOn(db, "finishRun");

    const result = await finalizeRun(db, log, RUN_ID, runClaim, completion([], "sse", "local"));

    expect(runClaim.claim).toBe("final");
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(finishRun.mock.calls[0]?.[2]).toEqual({ replaceShutdownProvisional: true });
    expect(result).toMatchObject({
      claimed: true,
      written: true,
      status: "completed",
      error: null,
    });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "completed", error: null });
  });

  it("a failure over it writes nothing, returns at once — the provisional write still going —, and hands back the stop's failure", async () => {
    const { info, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    // The provisional failure's write is held until the test lets it go.
    const realFinishRun = db.finishRun.bind(db);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishRun = vi.spyOn(db, "finishRun").mockImplementationOnce(async (...args) => {
      await held;
      return realFinishRun(...args);
    });
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };

    const first = finalizeRun(db, log, RUN_ID, runClaim, provisional());
    let secondSettled = false;
    const second = finalizeRun(db, log, RUN_ID, runClaim, failure("the model refused")).then(
      (result) => {
        secondSettled = true;
        return result;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A call of no effect returns at once: it waits on no write, not even the stop's.
    expect(secondSettled).toBe(true);
    expect((await db.getRun(RUN_ID))?.status).toBe("running");

    release();
    expect(await second).toEqual({
      claimed: false,
      written: false,
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      stopped: true,
      cacheSavingsUsd: 0,
      contentCleared: false,
    });
    await first;
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      { event: "run_finalize_skipped", run_id: RUN_ID, status: "failed" },
    ]);
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect(runClaim.claim).toBe("shutdown-provisional");
  });

  it("once the stop abandoned a run, a failure of its own is written as the stop's, for good", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };

    const result = await finalizeRun(
      db,
      log,
      RUN_ID,
      runClaim,
      failure("Run aborted by caller mid-iteration"),
    );

    expect(runClaim.claim).toBe("final");
    expect(result).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR, stopped: true });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR });
  });

  it("a caller is told the stop's failure under its own code, SERVER_STOPPED", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };

    const result = await finalizeRun(db, log, RUN_ID, runClaim, failure("the model refused"));

    expect(SHUTDOWN_RUN_ERROR_CODE).toBe("SERVER_STOPPED");
    expect(failureToTell(result)).toEqual({ code: "SERVER_STOPPED", message: SHUTDOWN_RUN_ERROR });
  });

  it("on the stop's path, a final write that fails still tells the caller the stop's failure", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    vi.spyOn(db, "finishRun").mockRejectedValue(new Error("the database is down"));
    const runClaim: FinalStatusClaim = { claim: "none", reason: "shutdown" };
    // Its three attempts, spaced, on the case's clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = finalizeRun(
      db,
      log,
      RUN_ID,
      runClaim,
      failure("Run aborted by caller mid-iteration"),
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    // The row could not be written: it is still running.
    expect(result).toMatchObject({ claimed: true, written: false, status: null, stopped: true });
    expect(failureToTell(result)).toEqual({ code: "SERVER_STOPPED", message: SHUTDOWN_RUN_ERROR });
    expect((await db.getRun(RUN_ID))?.status).toBe("running");
  });

  it("off the stop's path, a final write that fails tells the caller nothing of its own", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    vi.spyOn(db, "finishRun").mockRejectedValue(new Error("the database is down"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = finalizeRun(db, log, RUN_ID, claim(), failure("the model refused"));
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ written: false, status: null, stopped: false, error: null });
    expect(failureToTell(result)).toBeNull();
  });

  it("a failure of a run the stop never abandoned keeps its own error", async () => {
    const { log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const runClaim = claim();

    const result = await finalizeRun(db, log, RUN_ID, runClaim, failure("the model refused"));

    expect(result).toMatchObject({ status: "failed", error: "the model refused", stopped: false });
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: "the model refused" });
  });
});

describe("finalizeRun — a run whose account was deleted while it ran", () => {
  const CLEARED_AT = "2026-03-04T05:06:07.890Z";
  const { error: logError, log } = logger();

  beforeEach(() => {
    logError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearOutputCacheForTests();
  });

  /** A running run; marked as an account deletion marks it when `cleared`. */
  async function clearedRun(cleared: boolean): Promise<MemoryDb> {
    const db = new MemoryDb();
    const run = await db.createRun({
      id: RUN_ID,
      agent_id: null,
      agent_version: "@1.0.0",
      status: "running",
      input: {},
    });
    // The in-memory store hands back the row it keeps.
    if (cleared) run.content_cleared_at = CLEARED_AT;
    return db;
  }

  const WITH_REFUSED_NAME: FileInfo[] = [...TWO_FILES, { name: "../x", size: 1 }];

  it("on the cloud runtime, deletes the objects it would have recorded, never under a refused name, and says so", async () => {
    const db = await clearedRun(true);
    const outputs = new MemoryStorage();
    const deletes = vi.spyOn(outputs, "delete");

    const result = await finalizeRun(
      db,
      log,
      RUN_ID,
      claim(),
      completion(WITH_REFUSED_NAME, "sse", "flyio", outputs),
    );

    expect(result.contentCleared).toBe(true);
    expect(deletes.mock.calls.map(([key]) => key)).toEqual([
      runOutputKey(RUN_ID, "report.txt"),
      runOutputKey(RUN_ID, "data/table.csv"),
      runOutputsArchiveKey(RUN_ID),
    ]);
    const run = await db.getRun(RUN_ID);
    expect(run).toMatchObject({
      status: "completed",
      output: null,
      files: null,
      purge_after: null,
    });
    expect(run?.duration_ms).toBe(10);
    expect(logError).not.toHaveBeenCalled();
  });

  it("a delete that fails is logged without the key or the file name, and the others are still deleted", async () => {
    const db = await clearedRun(true);
    const outputs = new MemoryStorage();
    const deletes = vi
      .spyOn(outputs, "delete")
      .mockRejectedValueOnce(Object.assign(new Error("report.txt: unreachable"), { code: "EIO" }));

    await finalizeRun(db, log, RUN_ID, claim(), completion(TWO_FILES, "webhook", "flyio", outputs));

    expect(deletes).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toEqual({
      event: "cleared_run_output_delete_failed",
      error_name: "Error",
      error_code: "EIO",
    });
    const logged = JSON.stringify(logError.mock.calls);
    for (const secret of ["report.txt", RUN_ID, "_runs/"]) expect(logged).not.toContain(secret);
  });

  it("drops the run's local output directory, registered just before", async () => {
    const db = await clearedRun(true);
    const dir = mkdtempSync(join(tmpdir(), "skrun-cleared-"));
    writeFileSync(join(dir, "report.txt"), "hello");
    registerOutput(RUN_ID, dir, [{ name: "report.txt", size: 5 }]);
    expect(getOutputDir(RUN_ID)).toBe(dir);

    const result = await finalizeRun(
      db,
      log,
      RUN_ID,
      claim(),
      completion([{ name: "report.txt", size: 5 }], "sync", "local"),
    );

    expect(result.contentCleared).toBe(true);
    expect(getOutputDir(RUN_ID)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("a failure drops the directory too, and deletes no object", async () => {
    const db = await clearedRun(true);
    const outputs = new MemoryStorage();
    const deletes = vi.spyOn(outputs, "delete");
    const dir = mkdtempSync(join(tmpdir(), "skrun-cleared-failed-"));
    registerOutput(RUN_ID, dir, []);

    const result = await finalizeRun(db, log, RUN_ID, claim(), {
      ...failure("it broke"),
      runtimeMode: "flyio",
      outputStorage: outputs,
    });

    expect(result.contentCleared).toBe(true);
    expect(getOutputDir(RUN_ID)).toBeUndefined();
    expect(deletes).not.toHaveBeenCalled();
    expect(await db.getRun(RUN_ID)).toMatchObject({ status: "failed", error: null });
  });

  it("a run never cleared keeps its content, its objects and its directory", async () => {
    const db = await clearedRun(false);
    const outputs = new MemoryStorage();
    const deletes = vi.spyOn(outputs, "delete");
    const dir = mkdtempSync(join(tmpdir(), "skrun-kept-"));
    registerOutput(RUN_ID, dir, []);

    const result = await finalizeRun(
      db,
      log,
      RUN_ID,
      claim(),
      completion(TWO_FILES, "sse", "flyio", outputs),
    );

    expect(result.contentCleared).toBe(false);
    expect(deletes).not.toHaveBeenCalled();
    expect(getOutputDir(RUN_ID)).toBe(dir);
    expect((await db.getRun(RUN_ID))?.output).toEqual({ answer: "done" });
  });
});

// What a run's row keeps of its content is bounded — the output at 32 KiB of
// JSON text, the input and the error at 8 KiB —, counted in bytes and cut
// between two characters, never inside one.
describe("truncateRunContent — what a run's row keeps", () => {
  const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
  const jsonBytes = (value: unknown) => bytesOf(JSON.stringify(value));
  /** An object whose JSON text takes exactly `bytes` bytes. */
  const objectOf = (bytes: number) => ({ text: "a".repeat(bytes - jsonBytes({ text: "" })) });

  it("keeps an output of exactly 32 KiB whole, and replaces one byte more by the marker", () => {
    const whole = objectOf(RUN_OUTPUT_KEPT_BYTES);
    expect(truncateRunContent({ output: whole }).output).toBe(whole);

    const over = objectOf(RUN_OUTPUT_KEPT_BYTES + 1);
    const kept = truncateRunContent({ output: over }).output as unknown as TruncatedRunContent;
    expect(Object.keys(kept)).toEqual(["_truncated"]);
    expect(kept._truncated.bytes).toBe(RUN_OUTPUT_KEPT_BYTES + 1);
    expect(JSON.stringify(over).startsWith(kept._truncated.preview)).toBe(true);
    expect(jsonBytes(kept)).toBeLessThanOrEqual(RUN_OUTPUT_KEPT_BYTES);
    expect(jsonBytes(kept)).toBeGreaterThan(RUN_OUTPUT_KEPT_BYTES - 16);
  });

  it("keeps an input of exactly 8 KiB whole, and replaces one byte more by the marker", () => {
    const whole = objectOf(RUN_INPUT_KEPT_BYTES);
    expect(truncateRunContent({ input: whole }).input).toBe(whole);

    const kept = truncateRunContent({ input: objectOf(RUN_INPUT_KEPT_BYTES + 1) })
      .input as unknown as TruncatedRunContent;
    expect(kept._truncated.bytes).toBe(RUN_INPUT_KEPT_BYTES + 1);
    expect(jsonBytes(kept)).toBeLessThanOrEqual(RUN_INPUT_KEPT_BYTES);
  });

  it("counts a marker's preview as its JSON writes it: quotes escaped, multi-byte characters never split", () => {
    // Quotes take two bytes once escaped inside the preview; each "é" takes two, each emoji four.
    const value = { list: Array.from({ length: 4000 }, (_, i) => `é${i % 2 ? "😀" : '"'}`) };
    const kept = truncateRunContent({ input: value }).input as unknown as TruncatedRunContent;
    const { preview, bytes } = kept._truncated;
    expect(bytes).toBe(jsonBytes(value));
    expect(JSON.stringify(value).startsWith(preview)).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(jsonBytes(kept)).toBeLessThanOrEqual(RUN_INPUT_KEPT_BYTES);
    expect(jsonBytes(kept)).toBeGreaterThan(RUN_INPUT_KEPT_BYTES - 8);
  });

  it("keeps an error of exactly 8 KiB whole, and cuts one longer on a character, its full size said after it", () => {
    const whole = "e".repeat(RUN_ERROR_KEPT_BYTES);
    expect(truncateRunContent({ error: whole }).error).toBe(whole);

    // Three bytes a character: the cut never falls inside one.
    const long = "€".repeat(4096);
    const kept = truncateRunContent({ error: long }).error as string;
    expect(kept).toMatch(/^€+… \[truncated: 12288 bytes\]$/);
    expect(bytesOf(kept)).toBeLessThanOrEqual(RUN_ERROR_KEPT_BYTES);
    expect(bytesOf(kept)).toBeGreaterThan(RUN_ERROR_KEPT_BYTES - 3);
  });

  // What Postgres refuses to store: a NUL byte in `text`, and the escapes JSON
  // writes for a NUL or a lone surrogate in `jsonb`. The row's copy replaces
  // them; a surrogate pair is one character, and stays.
  it("replaces each NUL and each lone surrogate by U+FFFD — in the input, the output and the error, keys included —, and keeps a surrogate pair", () => {
    const content = {
      input: { "q\u0000": "ask\u0000" },
      output: {
        answer: "done\u0000",
        high: "a\ud800b",
        low: ["\udc00z"],
        pair: "😀",
        n: 1,
        ok: true,
      },
      error: "Tool failed: \u0000 then \ud83d",
    };
    const kept = truncateRunContent(content);
    expect(kept.input).toEqual({ "q�": "ask�" });
    expect(kept.output).toEqual({
      answer: "done�",
      high: "a�b",
      low: ["�z"],
      pair: "😀",
      n: 1,
      ok: true,
    });
    expect(kept.error).toBe("Tool failed: � then �");
    // The caller's content is untouched.
    expect(content.output.answer).toBe("done\u0000");
    expect(content.error).toBe("Tool failed: \u0000 then \ud83d");
  });

  it("returns content holding neither as the very same value, and keeps a key named __proto__ a key", () => {
    const output = { answer: "done", nested: { list: ["a", "😀"] } };
    expect(truncateRunContent({ output }).output).toBe(output);

    const withProto = JSON.parse('{"__proto__": {"x": "a\\u0000"}}') as Record<string, unknown>;
    const kept = truncateRunContent({ output: withProto }).output as Record<string, unknown>;
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(JSON.stringify(kept)).toBe('{"__proto__":{"x":"a�"}}');
  });

  it("counts the bound on the replaced text: an error of NULs that fits as given, but not once replaced, is cut", () => {
    // A NUL takes one byte, U+FFFD three.
    const nuls = "\u0000".repeat(RUN_ERROR_KEPT_BYTES);
    const kept = truncateRunContent({ error: nuls }).error as string;
    expect(kept).toMatch(/^�+… \[truncated: 24576 bytes\]$/);
    expect(bytesOf(kept)).toBeLessThanOrEqual(RUN_ERROR_KEPT_BYTES);
  });

  // The row keeps no value nested deeper than the bound. The run route refuses
  // such an input before its copy is built, and the agent loop such an
  // output: what follows is the copy's defense, should one reach it all the
  // same — a marker that neither measures nor writes the value, its depth
  // measured no deeper than the first level past the bound.
  /** `{ n: { n: … leaf } }`, `levels` levels deep, the value itself the first. */
  const nestedAround = (levels: number, leaf: unknown = 1): Record<string, unknown> => {
    let value = leaf;
    for (let level = 0; level < levels; level++) value = { n: value };
    return value as Record<string, unknown>;
  };
  /** `[[ … ]]`, `levels` levels deep, the value itself the first. */
  const arraysAround = (levels: number): unknown[] => {
    let value: unknown[] = [];
    for (let level = 1; level < levels; level++) value = [value];
    return value;
  };
  /** The marker of a value nested deeper than the bound: no size measured, nothing of it written. */
  const TOO_DEEP = { _truncated: { bytes: 0, preview: "" } };

  it("keeps an input and an output nested 100 levels deep whole, and replaces one nested 101 levels deep — small as it is, an object or an array — by the marker that measures and writes nothing of it", () => {
    const whole = nestedAround(100);
    expect(truncateRunContent({ input: whole, output: whole })).toEqual({
      input: whole,
      output: whole,
    });
    expect(truncateRunContent({ output: whole }).output).toBe(whole);

    const deep = nestedAround(101);
    expect(bytesOf(JSON.stringify(deep))).toBeLessThan(RUN_INPUT_KEPT_BYTES);
    expect(truncateRunContent({ input: deep, output: deep })).toEqual({
      input: TOO_DEEP,
      output: TOO_DEEP,
    });
    // A root array: the input of a request whose `input` is one.
    const array = arraysAround(101) as unknown as Record<string, unknown>;
    expect(truncateRunContent({ input: array }).input).toEqual(TOO_DEEP);
    const array100 = arraysAround(100) as unknown as Record<string, unknown>;
    expect(truncateRunContent({ input: array100 }).input).toBe(array100);
  });

  it("replaces an input and an output nested ten thousand levels deep — past what JSON.stringify writes — and one that contains itself by the same marker, without throwing", () => {
    const deep = nestedAround(10_000, "done");
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    const loop: Record<string, unknown> = { answer: "done" };
    loop.self = loop;
    expect(() => JSON.stringify(loop)).toThrow(TypeError);

    let kept: Record<string, unknown> = {};
    expect(() => {
      kept = truncateRunContent({ input: deep, output: loop });
    }).not.toThrow();
    expect(kept).toEqual({ input: TOO_DEEP, output: TOO_DEEP });
  });

  it("copies a value of about 1 MB nested half a million levels deep at no cost of its size: the marker within milliseconds, the heap no larger", () => {
    // Built from its text, as a request's body is read.
    const levels = 500_000;
    const deep = JSON.parse(`{"q":${"[".repeat(levels)}${"]".repeat(levels)}}`) as Record<
      string,
      unknown
    >;
    let kept: Record<string, unknown> = {};
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    expect(() => {
      kept = truncateRunContent({ input: deep, output: deep });
    }).not.toThrow();
    const elapsedMs = performance.now() - started;
    const grownBytes = process.memoryUsage().heapUsed - heapBefore;

    // Wide margins, for a slow machine. On a developer's machine: under 1 ms
    // and under 1 MB; writing the value's text for its marker took about
    // 250 ms and 190 MB of heap, each time.
    expect(elapsedMs).toBeLessThan(100);
    expect(grownBytes).toBeLessThan(16 * 1024 * 1024);
    expect(kept).toEqual({ input: TOO_DEEP, output: TOO_DEEP });
  });

  it("leaves null content and every other field as given", () => {
    const write = {
      status: "failed" as const,
      error: null,
      completed_at: "2026-10-17T00:00:00.000Z",
    };
    expect(truncateRunContent(write)).toEqual(write);
    expect(truncateRunContent({ input: undefined, output: null })).toEqual({
      input: undefined,
      output: null,
    });
  });
});

describe("finalizeRun — what the row keeps, and what the caller is told", () => {
  const LONG_ERROR = "x".repeat(12 * 1024);

  it("a failure's error of 12 KiB: the row keeps it cut and suffixed, the caller is told it whole", async () => {
    const db = new MemoryDb();
    await runningRun(db);

    const written = await finalizeRun(db, logger().log, RUN_ID, claim(), failure(LONG_ERROR));

    const suffix = "… [truncated: 12288 bytes]";
    const row = await db.getRun(RUN_ID);
    expect(row?.error).toBe(
      `${"x".repeat(RUN_ERROR_KEPT_BYTES - Buffer.byteLength(suffix))}${suffix}`,
    );
    expect(written).toMatchObject({ written: true, status: "failed", error: LONG_ERROR });
    expect(failureToTell(written)).toEqual({ message: LONG_ERROR });
  });

  it("the same failure on a row the stop's write finished first: the caller is told the row's phrase, not its own error", async () => {
    const db = new MemoryDb();
    await runningRun(db);
    await db.finishRun(RUN_ID, {
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      completed_at: "2026-10-17T00:00:00.000Z",
    });

    const written = await finalizeRun(db, logger().log, RUN_ID, claim(), failure(LONG_ERROR));

    expect(written).toMatchObject({ written: false, status: "failed", error: SHUTDOWN_RUN_ERROR });
    expect((await db.getRun(RUN_ID))?.error).toBe(SHUTDOWN_RUN_ERROR);
  });

  it("a completion's output of 64 KiB: the row keeps the marker", async () => {
    const db = new MemoryDb();
    await runningRun(db);
    const output = { answer: "y".repeat(64 * 1024) };

    await finalizeRun(db, logger().log, RUN_ID, claim(), {
      ...completion([], "sse", "local"),
      completion: { ...fields([]), output },
    } as FinalizeRunInput);

    expect((await db.getRun(RUN_ID))?.output).toEqual({
      _truncated: {
        bytes: Buffer.byteLength(JSON.stringify(output)),
        preview: expect.stringMatching(/^\{"answer":"yyy/),
      },
    });
  });

  // Nested past what JSON.stringify writes. The agent loop refuses such an
  // output; should one reach the final write all the same, the copy's defense
  // is the marker, so the first write lands, whole otherwise.
  it("a completion's output nested ten thousand levels deep: the row keeps the marker that measures and writes nothing of it, at the first write, with its usage and its files", async () => {
    const { error: logError, warn, log } = logger();
    const db = new MemoryDb();
    await runningRun(db);
    const finishRun = vi.spyOn(db, "finishRun");
    let output: Record<string, unknown> = { answer: "done" };
    for (let level = 0; level < 10_000; level++) output = { nested: output };
    expect(() => JSON.stringify(output)).toThrow(RangeError);

    const written = await finalizeRun(db, log, RUN_ID, claim(), {
      ...completion(TWO_FILES, "sync", "flyio"),
      completion: { ...fields(TWO_FILES), output },
    } as FinalizeRunInput);

    expect(written).toMatchObject({ claimed: true, written: true, status: "completed" });
    expect(finishRun).toHaveBeenCalledOnce();
    const row = await db.getRun(RUN_ID);
    expect(row).toMatchObject({
      status: "completed",
      usage_total_tokens: 3,
      files: [
        { name: "report.txt", size: 5 },
        { name: "data/table.csv", size: 8 },
      ],
    });
    expect(row?.output).toEqual({ _truncated: { bytes: 0, preview: "" } });
    expect(logError).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
