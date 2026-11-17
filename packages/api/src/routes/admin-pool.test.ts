import { FlyMachinesApi, type Machine, RunnerPool } from "@skrun-dev/runtime";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { KeyContext } from "../types.js";
import { createAdminPoolRoutes } from "./admin-pool.js";

function createTestApp(role: "admin" | "user", pool?: RunnerPool, key?: KeyContext) {
  const fakeAuth = async (c: Context, next: () => Promise<void>) => {
    c.set("user", { id: "u1", namespace: "test", username: "test", role, key });
    await next();
  };
  const app = new Hono();
  app.route("/api", createAdminPoolRoutes(fakeAuth, pool));
  return app;
}

function makePool(size: number): RunnerPool {
  return new RunnerPool(new FlyMachinesApi("tok", "app"), {
    size,
    imageTag: "registry.example/runner:v1",
  });
}

/** An administrator's key reduced to running agents: not a master credential. */
const REDUCED_KEY: KeyContext = {
  id: "k1",
  scope_kind: "account",
  operations: ["agent:run"],
  agent_ids: [],
};

/**
 * A real pool whose counters went through its own paths: two destructions that
 * failed, a sweep that destroyed one run machine and could not read one run, a
 * maintenance pass skipped because the last one was still reconciling, and
 * four assignments' measurements of the infrastructure hosts: a moved address,
 * two that said nothing, one that found them unchanged.
 */
async function poolThatCounted(size: number): Promise<RunnerPool> {
  let answerListing: (machines: Machine[]) => void = () => {};
  const listing = new Promise<Machine[]>((resolve) => {
    answerListing = resolve;
  });
  const flyApi = { list: () => listing } as unknown as FlyMachinesApi;
  const pool = new RunnerPool(flyApi, { size, imageTag: "registry.example/runner:v1" });
  // A pool that keeps a stock would fill after its pass: not this bench's subject.
  pool.fill = async () => {};
  const pass = () => (pool as unknown as { maintain(): Promise<void> }).maintain();

  pool.recordDestroyFailure();
  pool.recordDestroyFailure();
  pool.recordSweep({ destroyed: 1, readFailures: 1 });
  pool.recordInfraHosts("changed");
  pool.recordInfraHosts("unmeasured");
  pool.recordInfraHosts(undefined);
  pool.recordInfraHosts("unchanged");
  const first = pass(); // its listing does not answer yet
  await pass(); // finds the first still reconciling: skipped, counted
  answerListing([]);
  await first;
  return pool;
}

describe("GET /api/admin/pool", () => {
  it("shows an administrator the counters", async () => {
    const res = await createTestApp("admin", makePool(2)).request("/api/admin/pool");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      enabled: true,
      size: 2,
      ready: 0,
      hits: 0,
      misses: 0,
      skipped: 0,
    });
  });

  // A pool passed over by runs not entitled to it is not a pool that failed to
  // serve: the skips are their own number, beside the misses.
  it("shows the runs that skipped the pool apart from its misses", async () => {
    const pool = makePool(2);
    pool.recordMiss("empty");
    pool.recordSkip();
    pool.recordSkip();
    const res = await createTestApp("admin", pool).request("/api/admin/pool");
    await expect(res.json()).resolves.toMatchObject({ misses: 1, skipped: 2 });
  });

  // Instance-wide numbers about the fleet: a tenant has no business seeing them
  // and no way to act on them. Opaque 404 rather than 403, like the rest of the
  // API — an unprivileged caller learns nothing about whether a pool exists here.
  it("hides the endpoint from a non-administrator", async () => {
    const res = await createTestApp("user", makePool(2)).request("/api/admin/pool");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // "No pool here" and "a pool that is failing" are different answers, and the
  // counters alone cannot tell them apart.
  it("reports a deployment with no pool as disabled rather than pretending", async () => {
    const res = await createTestApp("admin", undefined).request("/api/admin/pool");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
  });

  // A pool at size 0 keeps no stock — it is off — but its maintenance runs:
  // what it destroyed, or failed to, is still worth reading.
  it("treats a pool at size 0 as off, and still shows its counters", async () => {
    const res = await createTestApp("admin", makePool(0)).request("/api/admin/pool");
    await expect(res.json()).resolves.toMatchObject({
      enabled: false,
      size: 0,
      ready: 0,
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

  it("shows the maintenance's counters with the pool off and with a pool of two, and still hides them from an administrator's reduced key", async () => {
    for (const [size, enabled] of [
      [0, false],
      [2, true],
    ] as const) {
      const pool = await poolThatCounted(size);
      const res = await createTestApp("admin", pool).request("/api/admin/pool");
      expect(res.status, `size ${size}`).toBe(200);
      await expect(res.json(), `size ${size}`).resolves.toMatchObject({
        enabled,
        size,
        destroyFailures: 2,
        sweepPasses: 1,
        sweepDestroyed: 1,
        sweepReadFailures: 1,
        skippedPasses: 1,
        vanished: 0,
        infraHostsChanged: 1,
        infraHostsUnmeasured: 2,
      });

      const reduced = await createTestApp("admin", pool, REDUCED_KEY).request("/api/admin/pool");
      expect(reduced.status, `size ${size}, reduced key`).toBe(404);
      await expect(reduced.json(), `size ${size}, reduced key`).resolves.toEqual({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    }
  });
});
