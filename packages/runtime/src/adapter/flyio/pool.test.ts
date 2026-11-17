import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger.js";
import { type CreateProgress, FlyMachinesApi, type Machine } from "./fly-api.js";
import { type PooledMachine, RunnerPool, type RunnerPoolOptions } from "./pool.js";

const flyApi = {} as FlyMachinesApi;

function makePool(overrides: Partial<RunnerPoolOptions> = {}, now = () => 1_000_000): RunnerPool {
  return new RunnerPool(flyApi, {
    size: 2,
    imageTag: "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
    now,
    ...overrides,
  });
}

function seed(pool: RunnerPool, id: string, over: Partial<PooledMachine> = {}): PooledMachine {
  return pool.register({
    machineId: id,
    privateIp: `fdaa:0:1::${id}`,
    claimToken: "c".repeat(64),
    imageTag: "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
    ...over,
  });
}

describe("RunnerPool — registry and transitions", () => {
  it("is disabled at size 0, which is the default everywhere but our own cloud", () => {
    expect(makePool({ size: 0 }).enabled).toBe(false);
    expect(makePool({ size: 3 }).enabled).toBe(true);
  });

  it("registers a machine as filling — never offerable before it is confirmed ready", () => {
    const pool = makePool();
    const entry = seed(pool, "m1");
    expect(entry.state).toBe("filling");
    expect(pool.takeReady()).toBeUndefined();
  });

  it("promotes only from filling, so a claimed machine cannot be resurrected", () => {
    const pool = makePool();
    seed(pool, "m1");
    expect(pool.markReady("m1")).toBe(true);
    expect(pool.markReady("m1")).toBe(false); // already ready
    pool.takeReady();
    expect(pool.markReady("m1")).toBe(false); // claimed — the single-use invariant
    expect(pool.markReady("unknown")).toBe(false);
  });

  // The absence of await inside takeReady is the point: two runs arriving together
  // cannot be handed the same machine, because neither can interleave with the other.
  it("hands each ready machine to exactly one caller", () => {
    const pool = makePool({ size: 2 });
    seed(pool, "m1");
    seed(pool, "m2");
    pool.markReady("m1");
    pool.markReady("m2");

    const taken = [pool.takeReady(), pool.takeReady(), pool.takeReady()];
    expect(taken[0]?.machineId).not.toBe(taken[1]?.machineId);
    expect(taken[2]).toBeUndefined();
    expect(pool.stats()).toMatchObject({ ready: 0, claimed: 2 });
  });

  it("stops offering a machine the moment it is draining", () => {
    const pool = makePool();
    seed(pool, "m1");
    pool.markReady("m1");
    expect(pool.markDraining("m1")).toBe(true);
    expect(pool.takeReady()).toBeUndefined();
    expect(pool.stats().draining).toBe(1);
  });

  it("forgets a machine once it has actually been destroyed", () => {
    const pool = makePool();
    seed(pool, "m1");
    expect(pool.forget("m1")).toBe(true);
    expect(pool.get("m1")).toBeUndefined();
    expect(pool.forget("m1")).toBe(false);
  });
});

describe("RunnerPool — staleness", () => {
  // Not tidiness: a machine built from a superseded image would quietly run
  // superseded code, including anything shipped to fix a security problem.
  it("treats an image-tag mismatch as stale", () => {
    const pool = makePool();
    const fresh = seed(pool, "m1");
    const old = seed(pool, "m2", { imageTag: "registry.example/runner:v0" });
    expect(pool.isStale(fresh)).toBe(false);
    expect(pool.isStale(old)).toBe(true);
  });

  // A machine whose firewall rules admit a previous harness address cannot be
  // reached by this one — it would fail at assignment rather than at claim time.
  it("treats a harness-address mismatch as stale", () => {
    const pool = makePool();
    expect(pool.isStale(seed(pool, "m1", { harness6pn: "fdaa:0:1::99" }))).toBe(true);
  });

  it("does not confuse 'no address configured' with a mismatch", () => {
    const pool = makePool({ harness6pn: undefined });
    expect(pool.isStale(seed(pool, "m1", { harness6pn: undefined }))).toBe(false);
  });
});

describe("RunnerPool — expiry and deficit", () => {
  it("expires a machine that has sat unused past the idle limit", () => {
    let clock = 1_000_000;
    const pool = makePool({ maxIdleMs: 60_000 }, () => clock);
    const entry = seed(pool, "m1");
    expect(pool.isExpired(entry)).toBe(false);
    clock += 60_000;
    expect(pool.isExpired(entry)).toBe(true);
  });

  it("counts machines under construction towards the target, so a top-up cannot overshoot", () => {
    const pool = makePool({ size: 3 });
    expect(pool.deficit()).toBe(3);
    seed(pool, "m1"); // filling
    expect(pool.deficit()).toBe(2);
    seed(pool, "m2");
    pool.markReady("m2");
    expect(pool.deficit()).toBe(1);
  });

  it("counts a claimed or draining machine as gone, so the pool refills behind it", () => {
    const pool = makePool({ size: 1 });
    seed(pool, "m1");
    pool.markReady("m1");
    expect(pool.deficit()).toBe(0);
    pool.takeReady();
    expect(pool.deficit()).toBe(1);
  });
});

describe("RunnerPool — fill pipeline", () => {
  function fillHarness(opts: Partial<RunnerPoolOptions> = {}) {
    const calls: string[] = [];
    let n = 0;
    const flyApi = {
      create: async (req: { name?: string }) => {
        calls.push("create");
        n += 1;
        return { id: `m${n}`, name: req.name ?? "", state: "started", private_ip: `fdaa::${n}` };
      },
      suspend: async (id: string) => {
        calls.push(`suspend:${id}`);
      },
      destroy: async (id: string) => {
        calls.push(`destroy:${id}`);
      },
    } as unknown as FlyMachinesApi;

    const pool = new RunnerPool(flyApi, {
      size: 2,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
      now: () => 1_000_000,
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      ...opts,
    });
    return { pool, calls };
  }

  it("fills to the target and marks each machine ready only after its suspend", async () => {
    const { pool, calls } = fillHarness();
    await pool.fill();
    expect(pool.stats()).toMatchObject({ ready: 2, filling: 0, fillErrors: 0 });
    expect(calls).toEqual(["create", "suspend:m1", "create", "suspend:m2"]);
  });

  // The platform advises against suspending many machines at once, so a top-up
  // that fanned out would hit exactly that. Asserted through call ordering: a
  // create never overlaps the previous suspend.
  it("builds one machine at a time rather than fanning out", async () => {
    const { pool, calls } = fillHarness({ size: 3 });
    await pool.fill();
    expect(calls).toEqual(["create", "suspend:m1", "create", "suspend:m2", "create", "suspend:m3"]);
  });

  it("does nothing when the pool is disabled", async () => {
    const { pool, calls } = fillHarness({ size: 0 });
    await pool.fill();
    expect(calls).toEqual([]);
  });

  it("ignores a re-entrant fill, which would race the deficit and overshoot", async () => {
    const { pool, calls } = fillHarness({ size: 2 });
    await Promise.all([pool.fill(), pool.fill()]);
    expect(calls.filter((c) => c === "create")).toHaveLength(2);
  });

  // A machine that never answers is written off, not left behind: by name alone it
  // is indistinguishable from a working one, and it bills for as long as it lives.
  it("destroys a machine that never becomes ready, and counts the failure", async () => {
    const { pool, calls } = fillHarness({
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      maxBootTimeMs: 0,
    });
    await pool.fill();
    expect(calls).toContain("destroy:m1");
    expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
    expect(pool.get("m1")).toBeUndefined();
  });

  it("stops the round after a failure instead of hammering a failing platform", async () => {
    const { pool, calls } = fillHarness({
      size: 3,
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      maxBootTimeMs: 0,
    });
    await pool.fill();
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("never offers a machine whose suspend failed", async () => {
    const flyApi = {
      create: async () => ({ id: "m1", name: "p", state: "started", private_ip: "fdaa::1" }),
      suspend: async () => {
        throw new Error("not suspendable");
      },
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      now: () => 1,
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    await pool.fill();
    expect(pool.takeReady()).toBeUndefined();
    expect(pool.stats().fillErrors).toBe(1);
  });
});

describe("RunnerPool — draining", () => {
  function drainHarness(opts: Partial<RunnerPoolOptions> = {}) {
    const destroyed: string[] = [];
    const flyApi = {
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(flyApi, {
      size: 2,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
      now: () => 1_000_000,
      ...opts,
    });
    return { pool, destroyed };
  }

  it("destroys a machine built from a superseded image", async () => {
    const { pool, destroyed } = drainHarness();
    seed(pool, "old", { imageTag: "registry.example/runner:v0" });
    seed(pool, "new");
    pool.markReady("old");
    pool.markReady("new");

    expect(await pool.drainStale()).toBe(1);
    expect(destroyed).toEqual(["old"]);
    expect(pool.get("old")).toBeUndefined();
    expect(pool.get("new")?.state).toBe("ready");
    expect(pool.stats().drains).toBe(1);
  });

  it("destroys a machine whose rules admit a previous harness address", async () => {
    const { pool, destroyed } = drainHarness();
    seed(pool, "orphaned", { harness6pn: "fdaa:0:1::99" });
    pool.markReady("orphaned");
    await pool.drainStale();
    expect(destroyed).toEqual(["orphaned"]);
  });

  it("recycles a machine that has sat unused past the idle limit", async () => {
    let clock = 1_000_000;
    const { pool, destroyed } = drainHarness({ maxIdleMs: 60_000, now: () => clock });
    seed(pool, "idle");
    pool.markReady("idle");
    expect(await pool.drainStale()).toBe(0);
    clock += 60_000;
    expect(await pool.drainStale()).toBe(1);
    expect(destroyed).toEqual(["idle"]);
  });

  // A machine serving a run is destroyed by that run when it ends, not by a
  // background sweep that has no idea a run is in flight.
  it("never touches a machine that is already serving a run", async () => {
    const { pool, destroyed } = drainHarness();
    seed(pool, "busy", { imageTag: "registry.example/runner:v0" });
    pool.markReady("busy");
    pool.takeReady();
    expect(await pool.drainStale()).toBe(0);
    expect(destroyed).toEqual([]);
  });

  // A retirement is counted once the platform has destroyed the machine: one it
  // failed to destroy is a failed destruction, never a drain — as for the
  // reconciliation's.
  it("counts a retirement in drains only once its destruction is done", async () => {
    const asked: string[] = [];
    const flyApi = {
      destroy: async (id: string) => {
        asked.push(id);
        throw new Error("refused");
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(
      flyApi,
      {
        size: 2,
        imageTag: "registry.example/runner:v1",
        harness6pn: "fdaa:0:1::2",
        now: () => 1_000_000,
      },
      quiet,
    );
    seed(pool, "old", { imageTag: "registry.example/runner:v0" });
    pool.markReady("old");

    expect(await pool.drainStale()).toBe(0);
    expect(asked).toEqual(["old"]);
    expect(pool.get("old")).toBeUndefined();
    expect(pool.stats()).toMatchObject({ drains: 0, destroyFailures: 1 });
  });

  // A run arriving mid-drain must not wait: the machine leaves the offerable set
  // before it is destroyed, so the caller just finds an empty pool and goes cold.
  it("takes a draining machine out of service before destroying it", async () => {
    const { pool } = drainHarness();
    seed(pool, "old", { imageTag: "registry.example/runner:v0" });
    pool.markReady("old");
    const drain = pool.drainStale();
    expect(pool.takeReady()).toBeUndefined();
    await drain;
  });
});

describe("RunnerPool — reconciliation across harness instances", () => {
  const HOUR = 3_600_000;
  function reconcileHarness(live: Array<Record<string, unknown>>, now = 10 * HOUR) {
    const destroyed: string[] = [];
    const flyApi = {
      list: async () => live,
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      maxIdleMs: HOUR,
      now: () => now,
    });
    return { pool, destroyed };
  }

  const at = (ms: number) => new Date(ms).toISOString();

  it("reclaims a long-suspended pool machine no instance could still want", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "orphan", name: "skrun-pool-x", state: "suspended", updated_at: at(1 * HOUR) },
    ]);
    expect((await pool.reconcile()).destroyed).toBe(1);
    expect(destroyed).toEqual(["orphan"]);
    expect(pool.stats().orphansDestroyed).toBe(1);
  });

  // The critical case. Another instance's freshly-filled machine is unknown to
  // this one; destroying on "I have never heard of it" would eat its inventory.
  it("leaves a recently suspended machine alone — it may be another instance's", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "theirs", name: "skrun-pool-x", state: "suspended", updated_at: at(9.9 * HOUR) },
    ]);
    expect((await pool.reconcile()).destroyed).toBe(0);
    expect(destroyed).toEqual([]);
  });

  // The dangerous case: a started machine is very likely serving a run RIGHT NOW,
  // and that run may belong to a different harness instance entirely.
  it("never destroys a started machine within the run window", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "running", name: "skrun-pool-x", state: "started", updated_at: at(10 * HOUR - 60_000) },
    ]);
    expect((await pool.reconcile()).destroyed).toBe(0);
    expect(destroyed).toEqual([]);
  });

  it("reclaims a started machine untouched for far longer than a run can last", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "abandoned", name: "skrun-pool-x", state: "started", updated_at: at(1 * HOUR) },
    ]);
    expect((await pool.reconcile()).destroyed).toBe(1);
    expect(destroyed).toEqual(["abandoned"]);
  });

  it("ignores machines outside the pool namespace", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "a-run", name: "skrun-run-abc", state: "started", updated_at: at(1 * HOUR) },
    ]);
    await pool.reconcile();
    expect(destroyed).toEqual([]);
  });

  it("leaves its own machines to their own lifecycle", async () => {
    const { pool, destroyed } = reconcileHarness([
      { id: "mine", name: "skrun-pool-mine", state: "suspended", updated_at: at(1 * HOUR) },
    ]);
    seed(pool, "mine");
    pool.markReady("mine");
    await pool.reconcile();
    expect(destroyed).toEqual([]);
  });

  it("forgets a machine the platform no longer has once two listings have missed it", async () => {
    const { pool } = reconcileHarness([]);
    seed(pool, "vanished");
    expect((await pool.reconcile()).forgotten).toBe(0);
    expect(pool.get("vanished")).toBeDefined();
    expect((await pool.reconcile()).forgotten).toBe(1);
    expect(pool.get("vanished")).toBeUndefined();
    expect(pool.stats().vanished).toBe(1);
  });

  // Read through the real client: one machine of the app in a state it did not
  // read before used to fail the whole listing, and reconciliation skipped. A
  // machine that failed is judged as a paused one: past the idle limit, gone.
  it("goes on when the app holds machines in states the client did not read before", async () => {
    const live = [
      { id: "fresh", name: "skrun-run-a", state: "creating", updated_at: at(10 * HOUR) },
      { id: "broken", name: "skrun-pool-b", state: "failed", updated_at: at(1 * HOUR) },
      { id: "odd", name: "skrun-pool-c", state: "hibernating", updated_at: at(1 * HOUR) },
      { id: "orphan", name: "skrun-pool-x", state: "suspended", updated_at: at(1 * HOUR) },
    ];
    const destroyed: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "DELETE") {
        destroyed.push(new URL(String(input)).pathname.split("/").pop() ?? "");
        return new Response("", { status: 200 });
      }
      const listed = live.filter((m) => !destroyed.includes(m.id));
      return new Response(JSON.stringify(listed), { status: 200 });
    }) as typeof fetch;
    const pool = new RunnerPool(new FlyMachinesApi("token", "app", { fetchImpl }), {
      size: 1,
      imageTag: "registry.example/runner:v1",
      maxIdleMs: HOUR,
      now: () => 10 * HOUR,
    });
    seed(pool, "vanished");

    expect(await pool.reconcile()).toEqual({ destroyed: 2, forgotten: 0 });
    expect(await pool.reconcile()).toEqual({ destroyed: 0, forgotten: 1 });
    expect(destroyed).toEqual(["broken", "orphan"]);
    expect(pool.get("vanished")).toBeUndefined();
  });

  it("skips reconciliation rather than guessing when the platform cannot be listed", async () => {
    const flyApi = {
      list: async () => {
        throw new Error("api down");
      },
      destroy: async () => {
        throw new Error("must not be called");
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(flyApi, { size: 1, imageTag: "t", now: () => 0 });
    await expect(pool.reconcile()).resolves.toEqual({ destroyed: 0, forgotten: 0 });
  });
});

/** A logger that writes nothing: these passes log by design. */
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/**
 * A pool whose maintenance passes can be awaited — the ones its own start and
 * timer launch included, so a test sees what a server would.
 */
class WatchedPool extends RunnerPool {
  readonly passes: Promise<void>[] = [];

  protected override maintain(): Promise<void> {
    const pass = super.maintain();
    this.passes.push(pass);
    return pass;
  }

  /** One more pass, as the timer would run it. */
  pass(): Promise<void> {
    return this.maintain();
  }

  /** Every pass started so far, settled. */
  async settled(): Promise<void> {
    await Promise.allSettled(this.passes);
  }
}

/** A platform the maintenance reads: its listing, the destructions and creations asked of it. */
function maintainedPlatform(listed: Array<Record<string, unknown>>) {
  const destroyed: string[] = [];
  const created: string[] = [];
  const flyApi = {
    list: async () => listed.filter((m) => !destroyed.includes(String(m.id))),
    destroy: async (id: string) => {
      destroyed.push(id);
    },
    create: async (request: { name?: string }) => {
      created.push(request.name ?? "");
      throw new Error("no machine is made in this test");
    },
  } as unknown as FlyMachinesApi;
  return { flyApi, destroyed, created };
}

// A pool parked at size 0 used to run no maintenance at all, and the stock an
// earlier process left — paused, billing — stayed until someone noticed. The
// maintenance now runs at any size; at size 0 it never fills.
describe("RunnerPool — the maintenance runs at any size", () => {
  const HOUR = 3_600_000;
  const START = 10 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();
  const IMAGE = "registry.example/runner:v1";

  it("at size 0, destroys at its first pass every pooled machine not started and created before the process, and creates nothing", async () => {
    const before = at(START - HOUR);
    const recently = at(START - 60_000);
    const after = at(START + 1_000);
    const platform = maintainedPlatform([
      {
        id: "paused",
        name: "skrun-pool-a",
        state: "suspended",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "stopped",
        name: "skrun-pool-b",
        state: "stopped",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "failed",
        name: "skrun-pool-c",
        state: "failed",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "never-started",
        name: "skrun-pool-d",
        state: "created",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "started",
        name: "skrun-pool-e",
        state: "started",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "starting",
        name: "skrun-pool-f",
        state: "starting",
        created_at: before,
        updated_at: recently,
      },
      {
        id: "younger",
        name: "skrun-pool-g",
        state: "suspended",
        created_at: after,
        updated_at: after,
      },
      {
        id: "a-run",
        name: "skrun-run-r",
        state: "stopped",
        created_at: before,
        updated_at: recently,
      },
    ]);
    let clock = START;
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 0, imageTag: IMAGE, now: () => clock, maintenanceIntervalMs: 60_000 },
      quiet,
    );
    clock = START + 2_000;

    pool.start();
    await pool.settled();
    pool.stop();

    expect([...platform.destroyed].sort()).toEqual([
      "failed",
      "never-started",
      "paused",
      "stopped",
    ]);
    expect(platform.created).toEqual([]);
    expect(pool.stats()).toMatchObject({ orphansDestroyed: 4, drains: 0, fillErrors: 0 });
  });

  it("at size 2, leaves a pooled machine not started for an hour, and destroys it past the idle limit", async () => {
    const created = at(START - 2 * HOUR);
    const pausedAt = START - HOUR;
    const config = { image: IMAGE, env: {} };
    const platform = maintainedPlatform([
      {
        id: "paused",
        name: "skrun-pool-a",
        state: "suspended",
        created_at: created,
        updated_at: at(pausedAt),
        config,
      },
      {
        id: "stopped",
        name: "skrun-pool-b",
        state: "stopped",
        created_at: created,
        updated_at: at(pausedAt),
        config,
      },
      {
        id: "failed",
        name: "skrun-pool-c",
        state: "failed",
        created_at: created,
        updated_at: at(pausedAt),
        config,
      },
      {
        id: "never-started",
        name: "skrun-pool-d",
        state: "created",
        created_at: created,
        updated_at: at(pausedAt),
        config,
      },
    ]);
    let clock = START;
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 2, imageTag: IMAGE, now: () => clock, maintenanceIntervalMs: 60_000 },
      quiet,
    );

    pool.start();
    await pool.settled();
    const afterAnHour = [...platform.destroyed];

    clock = pausedAt + 6 * HOUR;
    await pool.pass();
    pool.stop();

    expect(afterAnHour).toEqual([]);
    expect([...platform.destroyed].sort()).toEqual([
      "failed",
      "never-started",
      "paused",
      "stopped",
    ]);
    expect(pool.stats()).toMatchObject({ orphansDestroyed: 4, drains: 0 });
  });
});

// A ready machine left past the idle limit, and a stock of a superseded image,
// used to be retired by a function nothing called. The maintenance retires
// both — the second only when an older process left it, judged on the image the
// platform lists, never on a harness address.
describe("RunnerPool — the age and the image, applied", () => {
  const HOUR = 3_600_000;
  const START = 10 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();
  const IMAGE = "registry.example/runner:v1";
  const OLDER_IMAGE = "registry.example/runner:v0";
  const HARNESS = "fdaa:0:1::2";
  const DIGEST = `sha256:${"0a".repeat(32)}`;
  /** When the passes below run: six hours after the process started. */
  const PASS = START + 6 * HOUR;

  /** An unknown pooled machine, paused a minute before the pass and created before the process. */
  function paused(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      name: `skrun-pool-${id}`,
      state: "suspended",
      created_at: at(START - 2 * HOUR),
      updated_at: at(PASS - 60_000),
      config: { image: IMAGE, env: { RUNNER_HARNESS_6PN: HARNESS } },
      ...over,
    };
  }

  it("retires its own ready machine past the idle limit and a stock of another image an older process left, never one of another harness address", async () => {
    const platform = maintainedPlatform([
      paused("ours", { created_at: at(START) }),
      paused("older-image", {
        config: { image: OLDER_IMAGE, env: { RUNNER_HARNESS_6PN: HARNESS } },
      }),
      paused("other-harness", {
        config: { image: IMAGE, env: { RUNNER_HARNESS_6PN: "fdaa:0:9::9" } },
      }),
      paused("same-image"),
      paused("same-image-with-digest", {
        config: { image: `${IMAGE}@${DIGEST}`, env: { RUNNER_HARNESS_6PN: HARNESS } },
      }),
      paused("started-older-image", {
        state: "started",
        config: { image: OLDER_IMAGE, env: { RUNNER_HARNESS_6PN: HARNESS } },
      }),
    ]);
    let clock = START;
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 1, imageTag: IMAGE, harness6pn: HARNESS, now: () => clock },
      quiet,
    );
    seed(pool, "ours");
    pool.markReady("ours");
    clock = PASS;

    await pool.pass();

    expect([...platform.destroyed].sort()).toEqual(["older-image", "ours"]);
    expect(pool.stats()).toMatchObject({ drains: 2, orphansDestroyed: 0 });
  });

  it("compares a configured image that pins a digest whole", async () => {
    const OTHER_DIGEST = `sha256:${"0b".repeat(32)}`;
    const platform = maintainedPlatform([
      paused("same-digest", {
        config: { image: `${IMAGE}@${DIGEST}`, env: { RUNNER_HARNESS_6PN: HARNESS } },
      }),
      paused("other-digest", {
        config: { image: `${IMAGE}@${OTHER_DIGEST}`, env: { RUNNER_HARNESS_6PN: HARNESS } },
      }),
    ]);
    let clock = START;
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 2, imageTag: `${IMAGE}@${DIGEST}`, harness6pn: HARNESS, now: () => clock },
      quiet,
    );
    clock = PASS;

    await pool.pass();

    expect(platform.destroyed).toEqual(["other-digest"]);
    expect(pool.stats()).toMatchObject({ drains: 1 });
  });

  // A listing that does not carry a machine's configuration says nothing of its
  // image: read as "different", it would empty every stock at every boot.
  it("at size 2, leaves every pooled machine whose image the listing does not carry", async () => {
    const platform = maintainedPlatform([
      paused("no-config", { config: undefined }),
      paused("no-image", { config: { env: {} } }),
      paused("empty-image", { config: { image: "", env: {} } }),
      paused("stopped-no-config", { state: "stopped", config: undefined }),
    ]);
    let clock = START;
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 2, imageTag: IMAGE, harness6pn: HARNESS, now: () => clock },
      quiet,
    );
    clock = PASS;

    await pool.pass();

    expect(platform.destroyed).toEqual([]);
    expect(pool.stats()).toMatchObject({ drains: 0, orphansDestroyed: 0 });
  });

  /**
   * One platform for two harness processes: what one creates, the other lists;
   * what one destroys, the other no longer sees.
   */
  function sharedPlatform(clock: () => number) {
    type Held = {
      id: string;
      name: string;
      state: string;
      private_ip: string;
      created_at: string;
      updated_at: string;
      config: { image: string; env?: Record<string, string> };
    };
    const machines = new Map<string, Held>();
    const destroyed: string[] = [];
    let seq = 0;
    const flyApi = {
      create: async (request: { name?: string; config: Held["config"] }) => {
        seq += 1;
        const machine: Held = {
          id: `m${seq}`,
          name: request.name ?? "",
          state: "started",
          private_ip: `fdaa::${seq}`,
          created_at: at(clock()),
          updated_at: at(clock()),
          config: { image: request.config.image, env: request.config.env },
        };
        machines.set(machine.id, machine);
        return { ...machine };
      },
      suspend: async (id: string) => {
        const machine = machines.get(id);
        if (machine) {
          machine.state = "suspended";
          machine.updated_at = at(clock());
        }
      },
      list: async () => [...machines.values()].map((m) => ({ ...m })),
      destroy: async (id: string) => {
        destroyed.push(id);
        machines.delete(id);
      },
      listByLabel: async () => [],
    } as unknown as FlyMachinesApi;
    return { flyApi, machines, destroyed };
  }

  function harness(
    platform: ReturnType<typeof sharedPlatform>,
    clock: () => number,
    size: number,
    imageTag: string,
  ): WatchedPool {
    return new WatchedPool(
      platform.flyApi,
      {
        size,
        imageTag,
        harness6pn: HARNESS,
        now: clock,
        sleepImpl: async () => {},
        fetchImpl: (async () =>
          new Response(JSON.stringify({ process_id: "p" }), {
            status: 200,
          })) as unknown as typeof fetch,
      },
      quiet,
    );
  }

  /** The ids of the machines a pool holds ready. */
  const readyOf = (pool: RunnerPool) =>
    pool
      .all()
      .filter((m) => m.state === "ready")
      .map((m) => m.machineId)
      .sort();

  it.each([
    ["a deploy", OLDER_IMAGE, IMAGE],
    ["a rollback", IMAGE, OLDER_IMAGE],
  ])("on %s, only the newer process empties the older one's stock, and neither touches the other's after", async (_what, imageOfA, imageOfB) => {
    let now = START;
    const clock = () => now;
    const platform = sharedPlatform(clock);
    const a = harness(platform, clock, 2, imageOfA);
    await a.pass();
    const stockOfA = readyOf(a);

    now += HOUR;
    const b = harness(platform, clock, 2, imageOfB);
    await b.pass();
    const stockOfB = readyOf(b);
    // Both keep passing — the older one refilling what it lost — and nothing
    // more is destroyed on either side.
    for (let pass = 0; pass < 3; pass += 1) {
      now += 60_000;
      await a.pass();
      await b.pass();
    }

    expect(stockOfA).toHaveLength(2);
    expect(stockOfB).toHaveLength(2);
    expect([...platform.destroyed].sort()).toEqual(stockOfA);
    expect(readyOf(b)).toEqual(stockOfB);
    expect(b.stats()).toMatchObject({ drains: 2, orphansDestroyed: 0 });
    expect(a.stats()).toMatchObject({ drains: 0, orphansDestroyed: 0 });
  });

  it("on one image, a newer process leaves the older one's stock, and counts no retirement", async () => {
    let now = START;
    const clock = () => now;
    const platform = sharedPlatform(clock);
    const a = harness(platform, clock, 2, IMAGE);
    await a.pass();
    now += HOUR;
    const b = harness(platform, clock, 2, IMAGE);
    await b.pass();
    await a.pass();

    expect(platform.destroyed).toEqual([]);
    expect(platform.machines.size).toBe(4);
    expect(a.stats()).toMatchObject({ drains: 0, orphansDestroyed: 0 });
    expect(b.stats()).toMatchObject({ drains: 0, orphansDestroyed: 0 });
  });

  it("parked at 0 after the other, a process empties the older stock; parked at 0 before it, it never touches the newer one's", async () => {
    // A newer process at size 0: the stock an older one left is emptied.
    let now = START;
    const clock = () => now;
    const first = sharedPlatform(clock);
    const older = harness(first, clock, 2, IMAGE);
    await older.pass();
    const stockOfOlder = readyOf(older);
    now += HOUR;
    const parked = harness(first, clock, 0, IMAGE);
    await parked.pass();

    // An older process at size 0: a newer one's stock is left, and no
    // destroy-and-refill loop starts between them.
    now = START;
    const second = sharedPlatform(clock);
    const parkedFirst = harness(second, clock, 0, IMAGE);
    now += HOUR;
    const newer = harness(second, clock, 2, IMAGE);
    for (let pass = 0; pass < 3; pass += 1) {
      await newer.pass();
      await parkedFirst.pass();
      now += 60_000;
    }

    expect([...first.destroyed].sort()).toEqual(stockOfOlder);
    expect(parked.stats()).toMatchObject({ orphansDestroyed: 2, drains: 0 });
    expect(second.destroyed).toEqual([]);
    expect(second.machines.size).toBe(2);
    expect(newer.stats()).toMatchObject({ ready: 2, fillErrors: 0 });
  });
});

// The timer starts a pass every interval without waiting for the last one: two
// reconciliations at once would destroy the same machine twice. One at a time —
// but only the reconciliation, the retirement and the sweep: a fill holds a
// machine for minutes, and waiting for it would skip as many reconciliations.
describe("RunnerPool — one reconciliation at a time, and the sweep on its listing", () => {
  const HOUR = 3_600_000;
  const at = (ms: number) => new Date(ms).toISOString();
  const IMAGE = "registry.example/runner:v1";

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A promise and the hand that settles it. */
  function deferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** A logger that keeps every line it is given, with the sentence it ends on. */
  function recording() {
    const lines: Array<{ fields: Record<string, unknown>; msg: unknown }> = [];
    const keep = (fields: Record<string, unknown>, msg?: unknown) => {
      lines.push({ fields, msg });
    };
    const logger = { info: keep, warn: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, line: (event: string) => lines.find((l) => l.fields.event === event) };
  }

  it("skips and counts a pass that finds the last reconciliation still running, and destroys nothing twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const now = 10 * HOUR;
    const slow = deferred();
    const arrived = deferred();
    const asked: string[] = [];
    let lists = 0;
    const api = {
      // Listed until its destruction completes, as the platform would.
      list: async () => {
        lists += 1;
        return [{ id: "orphan", name: "skrun-pool-x", state: "suspended", updated_at: at(HOUR) }];
      },
      destroy: (id: string) => {
        asked.push(id);
        arrived.resolve();
        return slow.promise;
      },
    } as unknown as FlyMachinesApi;
    const pool = new WatchedPool(
      api,
      { size: 0, imageTag: IMAGE, maxIdleMs: HOUR, now: () => now, maintenanceIntervalMs: 1_000 },
      quiet,
    );

    pool.start();
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    slow.resolve();
    await pool.settled();
    pool.stop();

    expect(asked).toEqual(["orphan"]);
    expect(lists).toBe(1);
    expect(pool.stats()).toMatchObject({ skippedPasses: 2, orphansDestroyed: 1 });
  });

  it("reconciles and sweeps on every interval while a fill of three machines takes two minutes each", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const listed = new Map<string, Record<string, unknown>>();
    const created: string[] = [];
    let lists = 0;
    const api = {
      list: async () => {
        lists += 1;
        return [...listed.values()];
      },
      create: async (request: { name?: string }) => {
        const machine = {
          id: `m${created.length + 1}`,
          name: request.name ?? "",
          state: "started",
          private_ip: `fdaa::${created.length + 1}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        created.push(machine.id);
        listed.set(machine.id, machine);
        return machine;
      },
      // Each pause takes two minutes.
      suspend: (id: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            const machine = listed.get(id);
            if (machine) machine.state = "suspended";
            resolve();
          }, 120_000),
        ),
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const sweeps: number[] = [];
    const pool = new WatchedPool(
      api,
      {
        size: 3,
        imageTag: IMAGE,
        maintenanceIntervalMs: 60_000,
        sleepImpl: async () => {},
        fetchImpl: (async () =>
          new Response(JSON.stringify({ process_id: "p" }), {
            status: 200,
          })) as unknown as typeof fetch,
      },
      quiet,
    );

    pool.start({
      sweep: async (live) => {
        sweeps.push(live.length);
        return { destroyed: 0, readFailures: 0 };
      },
    });
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1_000);
    pool.stop();
    await pool.settled();

    expect(created).toEqual(["m1", "m2", "m3"]);
    expect(pool.stats()).toMatchObject({ ready: 3, skippedPasses: 0, sweepPasses: 7 });
    expect(lists).toBe(7);
    expect(sweeps).toHaveLength(7);
  });

  it("hands the sweep the listing of its pass, from one listing, with the pass's signal, and counts what it did", async () => {
    const listing = [
      { id: "r1", name: "skrun-run-a", state: "started", updated_at: at(9 * HOUR) },
      { id: "p1", name: "skrun-pool-b", state: "suspended", updated_at: at(9 * HOUR) },
    ];
    let lists = 0;
    const api = {
      list: async () => {
        lists += 1;
        return listing;
      },
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const received: Array<{ live: unknown; signal: AbortSignal }> = [];
    const pool = new WatchedPool(
      api,
      { size: 0, imageTag: IMAGE, now: () => 10 * HOUR, maintenanceIntervalMs: 60_000 },
      quiet,
    );

    pool.start({
      sweep: async (live, signal) => {
        received.push({ live, signal });
        return { destroyed: 2, readFailures: 1 };
      },
    });
    await pool.settled();
    pool.stop();

    expect(lists).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.live).toEqual(listing);
    expect(received[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(received[0]?.signal.aborted).toBe(false);
    expect(pool.stats()).toMatchObject({
      sweepPasses: 1,
      sweepDestroyed: 2,
      sweepReadFailures: 1,
    });
  });

  it("logs a sweep that throws by the error's class, and lets the reconciliation and the fill run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const WITNESS = "witness-51ee";
    let clock = 10 * HOUR;
    const destroyed: string[] = [];
    let creates = 0;
    let passes = 0;
    const api = {
      // A paused orphan past the idle limit, a fresh one every pass.
      list: async () => {
        passes += 1;
        return [
          {
            id: `orphan-${passes}`,
            name: `skrun-pool-${passes}`,
            state: "suspended",
            updated_at: at(HOUR),
          },
        ];
      },
      destroy: async (id: string) => {
        destroyed.push(id);
      },
      create: async () => {
        creates += 1;
        throw new Error("no machine is made in this test");
      },
    } as unknown as FlyMachinesApi;
    const log = recording();
    let sweeps = 0;
    const pool = new WatchedPool(
      api,
      {
        size: 1,
        imageTag: IMAGE,
        maxIdleMs: HOUR,
        now: () => clock,
        maintenanceIntervalMs: 1_000,
      },
      log.logger,
    );

    pool.start({
      sweep: async () => {
        sweeps += 1;
        if (sweeps === 2) throw new Error(`database unreachable ${WITNESS}`);
        return { destroyed: 0, readFailures: 0 };
      },
    });
    await pool.settled();
    clock += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await pool.settled();
    pool.stop();

    expect(sweeps).toBe(2);
    expect(destroyed).toEqual(["orphan-1", "orphan-2"]);
    expect(creates).toBe(2);
    expect(pool.stats()).toMatchObject({ sweepPasses: 1, orphansDestroyed: 2 });
    const line = log.line("pool_sweep_failed");
    expect(line?.fields).toMatchObject({ error_name: "Error" });
    expect(JSON.stringify(line)).not.toContain(WITNESS);
  });
});

// A machine the platform stops listing, without this process destroying it,
// used to be forgotten on the first listing that missed it — and counted
// nowhere. A listing can miss a machine just made, or one that is there: it is
// forgotten only once two listings in a row, both sent after it was
// registered, have missed it, and it is counted.
describe("RunnerPool — a pooled machine the platform stops listing", () => {
  const MINUTE = 60_000;
  const START = 10 * 3_600_000;
  const IMAGE = "registry.example/runner:v1";
  const HARNESS = "fdaa:0:1::2";
  const at = (ms: number) => new Date(ms).toISOString();

  /** One of the pool's machines as the platform lists it, paused. */
  const listed = (id: string) => ({
    id,
    name: `skrun-pool-${id}`,
    state: "suspended",
    created_at: at(START),
    updated_at: at(START),
    config: { image: IMAGE },
  });

  /**
   * A platform whose listings are the ones the test gives, in turn — each a
   * function, so that something can happen while a listing is in flight. It
   * keeps what it was asked to destroy and to create, and creates nothing.
   */
  function scripted(listings: Array<() => Array<Record<string, unknown>>>) {
    const destroyed: string[] = [];
    let creates = 0;
    let lists = 0;
    const flyApi = {
      list: async () => {
        const next = listings[lists];
        lists += 1;
        if (!next) throw new Error("no listing given for this pass");
        return next();
      },
      destroy: async (id: string) => {
        destroyed.push(id);
      },
      create: async () => {
        creates += 1;
        throw new Error("no machine is made in this test");
      },
    } as unknown as FlyMachinesApi;
    return { flyApi, destroyed, creates: () => creates };
  }

  function poolOn(flyApi: FlyMachinesApi, clock: () => number, size = 1): WatchedPool {
    return new WatchedPool(
      flyApi,
      { size, imageTag: IMAGE, harness6pn: HARNESS, now: clock, maintenanceIntervalMs: MINUTE },
      quiet,
    );
  }

  it("forgets a ready machine the listings stop returning on the second pass that misses it, never the first, and counts it", async () => {
    let now = START;
    const platform = scripted([() => [], () => []]);
    const pool = poolOn(platform.flyApi, () => now);
    seed(pool, "gone");
    pool.markReady("gone");

    now += MINUTE;
    await pool.pass();
    const afterOne = { held: pool.get("gone") !== undefined, vanished: pool.stats().vanished };
    now += MINUTE;
    await pool.pass();

    expect(afterOne).toEqual({ held: true, vanished: 0 });
    expect(pool.get("gone")).toBeUndefined();
    expect(pool.stats().vanished).toBe(1);
    expect(platform.destroyed).toEqual([]);
  });

  it("keeps a machine registered while a listing that does not return it was in flight", async () => {
    let now = START;
    let pool: WatchedPool | undefined;
    const platform = scripted([
      // The fill registers its machine after this listing was sent.
      () => {
        now += 1_000;
        if (pool) seed(pool, "late");
        return [];
      },
      () => [],
    ]);
    pool = poolOn(platform.flyApi, () => now);

    await pool.pass();
    now += MINUTE;
    await pool.pass();

    expect(pool.get("late")?.state).toBe("filling");
    expect(pool.stats().vanished).toBe(0);
  });

  it("never forgets a machine one listing missed and the next returned", async () => {
    let now = START;
    const platform = scripted([() => [], () => [listed("flaky")], () => []]);
    const pool = poolOn(platform.flyApi, () => now);
    seed(pool, "flaky");
    pool.markReady("flaky");

    for (let pass = 0; pass < 3; pass += 1) {
      now += MINUTE;
      await pool.pass();
    }

    expect(pool.get("flaky")?.state).toBe("ready");
    expect(pool.stats().vanished).toBe(0);
  });

  // A listing that fails says nothing. Read as an empty one, it would forget
  // every machine the pool holds — which then fills on top of them — and hand
  // the sweep a platform with nothing on it.
  it("forgets nothing, counts nothing vanished, fills nothing and calls no sweep while the listing fails", async () => {
    let now = START;
    const platform = scripted([]);
    const pool = poolOn(platform.flyApi, () => now, 2);
    for (const id of ["a", "b"]) {
      seed(pool, id);
      pool.markReady(id);
    }
    const sweeps: Machine[][] = [];

    pool.start({
      sweep: async (live) => {
        sweeps.push(live);
        return { destroyed: 0, readFailures: 0 };
      },
    });
    await pool.settled();
    now += MINUTE;
    await pool.pass();
    pool.stop();

    expect(
      pool
        .all()
        .map((m) => m.machineId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(pool.stats()).toMatchObject({ vanished: 0, ready: 2 });
    expect(sweeps).toEqual([]);
    expect(platform.creates()).toBe(0);
  });
});

// A started pooled machine nobody holds may be serving another instance's run:
// it is taken for abandoned only past a window the composition derives from the
// longest a run may last. The window used to be four default run timeouts —
// 20 min — whatever the instance allowed.
describe("RunnerPool — the window of a started pooled machine nobody holds", () => {
  const MINUTE = 60_000;
  const START = 10 * 3_600_000;
  const IMAGE = "registry.example/runner:v1";
  const at = (ms: number) => new Date(ms).toISOString();

  it.each([
    ["spared with a window of 31 min", { startedOrphanWindowMs: 31 * MINUTE }, []],
    ["destroyed without one, past the default", {}, ["running"]],
  ])("a started pooled machine untouched for 21 min is %s", async (_what, startOptions, expected) => {
    const platform = maintainedPlatform([
      {
        id: "running",
        name: "skrun-pool-r",
        state: "started",
        created_at: at(START - 21 * MINUTE),
        updated_at: at(START - 21 * MINUTE),
        config: { image: IMAGE },
      },
    ]);
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 1, imageTag: IMAGE, now: () => START, maintenanceIntervalMs: 3_600_000 },
      quiet,
    );

    pool.start(startOptions);
    await pool.settled();
    pool.stop();

    expect(platform.destroyed).toEqual(expected);
  });

  // Assigned to a run, a pooled machine carries its run's label: the sweep
  // judges it on its run's row, whatever its window says. A reconciliation run
  // with no sweep to hand it to still judges it on the window.
  it.each([
    ["left to the sweep, past any window", true, ["unassigned"], ["assigned", "unassigned"]],
    ["judged on the window when no sweep runs", false, ["assigned", "unassigned"], []],
  ])("a started pooled machine its run labels, untouched for 9 h, is %s", async (_what, withSweep, destroyed, swept) => {
    const started = (id: string, metadata: Record<string, string>) => ({
      id,
      name: `skrun-pool-${id}`,
      state: "started",
      created_at: at(START - 10 * 60 * MINUTE),
      updated_at: at(START - 9 * 60 * MINUTE),
      config: { image: IMAGE, metadata },
    });
    const platform = maintainedPlatform([
      started("assigned", {
        skrun_pool_id: "assigned",
        skrun_run_id: "00000000-0000-4000-8000-000000000001",
        skrun_lifetime_end: at(START - 60 * MINUTE),
      }),
      started("unassigned", { skrun_pool_id: "unassigned" }),
    ]);
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 1, imageTag: IMAGE, now: () => START, maintenanceIntervalMs: 3_600_000 },
      quiet,
    );
    const handed: string[] = [];

    pool.start(
      withSweep
        ? {
            sweep: async (live) => {
              handed.push(...live.map((m) => m.id));
              return { destroyed: 0, readFailures: 0 };
            },
          }
        : {},
    );
    await pool.settled();
    pool.stop();

    expect(platform.destroyed).toEqual(destroyed);
    // The sweep gets the pass's whole listing: what the reconciliation left among it.
    expect(handed).toEqual(swept);
  });

  // The two writes of an assignment are separate: either can land and the other
  // fail. The sweep never takes a pooled machine that declares no end past a
  // fallback — it has none —, nor one that carries no run's label — it never
  // looks at it —, so a machine missing either is left to the reconciliation's
  // window, a sweep running or not.
  it("a started pooled machine its run labels without the end of its life, or the other way round, untouched for 9 h, is judged on the window", async () => {
    const platform = maintainedPlatform([
      {
        id: "labelled",
        name: "skrun-pool-labelled",
        state: "started",
        created_at: at(START - 10 * 60 * MINUTE),
        updated_at: at(START - 9 * 60 * MINUTE),
        config: {
          image: IMAGE,
          metadata: {
            skrun_pool_id: "labelled",
            skrun_run_id: "00000000-0000-4000-8000-000000000001",
          },
        },
      },
      {
        id: "unreadable-end",
        name: "skrun-pool-unreadable-end",
        state: "started",
        created_at: at(START - 10 * 60 * MINUTE),
        updated_at: at(START - 9 * 60 * MINUTE),
        config: {
          image: IMAGE,
          metadata: {
            skrun_pool_id: "unreadable-end",
            skrun_run_id: "00000000-0000-4000-8000-000000000002",
            skrun_lifetime_end: "tomorrow",
          },
        },
      },
      {
        id: "end-without-label",
        name: "skrun-pool-end-without-label",
        state: "started",
        created_at: at(START - 10 * 60 * MINUTE),
        updated_at: at(START - 9 * 60 * MINUTE),
        config: {
          image: IMAGE,
          metadata: {
            skrun_pool_id: "end-without-label",
            skrun_lifetime_end: at(START + 30 * MINUTE),
          },
        },
      },
    ]);
    const pool = new WatchedPool(
      platform.flyApi,
      { size: 1, imageTag: IMAGE, now: () => START, maintenanceIntervalMs: 3_600_000 },
      quiet,
    );

    pool.start({ sweep: async () => ({ destroyed: 0, readFailures: 0 }) });
    await pool.settled();
    pool.stop();

    expect(platform.destroyed).toEqual(["labelled", "unreadable-end", "end-without-label"]);
  });
});

// A reconciliation lists the app, then destroys what it judged one machine at a
// time — and another process may wake one of them for a run in between. A
// machine it judged not started is destroyed without force, which the platform
// refuses for a machine running by then (measured against it on 2026-10-23):
// that one is spared, neither destroyed nor failed. A machine created and never
// started is refused without force whatever happens; only its fill starts it,
// and a fill is bounded: past that bound it is destroyed with force, before it
// left to a later pass. A started machine past its window keeps force.
describe("RunnerPool — a machine woken between the listing and its destruction", () => {
  const HOUR = 3_600_000;
  const START = 10 * HOUR;
  const IMAGE = "registry.example/runner:v1";
  const OLDER_IMAGE = "registry.example/runner:v0";
  const at = (ms: number) => new Date(ms).toISOString();
  const REFUSED_IN_STATE =
    '{"error":"failed_precondition: unable to destroy machine, not currently stopped, suspended, failed, pending, or archived"}';

  /**
   * The platform as measured, behind the real client: a listing of its
   * machines; a DELETE with force destroys any of them, one without destroys a
   * stopped, suspended or failed machine and refuses any other, 412. `onDelete`
   * runs as each DELETE arrives, before it is answered — where a peer wakes a
   * machine.
   */
  function platform(
    machines: Array<Record<string, unknown>>,
    onDelete?: (id: string, live: Map<string, Record<string, unknown>>) => void,
  ) {
    const live = new Map(machines.map((m) => [String(m.id), { ...m }]));
    const deletes: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "DELETE") {
        const id = url.pathname.split("/").pop() ?? "";
        const forced = url.searchParams.get("force") === "true";
        deletes.push(forced ? `${id}?force=true` : id);
        onDelete?.(id, live);
        const machine = live.get(id);
        if (!machine) return new Response('{"error":"machine not found"}', { status: 404 });
        if (!forced && !["stopped", "suspended", "failed"].includes(String(machine.state))) {
          return new Response(REFUSED_IN_STATE, { status: 412 });
        }
        live.delete(id);
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify([...live.values()]), { status: 200 });
    }) as typeof fetch;
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl,
      sleepImpl: async () => {},
      logger: quiet,
    });
    return { live, deletes, flyApi };
  }

  /** A logger that keeps every line, with its level. */
  function recording() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (level: string) => (fields: Record<string, unknown>) => {
      lines.push({ level, ...fields });
    };
    const logger = {
      info: keep("info"),
      warn: keep("warn"),
      error: keep("error"),
      debug: keep("debug"),
    } as unknown as Logger;
    return { logger, lines };
  }

  it.each([
    ["parked", { size: 0 }, IMAGE, START - 60_000],
    ["image", { size: 1 }, OLDER_IMAGE, START - 60_000],
    ["idle", { size: 1, maxIdleMs: HOUR }, IMAGE, START - 2 * HOUR],
  ] as const)("a machine judged %s, listed suspended and woken by another process before its destruction, is spared: never destroyed, never counted", async (reason, options, image, updatedAt) => {
    const listed = (id: string) => ({
      id,
      name: `skrun-pool-${id}`,
      state: "suspended",
      created_at: at(START - 2 * HOUR),
      updated_at: at(updatedAt),
      config: { image },
    });
    // The peer wakes a2 for a run while the first destruction is under way.
    const fly = platform([listed("a1"), listed("a2")], (id, live) => {
      if (id !== "a1") return;
      const woken = live.get("a2");
      if (woken) Object.assign(woken, { state: "started", updated_at: at(START) });
    });
    const log = recording();
    const pool = new RunnerPool(
      fly.flyApi,
      { ...options, imageTag: IMAGE, now: () => START },
      log.logger,
    );

    const result = await pool.reconcile();

    expect(fly.deletes).toEqual(["a1", "a2"]);
    expect([...fly.live.keys()]).toEqual(["a2"]);
    expect(result).toEqual({ destroyed: 1, forgotten: 0 });
    expect(pool.stats()).toMatchObject({
      destroyFailures: 0,
      orphansDestroyed: reason === "image" ? 0 : 1,
      drains: reason === "image" ? 1 : 0,
    });
    const aboutA2 = log.lines.filter((line) => line.machine_id === "a2");
    expect(aboutA2).toEqual([
      {
        level: "info",
        event: "pool_orphan_spared",
        machine_id: "a2",
        machine_state: "suspended",
        reason,
        spared: "refused_in_state",
      },
    ]);
  });

  it("destroys a machine listed stopped or failed without force", async () => {
    const fly = platform(
      ["stopped", "failed"].map((state) => ({
        id: state,
        name: `skrun-pool-${state}`,
        state,
        created_at: at(START - HOUR),
        updated_at: at(START - 60_000),
      })),
    );
    const pool = new RunnerPool(fly.flyApi, { size: 0, imageTag: IMAGE, now: () => START }, quiet);

    expect(await pool.reconcile()).toEqual({ destroyed: 2, forgotten: 0 });
    expect(fly.deletes).toEqual(["stopped", "failed"]);
    expect(fly.live.size).toBe(0);
    expect(pool.stats()).toMatchObject({ orphansDestroyed: 2, destroyFailures: 0 });
  });

  // 753 s on the defaults: the fill's bound — 723 s, the longest one creation
  // waits in the client (123 s) plus four creation attempts of 60 s, a boot
  // budget of 120 s and four pause attempts of 60 s — plus three clean-up steps
  // of 10 s.
  it.each([
    ["on the defaults: 753 s", {}, 753_000],
    [
      "on a fill's bound of 60 s and clean-up steps of 1 s: 63 s",
      { fillStepBudgetMs: 60_000, cleanupStepMs: 1_000 },
      63_000,
    ],
  ] as const)("a machine listed created is destroyed with force once older than a fill's bound and its clean-up, and left to a later pass before — %s", async (_what, options, boundMs) => {
    const created = (id: string, ageMs: number) => ({
      id,
      name: `skrun-pool-${id}`,
      state: "created",
      created_at: at(START - ageMs),
      updated_at: at(START - ageMs),
    });
    const fly = platform([created("young", boundMs - 1_000), created("old", boundMs + 1_000)]);
    const log = recording();
    const pool = new RunnerPool(
      fly.flyApi,
      { ...options, size: 0, imageTag: IMAGE, now: () => START },
      log.logger,
    );

    expect(await pool.reconcile()).toEqual({ destroyed: 1, forgotten: 0 });
    expect(fly.deletes).toEqual(["old?force=true"]);
    expect([...fly.live.keys()]).toEqual(["young"]);
    expect(pool.stats()).toMatchObject({ orphansDestroyed: 1, destroyFailures: 0 });
    expect(log.lines.filter((line) => line.machine_id === "young")).toEqual([
      {
        level: "info",
        event: "pool_orphan_spared",
        machine_id: "young",
        machine_state: "created",
        reason: "parked",
        spared: "created_within_fill_bound",
      },
    ]);
  });

  // Its creation time is what says no fill can start it any more; its last
  // update, however old, never stands in for it.
  it("a machine listed created with no creation time to read is spared, however old its last update", async () => {
    const created = (id: string, createdAt: string | undefined) => ({
      id,
      name: `skrun-pool-${id}`,
      state: "created",
      ...(createdAt !== undefined && { created_at: createdAt }),
      updated_at: at(START - 7 * HOUR),
    });
    const fly = platform([created("absent", undefined), created("unreadable", "not a date")]);
    const log = recording();
    const pool = new RunnerPool(
      fly.flyApi,
      { size: 1, imageTag: IMAGE, now: () => START },
      log.logger,
    );

    expect(await pool.reconcile()).toEqual({ destroyed: 0, forgotten: 0 });
    expect(fly.deletes).toEqual([]);
    expect(log.lines.filter((line) => line.event === "pool_orphan_spared")).toEqual(
      ["absent", "unreadable"].map((id) => ({
        level: "info",
        event: "pool_orphan_spared",
        machine_id: id,
        machine_state: "created",
        reason: "idle",
        spared: "created_within_fill_bound",
      })),
    );
  });

  it("counts a destruction that failed as failed, never as destroyed", async () => {
    const failing = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl: failing,
      sleepImpl: async () => {},
      logger: quiet,
    });
    const pool = new RunnerPool(flyApi, { size: 1, imageTag: IMAGE, now: () => START }, quiet);
    // One of another image, one paused past the idle limit (6 h by default).
    const listing = {
      sentAt: START,
      machines: [
        {
          id: "superseded",
          name: "skrun-pool-a",
          state: "suspended" as const,
          created_at: at(START - HOUR),
          updated_at: at(START - HOUR),
          config: { image: OLDER_IMAGE },
        },
        {
          id: "idle",
          name: "skrun-pool-b",
          state: "suspended" as const,
          created_at: at(START - 8 * HOUR),
          updated_at: at(START - 7 * HOUR),
          config: { image: IMAGE },
        },
      ],
    };

    expect(await pool.reconcile(listing)).toEqual({ destroyed: 0, forgotten: 0 });
    expect(pool.stats()).toMatchObject({ destroyFailures: 2, orphansDestroyed: 0, drains: 0 });
  });

  // A 412 to a destruction without force that is not the refusal the client
  // reads — its body never read, or another — is still a refusal: the machine
  // may have been woken. Its line says to check it before destroying it by
  // hand. Any other failure, and any failure of a destruction with force, keeps
  // its line.
  it("counts a refusal without a reason it reads as failed, and says to check the machine — never so for another failure", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const id = new URL(String(input)).pathname.split("/").pop() ?? "";
      if (id === "unavailable") return new Response("unavailable", { status: 503 });
      if (id === "refused") return new Response('{"error":"precondition"}', { status: 412 });
      return new Response(REFUSED_IN_STATE, { status: 412 });
    }) as typeof fetch;
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl,
      sleepImpl: async () => {},
      logger: quiet,
    });
    const lines: Array<{ level: string; fields: Record<string, unknown>; msg?: string }> = [];
    const keep = (level: string) => (fields: Record<string, unknown>, msg?: string) => {
      lines.push({ level, fields, msg });
    };
    const logger = {
      info: keep("info"),
      warn: keep("warn"),
      error: keep("error"),
      debug: keep("debug"),
    } as unknown as Logger;
    const pool = new RunnerPool(flyApi, { size: 0, imageTag: IMAGE, now: () => START }, logger);
    const listed = (id: string, state: "suspended" | "created") => ({
      id,
      name: `skrun-pool-${id}`,
      state,
      created_at: at(START - HOUR),
      updated_at: at(START - HOUR),
      config: { image: IMAGE },
    });

    const result = await pool.reconcile({
      sentAt: START,
      machines: [
        listed("refused", "suspended"),
        listed("unavailable", "suspended"),
        // Created and never started, past a fill's bound: with force.
        listed("created-old", "created"),
      ],
    });

    expect(result).toEqual({ destroyed: 0, forgotten: 0 });
    expect(pool.stats()).toMatchObject({ destroyFailures: 3, orphansDestroyed: 0 });
    const failed = lines.filter((line) => line.fields.event === "pool_destroy_failed");
    expect(failed).toEqual([
      {
        level: "warn",
        fields: {
          event: "pool_destroy_failed",
          machine_id: "refused",
          machine_state: "suspended",
          error_name: "MachineSpawnError",
          error_code: "MACHINE_SPAWN_FAILED",
          error_status: "412",
        },
        msg:
          "orphan destroy refused (412) without a reason this server reads — the machine may " +
          "have been woken since the listing: check it before destroying it by hand",
      },
      ...["unavailable", "created-old"].map((id) => ({
        level: "warn",
        fields: { event: "pool_destroy_failed", machine_id: id },
        msg: "orphan destroy failed — manual cleanup may be required",
      })),
    ]);
  });

  it("still destroys with force a started machine untouched past its window", async () => {
    const fly = platform([
      {
        id: "abandoned",
        name: "skrun-pool-x",
        state: "started",
        created_at: at(START - 2 * HOUR),
        updated_at: at(START - HOUR),
      },
    ]);
    const pool = new RunnerPool(fly.flyApi, { size: 1, imageTag: IMAGE, now: () => START }, quiet);

    expect(await pool.reconcile()).toEqual({ destroyed: 1, forgotten: 0 });
    expect(fly.deletes).toEqual(["abandoned?force=true"]);
  });

  it("the retirement and the server's stop still destroy their own machines with force", async () => {
    const fly = platform([]);
    const pool = new RunnerPool(
      fly.flyApi,
      { size: 1, imageTag: IMAGE, harness6pn: "fdaa:0:1::2", now: () => START },
      quiet,
    );
    seed(pool, "stale", { imageTag: OLDER_IMAGE });
    pool.markReady("stale");
    seed(pool, "ready");
    pool.markReady("ready");

    await pool.drainStale();
    await pool.destroyOwnReady();

    expect(fly.deletes).toEqual(["stale?force=true", "ready?force=true"]);
  });
});

/**
 * How a piece of work stands after `ms` of real time: ended — answered or
 * failed — or still running. The wait's own timer is cleared either way.
 */
async function within(work: Promise<unknown>, ms: number): Promise<"ended" | "still running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still running">((resolve) => {
    timer = setTimeout(() => resolve("still running"), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => "ended" as const,
        () => "ended" as const,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A call that never answers: it ends only by failing, with the signal's reason,
 * once its signal aborts — as the platform's client ends a request that never
 * comes back. Without a signal, it never ends.
 */
function hangs(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// A platform call that never answers used to hold the reconciliation, or the
// fill, for as long as it hung: every later pass skipped, or nothing refilled.
// A pass's reconciliation, retirement and sweep share one bound; the fill has
// one per machine. Past it, the work ends and the next pass picks up.
describe("RunnerPool — a pass and a fill end within their bounds", () => {
  const BOUND_MS = 30;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const START = 10 * HOUR;
  const IMAGE = "registry.example/runner:v1";
  const HARNESS = "fdaa:0:1::2";
  const at = (ms: number) => new Date(ms).toISOString();

  /** A logger that keeps every line it is given. */
  function recording() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { info: keep, warn: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, line: (event: string) => lines.find((l) => l.event === event) };
  }

  /** A pool whose passes are awaited, and whose cleanups after a fill its bound cut are kept. */
  class BoundedPool extends WatchedPool {
    readonly cleanups: Promise<void>[] = [];

    protected override cleanUpCutFill(cut: {
      poolId: string;
      machineId: string | null;
      creation: CreateProgress;
    }): Promise<void> {
      const cleanup = super.cleanUpCutFill(cut);
      this.cleanups.push(cleanup);
      return cleanup;
    }
  }

  /** A pooled machine nobody holds, paused for hours: what a reconciliation destroys. */
  const orphan = {
    id: "orphan",
    name: "skrun-pool-x",
    state: "suspended",
    created_at: at(START - 2 * HOUR),
    updated_at: at(START - 2 * HOUR),
  };

  // What the pass starts after its bound cut it would be sent under a signal
  // already aborted: the platform's client refuses it at once, and a refused
  // destruction is counted. Only the call the bound cut is.
  it.each([
    ["listing", "list", { destroyFailures: 0, sweeps: 1 }],
    ["reconciliation's destruction", "destroy", { destroyFailures: 1, sweeps: 1 }],
    ["retirement's destruction", "retire", { destroyFailures: 1, sweeps: 1 }],
    ["sweep", "sweep", { destroyFailures: 0, sweeps: 2 }],
  ] as const)("a pass whose %s never answers ends at its bound, starts nothing more, and the next pass reconciles", async (_what, hanging, expected) => {
    let now = START - 2 * HOUR;
    let lists = 0;
    let sweeps = 0;
    const hung = new Set<string>();
    const api = {
      list: (options?: { signal?: AbortSignal }) => {
        lists += 1;
        if (hanging === "list" && lists === 1) return hangs(options?.signal);
        return Promise.resolve([orphan, { ...orphan, id: "orphan-2", name: "skrun-pool-y" }]);
      },
      destroy: (id: string, options?: { signal?: AbortSignal }) => {
        const target = hanging === "destroy" ? "orphan" : hanging === "retire" ? "old" : "";
        if (id === target && !hung.has(id)) {
          hung.add(id);
          return hangs(options?.signal);
        }
        if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
        return Promise.resolve();
      },
    } as unknown as FlyMachinesApi;
    const log = recording();
    const pool = new BoundedPool(
      api,
      {
        size: 0,
        imageTag: IMAGE,
        harness6pn: HARNESS,
        maxIdleMs: HOUR,
        now: () => now,
        maintenanceIntervalMs: HOUR,
        maintenancePassBudgetMs: BOUND_MS,
      },
      log.logger,
    );
    // Two of its own, ready past the idle limit: the retirement destroys them.
    for (const id of ["old", "old-2"]) {
      seed(pool, id);
      pool.markReady(id);
    }
    now = START;

    pool.start({
      sweep: (_live, signal) => {
        sweeps += 1;
        if (hanging === "sweep" && sweeps === 1) return hangs(signal);
        return Promise.resolve({ destroyed: 0, readFailures: 0 });
      },
    });
    const first = await within(pool.passes[0] ?? Promise.resolve(), 2_000);
    await pool.pass();
    pool.stop();

    expect(first).toBe("ended");
    expect(lists).toBe(2);
    expect(pool.stats()).toMatchObject({
      skippedPasses: 0,
      destroyFailures: expected.destroyFailures,
    });
    expect(sweeps).toBe(expected.sweeps);
    expect(pool.all()).toEqual([]);
    expect(log.line("pool_pass_cut")).toMatchObject({ budget_ms: BOUND_MS });
  });

  /** A platform that makes `m1`, `m2`… on demand, records what it destroys, and lets a test hang one call. */
  function fillPlatform(hanging: "create" | "suspend" | "none", clock: { now: number }) {
    let creates = 0;
    const destroyed: string[] = [];
    const searched: Array<[string, string]> = [];
    const first: { name?: string; poolId?: unknown } = {};
    const flyApi = {
      list: async () => [],
      create: (
        request: { name?: string; config: { metadata?: Record<string, unknown> } },
        progress?: CreateProgress,
        options?: { signal?: AbortSignal },
      ) => {
        creates += 1;
        if (progress) {
          progress.firstSentAt = clock.now;
          progress.lastSentAt = clock.now;
        }
        if (creates === 1) {
          first.name = request.name;
          first.poolId = request.config.metadata?.skrun_pool_id;
        }
        if (hanging === "create" && creates === 1) return hangs(options?.signal);
        return Promise.resolve({
          id: `m${creates}`,
          name: request.name ?? "",
          state: "started",
          private_ip: `fdaa::${creates}`,
        });
      },
      suspend: (id: string, options?: { signal?: AbortSignal }) => {
        if (hanging === "suspend" && id === "m1") return hangs(options?.signal);
        return Promise.resolve();
      },
      destroy: async (id: string) => {
        destroyed.push(id);
      },
      // The machine a creation that never answered made after all, under its label.
      listByLabel: async (key: string, value: string) => {
        searched.push([key, value]);
        return value === first.poolId ? [{ id: "m-cut", name: first.name, state: "started" }] : [];
      },
    } as unknown as FlyMachinesApi;
    return { flyApi, destroyed, searched, first, creates: () => creates };
  }

  /** A runner that answers every probe, but the first when `hangFirst`. */
  function runner(hangFirst: boolean) {
    let probes = 0;
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      probes += 1;
      if (hangFirst && probes === 1) return hangs(init?.signal);
      return new Response(JSON.stringify({ process_id: "p" }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function fillingPool(
    flyApi: FlyMachinesApi,
    clock: { now: number },
    fetchImpl: typeof fetch,
    logger: Logger = quiet,
  ): BoundedPool {
    return new BoundedPool(
      flyApi,
      {
        size: 1,
        imageTag: IMAGE,
        harness6pn: HARNESS,
        now: () => clock.now,
        sleepImpl: async (ms) => {
          clock.now += ms;
        },
        fetchImpl,
        maintenanceIntervalMs: MINUTE,
        fillStepBudgetMs: BOUND_MS,
      },
      logger,
    );
  }

  it.each([
    ["runner's first answer", "probe"],
    ["pause", "suspend"],
  ] as const)("a fill whose %s never comes ends at its bound, destroys its machine, and the next pass creates", async (_what, hanging) => {
    const clock = { now: START };
    const platform = fillPlatform(hanging === "suspend" ? "suspend" : "none", clock);
    const pool = fillingPool(platform.flyApi, clock, runner(hanging === "probe"));

    const first = await within(pool.pass(), 2_000);
    await Promise.all(pool.cleanups);
    await pool.pass();

    expect(first).toBe("ended");
    expect(platform.destroyed).toEqual(["m1"]);
    expect(platform.creates()).toBe(2);
    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 1 });
    expect(pool.get("m2")?.state).toBe("ready");
  });

  it("a fill whose creation never answers ends at its bound, looks for its machine by its label, and the next pass creates", async () => {
    const clock = { now: START };
    const platform = fillPlatform("create", clock);
    const pool = fillingPool(platform.flyApi, clock, runner(false));

    const first = await within(pool.pass(), 2_000);
    await Promise.all(pool.cleanups);
    await pool.pass();

    expect(first).toBe("ended");
    expect(platform.searched).toContainEqual(["skrun_pool_id", platform.first.poolId]);
    expect(platform.destroyed).toEqual(["m-cut"]);
    expect(platform.creates()).toBe(2);
    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 1 });
  });

  // The search for a cut fill's machine is shared with the adapter's; what it
  // finds and fails to destroy is the pool's to count, in both of its forms.
  it.each([
    ["reaches its step's bound", "hangs", { cut: true }],
    ["is refused", "throws", {}],
  ] as const)("a fill whose creation never answers counts as failed the destruction of the machine its search finds, when that destruction %s", async (_what, how, cutField) => {
    const clock = { now: START };
    const platform = fillPlatform("create", clock);
    const flyApi = {
      ...(platform.flyApi as unknown as Record<string, unknown>),
      destroy: (id: string, options?: { signal?: AbortSignal }) => {
        if (id !== "m-cut") return Promise.resolve();
        return how === "hangs" ? hangs(options?.signal) : Promise.reject(new Error("refused"));
      },
    } as unknown as FlyMachinesApi;
    const log = recording();
    const pool = new BoundedPool(
      flyApi,
      {
        size: 1,
        imageTag: IMAGE,
        harness6pn: HARNESS,
        now: () => clock.now,
        sleepImpl: async (ms) => {
          clock.now += ms;
        },
        fetchImpl: runner(false),
        maintenanceIntervalMs: MINUTE,
        fillStepBudgetMs: BOUND_MS,
        cleanupStepMs: 40,
      },
      log.logger,
    );

    const first = await within(pool.pass(), 2_000);
    await Promise.all(pool.cleanups);

    expect(first).toBe("ended");
    expect(log.line("pool_cut_create_cleanup")).toMatchObject({ found: 1, destroyed: 0 });
    expect(log.line("pool_destroy_failed")).toEqual({
      event: "pool_destroy_failed",
      machine_id: "m-cut",
      ...cutField,
    });
    expect(pool.stats()).toMatchObject({ destroyFailures: 1, fillErrors: 1 });
  });

  // That search reads the label a second apart until a read leaves ten seconds
  // after the creation's last request — on the pool's clock, the one the
  // creation was dated on here, never the process's.
  it("a fill whose creation never answers reads its label on the pool's clock, until a read leaves ten seconds after the creation was sent", async () => {
    const clock = { now: START };
    const platform = fillPlatform("create", clock);
    const pool = fillingPool(platform.flyApi, clock, runner(false));

    const first = await within(pool.pass(), 2_000);
    await Promise.all(pool.cleanups);

    expect(first).toBe("ended");
    // Sent at START; the reads leave at START + 1 s, + 2 s… and the tenth at START + 10 s.
    expect(platform.searched).toHaveLength(10);
  });

  // Each read of that search within the clean-up's step, as each destruction is.
  it("a fill whose creation never answers cuts a read of its search at the clean-up's step", async () => {
    const clock = { now: START };
    const platform = fillPlatform("create", clock);
    let reads = 0;
    const flyApi = {
      ...(platform.flyApi as unknown as Record<string, unknown>),
      listByLabel: (key: string, value: string, options?: { signal?: AbortSignal }) => {
        reads += 1;
        return reads === 1 ? hangs(options?.signal) : platform.flyApi.listByLabel(key, value);
      },
    } as unknown as FlyMachinesApi;
    const log = recording();
    const pool = new BoundedPool(
      flyApi,
      {
        size: 1,
        imageTag: IMAGE,
        harness6pn: HARNESS,
        now: () => clock.now,
        sleepImpl: async (ms) => {
          clock.now += ms;
        },
        fetchImpl: runner(false),
        maintenanceIntervalMs: MINUTE,
        fillStepBudgetMs: BOUND_MS,
        cleanupStepMs: 40,
      },
      log.logger,
    );

    const first = await within(pool.pass(), 2_000);
    const cleanup = await within(Promise.all(pool.cleanups), 2_000);

    expect(first).toBe("ended");
    expect(cleanup).toBe("ended");
    expect(log.line("pool_cut_create_read_cut")).toEqual({
      event: "pool_cut_create_read_cut",
      read: 1,
    });
    expect(platform.destroyed).toEqual(["m-cut"]);
  });

  // A fill that fails without its bound cutting it — its pause refused — cleans
  // up before it lets its guard go: the destruction of the machine it made and,
  // for a creation sent twice, the read of its label and the destruction of a
  // second machine. Each within a step of its own: the guard is held, at most,
  // the fill's bound plus those steps.
  it.each([
    ["the destruction of the machine it made", "destroy-made"],
    ["the read of its label for a second machine", "read"],
    ["the destruction of its second machine", "destroy-second"],
  ] as const)("a fill whose pause is refused ends within its clean-up's steps when %s never answers", async (_what, hanging) => {
    const STEP_MS = 40;
    const signals: Array<AbortSignal | undefined> = [];
    let name = "";
    const flyApi = {
      create: async (request: { name?: string }, progress?: CreateProgress) => {
        name = request.name ?? "";
        if (progress) progress.resent = hanging !== "destroy-made";
        return { id: "m1", name, state: "started", private_ip: "fdaa::1" };
      },
      suspend: async () => {
        throw new Error("suspend refused");
      },
      destroy: (id: string, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        const hung =
          (hanging === "destroy-made" && id === "m1") ||
          (hanging === "destroy-second" && id === "m-dup");
        return hung ? hangs(options?.signal) : Promise.resolve();
      },
      listByLabel: (_key: string, _value: string, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        if (hanging === "read") return hangs(options?.signal);
        return Promise.resolve([{ id: "m-dup", name, state: "started" }]);
      },
    } as unknown as FlyMachinesApi;
    const log = recording();
    const pool = new RunnerPool(
      flyApi,
      {
        size: 1,
        imageTag: IMAGE,
        harness6pn: HARNESS,
        sleepImpl: async () => {},
        fetchImpl: runner(false),
        fillStepBudgetMs: 10_000,
        cleanupStepMs: STEP_MS,
      },
      log.logger,
    );

    const outcome = await within(pool.fill(), 1_000);

    expect(outcome).toBe("ended");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(pool.stats()).toMatchObject({
      fillErrors: 1,
      destroyFailures: hanging === "read" ? 0 : 1,
    });
    if (hanging === "read") {
      expect(log.line("pool_duplicate_search_failed")).toMatchObject({
        machine_id: "m1",
        cut: true,
      });
    } else {
      expect(log.line("pool_destroy_failed")).toMatchObject({
        machine_id: hanging === "destroy-made" ? "m1" : "m-dup",
        cut: true,
      });
    }
  });

  it("says in its line how long the creation and the pause of a machine took", async () => {
    const clock = { now: START };
    const api = {
      create: async (request: { name?: string }) => {
        clock.now += 2_000;
        return { id: "m1", name: request.name ?? "", state: "started", private_ip: "fdaa::1" };
      },
      suspend: async () => {
        clock.now += 3_000;
      },
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const log = recording();
    const pool = fillingPool(api, clock, runner(false), log.logger);

    await pool.fill();

    expect(log.line("pool_fill")).toMatchObject({
      machine_id: "m1",
      create_ms: 2_000,
      suspend_ms: 3_000,
    });
  });

  describe("on a simulated clock", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("leaves no timer behind after a pass and a fill that ended on their own", async () => {
      const clock = { now: START };
      const platform = fillPlatform("none", clock);
      const pool = fillingPool(platform.flyApi, clock, runner(false));

      await pool.pass();

      expect(pool.stats().ready).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timer behind after a pass and a fill their bounds cut", async () => {
      const clock = { now: START };
      const platform = fillPlatform("create", clock);
      const api = Object.assign(Object.create(platform.flyApi), {
        list: (options?: { signal?: AbortSignal }) => hangs(options?.signal),
      }) as FlyMachinesApi;
      const log = recording();
      const pool = new BoundedPool(
        api,
        {
          size: 1,
          imageTag: IMAGE,
          harness6pn: HARNESS,
          now: () => clock.now,
          sleepImpl: async (ms) => {
            clock.now += ms;
          },
          fetchImpl: runner(false),
          maintenancePassBudgetMs: 1_000,
          fillStepBudgetMs: 2_000,
        },
        log.logger,
      );

      let ended = false;
      const pass = pool.pass().finally(() => {
        ended = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ended).toBe(true);
      await pass;
      await Promise.all(pool.cleanups);

      expect(log.line("pool_pass_cut")).toMatchObject({ budget_ms: 1_000 });
      expect(platform.destroyed).toEqual(["m-cut"]);
      expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("RunnerPool — operator counters", () => {
  it("separates a pool that had nothing from one whose machines did not work", () => {
    const pool = makePool();
    pool.recordHit();
    pool.recordMiss("empty");
    pool.recordMiss("unusable");
    expect(pool.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  // A run that was not entitled to a pooled machine passed the pool over on
  // purpose: counted apart, so the misses keep meaning a pool that failed to serve.
  it("counts a run that skipped the pool apart from the hits and the misses", () => {
    const pool = makePool();
    pool.recordHit();
    pool.recordMiss("empty");
    pool.recordSkip();
    pool.recordSkip();
    expect(pool.stats()).toMatchObject({ hits: 1, misses: 1, skipped: 2 });
  });

  // Every counter an operator needs to answer "is the pool doing its job?" without
  // reading platform logs.
  it("exposes the full counter set", () => {
    expect(Object.keys(makePool().stats()).sort()).toEqual([
      "claimed",
      "destroyFailures",
      "draining",
      "drains",
      "fillErrors",
      "filling",
      "hits",
      "infraHostsChanged",
      "infraHostsUnmeasured",
      "misses",
      "orphansDestroyed",
      "ready",
      "size",
      "skipped",
      "skippedPasses",
      "sweepDestroyed",
      "sweepPasses",
      "sweepReadFailures",
      "vanished",
    ]);
  });

  it("starts every counter of the maintenance at zero", () => {
    expect(makePool().stats()).toMatchObject({
      destroyFailures: 0,
      skippedPasses: 0,
      vanished: 0,
      sweepPasses: 0,
      sweepDestroyed: 0,
      sweepReadFailures: 0,
      infraHostsChanged: 0,
      infraHostsUnmeasured: 0,
    });
  });

  // What a pooled machine's runner reported at /init of its infrastructure hosts:
  // a moved address, or nothing to say — a runner too old to measure says nothing
  // at all, which is nothing to say too. The word counted is handed back.
  it("counts a moved infrastructure address apart from a measurement that said nothing", () => {
    const pool = makePool();
    expect(pool.recordInfraHosts("changed")).toBe("changed");
    expect(pool.recordInfraHosts("unmeasured")).toBe("unmeasured");
    expect(pool.recordInfraHosts(undefined)).toBe("unmeasured");
    expect(pool.recordInfraHosts("unchanged")).toBe("unchanged");
    expect(pool.stats()).toMatchObject({ infraHostsChanged: 1, infraHostsUnmeasured: 2 });
  });

  // The end of a run and the sweep of the run machines destroy machines the pool
  // does not hold: they report to it, so one counter says every failure.
  it("counts a failed destruction reported from outside, and adds up each sweep's pass", () => {
    const pool = makePool();
    pool.recordDestroyFailure();
    pool.recordDestroyFailure();
    pool.recordSweep({ destroyed: 2, readFailures: 1 });
    pool.recordSweep({ destroyed: 0, readFailures: 0 });
    expect(pool.stats()).toMatchObject({
      destroyFailures: 2,
      sweepPasses: 2,
      sweepDestroyed: 2,
      sweepReadFailures: 1,
    });
  });
});

// A destruction that fails leaves a machine billing until something else removes
// it. Each one is counted, wherever the pool tried it: a log line alone is what
// nobody reads.
describe("RunnerPool — every destruction that failed is counted", () => {
  const HOUR = 3_600_000;
  const at = (ms: number) => new Date(ms).toISOString();

  it("counts a destruction refused at a fill, at a retirement and at a reconciliation", async () => {
    const asked: string[] = [];
    const api = {
      create: async () => ({
        id: "m-fill",
        name: "skrun-pool-f",
        state: "started",
        private_ip: "fdaa::1",
      }),
      suspend: async () => {
        throw new Error("not suspendable");
      },
      list: async () => [
        { id: "orphan", name: "skrun-pool-x", state: "suspended", updated_at: at(1 * HOUR) },
      ],
      destroy: async (id: string) => {
        asked.push(id);
        throw new Error("refused");
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(api, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
      maxIdleMs: HOUR,
      now: () => 10 * HOUR,
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    await pool.fill();
    seed(pool, "old", { imageTag: "registry.example/runner:v0" });
    pool.markReady("old");
    await pool.drainStale();
    await pool.reconcile();

    expect(asked).toEqual(["m-fill", "old", "orphan"]);
    // The retirement's failed destruction is a failure, not a drain.
    expect(pool.stats()).toMatchObject({ destroyFailures: 3, fillErrors: 1, drains: 0 });
  });

  it("counts a refused destruction of the second machine a fill sent twice", async () => {
    const api = {
      create: async (request: { name?: string }, progress?: { resent: boolean }) => {
        if (progress) progress.resent = true;
        return { id: "m-kept", name: request.name ?? "", state: "started", private_ip: "fdaa::1" };
      },
      // Two machines of the fill's own name and label, as two crossing requests make.
      listByLabel: async (_key: string, value: string) => [
        { id: "m-kept", name: `skrun-pool-${value}`, state: "started" },
        { id: "m-dup", name: `skrun-pool-${value}`, state: "started" },
      ],
      suspend: async () => {},
      destroy: async () => {
        throw new Error("refused");
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(api, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      now: () => 1_000_000,
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    await pool.fill();

    expect(pool.stats()).toMatchObject({ destroyFailures: 1, ready: 1 });
  });
});

// At the server's stop, the ready machines this process holds serve no one —
// their assignment credential lives in its memory — and, paused, they bill their
// storage until another process's reconciliation judges them. The stop destroys
// them, each out of the inventory before its destruction is asked; a failure is
// counted. A machine being filled is left to the next process, one a run holds
// to its run.
describe("RunnerPool — its ready machines destroyed at the server's stop", () => {
  /** A pool holding one claimed machine, two ready ones and one being filled; each destruction noted. */
  function heldAtStop(
    destroy: (id: string, signal?: AbortSignal) => Promise<void> = async () => {},
  ) {
    const asked: Array<{ id: string; heldWhenAsked: unknown; signal?: AbortSignal }> = [];
    const api = {
      destroy: async (id: string, opts?: { signal?: AbortSignal }) => {
        asked.push({ id, heldWhenAsked: pool.get(id) ?? null, signal: opts?.signal });
        await destroy(id, opts?.signal);
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(
      api,
      { size: 3, imageTag: "registry.example/runner:v1", harness6pn: "fdaa:0:1::2" },
      quiet,
    );
    seed(pool, "serving");
    pool.markReady("serving");
    pool.takeReady();
    for (const id of ["ready-1", "ready-2"]) {
      seed(pool, id);
      pool.markReady(id);
    }
    seed(pool, "filling");
    return { pool, asked };
  }

  it("destroys every ready machine it holds, each out of the inventory before its destruction is asked, and leaves the one being filled and the one serving a run", async () => {
    const { pool, asked } = heldAtStop();
    const bound = new AbortController();

    const result = await pool.destroyOwnReady(bound.signal);

    expect(result).toEqual({ destroyed: 2, failed: 0 });
    expect(asked.map(({ id }) => id)).toEqual(["ready-1", "ready-2"]);
    expect(asked.map(({ heldWhenAsked }) => heldWhenAsked)).toEqual([null, null]);
    expect(asked.every(({ signal }) => signal === bound.signal)).toBe(true);
    expect(pool.stats()).toMatchObject({
      ready: 0,
      filling: 1,
      claimed: 1,
      draining: 0,
      destroyFailures: 0,
    });
  });

  it("counts as failed a destruction refused, and one still unanswered when its signal aborts — it does not wait past it", async () => {
    const { pool, asked } = heldAtStop(async (id) => {
      if (id === "ready-1") throw new Error("refused");
      // Never answers, whatever its signal says.
      await new Promise<void>(() => {});
    });
    const bound = new AbortController();
    setTimeout(() => bound.abort(), 30);

    const result = await pool.destroyOwnReady(bound.signal);

    expect(result).toEqual({ destroyed: 0, failed: 2 });
    expect(asked.map(({ id }) => id)).toEqual(["ready-1", "ready-2"]);
    expect(pool.stats()).toMatchObject({ ready: 0, draining: 0, destroyFailures: 2 });
  });

  // The stop destroys the ready machines, which reopens the deficit: a fill
  // under way must not answer it by creating machines while the server stops.
  it("a fill under way when the maintenance stops ends with the machine it is making: none created after, though its deficit reopens", async () => {
    let creates = 0;
    let answer: () => void = () => {};
    const firstAnswered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const api = {
      create: async (request: { name?: string }) => {
        creates += 1;
        if (creates === 1) await firstAnswered;
        return {
          id: `m-${creates}`,
          name: request.name ?? "",
          state: "started",
          private_ip: "fdaa::1",
        };
      },
      suspend: async () => {},
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(
      api,
      {
        size: 2,
        imageTag: "registry.example/runner:v1",
        now: () => 1_000_000,
        sleepImpl: async () => {},
        fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      },
      quiet,
    );

    const filling = pool.fill();
    await vi.waitFor(() => expect(creates).toBe(1));
    pool.stop();
    answer();
    await filling;
    // Its machine made ready, then destroyed by the stop: the deficit is back to two.
    await pool.destroyOwnReady();
    await pool.fill();

    expect(creates).toBe(1);
    expect(pool.stats()).toMatchObject({ ready: 0, filling: 0 });
  });

  it("asks nothing once its signal is up: the ready machines are counted as failed, left billing", async () => {
    const { pool, asked } = heldAtStop();

    const result = await pool.destroyOwnReady(AbortSignal.abort());

    expect(result).toEqual({ destroyed: 0, failed: 2 });
    expect(asked).toEqual([]);
    expect(pool.stats()).toMatchObject({ ready: 0, destroyFailures: 2 });
  });
});

/**
 * The pool used to have no way to start: `fill()` existed and nothing called it.
 * A pool that is never filled is not loud — it reports `ready: 0` and counts
 * misses, exactly like a busy one, while every run quietly takes the cold path.
 * These tests exist so that failure cannot come back silently.
 */
describe("RunnerPool — background maintenance", () => {
  class SpyPool extends RunnerPool {
    fills = 0;
    reconciles = 0;
    fillRejects = false;

    override async fill(): Promise<void> {
      this.fills++;
      if (this.fillRejects) throw new Error("platform unavailable");
    }

    override async reconcile(): Promise<{ destroyed: number; forgotten: number }> {
      this.reconciles++;
      return { destroyed: 0, forgotten: 0 };
    }
  }

  // A pass lists once, then hands that listing to the reconciliation.
  const listsNothing = { list: async () => [] } as unknown as FlyMachinesApi;

  function makeSpy(over: Partial<RunnerPoolOptions> = {}): SpyPool {
    return new SpyPool(listsNothing, {
      size: 2,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
      maintenanceIntervalMs: 1000,
      ...over,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills immediately on start — waiting a full interval would cold-path the first runs", async () => {
    vi.useFakeTimers();
    const pool = makeSpy();
    pool.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(pool.fills).toBe(1);
    expect(pool.reconciles).toBe(1);
    pool.stop();
  });

  it("keeps topping up on every interval, reconciling before it fills", async () => {
    vi.useFakeTimers();
    const pool = makeSpy();
    pool.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(pool.fills).toBe(4); // one at start + three ticks
    expect(pool.reconciles).toBe(4);
    pool.stop();
  });

  it("stops when told to, and a second start does not double the loop", async () => {
    vi.useFakeTimers();
    const pool = makeSpy();
    pool.start();
    pool.start(); // idempotent — no second immediate pass, no second timer
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.fills).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.fills).toBe(2);

    pool.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.fills).toBe(2); // nothing after stop
    pool.stop(); // safe to call twice
  });

  // Size 0 is the default everywhere but our cloud: no stock is kept, and none
  // is ever made — but the maintenance runs, so a stock left behind is emptied.
  it("at size 0, still reconciles on every interval, and never fills", async () => {
    vi.useFakeTimers();
    const pool = makeSpy({ size: 0 });
    pool.start();
    await vi.advanceTimersByTimeAsync(5_000);
    pool.requestTopUp();
    await vi.advanceTimersByTimeAsync(0);
    pool.stop();

    expect(pool.fills).toBe(0);
    expect(pool.reconciles).toBe(6); // one at start + five ticks
  });

  it("survives a failing pass — a timer that rejects would take the server down", async () => {
    vi.useFakeTimers();
    const pool = makeSpy();
    pool.fillRejects = true;
    pool.start();
    await vi.advanceTimersByTimeAsync(0);

    pool.fillRejects = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.fills).toBe(2); // the loop kept going after the failure
    pool.stop();
  });

  it("tops up on request once running, and stays inert before that", async () => {
    vi.useFakeTimers();
    const pool = makeSpy();

    // Before start: a claim must not spontaneously create machines.
    pool.requestTopUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.fills).toBe(0);

    pool.start();
    await vi.advanceTimersByTimeAsync(0);
    pool.requestTopUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.fills).toBe(2); // the start pass + the requested one

    // A rejected top-up is swallowed, not thrown at the caller (a request path).
    pool.fillRejects = true;
    expect(() => pool.requestTopUp()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    pool.stop();
  });
});

// A log line says an error's class and code, never its message: the platform's
// errors can quote a request or a machine's configuration.
describe("RunnerPool — a failure is logged by the error's class, never its message", () => {
  const WITNESS = "witness-6a0c";

  /** A logger that keeps every line it is given, with the sentence it ends on. */
  function recordingLogger() {
    const lines: Array<{ fields: Record<string, unknown>; msg: unknown }> = [];
    const keep = vi.fn((fields: unknown, msg?: unknown) => {
      if (typeof fields === "object" && fields !== null) {
        lines.push({ fields: fields as Record<string, unknown>, msg });
      }
    });
    const logger = { error: keep, warn: keep, info: keep, debug: keep } as unknown as Logger;
    const line = (event: string, msg?: string) =>
      lines.find((l) => l.fields.event === event && (msg === undefined || l.msg === msg))?.fields;
    return { logger, line };
  }

  /** A pool whose passes reject on demand: the maintenance loop's own catches are reached. */
  class FailingPool extends RunnerPool {
    fillError: Error | null = null;
    reconcileError: Error | null = null;

    override async fill(): Promise<void> {
      if (this.fillError) throw this.fillError;
    }

    override async reconcile(): Promise<{ destroyed: number; forgotten: number }> {
      if (this.reconcileError) throw this.reconcileError;
      return { destroyed: 0, forgotten: 0 };
    }
  }

  function failingPool(logger: Logger): FailingPool {
    return new FailingPool(
      // A pass lists once, then hands that listing to the reconciliation.
      { list: async () => [] } as unknown as FlyMachinesApi,
      { size: 2, imageTag: "registry.example/runner:v1", maintenanceIntervalMs: 1000 },
      logger,
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a failed top-up after a claim by the error's class", async () => {
    vi.useFakeTimers();
    const log = recordingLogger();
    const pool = failingPool(log.logger);
    pool.start();
    await vi.advanceTimersByTimeAsync(0);
    pool.fillError = new Error(`platform unavailable ${WITNESS}`);

    pool.requestTopUp();
    await vi.advanceTimersByTimeAsync(0);
    pool.stop();

    const line = log.line("pool_fill_failed", "top-up after a claim failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ error_name: "Error" });
  });

  it("logs a failed fill pass by the error's class", async () => {
    vi.useFakeTimers();
    const log = recordingLogger();
    const pool = failingPool(log.logger);
    pool.fillError = new Error(`platform unavailable ${WITNESS}`);

    pool.start();
    await vi.advanceTimersByTimeAsync(0);
    pool.stop();

    const line = log.line("pool_fill_failed", "fill pass failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ error_name: "Error" });
  });

  it("logs a failed reconciliation pass by the error's class", async () => {
    vi.useFakeTimers();
    const log = recordingLogger();
    const pool = failingPool(log.logger);
    pool.reconcileError = new Error(`listing refused ${WITNESS}`);

    pool.start();
    await vi.advanceTimersByTimeAsync(0);
    pool.stop();

    const line = log.line("pool_reconcile_failed", "reconciliation pass failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ error_name: "Error" });
  });

  it("logs a machine that could not be prepared by the error's class, and names the machine", async () => {
    const api = {
      create: async () => ({ id: "m1", name: "p", state: "started", private_ip: "fdaa::1" }),
      suspend: async () => {
        throw new Error(`Fly.io API POST /apps/runners/machines/m1/suspend: 412 ${WITNESS}`);
      },
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const log = recordingLogger();
    const pool = new RunnerPool(
      api,
      {
        size: 1,
        imageTag: "registry.example/runner:v1",
        now: () => 1,
        sleepImpl: async () => {},
        fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      },
      log.logger,
    );

    await pool.fill();

    const line = log.line("pool_fill_failed", "pooled machine could not be prepared");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ machine_id: "m1", error_name: "Error" });
  });

  it("logs a machine list it could not read by the error's class", async () => {
    const api = {
      list: async () => {
        throw new Error(`Fly.io API GET /apps/runners/machines: 503 ${WITNESS}`);
      },
      destroy: async () => {},
    } as unknown as FlyMachinesApi;
    const log = recordingLogger();
    const pool = new RunnerPool(api, { size: 1, imageTag: "t", now: () => 0 }, log.logger);

    await pool.reconcile();

    const line = log.line(
      "pool_reconcile_failed",
      "could not list machines — skipping reconciliation",
    );
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ error_name: "Error" });
  });
});

// Two requests that cross make two machines of one name and one label. Only the
// label finds the second, which would run, billing, until reconciliation judged
// it abandoned, past the window of a started machine. A fill that had to send its creation
// twice destroys it when it ends, whatever it ends on.
describe("RunnerPool — a refill whose creation was sent twice", () => {
  interface Listed {
    id: string;
    name: string;
    state: string;
  }

  function resentHarness(options: {
    resent: boolean;
    createFails?: boolean;
    bootFails?: boolean;
    searchFails?: boolean;
    labelled?: (name: string) => Listed[];
  }) {
    let created: { name: string; poolId: unknown } | undefined;
    const destroyed: string[] = [];
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { info: keep, warn: keep, error: keep, debug: keep } as unknown as Logger;
    const listByLabel = vi.fn(async (_key: string, _value: string): Promise<Listed[]> => {
      if (options.searchFails) throw new Error("listing refused witness-3f1d");
      const name = created?.name ?? "";
      return (
        options.labelled?.(name) ?? [
          { id: "m-kept", name, state: "started" },
          { id: "m-dup", name, state: "started" },
          { id: "m-gone", name, state: "destroying" },
          { id: "m-destroyed", name, state: "destroyed" },
          { id: "m-other", name: "skrun-pool-someone-else", state: "started" },
        ]
      );
    });
    const flyApi = {
      create: async (
        request: { name?: string; config: { metadata?: Record<string, unknown> } },
        progress?: { resent: boolean },
      ) => {
        created = { name: request.name ?? "", poolId: request.config.metadata?.skrun_pool_id };
        if (progress) progress.resent = options.resent;
        if (options.createFails) throw new Error("the outcome of the creation is unknown");
        return { id: "m-kept", name: created.name, state: "started", private_ip: "fdaa::1" };
      },
      listByLabel,
      suspend: async () => {},
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    } as unknown as FlyMachinesApi;
    const pool = new RunnerPool(
      flyApi,
      {
        size: 1,
        imageTag: "registry.example/runner:v1",
        now: () => 1_000_000,
        sleepImpl: async () => {},
        maxBootTimeMs: options.bootFails ? 0 : undefined,
        fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      },
      logger,
    );
    return { pool, destroyed, listByLabel, lines, created: () => created };
  }

  it("destroys the second machine of its label once the fill ends, and keeps the one it made ready", async () => {
    const { pool, destroyed, listByLabel, lines, created } = resentHarness({ resent: true });

    await pool.fill();

    expect(listByLabel).toHaveBeenCalledWith("skrun_pool_id", created()?.poolId, {
      signal: expect.any(AbortSignal),
    });
    expect(destroyed).toEqual(["m-dup"]);
    expect(pool.get("m-kept")?.state).toBe("ready");
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "pool_duplicate_destroyed", machine_id: "m-dup" }),
    );
  });

  it("destroys it too when the machine it kept fails its fill", async () => {
    const { pool, destroyed } = resentHarness({ resent: true, bootFails: true });

    await pool.fill();

    expect(destroyed).toEqual(["m-kept", "m-dup"]);
    expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
  });

  it("destroys it when the creation itself fails after it was sent twice", async () => {
    const { pool, destroyed } = resentHarness({
      resent: true,
      createFails: true,
      labelled: (name) => [{ id: "m-late", name, state: "started" }],
    });

    await pool.fill();

    expect(destroyed).toEqual(["m-late"]);
    expect(pool.stats().fillErrors).toBe(1);
  });

  it("searches nothing more when its creation was sent once", async () => {
    const { pool, destroyed, listByLabel } = resentHarness({ resent: false });

    await pool.fill();

    expect(listByLabel).not.toHaveBeenCalled();
    expect(destroyed).toEqual([]);
    expect(pool.stats().ready).toBe(1);
  });

  it("ends the fill as it would have when the search for its second machine fails, and logs it by the error's class", async () => {
    const { pool, destroyed, lines } = resentHarness({ resent: true, searchFails: true });

    await pool.fill();

    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 0 });
    expect(destroyed).toEqual([]);
    const line = lines.find((l) => l.event === "pool_duplicate_search_failed");
    expect(line).toMatchObject({ machine_id: "m-kept", error_name: "Error" });
    expect(JSON.stringify(line)).not.toContain("witness-3f1d");
  });

  // Through the machines client itself: the first request reaches the platform
  // and its answer is lost; the search finds nothing; the resend crosses the
  // first creation, which lands with it.
  it("destroys the second machine two crossing requests made, through the platform client", async () => {
    type Held = Listed & { private_ip: string; config: { metadata?: Record<string, unknown> } };
    const machines = new Map<string, Held>();
    const deleted: string[] = [];
    let posts = 0;
    let seq = 0;
    let firstBody: { name: string; config: Held["config"] } | null = null;
    const make = (body: { name: string; config: Held["config"] }): Held => {
      seq += 1;
      const machine = {
        id: `m-${seq}`,
        name: body.name,
        state: "started",
        private_ip: `fdaa::${seq}`,
        config: body.config,
      };
      machines.set(machine.id, machine);
      return machine;
    };
    const platform = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      // /v1/apps/<app>/machines[/<id>[/<action>]]
      const [, , , , id, action] = url.pathname.split("/").filter(Boolean);
      if (method === "POST" && id === undefined) {
        posts += 1;
        const body = JSON.parse(String(init?.body));
        if (posts === 1) {
          firstBody = body;
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          });
        }
        if (firstBody) make(firstBody);
        return new Response(JSON.stringify(make(body)), { status: 200 });
      }
      if (method === "GET") {
        const filters = [...url.searchParams].filter(([key]) => key.startsWith("metadata."));
        const listed = [...machines.values()].filter((m) =>
          filters.every(([key, value]) => m.config.metadata?.[key.slice(9)] === value),
        );
        return new Response(JSON.stringify(listed), { status: 200 });
      }
      if (method === "DELETE" && id !== undefined) {
        deleted.push(id);
        machines.delete(id);
        return new Response("{}", { status: 200 });
      }
      const machine = id === undefined ? undefined : machines.get(id);
      if (machine && action === "suspend") machine.state = "suspended";
      return new Response("{}", { status: machine ? 200 : 404 });
    }) as typeof fetch;
    let clientNow = 0;
    const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
    const api = new FlyMachinesApi("token", "app", {
      fetchImpl: platform,
      nowImpl: () => clientNow,
      sleepImpl: async (ms) => {
        clientNow += ms;
      },
      logger: silent,
    });
    const pool = new RunnerPool(
      api,
      {
        size: 1,
        imageTag: "img",
        now: () => 1_000_000,
        sleepImpl: async () => {},
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: true, process_id: "p" }), {
            status: 200,
          })) as unknown as typeof fetch,
      },
      silent,
    );

    await pool.fill();

    expect(posts).toBe(2);
    expect(pool.all().map((m) => [m.machineId, m.state])).toEqual([["m-2", "ready"]]);
    expect(deleted).toEqual(["m-1"]);
    expect([...machines.keys()]).toEqual(["m-2"]);
  });
});

// ---------------------------------------------------------------------------
// The fill's /healthz probe: a redirect is never followed, and the answer is
// read within its bounds. The machine is the runner's, but nothing guarantees
// that what answers is.
// ---------------------------------------------------------------------------

describe("RunnerPool — the fill's readiness probe reads the runner bounded, and never follows a redirect", () => {
  const KIB = 1024;

  /** A platform client whose one machine sits at `privateIp`; destroys are recorded. */
  function platform(privateIp: string) {
    const calls: string[] = [];
    const flyApi = {
      create: async (req: { name?: string }) => {
        calls.push("create");
        return { id: "m1", name: req.name ?? "", state: "started", private_ip: privateIp };
      },
      suspend: async (id: string) => {
        calls.push(`suspend:${id}`);
      },
      destroy: async (id: string) => {
        calls.push(`destroy:${id}`);
      },
    } as unknown as FlyMachinesApi;
    return { flyApi, calls };
  }

  /** A logger that keeps every line it is given, whatever the level. */
  function recording() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { info: keep, warn: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, line: (event: string) => lines.find((l) => l.event === event) };
  }

  /** A body in memory that counts what its reader took: one chunk per read, none read ahead. */
  function countedBody(text: string, chunk = 1024) {
    const bytes = Buffer.from(text);
    const state = { delivered: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.delivered >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.length, state.delivered + chunk);
          controller.enqueue(new Uint8Array(bytes.subarray(state.delivered, end)));
          state.delivered = end;
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, state };
  }

  describe("on the loopback address", () => {
    const servers: Array<{ close(): Promise<void> }> = [];
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((s) => s.close()));
    });

    async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
      const hits: string[] = [];
      const server = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.on("error", () => {});
        handler(req, res);
      });
      server.on("connection", (socket) => socket.on("error", () => {}));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const { port } = server.address() as AddressInfo;
      const local = {
        url: `http://127.0.0.1:${port}`,
        port,
        hits,
        close: () =>
          new Promise<void>((resolve) => {
            // Stop accepting first, then end every connection: the order Node documents.
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      };
      servers.push(local);
      return local;
    }

    it("writes off a machine whose /healthz redirects, and the address it points at is never asked", async () => {
      const target = await serve((_req, res) => res.end(JSON.stringify({ process_id: "p-1" })));
      const runner = await serve((_req, res) => {
        res.writeHead(302, { Location: `${target.url}/internal` });
        res.end();
      });
      const { flyApi, calls } = platform("127.0.0.1");
      const { logger, line } = recording();
      // No fetch given: the pool's own, on the loopback address.
      const pool = new RunnerPool(
        flyApi,
        {
          size: 1,
          imageTag: "registry.example/runner:v1",
          runnerPort: runner.port,
          maxBootTimeMs: 300,
          bootPollIntervalMs: 20,
        },
        logger,
      );

      await pool.fill();

      expect(target.hits).toEqual([]);
      expect(runner.hits.length).toBeGreaterThan(0);
      expect(line("pool_fill_failed")).toMatchObject({ machine_id: "m1" });
      expect(calls).toContain("destroy:m1");
      expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
    });
  });

  it("writes off a machine whose /healthz answers more than 64 KiB, past which it reads nothing", async () => {
    const head = JSON.stringify({ process_id: "p-1", pad: "" });
    const body = countedBody(`${head.slice(0, -2)}${"a".repeat(1024 * KIB)}"}`);
    const { flyApi, calls } = platform("fdaa::1");
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      sleepImpl: async () => {},
      fetchImpl: (async () =>
        new Response(body.stream, { status: 200 })) as unknown as typeof fetch,
    });

    await pool.fill();

    expect(body.state.delivered).toBeLessThanOrEqual(64 * KIB + KIB);
    expect(body.state.cancelled).toBe(true);
    expect(calls).toContain("destroy:m1");
    expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
  });

  it("reads nothing of a probe answer that is not OK, and probes again", async () => {
    const refused = countedBody("e".repeat(64 * KIB));
    let probes = 0;
    const { flyApi } = platform("fdaa::1");
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        probes += 1;
        return probes === 1
          ? new Response(refused.stream, { status: 503 })
          : new Response(JSON.stringify({ process_id: "p-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await pool.fill();

    expect(refused.state.delivered).toBe(0);
    expect(refused.state.cancelled).toBe(true);
    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 0 });
  });

  it("still takes a small answer it cannot parse as a machine that cannot say its process", async () => {
    const { flyApi } = platform("fdaa::1");
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });

    await pool.fill();

    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 0 });
    expect(pool.get("m1")?.processId).toBeUndefined();
  });

  it("still takes a machine whose answer to the probe is cut while it is read, as one that cannot say its process", async () => {
    // The head of the answer, then the connection cut: a failure of the read
    // that is neither past the bound nor past the deadline.
    const cutBody = () => {
      let sent = false;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent) {
              controller.error(new TypeError("terminated"));
              return;
            }
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"process_id":"p-'));
          },
        },
        { highWaterMark: 0 },
      );
    };
    const { flyApi, calls } = platform("fdaa::1");
    const pool = new RunnerPool(flyApi, {
      size: 1,
      imageTag: "registry.example/runner:v1",
      sleepImpl: async () => {},
      fetchImpl: (async () => new Response(cutBody(), { status: 200 })) as unknown as typeof fetch,
    });

    await pool.fill();

    expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 0 });
    expect(pool.get("m1")?.processId).toBeUndefined();
    expect(calls).not.toContain("destroy:m1");
  });

  describe("on a simulated clock", () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A fetch whose `nth` /healthz is answered by `answer`; records each request's signal. */
    function probes(answer: (init: RequestInit | undefined, nth: number) => Promise<Response>) {
      const signals: Array<AbortSignal | null | undefined> = [];
      let notify: (() => void) | undefined;
      const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        signals.push(init?.signal);
        notify?.();
        return answer(init, signals.length);
      }) as unknown as typeof fetch;
      const asked = (n: number) =>
        new Promise<void>((resolve) => {
          if (signals.length >= n) resolve();
          else notify = () => signals.length >= n && resolve();
        });
      return { fetchImpl, signals, asked };
    }

    function neverAnswers(init?: RequestInit): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }

    it("gives up on a probe whose headers have not come at 5 s, and probes again", async () => {
      const probe = probes(async (init, nth) =>
        nth === 1
          ? neverAnswers(init)
          : new Response(JSON.stringify({ process_id: "p-1" }), { status: 200 }),
      );
      const { flyApi } = platform("fdaa::1");
      const pool = new RunnerPool(flyApi, {
        size: 1,
        imageTag: "registry.example/runner:v1",
        bootPollIntervalMs: 1_000,
        fetchImpl: probe.fetchImpl,
      });

      const filling = pool.fill();
      await probe.asked(1);
      await vi.advanceTimersByTimeAsync(4_999);
      const before = probe.signals[0]?.aborted;
      await vi.advanceTimersByTimeAsync(1);

      expect([before, probe.signals[0]?.aborted]).toEqual([false, true]);
      await vi.advanceTimersByTimeAsync(1_000);
      await filling;
      expect(pool.stats()).toMatchObject({ ready: 1, fillErrors: 0 });
      expect(pool.get("m1")?.processId).toBe("p-1");
    });

    it("writes off a machine whose answer to the probe is still coming at 5 s", async () => {
      const state = { cancelled: false };
      let headSent = false;
      let ticks = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!headSent) {
              headSent = true;
              controller.enqueue(new TextEncoder().encode('{"process_id":"p-1","pad":"'));
              return;
            }
            // One byte a second, ending by itself after 600 s.
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                if (!state.cancelled) {
                  ticks += 1;
                  if (ticks > 600) controller.close();
                  else controller.enqueue(new Uint8Array([0x61]));
                }
                resolve();
              }, 1_000);
            });
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const probe = probes(async () => new Response(stream, { status: 200 }));
      const { flyApi, calls } = platform("fdaa::1");
      const pool = new RunnerPool(flyApi, {
        size: 1,
        imageTag: "registry.example/runner:v1",
        fetchImpl: probe.fetchImpl,
      });

      const filling = pool.fill();
      await probe.asked(1);
      await vi.advanceTimersByTimeAsync(4_999);
      const before = state.cancelled;
      await vi.advanceTimersByTimeAsync(1);

      expect([before, state.cancelled]).toEqual([false, true]);
      await filling;
      expect(calls).toContain("destroy:m1");
      expect(pool.stats()).toMatchObject({ ready: 0, fillErrors: 1 });
    });
  });
});
