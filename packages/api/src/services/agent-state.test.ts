import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StateConfigSchema } from "@skrun-dev/schema";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { MissingStateReferenceError } from "../db/state-errors.js";
import { errorFields } from "../utils/error-fields.js";
import {
  createStateCallbacks,
  STATE_SWEEP_INTERVAL_MS,
  startStateSweep,
  statePartitionFor,
} from "./agent-state.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function makeDb() {
  return {
    getState: vi.fn(async () => ({
      state: { remembered: true },
      expires_at: "2099-01-01T00:00:00.000Z",
    })),
    setState: vi.fn(async () => {}),
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function config(state: Record<string, unknown>) {
  return StateConfigSchema.parse(state);
}

describe("statePartitionFor", () => {
  it("a shared agent has one notebook, whoever calls it", () => {
    expect(statePartitionFor("shared", { kind: "account", userId: "u-1" })).toEqual({
      kind: "shared",
    });
    expect(statePartitionFor("shared", { kind: "key", keyId: "k-1" })).toEqual({ kind: "shared" });
    expect(statePartitionFor("shared", null)).toEqual({ kind: "shared" });
  });

  it("a per-caller agent keeps the caller's own notebook", () => {
    expect(statePartitionFor("per_caller", { kind: "account", userId: "u-1" })).toEqual({
      kind: "account",
      userId: "u-1",
    });
    expect(statePartitionFor("per_caller", { kind: "key", keyId: "k-1" })).toEqual({
      kind: "key",
      keyId: "k-1",
    });
  });

  it("a per-caller agent has no notebook for a caller with no identity", () => {
    expect(statePartitionFor("per_caller", null)).toBeNull();
  });
});

describe("createStateCallbacks", () => {
  it("binds the agent's id and the caller's partition, ignoring the name the loop passes", async () => {
    const db = makeDb();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "key", keyId: "k-1" },
      log: makeLog(),
      now: () => NOW,
    });

    expect(await cb.getState("some-slug")).toEqual({ remembered: true });
    await cb.getState("another-slug");
    await cb.setState("yet-another-slug", { n: 1 });

    expect(db.getState).toHaveBeenNthCalledWith(1, "agent-1", { kind: "key", keyId: "k-1" });
    expect(db.getState).toHaveBeenNthCalledWith(2, "agent-1", { kind: "key", keyId: "k-1" });
    expect(db.setState).toHaveBeenCalledWith(
      "agent-1",
      { kind: "key", keyId: "k-1" },
      { n: 1 },
      expect.any(String),
    );
  });

  it("a shared agent reads and writes the shared notebook", async () => {
    const db = makeDb();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv", scope: "shared" }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
      now: () => NOW,
    });
    await cb.getState("x");
    await cb.setState("x", { n: 1 });
    expect(db.getState).toHaveBeenCalledWith("agent-1", { kind: "shared" });
    expect(db.setState.mock.calls[0][1]).toEqual({ kind: "shared" });
  });

  it("returns null when the partition has no notebook", async () => {
    const db = makeDb();
    db.getState.mockResolvedValueOnce(null as never);
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
    });
    expect(await cb.getState("x")).toBeNull();
  });

  it.each([
    ["a millisecond ago", -1],
    ["at this very instant", 0],
    ["a day ago", -DAY_MS],
  ])("a notebook whose deadline passed %s reads as absent", async (_when, offset) => {
    const db = makeDb();
    db.getState.mockResolvedValueOnce({
      state: { stale: true },
      expires_at: new Date(NOW.getTime() + offset).toISOString(),
    } as never);
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
      now: () => NOW,
    });
    expect(await cb.getState("x")).toBeNull();
    expect(db.getState).toHaveBeenCalledTimes(1);
  });

  it("a notebook whose deadline is a millisecond away is read", async () => {
    const db = makeDb();
    db.getState.mockResolvedValueOnce({
      state: { fresh: true },
      expires_at: new Date(NOW.getTime() + 1).toISOString(),
    } as never);
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
      now: () => NOW,
    });
    expect(await cb.getState("x")).toEqual({ fresh: true });
  });

  it("a caller with no identity reads and writes nothing on a per-caller agent, said once in the log", async () => {
    const db = makeDb();
    const log = makeLog();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: null,
      log,
    });

    expect(await cb.getState("x")).toBeNull();
    await cb.setState("x", { n: 1 });

    expect(db.getState).not.toHaveBeenCalled();
    expect(db.setState).not.toHaveBeenCalled();
    const skipped = log.info.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "state_skipped",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0]).toEqual({ event: "state_skipped", reason: "no_account_row" });
  });

  it("a caller with no identity still shares the notebook of a shared agent", async () => {
    const db = makeDb();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv", scope: "shared" }),
      caller: null,
      log: makeLog(),
    });
    await cb.getState("x");
    expect(db.getState).toHaveBeenCalledWith("agent-1", { kind: "shared" });
  });

  it("writes a deadline of now plus the agent's ttl", async () => {
    const db = makeDb();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv", ttl: "7d" }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
      now: () => NOW,
    });
    await cb.setState("x", { n: 1 });
    expect(db.setState.mock.calls[0][3]).toBe(new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
  });

  it.each([
    ["0d", 1],
    ["9999d", 365],
    ["99999999999d", 365],
  ])("bounds the deadline: a ttl of %s is kept %i days", async (ttl, days) => {
    const db = makeDb();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv", ttl }),
      caller: { kind: "account", userId: "u-1" },
      log: makeLog(),
      now: () => NOW,
    });
    await cb.setState("x", { n: 1 });
    expect(db.setState.mock.calls[0][3]).toBe(
      new Date(NOW.getTime() + days * DAY_MS).toISOString(),
    );
  });

  it.each([
    [
      "Postgres",
      Object.assign(new Error("insert violates foreign key constraint"), { code: "23503" }),
    ],
    [
      "SQLite",
      Object.assign(new Error("FOREIGN KEY constraint failed"), {
        code: "SQLITE_CONSTRAINT_FOREIGNKEY",
      }),
    ],
    ["the in-memory backend", new MissingStateReferenceError("key", "k-1")],
  ])("a write refused for a missing reference (%s) is logged and does not throw: the run keeps its result", async (_backend, failure) => {
    const db = makeDb();
    db.setState.mockRejectedValueOnce(failure as never);
    const log = makeLog();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "key", keyId: "k-1" },
      log,
    });

    await expect(cb.setState("x", { n: 1 })).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0];
    expect(fields).toMatchObject({
      event: "state_write_failed",
      absorbed: true,
      error_code: (failure as { code: string }).code,
    });
    // The log line names the error, never its message nor the notebook's content.
    expect(JSON.stringify(fields)).not.toContain((failure as Error).message);
    expect(JSON.stringify(fields)).not.toContain('"n"');
  });

  it.each([
    ["a lost connection", new Error("connection lost")],
    ["a timeout", Object.assign(new Error("canceling statement"), { code: "57014" })],
    ["a CHECK violation", Object.assign(new Error("violates check constraint"), { code: "23514" })],
    [
      "a malformed id",
      Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" }),
    ],
    [
      "a SQLite CHECK violation",
      Object.assign(new Error("CHECK constraint failed"), { code: "SQLITE_CONSTRAINT_CHECK" }),
    ],
  ])("any other failed write (%s) fails the run, under a fixed message, and is logged", async (_what, failure) => {
    const db = makeDb();
    db.setState.mockRejectedValueOnce(failure as never);
    const log = makeLog();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "key", keyId: "k-1" },
      log,
    });

    const thrown = await cb.setState("x", { n: 1 }).then(
      () => null,
      (err: unknown) => err as Error & { code?: string },
    );

    // What the caller is told says nothing of the database: no table, no
    // constraint, no value. The original error's code goes along.
    expect(thrown?.message).toBe("State write failed");
    expect(thrown?.code).toBe((failure as { code?: string }).code);
    // The log line names the original error by its class and code, never its message.
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0];
    expect(fields).toEqual({
      event: "state_write_failed",
      absorbed: false,
      ...errorFields(failure),
    });
    expect(JSON.stringify(fields)).not.toContain(failure.message);
  });

  it("a deadline that cannot be computed fails the write, and nothing is written", async () => {
    const db = makeDb();
    const log = makeLog();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "key", keyId: "k-1" },
      log,
      now: () => new Date(Number.NaN),
    });

    await expect(cb.setState("x", { n: 1 })).rejects.toThrow(RangeError);
    expect(db.setState).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a failed read is not swallowed: the run fails under a fixed message, and it is logged", async () => {
    const db = makeDb();
    db.getState.mockRejectedValueOnce(
      Object.assign(new Error("connection lost"), { code: "ECONNRESET" }) as never,
    );
    const log = makeLog();
    const cb = createStateCallbacks({
      db,
      agentId: "agent-1",
      state: config({ type: "kv" }),
      caller: { kind: "key", keyId: "k-1" },
      log,
    });
    const err = await cb.getState("x").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("State read failed");
    expect(err?.message).not.toContain("connection lost");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "state_read_failed" }),
      expect.any(String),
    );
  });
});

describe("the sweep of expired notebooks", () => {
  /** An agent and an account to write notebooks for, in a fresh in-memory backend. */
  async function backend() {
    const db = new MemoryDb();
    const owner = await db.createUser({ github_id: "sweep-owner", username: "sweep-owner" });
    const agent = await db.createAgent({
      name: "swept",
      namespace: "sweep",
      description: "",
      owner_id: owner.id,
    });
    const caller = await db.createUser({ github_id: "sweep-caller", username: "sweep-caller" });
    return { db, agentId: agent.id, account: { kind: "account" as const, userId: caller.id } };
  }
  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
  const SHARED = { kind: "shared" } as const;

  beforeEach(() => {
    // The clock and the interval are faked; setImmediate stays real, so a case
    // can let an unhandled rejection surface.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a pass at startup, before any interval has elapsed", async () => {
    const { db, agentId, account } = await backend();
    await db.setState(agentId, SHARED, { n: 1 }, fromNow(-1_000));
    await db.setState(agentId, account, { n: 2 }, fromNow(-STATE_SWEEP_INTERVAL_MS));
    const timer = startStateSweep(db);
    try {
      // Drains the pass's promise without moving the clock.
      await vi.advanceTimersByTimeAsync(0);
      expect(await db.getState(agentId, SHARED)).toBeNull();
      expect(await db.getState(agentId, account)).toBeNull();
    } finally {
      clearInterval(timer);
    }
  });

  it("then makes one every interval, deleting only what expired, without holding the process", async () => {
    const { db, agentId, account } = await backend();
    await db.setState(agentId, account, { kept: true }, fromNow(24 * STATE_SWEEP_INTERVAL_MS));
    const timer = startStateSweep(db);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // A notebook that expires after startup is gone one interval later.
      await db.setState(agentId, SHARED, { soon: true }, fromNow(60_000));
      await vi.advanceTimersByTimeAsync(STATE_SWEEP_INTERVAL_MS);

      expect(await db.getState(agentId, SHARED)).toBeNull();
      expect((await db.getState(agentId, account))?.state).toEqual({ kept: true });
      // Last, so a failure here does not hide whether the sweep itself worked.
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it("a pass that fails is logged by the error's class and code, not thrown, and the next one runs", async () => {
    // A plain function, not a vi.fn(): a mock subscribes to the promise it
    // returns (to record how it settled), which would handle the rejection
    // itself and hide a sweep that does not.
    let passes = 0;
    const purgeExpiredState = (): Promise<void> => {
      passes += 1;
      return Promise.reject(
        Object.assign(new Error("connection to db.internal lost"), { code: "ECONNRESET" }),
      );
    };
    const log = { error: vi.fn() };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const timer = startStateSweep({ purgeExpiredState }, log);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Real: lets an unhandled rejection, if any, be reported.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0][0]).toEqual({
        event: "state_sweep_failed",
        error_name: "Error",
        error_code: "ECONNRESET",
      });
      expect(JSON.stringify(log.error.mock.calls)).not.toContain("db.internal");

      await vi.advanceTimersByTimeAsync(STATE_SWEEP_INTERVAL_MS);
      expect(passes).toBe(2);
      expect(log.error).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer);
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // The cases above call the starter directly: they would stay green if no
  // server ever started it. These two files are the ones that run a server.
  // Their source is read without its comments: a call commented out is no call.
  it("both server entry points start the sweep", () => {
    for (const entry of ["server.ts", "dev.ts"]) {
      const source = readFileSync(join(SRC_DIR, entry), "utf8");
      expect(callsFunction(source, "startStateSweep"), entry).toBe(true);
    }
  });

  // createApp is what every test builds: a sweep started there would run in
  // each of them, and twice in a server, which starts its own.
  it("the app factory does not start the sweep", () => {
    const source = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    expect(source).toContain("export function createApp(");
    expect(callsFunction(source, "startStateSweep"), "index.ts").toBe(false);
  });
});

const SRC_DIR = join(import.meta.dirname, "..");

/**
 * Whether `source` calls `name`. Read as a syntax tree, not as text: a call in a
 * comment or a string is no call, and a comment that happens to hold `/*` (a
 * route pattern, say) cannot hide the code after it.
 */
function callsFunction(source: string, name: string): boolean {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
