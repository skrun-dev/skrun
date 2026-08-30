import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlyMachinesApi } from "./fly-api.js";
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
      maxRunTimeoutMs: 300_000,
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

  it("forgets machines the platform no longer has", async () => {
    const { pool } = reconcileHarness([]);
    seed(pool, "vanished");
    expect((await pool.reconcile()).forgotten).toBe(1);
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

describe("RunnerPool — operator counters", () => {
  it("separates a pool that had nothing from one whose machines did not work", () => {
    const pool = makePool();
    pool.recordHit();
    pool.recordMiss("empty");
    pool.recordMiss("unusable");
    expect(pool.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  // Every counter an operator needs to answer "is the pool doing its job?" without
  // reading platform logs.
  it("exposes the full counter set", () => {
    expect(Object.keys(makePool().stats()).sort()).toEqual([
      "claimed",
      "draining",
      "drains",
      "fillErrors",
      "filling",
      "hits",
      "misses",
      "orphansDestroyed",
      "ready",
      "size",
    ]);
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

  function makeSpy(over: Partial<RunnerPoolOptions> = {}): SpyPool {
    return new SpyPool(flyApi, {
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

  it("never starts on a disabled pool — size 0 is the default everywhere but our cloud", async () => {
    vi.useFakeTimers();
    const pool = makeSpy({ size: 0 });
    pool.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.fills).toBe(0);
    expect(pool.reconciles).toBe(0);
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
