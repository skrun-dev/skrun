import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_STARTED_ORPHAN_WINDOW_MS,
  INSTALL_REGISTRY_ALLOWLIST,
  MACHINE_LIFETIME_GRACE_MS,
  type Machine,
  type MachineState,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
  processOutputBytesBudget,
  type RunnerPool,
  storageInfraHosts,
} from "@skrun-dev/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import { MemoryStorage } from "../storage/memory.js";
import { runAcquisitionBounds } from "./acquisition-bounds.js";
import {
  buildFlyioDeps,
  readPoolSize,
  resolveRuntime,
  selectRuntimeMode,
} from "./adapter-selection.js";

const fullEnv = {
  FLY_API_TOKEN: "fly-tok",
  SKRUN_RUNNERS_APP: "skrun-runners",
  S3_ACCESS_KEY_ID: "ak",
  S3_SECRET_ACCESS_KEY: "sk",
  S3_BUCKET: "bucket",
  S3_ENDPOINT: "http://localhost:9000",
  RUNTIME_IMAGE_TAG: "ghcr.io/skrun-dev/skrun-runtime:edge",
} as unknown as NodeJS.ProcessEnv;

describe("adapter-selection", () => {
  it("selectRuntimeMode parses local/flyio, defaults to local, throws on garbage", () => {
    expect(selectRuntimeMode({ SKRUN_RUNTIME: "local" } as NodeJS.ProcessEnv)).toBe("local");
    expect(selectRuntimeMode({ SKRUN_RUNTIME: "flyio" } as NodeJS.ProcessEnv)).toBe("flyio");
    expect(selectRuntimeMode({} as NodeJS.ProcessEnv)).toBe("local");
    expect(() => selectRuntimeMode({ SKRUN_RUNTIME: "nope" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("buildFlyioDeps fails fast when RUNTIME_IMAGE_TAG is unset (no silent :latest)", () => {
    const { RUNTIME_IMAGE_TAG: _omit, ...noTag } = fullEnv as Record<string, string>;
    expect(() => buildFlyioDeps(noTag as NodeJS.ProcessEnv)).toThrow(/RUNTIME_IMAGE_TAG/);
  });

  it("buildFlyioDeps returns the explicit tag when set (no :latest fallback)", () => {
    const deps = buildFlyioDeps(fullEnv);
    expect(deps.runtimeImageTag).toBe("ghcr.io/skrun-dev/skrun-runtime:edge");
  });

  it("buildFlyioDeps hands every run the process's output bytes budget, the same instance at every call", () => {
    const deps = buildFlyioDeps(fullEnv);
    expect(deps.outputsBudget).toBe(processOutputBytesBudget());
    expect(buildFlyioDeps(fullEnv).outputsBudget).toBe(deps.outputsBudget);
  });

  it("buildFlyioDeps reports ALL missing cloud env vars at once", () => {
    expect(() => buildFlyioDeps({} as NodeJS.ProcessEnv)).toThrow(/RUNTIME_IMAGE_TAG/);
    expect(() => buildFlyioDeps({} as NodeJS.ProcessEnv)).toThrow(/FLY_API_TOKEN/);
  });

  it("infra docker-compose carries the documented :latest default (public self-host config)", () => {
    // Public self-host config only. A public test (this file syncs to the OSS mirror)
    // must NOT read non-synced files — they are absent there. The image-tag policy on
    // the PRIVATE artifacts (`.github/workflows/runtime-image.yml` publishes `:edge`,
    // `infra-cloud/fly.toml` pins a tag) is guarded by the two tests above (the api fails fast
    // if RUNTIME_IMAGE_TAG is unset) + a private `ci-internal` check.
    const root = join(import.meta.dirname, "..", "..", "..", "..");
    const compose = readFileSync(join(root, "infra", "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/RUNTIME_IMAGE_TAG:-latest/);
  });
});

describe("resolveRuntime — the one decision an entry point makes", () => {
  it("local: the mode alone, no cloud dependencies — even with cloud credentials in the environment", () => {
    expect(resolveRuntime({} as NodeJS.ProcessEnv)).toEqual({ mode: "local" });
    expect(resolveRuntime({ ...fullEnv, SKRUN_RUNTIME: "local" })).toEqual({ mode: "local" });
  });

  it("flyio with a complete configuration: the mode and the dependencies built from the same environment", () => {
    const runtime = resolveRuntime({ ...fullEnv, SKRUN_RUNTIME: "flyio" });
    expect(runtime.mode).toBe("flyio");
    expect(runtime.flyioDeps?.runtimeImageTag).toBe("ghcr.io/skrun-dev/skrun-runtime:edge");
    expect(runtime.flyioDeps?.storage).toBeDefined();
  });

  it("an incomplete cloud configuration or an unknown mode throws, as it always has", () => {
    expect(() => resolveRuntime({ SKRUN_RUNTIME: "flyio" } as NodeJS.ProcessEnv)).toThrow(
      /SKRUN_RUNTIME=flyio is missing required env vars/,
    );
    expect(() => resolveRuntime({ SKRUN_RUNTIME: "kubernetes" } as NodeJS.ProcessEnv)).toThrow(
      /SKRUN_RUNTIME="kubernetes" is not a valid runtime/,
    );
  });
});

describe("pre-warm pool configuration (optional, default off)", () => {
  const cloudEnv = fullEnv;

  // A pool is built at any size: at 0 it keeps no stock — it is off, and every
  // run creates its own machine — but its maintenance still has machines to
  // look after once the app starts it.
  it("defaults to a pool that keeps no stock, so every run creates its own machine", () => {
    expect(readPoolSize({} as NodeJS.ProcessEnv)).toBe(0);
    expect(readPoolSize({ SKRUN_RUNNER_POOL_SIZE: "" } as NodeJS.ProcessEnv)).toBe(0);
    const pool = buildFlyioDeps(cloudEnv).pool;
    expect(pool?.size).toBe(0);
    expect(pool?.enabled).toBe(false);
  });

  // An operator already running in cloud mode must upgrade untouched. A
  // required pool variable would refuse to start every one of them.
  it("does not make the pool variable required for an existing cloud deployment", () => {
    expect(() => buildFlyioDeps(cloudEnv)).not.toThrow();
  });

  it("builds a pool when asked, sized as configured", () => {
    const deps = buildFlyioDeps({ ...cloudEnv, SKRUN_RUNNER_POOL_SIZE: "3" });
    expect(deps.pool?.enabled).toBe(true);
    expect(deps.pool?.size).toBe(3);
  });

  // The hosts a pooled runner may reach for its infrastructure are those of a
  // cold one — one definition — the object store's host read from a probe URL,
  // as no run exists when the pool fills.
  it("gives a pooled runner the infrastructure hosts a cold one gets, the store's host among them", async () => {
    const deps = buildFlyioDeps({ ...cloudEnv, SKRUN_RUNNER_POOL_SIZE: "1" });
    const pool = deps.pool as unknown as { resolveInfraHosts(): Promise<string[]> };

    const hosts = await pool.resolveInfraHosts();

    // S3_ENDPOINT is http://localhost:9000: the store's URLs are on localhost.
    expect(hosts).toEqual([...INSTALL_REGISTRY_ALLOWLIST, "localhost"]);
    expect(hosts).toEqual(await storageInfraHosts(deps.storage));
  });

  // A typo should not silently disable a pool the operator believes is running.
  it("fails loudly on a value that is not a non-negative integer", () => {
    for (const bad of ["two", "-1", "1.5"]) {
      expect(() => readPoolSize({ SKRUN_RUNNER_POOL_SIZE: bad } as NodeJS.ProcessEnv)).toThrow(
        /non-negative integer/,
      );
    }
  });
});

// On the cloud runtime the app starts one maintenance of the runners' machines,
// whatever the pool's size: it is what destroys a machine a process that died
// left billing. These cases build the dependencies from an environment, as an
// entry point does, behind a platform simulated at its address; the app's own
// database judges the run machines.
describe("the cloud runtime's machine maintenance, started by the app at any pool size", () => {
  const T0 = Date.parse("2026-10-23T12:00:00.000Z");
  const MIN = 60_000;
  const INTERVAL_MS = 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const RUN_ENDED = "00000000-0000-4000-8000-000000000001";
  const RUN_UNKNOWN = "00000000-0000-4000-8000-000000000002";

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A listed machine of the runners' app, created `ageMs` before T0 and untouched since. */
  function listed(id: string, name: string, state: MachineState, ageMs: number): Machine {
    return {
      id,
      name,
      state,
      created_at: iso(T0 - ageMs),
      updated_at: iso(T0 - ageMs),
      config: { image: fullEnv.RUNTIME_IMAGE_TAG as string, env: {} },
    } as Machine;
  }

  /**
   * The runners' app as the platform holds it, answering at its address: a
   * listing, a destruction (the machine is gone after it), a creation —
   * refused, counted.
   */
  function platform(machines: Machine[]) {
    const held = new Map(machines.map((m) => [m.id, m]));
    const seen = { listings: 0, destroyed: [] as string[], creations: 0 };
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const one = /\/machines\/([^/]+)$/.exec(path);
      if (method === "GET" && path.endsWith("/machines")) {
        seen.listings += 1;
        return answer([...held.values()]);
      }
      if (method === "DELETE" && one) {
        const id = decodeURIComponent(one[1] as string);
        held.delete(id);
        seen.destroyed.push(id);
        return answer({ ok: true });
      }
      if (method === "POST" && path.endsWith("/machines")) {
        seen.creations += 1;
        return answer({ error: "no machine is created on this bench" }, 422);
      }
      return answer({ error: `unexpected ${method} ${path}` }, 404);
    };
    return { seen, fetchImpl };
  }

  it("at size 0, lists the app on every interval, sweeps the run machines on the app's database, spares a started pooled machine within the instance's longest run, and creates nothing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0 });
    const db = new MemoryDb();
    await db.createRun({
      id: RUN_ENDED,
      agent_id: null,
      agent_version: "dev/agent@1.0.0",
      status: "running",
      created_at: iso(T0 - 20 * MIN),
    });
    await db.finishRun(RUN_ENDED, { status: "completed", completed_at: iso(T0 - 6 * MIN) });
    const fly = platform([
      // A run's machine, its run ended more than the grace ago: only its row says so.
      listed("run-ended", machineNameForRun(RUN_ENDED), "started", 10 * MIN),
      // A run's machine without a row, younger than the fallback: spared.
      listed("run-unknown", machineNameForRun(RUN_UNKNOWN), "started", 10 * MIN),
      // A paused pooled machine an earlier process left: a pool at 0 empties it.
      listed("pool-parked", `${POOL_MACHINE_NAME_PREFIX}parked`, "suspended", 60 * MIN),
      // A started pooled machine untouched for 21 min — past the pool's default
      // window, within the instance's longest run (1 h), its margin and its grace.
      listed("pool-started", `${POOL_MACHINE_NAME_PREFIX}started`, "started", 21 * MIN),
    ]);
    vi.stubGlobal("fetch", fly.fetchImpl);
    const deps = buildFlyioDeps({ ...fullEnv, SKRUN_RUNNER_POOL_SIZE: "0" });
    const pool = deps.pool as RunnerPool;
    try {
      createApp(new MemoryStorage(), db, {
        runtimeMode: "flyio",
        flyioDeps: deps,
        quotaConfig: parseQuotaEnv({ SKRUN_RUN_MAX_TIMEOUT_S: "3600" }),
      });

      // The first pass runs at once, then one per interval.
      await vi.waitFor(() => expect(fly.seen.listings).toBe(1));
      await vi.waitFor(() => expect(pool.stats().sweepPasses).toBe(1));
      for (const pass of [2, 3]) {
        vi.advanceTimersByTime(INTERVAL_MS);
        await vi.waitFor(() => expect(fly.seen.listings).toBe(pass));
        await vi.waitFor(() => expect(pool.stats().sweepPasses).toBe(pass));
      }

      expect(fly.seen.creations).toBe(0);
      expect([...fly.seen.destroyed].sort()).toEqual(["pool-parked", "run-ended"]);
      expect(pool.enabled).toBe(false);
      expect(pool.stats()).toMatchObject({
        sweepDestroyed: 1,
        sweepReadFailures: 0,
        orphansDestroyed: 1,
        ready: 0,
        filling: 0,
      });
    } finally {
      pool?.stop();
    }
  });

  it("hands the maintenance a sweep and the window of a started pooled machine: the instance's longest run, its seat's margin and the grace — never below the pool's default", () => {
    const capped = { SKRUN_RUN_MAX_TIMEOUT_S: "900", SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20" };
    const cases: Array<[string, Record<string, string>, number | null]> = [
      ["no longest timeout: the pool's default", {}, null],
      [
        "a longest run shorter than the default: the default",
        { SKRUN_RUN_MAX_TIMEOUT_S: "60" },
        null,
      ],
      ["a longest timeout of 1 h", { SKRUN_RUN_MAX_TIMEOUT_S: "3600" }, 3600],
      ["a longest timeout of 15 min under an instance cap of 20", capped, 900],
    ];
    // A pool that keeps a stock, then one that does not: the seat's margin
    // counts one creation more while a pool refills.
    for (const size of ["2", "0"]) {
      for (const [label, env, maxTimeoutS] of cases) {
        const window =
          maxTimeoutS === null
            ? DEFAULT_STARTED_ORPHAN_WINDOW_MS
            : maxTimeoutS * 1000 +
              runAcquisitionBounds(parseQuotaEnv(env), size !== "0").seatMarginMs +
              MACHINE_LIFETIME_GRACE_MS;
        const at = `size ${size}, ${label}`;
        const deps = buildFlyioDeps({ ...fullEnv, SKRUN_RUNNER_POOL_SIZE: size });
        expect(deps.pool, at).toBeDefined();
        const start = vi.spyOn(deps.pool as RunnerPool, "start").mockImplementation(() => {});
        createApp(new MemoryStorage(), new MemoryDb(), {
          runtimeMode: "flyio",
          flyioDeps: deps,
          quotaConfig: parseQuotaEnv(env),
        });
        expect(start, at).toHaveBeenCalledOnce();
        const options = start.mock.calls[0]?.[0];
        expect(options?.startedOrphanWindowMs, at).toBe(window);
        expect(options?.sweep, at).toBeTypeOf("function");
      }
    }
  });
});
