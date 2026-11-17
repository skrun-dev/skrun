import {
  acquisitionBudgetMs,
  FLY_APP_ACTION_BURST,
  FlyMachinesApi,
  type Logger,
  MACHINE_LIFETIME_GRACE_MS,
  type Machine,
  type MachineState,
  RunnerPool,
  undeclaredLifetimeFallbackMs,
} from "@skrun-dev/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbAdapter } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { createRunMachineSweep, type RunMachineSweepOptions } from "./machine-sweep.js";

// The sweep judges every machine the cloud runtime created for a run on its
// run's row — never on what one process remembers: several processes share one
// app of machines and one database, and each knows only its own runs. The
// clock of the sweep is simulated; the bound of a pass is real milliseconds.

const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const MIN = 60_000;
const GRACE = MACHINE_LIFETIME_GRACE_MS;
const FALLBACK = undeclaredLifetimeFallbackMs();
const READ_FLOOR = acquisitionBudgetMs({ concurrentCreates: FLY_APP_ACTION_BURST });

const iso = (ms: number) => new Date(ms).toISOString();

/** The n-th run id of the bench — a uuid, as the route mints them. */
function runId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * A listed machine made for run `run`, `ageMs` old at T0 (no creation instant
 * when absent), labelled with its run unless `label` is false, declaring a
 * lifetime of `lifetimeS` seconds when given.
 */
function runMachine(
  id: string,
  run: string,
  opts: { ageMs?: number; state?: MachineState; lifetimeS?: number; label?: false } = {},
): Machine {
  return {
    id,
    name: `skrun-run-${run}`,
    state: opts.state ?? "started",
    created_at: opts.ageMs === undefined ? undefined : iso(T0 - opts.ageMs),
    config: {
      image: "registry.example/skrun-runtime:runner",
      env: opts.lifetimeS === undefined ? {} : { RUNNER_LIFETIME_S: String(opts.lifetimeS) },
      metadata: opts.label === false ? undefined : { skrun_run_id: run },
    },
  } as Machine;
}

/** A run admitted at `createdAt`, its seat's deadline at `deadlineAt`, still running. */
async function admit(
  db: MemoryDb,
  id: string,
  deadlineAt: number,
  createdAt = T0 - 2 * 60 * MIN,
): Promise<void> {
  await db.admitRun({
    run: { id, agent_id: null, agent_version: "dev/agent@1.0.0" },
    now: iso(createdAt),
    deadlineAt: iso(deadlineAt),
    windowStart: null,
    limits: { concurrentRuns: null, computeMs: null, fastRunsPerHour: null, instanceCap: null },
    poolRunning: false,
  });
}

/** The run's final status, written at `endedAt`. */
async function finish(db: MemoryDb, id: string, endedAt: number): Promise<void> {
  await db.finishRun(id, { status: "completed", completed_at: iso(endedAt) });
}

/** A logger that keeps every line it is given. */
function recordingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; fields: Record<string, unknown> }>;
} {
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const at = (level: string) => (fields: Record<string, unknown>) => {
    lines.push({ level, fields });
  };
  const logger = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
    trace: at("trace"),
    fatal: at("fatal"),
    level: "info",
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

/**
 * The app's machines as the platform holds them: a destruction removes one, and
 * is refused — as the client refuses it — under a signal already aborted.
 */
function platform(machines: Machine[]): {
  live: () => Machine[];
  destroyed: string[];
  flyApi: RunMachineSweepOptions["flyApi"];
} {
  const held = new Map(machines.map((m) => [m.id, m]));
  const destroyed: string[] = [];
  return {
    live: () => [...held.values()],
    destroyed,
    flyApi: {
      destroy: async (machineId, options) => {
        if (options?.signal?.aborted) throw options.signal.reason;
        held.delete(machineId);
        destroyed.push(machineId);
      },
    },
  };
}

/** A pool that only keeps the counters a sweep reports to — never started. */
function counterPool(): RunnerPool {
  return new RunnerPool({} as FlyMachinesApi, { size: 0, imageTag: "registry.example/img" });
}

/** A signal that aborts once `ms` real milliseconds have passed — the bound of a pass. */
function passBound(ms: number): { signal: AbortSignal; end: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("the pass reached its bound")), ms);
  timer.unref?.();
  return { signal: controller.signal, end: () => clearTimeout(timer) };
}

/** Whether `work` settles within `ms` real milliseconds. */
async function settlesWithin(
  work: Promise<unknown>,
  ms = 2_000,
): Promise<"ended" | "still running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still running">((resolve) => {
    timer = setTimeout(() => resolve("still running"), ms);
  });
  try {
    return await Promise.race([work.then(() => "ended" as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

const never = () => new AbortController().signal;

function sweepOf(
  options: Partial<RunMachineSweepOptions> &
    Pick<RunMachineSweepOptions, "db" | "flyApi" | "pool" | "logger">,
): ReturnType<typeof createRunMachineSweep> {
  return createRunMachineSweep({
    now: () => T0,
    readFloorMs: READ_FLOOR,
    graceMs: GRACE,
    fallbackMs: FALLBACK,
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sweep of the run machines — each judged on its run's row", () => {
  it("destroys the machines of finished runs, of runs past their deadline and of absent rows past their fallback, spares the rest, and never reads for a machine still being acquired", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - 6 * MIN);
    await admit(db, runId(2), T0 + 60 * MIN);
    await finish(db, runId(2), T0 - 6 * MIN);
    await admit(db, runId(3), T0 + 10 * MIN);
    await admit(db, runId(4), T0 - 6 * MIN);
    // Runs 5 to 8 have no row.
    await admit(db, runId(9), T0 + 60 * MIN);
    await finish(db, runId(9), T0 - 60 * MIN);
    const app = platform([
      runMachine("finished-started", runId(1), { ageMs: 30 * MIN }),
      // Found by its name alone: no label.
      runMachine("finished-stopped", runId(2), { ageMs: 30 * MIN, state: "stopped", label: false }),
      runMachine("running", runId(3), { ageMs: 2 * 60 * MIN }),
      runMachine("past-deadline", runId(4), { ageMs: 2 * 60 * MIN }),
      runMachine("absent-undeclared-young", runId(5), { ageMs: FALLBACK - MIN }),
      runMachine("absent-undeclared-old", runId(6), { ageMs: FALLBACK + MIN }),
      // Past the fallback, short of its own lifetime plus the grace: its own wins.
      runMachine("absent-declared-young", runId(7), {
        ageMs: 1_250_000 + GRACE - MIN,
        lifetimeS: 1250,
      }),
      runMachine("absent-declared-old", runId(8), {
        ageMs: 1_250_000 + GRACE + MIN,
        lifetimeS: 1250,
      }),
      // Its run finished long ago — but a machine this young is still being acquired.
      runMachine("young", runId(9), { ageMs: 20_000 }),
    ]);
    const reads = vi.spyOn(db, "getRun");
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool: counterPool(), logger });

    const result = await sweep(app.live(), never());

    expect([...app.destroyed].sort()).toEqual([
      "absent-declared-old",
      "absent-undeclared-old",
      "finished-started",
      "finished-stopped",
      "past-deadline",
    ]);
    expect(result).toEqual({ destroyed: 5, readFailures: 0 });
    expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(runId).sort(),
    );
    const swept = lines
      .filter((l) => l.fields.event === "run_machine_swept")
      .map((l) => [l.fields.machine_id, l.fields.reason, l.fields.machine_state, l.fields.run_id]);
    expect(swept.sort()).toEqual(
      [
        ["absent-declared-old", "no_row", "started", runId(8)],
        ["absent-undeclared-old", "no_row", "started", runId(6)],
        ["finished-started", "finished", "started", runId(1)],
        ["finished-stopped", "finished", "stopped", runId(2)],
        ["past-deadline", "deadline", "started", runId(4)],
      ].sort(),
    );
  });

  it("spares a machine within the grace of its run's end, or of its seat's deadline", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - GRACE + MIN);
    await admit(db, runId(2), T0 - GRACE + MIN);
    const app = platform([
      runMachine("just-finished", runId(1), { ageMs: 2 * 60 * MIN }),
      runMachine("just-past-deadline", runId(2), { ageMs: 2 * 60 * MIN }),
    ]);
    const sweep = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
    });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 0, readFailures: 0 });
    expect(app.destroyed).toEqual([]);
  });

  it("judges a row without a deadline, and a finished row without its end, by the machine's fallback", async () => {
    const db = new MemoryDb();
    // Rows written without a deadline, or finished without an end instant.
    for (const n of [1, 2]) {
      await db.createRun({ id: runId(n), agent_id: null, agent_version: "a@1", status: "running" });
    }
    for (const n of [3, 4]) {
      await db.createRun({ id: runId(n), agent_id: null, agent_version: "a@1", status: "failed" });
    }
    const app = platform([
      runMachine("no-deadline-young", runId(1), { ageMs: FALLBACK - MIN }),
      runMachine("no-deadline-old", runId(2), { ageMs: FALLBACK + MIN }),
      runMachine("no-end-young", runId(3), { ageMs: 1_000_000 + GRACE - MIN, lifetimeS: 1000 }),
      runMachine("no-end-old", runId(4), { ageMs: 1_000_000 + GRACE + MIN, lifetimeS: 1000 }),
    ]);
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool: counterPool(), logger });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 2, readFailures: 0 });
    expect(
      lines
        .filter((l) => l.fields.event === "run_machine_swept")
        .map((l) => [l.fields.machine_id, l.fields.reason])
        .sort(),
    ).toEqual([
      ["no-deadline-old", "no_deadline"],
      ["no-end-old", "finished"],
    ]);
  });

  it("reads the row of a machine whose age it cannot tell, and spares it when the row cannot judge it", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - 60 * MIN);
    const app = platform([
      runMachine("ageless-finished", runId(1)),
      runMachine("ageless-absent", runId(2)),
    ]);
    const sweep = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
    });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 1, readFailures: 0 });
    expect(app.destroyed).toEqual(["ageless-finished"]);
  });

  it("never judges a machine that is not a run's — a pooled machine that carries no run, any other — nor one whose destruction is under way or done", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - 60 * MIN);
    const pooled = {
      id: "pooled",
      name: "skrun-pool-abc123",
      state: "stopped",
      created_at: iso(T0 - 9 * 60 * MIN),
      config: { image: "img", env: {}, metadata: { skrun_pool_id: "abc123" } },
    } as Machine;
    const other = {
      id: "other",
      name: "api-server-1",
      state: "started",
      created_at: iso(T0 - 9 * 60 * MIN),
    } as Machine;
    const app = platform([
      pooled,
      other,
      runMachine("destroying", runId(1), { ageMs: 2 * 60 * MIN, state: "destroying" }),
      runMachine("destroyed", runId(1), { ageMs: 2 * 60 * MIN, state: "destroyed" }),
    ]);
    const reads = vi.spyOn(db, "getRun");
    const sweep = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
    });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 0, readFailures: 0 });
    expect(app.destroyed).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("judges a machine whose name holds no run id as an absent row, without asking a database that would refuse the id", async () => {
    // A database that holds run ids as uuids refuses to read anything else.
    const memory = new MemoryDb();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const db: Pick<DbAdapter, "getRun"> = {
      getRun: async (id) => {
        if (!uuid.test(id)) throw new Error("invalid input syntax for type uuid");
        return memory.getRun(id);
      },
    };
    const reads = vi.spyOn(db, "getRun");
    const app = platform([
      runMachine("not-a-run-young", "not-a-run-a", { ageMs: FALLBACK - MIN, label: false }),
      runMachine("not-a-run-old", "not-a-run-b", { ageMs: FALLBACK + MIN, label: false }),
    ]);
    const sweep = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
    });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 1, readFailures: 0 });
    expect(app.destroyed).toEqual(["not-a-run-old"]);
    expect(reads).not.toHaveBeenCalled();
  });
});

/**
 * A listed pooled machine assigned to run `run` — labelled with it, and with the
 * end of its life `endInMs` from T0 when given —, its last update (the
 * labels' write) `touchedMs` before T0, created long before, at its fill.
 */
function assignedPooled(
  id: string,
  run: string,
  opts: { endInMs?: number; touchedMs?: number; state?: MachineState; end?: string } = {},
): Machine {
  const end = opts.end ?? (opts.endInMs === undefined ? undefined : iso(T0 + opts.endInMs));
  return {
    id,
    name: `skrun-pool-${id}`,
    state: opts.state ?? "started",
    created_at: iso(T0 - 9 * 60 * MIN),
    updated_at: iso(T0 - (opts.touchedMs ?? 60 * MIN)),
    config: {
      image: "registry.example/skrun-runtime:runner",
      env: {},
      metadata: {
        skrun_pool_id: id,
        skrun_run_id: run,
        ...(end === undefined ? {} : { skrun_lifetime_end: end }),
      },
    },
  } as Machine;
}

// A pooled machine assigned to a run carries the run's label and the end of its
// life once its runner answered the assignment. Its name says only that it is
// a pooled one, and its creation dates its fill: it is judged on its run's
// row, and, when the row cannot judge it, on the end it declares — never on its
// age.
describe("the sweep of the run machines — an assigned pooled machine, judged on its run's row", () => {
  it("destroys an assigned pooled machine whose run finished, or is past its deadline, or has no row past the end it declares; spares the rest; never reads one just labelled", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - 6 * MIN);
    await admit(db, runId(2), T0 + 10 * MIN);
    await admit(db, runId(3), T0 - 6 * MIN);
    // Runs 4 to 7 have no row.
    await admit(db, runId(8), T0 + 60 * MIN);
    await finish(db, runId(8), T0 - 60 * MIN);
    const unassigned = {
      id: "stock",
      name: "skrun-pool-stock",
      state: "suspended",
      created_at: iso(T0 - 9 * 60 * MIN),
      updated_at: iso(T0 - 9 * 60 * MIN),
      config: { image: "img", env: {}, metadata: { skrun_pool_id: "stock" } },
    } as Machine;
    const app = platform([
      assignedPooled("finished", runId(1), { endInMs: 60 * MIN }),
      assignedPooled("running", runId(2), { endInMs: 30 * MIN }),
      assignedPooled("past-deadline", runId(3), { endInMs: 60 * MIN }),
      assignedPooled("no-row-past-end", runId(4), { endInMs: -(GRACE + MIN) }),
      assignedPooled("no-row-within-end", runId(5), { endInMs: -(GRACE - MIN) }),
      // Its run unknown, no end it declares: its age says nothing of its run.
      assignedPooled("no-row-no-end", runId(6)),
      assignedPooled("no-row-unreadable-end", runId(7), { end: "in an hour" }),
      // Its run finished long ago — but labelled this recently, its run is still getting it.
      assignedPooled("just-labelled", runId(8), { endInMs: -(GRACE + MIN), touchedMs: 20_000 }),
      unassigned,
    ]);
    const reads = vi.spyOn(db, "getRun");
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool: counterPool(), logger });

    const result = await sweep(app.live(), never());

    expect([...app.destroyed].sort()).toEqual(["finished", "no-row-past-end", "past-deadline"]);
    expect(result).toEqual({ destroyed: 3, readFailures: 0 });
    expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(runId).sort(),
    );
    expect(
      lines
        .filter((l) => l.fields.event === "run_machine_swept")
        .map((l) => [l.fields.machine_id, l.fields.reason, l.fields.run_id])
        .sort(),
    ).toEqual(
      [
        ["finished", "finished", runId(1)],
        ["no-row-past-end", "no_row", runId(4)],
        ["past-deadline", "deadline", runId(3)],
      ].sort(),
    );
  });

  it("judges a row without a deadline, and a finished row without its end, by the end the machine declares", async () => {
    const db = new MemoryDb();
    for (const n of [1, 2]) {
      await db.createRun({ id: runId(n), agent_id: null, agent_version: "a@1", status: "running" });
    }
    for (const n of [3, 4]) {
      await db.createRun({ id: runId(n), agent_id: null, agent_version: "a@1", status: "failed" });
    }
    const app = platform([
      assignedPooled("no-deadline-within", runId(1), { endInMs: -(GRACE - MIN) }),
      assignedPooled("no-deadline-past", runId(2), { endInMs: -(GRACE + MIN) }),
      assignedPooled("no-end-within", runId(3), { endInMs: 10 * MIN }),
      assignedPooled("no-end-past", runId(4), { endInMs: -(GRACE + MIN) }),
    ]);
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool: counterPool(), logger });

    expect(await sweep(app.live(), never())).toEqual({ destroyed: 2, readFailures: 0 });
    expect(
      lines
        .filter((l) => l.fields.event === "run_machine_swept")
        .map((l) => [l.fields.machine_id, l.fields.reason])
        .sort(),
    ).toEqual([
      ["no-deadline-past", "no_deadline"],
      ["no-end-past", "finished"],
    ]);
  });
});

describe("the sweep of the run machines — a row it cannot read", () => {
  it("spares a machine whose run cannot be read — a read that throws, then one that never answers within the pass's bound — counted, never taken for an absent row", async () => {
    const db = new MemoryDb();
    // Two hours old and declaring no lifetime: taken for an absent row, it would go.
    const app = platform([runMachine("unreadable", runId(1), { ageMs: 2 * 60 * MIN })]);
    const pool = counterPool();
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool, logger });

    // First pass: the read throws.
    const reads = vi.spyOn(db, "getRun");
    reads.mockRejectedValueOnce(new Error("connection terminated"));
    const first = await sweep(app.live(), never());
    pool.recordSweep(first);
    expect(first).toEqual({ destroyed: 0, readFailures: 1 });
    expect(pool.stats().sweepReadFailures).toBe(1);

    // Second pass: the read never answers; the pass's bound ends the sweep there.
    reads.mockImplementationOnce(() => new Promise<never>(() => {}));
    const bound = passBound(30);
    let second: Awaited<ReturnType<typeof sweep>> | undefined;
    try {
      const work = sweep(app.live(), bound.signal).then((result) => {
        second = result;
      });
      expect(await settlesWithin(work)).toBe("ended");
    } finally {
      bound.end();
    }
    expect(second).toEqual({ destroyed: 0, readFailures: 1 });
    pool.recordSweep(second ?? { destroyed: 0, readFailures: 0 });
    expect(pool.stats().sweepReadFailures).toBe(2);

    expect(app.destroyed).toEqual([]);
    expect(lines.filter((l) => l.fields.event === "run_machine_swept")).toEqual([]);
    const failed = lines.filter((l) => l.fields.event === "run_machine_sweep_read_failed");
    expect(failed.map((l) => [l.level, l.fields.machine_id, l.fields.run_id])).toEqual([
      ["warn", "unreadable", runId(1)],
      ["warn", "unreadable", runId(1)],
    ]);
    // Said by the error's class, never its message.
    expect(JSON.stringify(failed)).not.toContain("connection terminated");
  });

  it("starts nothing more once the pass's bound has cut it", async () => {
    const db = new MemoryDb();
    await admit(db, runId(2), T0 + 60 * MIN);
    await finish(db, runId(2), T0 - 60 * MIN);
    const app = platform([
      runMachine("hanging", runId(1), { ageMs: 2 * 60 * MIN }),
      runMachine("finished", runId(2), { ageMs: 2 * 60 * MIN }),
    ]);
    const getRun = db.getRun.bind(db);
    const reads = vi
      .spyOn(db, "getRun")
      .mockImplementation((id) => (id === runId(1) ? new Promise<never>(() => {}) : getRun(id)));
    const pool = counterPool();
    const sweep = sweepOf({ db, flyApi: app.flyApi, pool, logger: recordingLogger().logger });

    const bound = passBound(30);
    let result: Awaited<ReturnType<typeof sweep>> | undefined;
    try {
      const work = sweep(app.live(), bound.signal).then((r) => {
        result = r;
      });
      expect(await settlesWithin(work)).toBe("ended");
    } finally {
      bound.end();
    }

    expect(result).toEqual({ destroyed: 0, readFailures: 1 });
    expect(reads.mock.calls.map(([id]) => id)).toEqual([runId(1)]);
    expect(app.destroyed).toEqual([]);
    expect(pool.stats().destroyFailures).toBe(0);
  });

  it("ends the pool's pass at its bound when a read never answers, and the pool counts it", async () => {
    const db = new MemoryDb();
    vi.spyOn(db, "getRun").mockImplementation(() => new Promise<never>(() => {}));
    const listing = [runMachine("hanging", runId(1), { ageMs: 2 * 60 * MIN })];
    const flyApi = {
      list: async () => listing,
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    // The pool's own pass, its bound armed at 30 real milliseconds.
    class OnePassPool extends RunnerPool {
      readonly passes: Promise<void>[] = [];
      protected override maintain(): Promise<void> {
        const pass = super.maintain();
        this.passes.push(pass);
        return pass;
      }
    }
    const pool = new OnePassPool(
      flyApi,
      {
        size: 0,
        imageTag: "registry.example/img",
        maintenanceIntervalMs: 3_600_000,
        maintenancePassBudgetMs: 30,
      },
      recordingLogger().logger,
    );
    const sweep = sweepOf({ db, flyApi, pool, logger: recordingLogger().logger });

    try {
      pool.start({ sweep });
      expect(pool.passes).toHaveLength(1);
      expect(await settlesWithin(Promise.all(pool.passes))).toBe("ended");
    } finally {
      pool.stop();
    }
    expect(pool.stats()).toMatchObject({ sweepPasses: 1, sweepReadFailures: 1, sweepDestroyed: 0 });
  });
});

describe("the sweep of the run machines — two processes, one database", () => {
  it("never destroys the machine of a run one process serves before its deadline, whichever process sweeps", async () => {
    const db = new MemoryDb();
    const deadline = T0 + 20 * MIN;
    await admit(db, runId(1), deadline);
    await admit(db, runId(2), T0 + 60 * MIN);
    await finish(db, runId(2), T0 - MIN);
    const app = platform([
      runMachine("served", runId(1), { ageMs: 2 * 60 * MIN }),
      runMachine("done", runId(2), { ageMs: 30 * MIN }),
    ]);
    let clock = T0;
    const sweepA = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
      now: () => clock,
    });
    const sweepB = sweepOf({
      db,
      flyApi: app.flyApi,
      pool: counterPool(),
      logger: recordingLogger().logger,
      now: () => clock,
    });

    for (const at of [T0, T0 + 10 * MIN, deadline, deadline + GRACE - 1_000]) {
      clock = at;
      await sweepB(app.live(), never());
      await sweepA(app.live(), never());
      expect(app.live().map((m) => m.id)).toContain("served");
    }
    expect(app.destroyed).toEqual(["done"]);

    clock = deadline + GRACE + MIN;
    await sweepB(app.live(), never());
    expect(app.destroyed).toEqual(["done", "served"]);
  });
});

describe("the sweep of the run machines — its destructions", () => {
  it("counts a machine the platform already removed as destroyed — no failure, no warning", async () => {
    const db = new MemoryDb();
    await admit(db, runId(1), T0 + 60 * MIN);
    await finish(db, runId(1), T0 - 60 * MIN);
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl: (async () =>
        new Response('{"error":"machine not found"}', { status: 404 })) as typeof fetch,
      logger: recordingLogger().logger,
    });
    const pool = counterPool();
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi, pool, logger });

    const result = await sweep([runMachine("gone", runId(1), { ageMs: 2 * 60 * MIN })], never());

    expect(result).toEqual({ destroyed: 1, readFailures: 0 });
    expect(pool.stats().destroyFailures).toBe(0);
    expect(lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
  });

  it("counts a destruction that fails on the pool's counter, logs it by the error's class, and goes on", async () => {
    const db = new MemoryDb();
    for (const n of [1, 2]) {
      await admit(db, runId(n), T0 + 60 * MIN);
      await finish(db, runId(n), T0 - 60 * MIN);
    }
    const destroyed: string[] = [];
    const flyApi: RunMachineSweepOptions["flyApi"] = {
      destroy: async (machineId) => {
        if (machineId === "refused") throw new Error("platform said no to refused");
        destroyed.push(machineId);
      },
    };
    const pool = counterPool();
    const { logger, lines } = recordingLogger();
    const sweep = sweepOf({ db, flyApi, pool, logger });

    const result = await sweep(
      [
        runMachine("refused", runId(1), { ageMs: 2 * 60 * MIN }),
        runMachine("next", runId(2), { ageMs: 2 * 60 * MIN }),
      ],
      never(),
    );

    expect(result).toEqual({ destroyed: 1, readFailures: 0 });
    expect(destroyed).toEqual(["next"]);
    expect(pool.stats().destroyFailures).toBe(1);
    const failed = lines.filter((l) => l.fields.event === "run_machine_sweep_destroy_failed");
    expect(failed.map((l) => [l.level, l.fields.machine_id, l.fields.run_id])).toEqual([
      ["warn", "refused", runId(1)],
    ]);
    expect(JSON.stringify(failed)).not.toContain("platform said no");
  });
});
