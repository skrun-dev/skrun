import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../../llm/providers/types.js";
import { LLMRouter } from "../../llm/router.js";
import type { Logger } from "../../logger.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { RunEvent, RunnerSpawnedInfo, RunRequest } from "../../types.js";
import { FlyioAdapter, type PresignedStorageAdapter } from "./adapter.js";
import { type CreateMachineRequest, FlyMachinesApi } from "./fly-api.js";
import { buildMachineConfig, buildPoolMachineConfig } from "./machine-config.js";
import { RunnerPool } from "./pool.js";
import { authorizeRunnerRequest } from "./rpc-auth.js";

// One machines client per process is shared by the pre-warm pool and by every
// run (the API builds it once). This bench wires the REAL client to a fake
// platform, and the real adapter and pool to fake runners that authorize each
// request the way the runner does, with the credentials of their own machine.
// Two creations at once must then end with two machines, each holding the
// configuration — and the credential — of the caller that asked for it.
//
// Nothing here waits on a timer it cannot bound: every held response and every
// "wait until" carries a guard after which the test goes on and fails on what
// it asserts, rather than hanging.

const APP = "runners-app";
const IMAGE = "registry.example/runner:v1";
/** Real-time bound of every hold and every wait of this bench. */
const GUARD_MS = 2_000;
/** Room for a failing case to run out its guards and reach its assertions. */
const TEST_TIMEOUT_MS = 20_000;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface FakeMachine {
  id: string;
  name: string;
  state: "started" | "suspended" | "stopped";
  private_ip: string;
  config: CreateMachineRequest["config"];
  created_at: string;
}

interface FakeRunner {
  processId: string;
  claimToken?: string;
  runToken?: string;
}

interface Hold {
  /** Resolves when the held request has reached the platform. */
  arrived: Promise<void>;
  release(): void;
}

function connectionRefused(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The platform and the private network, in memory. A creation builds a machine
 * from the body it receives — a fresh id and private address per request — and
 * boots a runner that holds the credentials of that body's environment.
 */
class FakeFly {
  readonly machines = new Map<string, FakeMachine>();
  readonly runners = new Map<string, FakeRunner>();
  /** Names of the machines each creation request asked for, in arrival order. */
  readonly posts: string[] = [];
  readonly suspends: string[] = [];
  readonly destroys: string[] = [];
  /** Runner requests refused by the runner's own authorization. */
  readonly denials: Array<{ machine: string; path: string; status: number }> = [];
  private seq = 0;
  private pendingHold: { gate: Promise<void>; arrive: () => void } | null = null;

  /** Hold the response to the next creation until the test releases it. */
  holdNextCreate(): Hold {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, GUARD_MS);
      release = () => {
        clearTimeout(guard);
        resolve();
      };
    });
    this.pendingHold = { gate, arrive };
    return { arrived, release };
  }

  /** Make the next creation's machine, then cut the connection before the answer. */
  cutNextCreateAfterMaking(): void {
    this.cutNext = true;
  }

  nameOf(machineId: string): string | undefined {
    return this.named.get(machineId);
  }

  /** The label a machine was created with — destroyed ones included. */
  labelOf(machineId: string): Record<string, unknown> | undefined {
    return this.labels.get(machineId);
  }

  /** The environment a machine was created with — destroyed ones included. */
  envOf(machineId: string): Record<string, string> | undefined {
    return this.envs.get(machineId);
  }

  /** Every machine ever created, by id — destroyed ones included. */
  private readonly named = new Map<string, string>();
  private readonly labels = new Map<string, Record<string, unknown> | undefined>();
  private readonly envs = new Map<string, Record<string, string> | undefined>();
  private cutNext = false;
  /** The label filter of each listing that named one, in arrival order. */
  readonly labelledListings: string[] = [];

  readonly platformFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    // /v1/apps/<app>/machines[/<id>[/<action>]]
    const [, , app, collection, id, action] = url.pathname.split("/").filter(Boolean);
    if (app !== APP || collection !== "machines") return json({ error: "not found" }, 404);

    if (method === "POST" && id === undefined) {
      const body = JSON.parse(String(init?.body)) as CreateMachineRequest;
      this.posts.push(body.name ?? "(unnamed)");
      const machine = this.createMachine(body);
      const hold = this.pendingHold;
      this.pendingHold = null;
      if (hold) {
        hold.arrive();
        await hold.gate;
      }
      if (this.cutNext) {
        this.cutNext = false;
        const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        throw new TypeError("fetch failed", { cause });
      }
      return json(machine);
    }
    if (method === "GET" && id === undefined) {
      // The platform filters on a label pair: `?metadata.<key>=<value>`.
      const filters = [...url.searchParams].filter(([key]) => key.startsWith("metadata."));
      if (filters.length > 0) this.labelledListings.push(url.search.slice(1));
      const listed = [...this.machines.values()].filter((m) =>
        filters.every(
          ([key, value]) => m.config.metadata?.[key.slice("metadata.".length)] === value,
        ),
      );
      return json(listed);
    }

    const machine = id === undefined ? undefined : this.machines.get(id);
    if (!machine) return json({ error: "machine not found" }, 404);
    if (method === "DELETE") {
      this.destroys.push(machine.id);
      this.machines.delete(machine.id);
      this.runners.delete(machine.id);
      return json({ ok: true });
    }
    if (method === "POST" && action === "suspend") {
      this.suspends.push(machine.id);
      machine.state = "suspended";
      return json({ ok: true });
    }
    if (method === "POST" && action === "start") {
      machine.state = "started";
      return json({ ok: true });
    }
    if (method === "POST" && action === "stop") {
      machine.state = "stopped";
      return json({ ok: true });
    }
    return json({ error: "unsupported" }, 400);
  }) as typeof fetch;

  /** The private network: a runner answers only while its machine is running. */
  readonly runnerFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const ip = url.hostname.replace(/^\[|\]$/g, "");
    const machine = [...this.machines.values()].find((m) => m.private_ip === ip);
    const runner = machine ? this.runners.get(machine.id) : undefined;
    if (!machine || !runner || machine.state !== "started") throw connectionRefused();

    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    const decision = authorizeRunnerRequest(url.pathname, auth, {
      claimToken: runner.claimToken,
      runToken: runner.runToken,
    });
    if (!decision.allowed) {
      const status = decision.denial === "already-claimed" ? 409 : 401;
      this.denials.push({ machine: machine.id, path: url.pathname, status });
      return json({ error: "unauthorized" }, status);
    }

    switch (url.pathname) {
      case "/healthz":
        return json({ ok: true, process_id: runner.processId });
      case "/claim": {
        const body = JSON.parse(String(init?.body)) as { rpcToken: string };
        runner.runToken = body.rpcToken;
        return json({ ok: true, process_id: runner.processId });
      }
      case "/init":
        return json({ ok: true, tools: [] });
      case "/outputs/collect":
        return json({ files: [] });
      default:
        return json({ error: "not found" }, 404);
    }
  }) as typeof fetch;

  private createMachine(body: CreateMachineRequest): FakeMachine {
    this.seq += 1;
    const machine: FakeMachine = {
      id: `m-${this.seq}`,
      name: body.name ?? `unnamed-${this.seq}`,
      state: "started",
      private_ip: `fdaa:0:1::${this.seq}`,
      config: body.config,
      created_at: new Date().toISOString(),
    };
    this.machines.set(machine.id, machine);
    this.named.set(machine.id, machine.name);
    this.labels.set(machine.id, body.config.metadata);
    this.envs.set(machine.id, body.config.env);
    const env = body.config.env ?? {};
    this.runners.set(machine.id, {
      processId: `proc-${this.seq}`,
      claimToken: env.RUNNER_CLAIM_TOKEN,
      runToken: env.RUNNER_RPC_TOKEN,
    });
    return machine;
  }
}

/** Poll a condition on real time, bounded. Returns whether it held in time. */
async function until(condition: () => boolean, guardMs = GUARD_MS): Promise<boolean> {
  const deadline = Date.now() + guardMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
}

function storage(): PresignedStorageAdapter {
  return {
    put: async () => {},
    getPresignedDownloadUrl: async () => "https://storage.example/bundle?sig=1",
    getPresignedUploadUrl: async () => "https://storage.example/outputs?sig=1",
  };
}

function okProvider(): LLMProvider {
  return {
    name: "mock",
    call: async () => ({
      content: '{"result":"ok"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    }),
  };
}

function runRequest(runId: string): RunRequest {
  return {
    agentConfig: {
      name: "test-agent",
      description: "Test agent",
      version: "1.0.0",
      model: { provider: "mock", name: "mock-model" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [],
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: [] },
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
      },
      state: { type: "none" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "You are a test agent.",
    input: { query: "hello" },
    runId,
    bundleKey: "acme/agent/1.0.0.agent",
  };
}

interface RunOutcome {
  events: RunEvent[];
  spawned: RunnerSpawnedInfo | undefined;
}

/** One run, on an adapter of its own — the API builds one per run — sharing the client and pool. */
async function runOnce(
  fake: FakeFly,
  flyApi: FlyMachinesApi,
  runId: string,
  pool?: RunnerPool,
  request: Partial<RunRequest> = {},
): Promise<RunOutcome> {
  const router = new LLMRouter();
  router.registerProvider("mock", okProvider());
  let spawned: RunnerSpawnedInfo | undefined;
  const adapter = new FlyioAdapter(
    flyApi,
    storage(),
    router,
    new ToolRegistry(),
    undefined,
    {
      runtimeImage: IMAGE,
      fetchImpl: fake.runnerFetch,
      pool,
      maxBootTimeMs: GUARD_MS,
      bootPollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
      onRunnerSpawned: (info) => {
        spawned = info;
      },
    },
    silentLogger,
  );
  const events: RunEvent[] = [];
  for await (const event of adapter.executeStream({ ...runRequest(runId), ...request })) {
    events.push(event);
  }
  return { events, spawned };
}

/**
 * The client's clock, virtual: every wait it makes — a send slot, a refusal, the
 * spacing of a label search's reads — moves the clock forward by its length and
 * ends on the next turn of the event loop. The buckets keep their arithmetic,
 * and nothing here waits for real time.
 */
function steppingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        now += ms;
        setImmediate(resolve);
      }),
  };
}

function sharedClient(fake: FakeFly): FlyMachinesApi {
  const clock = steppingClock();
  return new FlyMachinesApi("token", APP, {
    fetchImpl: fake.platformFetch,
    nowImpl: clock.now,
    sleepImpl: clock.sleep,
  });
}

const pools: RunnerPool[] = [];

function startablePool(fake: FakeFly, flyApi: FlyMachinesApi): RunnerPool {
  const pool = new RunnerPool(
    flyApi,
    {
      size: 1,
      imageTag: IMAGE,
      fetchImpl: fake.runnerFetch,
      maxBootTimeMs: GUARD_MS,
      bootPollIntervalMs: 5,
      sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      // Long enough that only the explicit start and the top-up after a claim fill.
      maintenanceIntervalMs: 3_600_000,
    },
    silentLogger,
  );
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.stop();
});

function types(outcome: RunOutcome): string[] {
  return outcome.events.map((e) => e.type);
}

describe("two machine creations at once", () => {
  it(
    "send two requests, and each caller gets the machine built from its own body",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);
      const hold = fake.holdNextCreate();

      const runBody = buildMachineConfig({
        runId: "run-a",
        image: IMAGE,
        allowedHosts: [],
        rpcToken: "r".repeat(64),
      });
      const poolBody = buildPoolMachineConfig({
        poolId: "p1",
        image: IMAGE,
        claimToken: "c".repeat(64),
      });

      const first = api.create(runBody);
      await hold.arrived;
      const second = api.create(poolBody);
      await until(() => fake.posts.length === 2);
      hold.release();
      const [forRun, forPool] = await Promise.all([first, second]);

      expect(fake.posts).toEqual([runBody.name, poolBody.name]);
      expect(forRun.name).toBe(runBody.name);
      expect(forPool.name).toBe(poolBody.name);
      expect(forRun.id).not.toBe(forPool.id);
      expect(forRun.config?.env?.RUNNER_RPC_TOKEN).toBe("r".repeat(64));
      expect(forPool.config?.env?.RUNNER_CLAIM_TOKEN).toBe("c".repeat(64));
      // Each machine carries its own label, the pool's none of a run's.
      expect(fake.labelOf(forRun.id)).toEqual({ skrun_run_id: "run-a" });
      expect(fake.labelOf(forPool.id)).toEqual({ skrun_pool_id: "p1" });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a pool refill and a cold run on one shared client", () => {
  it(
    "a cold run created while the pool refills gets its own machine, and the pool keeps its own",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);
      const pool = startablePool(fake, api);
      pool.start();
      expect(await until(() => pool.stats().ready === 1)).toBe(true);
      const pooled = pool.all()[0].machineId;

      // Run A takes the ready machine; the top-up after its claim creates the next
      // one, and that creation is held while run B, finding the pool empty,
      // creates its own.
      const refill = fake.holdNextCreate();
      const runA = runOnce(fake, api, "run-a", pool);
      await refill.arrived;
      const runB = runOnce(fake, api, "run-b", pool);
      await until(() => fake.posts.length === 3);
      refill.release();
      const [a, b] = await Promise.all([runA, runB]);
      await until(() => pool.stats().ready === 1);

      expect(fake.posts).toHaveLength(3);
      expect(fake.posts[2]).toBe("skrun-run-run-b");
      expect(fake.denials).toEqual([]);
      expect(types(a)).toContain("runner_spawned");
      expect(types(a).at(-1)).toBe("run_complete");
      expect(types(b)).toContain("runner_spawned");
      expect(types(b).at(-1)).toBe("run_complete");
      expect(a.spawned?.machineId).toBe(pooled);
      expect(fake.nameOf(b.spawned?.machineId ?? "")).toBe("skrun-run-run-b");

      // The pool holds the machine it created, ready and alive.
      const refilled = pool.all().find((m) => m.state === "ready")?.machineId ?? "";
      expect(fake.nameOf(refilled)).toMatch(/^skrun-pool-/);
      expect(fake.machines.get(refilled)?.state).toBe("suspended");
      // Nobody paused or destroyed a machine that was not theirs.
      expect(fake.suspends.map((id) => fake.nameOf(id))).toEqual([
        expect.stringMatching(/^skrun-pool-/),
        expect.stringMatching(/^skrun-pool-/),
      ]);
      expect([...fake.destroys].sort()).toEqual([pooled, b.spawned?.machineId].sort());
      // Each machine carries its own label, the pool's none of a run's.
      expect(fake.labelOf(b.spawned?.machineId ?? "")).toEqual({ skrun_run_id: "run-b" });
      for (const id of [pooled, refilled]) {
        expect(fake.labelOf(id)).toEqual({
          skrun_pool_id: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a pool refill started while a cold run creates gets its own machine, and never pauses the run's",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);
      const pool = startablePool(fake, api);

      // The run's creation is held; the pool starts filling during it.
      const cold = fake.holdNextCreate();
      const run = runOnce(fake, api, "run-a", pool);
      await cold.arrived;
      pool.start();
      await until(() => fake.posts.length === 2);
      await until(() => pool.stats().ready === 1);
      cold.release();
      const outcome = await run;
      await until(() => pool.stats().ready === 1);

      expect(fake.posts).toHaveLength(2);
      expect(fake.posts[1]).toMatch(/^skrun-pool-/);
      expect(fake.denials).toEqual([]);
      expect(types(outcome)).toContain("runner_spawned");
      expect(types(outcome).at(-1)).toBe("run_complete");
      expect(fake.nameOf(outcome.spawned?.machineId ?? "")).toBe("skrun-run-run-a");

      const ready = pool.all().find((m) => m.state === "ready")?.machineId ?? "";
      expect(fake.nameOf(ready)).toMatch(/^skrun-pool-/);
      expect(fake.suspends).toEqual([ready]);
      expect(fake.destroys).toEqual([outcome.spawned?.machineId]);
      expect(fake.labelOf(outcome.spawned?.machineId ?? "")).toEqual({ skrun_run_id: "run-a" });
      expect(fake.labelOf(ready)).toEqual({
        skrun_pool_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// A run that may not take a pooled machine creates its own even while the pool
// refills — once a pool runs, the most common way a cold creation meets a fill.
// The two creations cross on the shared client, and the run passed the pool
// over without touching it: it took nothing from it and asked it for nothing.
describe("a run sent to the cold path on purpose while the pool refills", () => {
  it(
    "creates its own machine beside the pool's — two machines, each with its own configuration and label; the run and the fill both succeed, and the pool was neither taken from nor asked to refill",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);
      const pool = startablePool(fake, api);
      const takeReady = vi.spyOn(pool, "takeReady");
      const requestTopUp = vi.spyOn(pool, "requestTopUp");

      // The pool's creation is held; the run creates its own meanwhile.
      const fill = fake.holdNextCreate();
      pool.start();
      await fill.arrived;
      const run = runOnce(fake, api, "run-a", pool, { poolEligible: false });
      await until(() => fake.posts.length === 2);
      fill.release();
      const outcome = await run;
      await until(() => pool.stats().ready === 1);

      expect(fake.posts).toHaveLength(2);
      expect(fake.posts[0]).toMatch(/^skrun-pool-/);
      expect(fake.posts[1]).toBe("skrun-run-run-a");
      expect(fake.denials).toEqual([]);
      expect(types(outcome)).toContain("runner_spawned");
      expect(types(outcome).at(-1)).toBe("run_complete");

      // Two machines: the run's, from the run's body, and the pool's, from its own.
      const runMachine = outcome.spawned?.machineId ?? "";
      const ready = pool.all().find((m) => m.state === "ready")?.machineId ?? "";
      expect(ready).not.toBe(runMachine);
      expect(fake.nameOf(runMachine)).toBe("skrun-run-run-a");
      expect(fake.labelOf(runMachine)).toEqual({ skrun_run_id: "run-a" });
      expect(fake.envOf(runMachine)?.RUNNER_RPC_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.envOf(runMachine)?.RUNNER_CLAIM_TOKEN).toBeUndefined();
      expect(fake.nameOf(ready)).toMatch(/^skrun-pool-/);
      expect(fake.labelOf(ready)).toEqual({
        skrun_pool_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(fake.envOf(ready)?.RUNNER_CLAIM_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.envOf(ready)?.RUNNER_RPC_TOKEN).toBeUndefined();

      // The fill succeeded — its machine paused and ready —, the run's machine went
      // with its run, and nobody paused or destroyed a machine that was not theirs.
      expect(fake.machines.get(ready)?.state).toBe("suspended");
      expect(fake.suspends).toEqual([ready]);
      expect(fake.destroys).toEqual([runMachine]);

      // The run passed the pool over: nothing taken, no refill asked, a skip counted.
      expect(takeReady).not.toHaveBeenCalled();
      expect(requestTopUp).not.toHaveBeenCalled();
      expect(pool.stats()).toMatchObject({ ready: 1, hits: 0, misses: 0, skipped: 1 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("two cold runs at once, no pool", () => {
  it(
    "each gets its own machine and completes",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);

      const first = fake.holdNextCreate();
      const runA = runOnce(fake, api, "run-a");
      await first.arrived;
      const runB = runOnce(fake, api, "run-b");
      await until(() => fake.posts.length === 2);
      first.release();
      const [a, b] = await Promise.all([runA, runB]);

      expect(fake.posts).toEqual(["skrun-run-run-a", "skrun-run-run-b"]);
      expect(fake.denials).toEqual([]);
      expect(types(a).at(-1)).toBe("run_complete");
      expect(types(b).at(-1)).toBe("run_complete");
      expect(fake.nameOf(a.spawned?.machineId ?? "")).toBe("skrun-run-run-a");
      expect(fake.nameOf(b.spawned?.machineId ?? "")).toBe("skrun-run-run-b");
      expect([...fake.destroys].sort()).toEqual(
        [a.spawned?.machineId, b.spawned?.machineId].sort(),
      );
      expect(fake.labelOf(a.spawned?.machineId ?? "")).toEqual({ skrun_run_id: "run-a" });
      expect(fake.labelOf(b.spawned?.machineId ?? "")).toEqual({ skrun_run_id: "run-b" });
    },
    TEST_TIMEOUT_MS,
  );
});

// The platform made the run's machine, then the connection was cut before its
// answer: the outcome is unknown. Sent again blindly, the creation would make a
// second machine and leave the first to bill. Found again by its label, the
// machine is the run's own — the configuration sent, the run's credential in it.
describe("a cold run whose creation's answer is lost", () => {
  it(
    "finds its machine by its label and runs on it: one creation sent, nothing else to clean up",
    async () => {
      const fake = new FakeFly();
      const api = sharedClient(fake);
      fake.cutNextCreateAfterMaking();

      const outcome = await runOnce(fake, api, "run-a");

      expect(fake.posts).toEqual(["skrun-run-run-a"]);
      expect(types(outcome)).toContain("runner_spawned");
      expect(types(outcome).at(-1)).toBe("run_complete");
      expect(fake.denials).toEqual([]);
      // The same machine: its id and its private address.
      expect(outcome.spawned?.machineId).toBe("m-1");
      expect(outcome.spawned?.privateIp).toBe("fdaa:0:1::1");
      expect(fake.labelOf("m-1")).toEqual({ skrun_run_id: "run-a" });
      // One search, a single read; no listing for duplicates — nothing was sent twice.
      expect(fake.labelledListings).toEqual(["metadata.skrun_run_id=run-a"]);
      // Destroyed at the end of the run, and no other machine left behind.
      expect(fake.destroys).toEqual(["m-1"]);
      expect(fake.machines.size).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
