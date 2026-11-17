import {
  FlyMachinesApi,
  type FlyMachinesApiOptions,
  MACHINE_LIFETIME_GRACE_MS,
  type Machine,
  undeclaredLifetimeFallbackMs,
} from "@skrun-dev/runtime";
import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { CliExit } from "../utils/exit.js";
import { cleanupMachines, registerAdminCommand } from "./admin.js";

const FIXED_NOW = 1_700_000_000_000;

function makeMachine(overrides: Partial<Machine>): Machine {
  return {
    id: overrides.id ?? "m-default",
    name: overrides.name ?? "skrun-run-default",
    state: "stopped",
    created_at: new Date(FIXED_NOW - 60_000).toISOString(),
    ...overrides,
  } as Machine;
}

function makeFlyApi(machines: Machine[]): {
  api: FlyMachinesApi;
  destroySpy: ReturnType<typeof vi.fn>;
} {
  const destroySpy = vi.fn().mockResolvedValue(undefined);
  const api = {
    list: vi.fn().mockResolvedValue(machines),
    destroy: destroySpy,
    create: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as FlyMachinesApi;
  return { api, destroySpy };
}

describe("cleanupMachines", () => {
  it("destroys runner machines older than --older-than", async () => {
    const old = makeMachine({
      id: "m-old",
      name: "skrun-run-abc",
      created_at: new Date(FIXED_NOW - 1_200_000).toISOString(), // 20 min old
    });
    const young = makeMachine({
      id: "m-young",
      name: "skrun-run-xyz",
      created_at: new Date(FIXED_NOW - 60_000).toISOString(), // 1 min old
    });
    const { api, destroySpy } = makeFlyApi([old, young]);
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: (l) => lines.push(l),
      olderThan: 600,
    });

    expect(result.scanned).toBe(2);
    expect(result.cleaned).toEqual(["m-old"]);
    expect(destroySpy).toHaveBeenCalledExactlyOnceWith("m-old");
    expect(lines.some((l) => l.includes("PASS cleanup-machines: scanned=2 cleaned=1"))).toBe(true);
  });

  it("dry-run lists candidates without calling destroy", async () => {
    const old = makeMachine({
      id: "m-old",
      name: "skrun-run-old",
      created_at: new Date(FIXED_NOW - 1_200_000).toISOString(),
    });
    const { api, destroySpy } = makeFlyApi([old]);
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: (l) => lines.push(l),
      olderThan: 600,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.cleaned).toEqual(["m-old"]);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("[dry-run] would destroy m-old"))).toBe(true);
  });

  it("ignores machines whose name does not match skrun-run-* (only sandbox runners are touched)", async () => {
    const sandboxRunner = makeMachine({
      id: "m-runner",
      name: "skrun-run-abc",
      created_at: new Date(FIXED_NOW - 3_600_000).toISOString(),
    });
    const apiServer = makeMachine({
      id: "m-api",
      name: "skrun-cloud-api",
      created_at: new Date(FIXED_NOW - 3_600_000).toISOString(),
    });
    const otherTenant = makeMachine({
      id: "m-other",
      name: "some-other-app-server",
      created_at: new Date(FIXED_NOW - 3_600_000).toISOString(),
    });
    const { api, destroySpy } = makeFlyApi([sandboxRunner, apiServer, otherTenant]);

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: () => {},
      olderThan: 600,
    });

    expect(result.scanned).toBe(1);
    expect(result.cleaned).toEqual(["m-runner"]);
    expect(destroySpy).toHaveBeenCalledExactlyOnceWith("m-runner");
  });

  it("never destroys a machine with a missing or unparseable created_at — it names it, and leaves it", async () => {
    const noTimestamp = makeMachine({
      id: "m-no-ts",
      name: "skrun-run-no-ts",
      created_at: undefined,
    });
    const unparseable = makeMachine({
      id: "m-bad-ts",
      name: "skrun-run-bad-ts",
      created_at: "not a date",
    });
    const { api, destroySpy } = makeFlyApi([noTimestamp, unparseable]);
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: (l) => lines.push(l),
      olderThan: 600,
    });

    expect(result.cleaned).toEqual([]);
    expect(result.left).toEqual(["m-no-ts", "m-bad-ts"]);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(lines).toContain(
      "left m-no-ts (name=skrun-run-no-ts, state=stopped): its listing gives no time to judge " +
        "it on — this command never destroys a machine on a time it cannot read",
    );
  });

  it("continues iterating when a single destroy call fails (best-effort cleanup)", async () => {
    const a = makeMachine({
      id: "m-a",
      name: "skrun-run-a",
      created_at: new Date(FIXED_NOW - 1_200_000).toISOString(),
    });
    const b = makeMachine({
      id: "m-b",
      name: "skrun-run-b",
      created_at: new Date(FIXED_NOW - 1_200_000).toISOString(),
    });
    const destroySpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("Fly API 503"))
      .mockResolvedValueOnce(undefined);
    const api = {
      list: vi.fn().mockResolvedValue([a, b]),
      destroy: destroySpy,
      create: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as FlyMachinesApi;
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: (l) => lines.push(l),
      olderThan: 600,
    });

    expect(result.cleaned).toEqual(["m-b"]);
    expect(destroySpy).toHaveBeenCalledTimes(2);
    expect(lines.some((l) => l.includes("FAILED to destroy m-a"))).toBe(true);
  });

  it("throws when no Fly creds configured (refuses to run silently)", async () => {
    await withEnv(
      { FLY_API_TOKEN: null, SKRUN_RUNNERS_APP: null, FLY_APP_NAME: null },
      async () => {
        await expect(cleanupMachines()).rejects.toThrow(/FLY_API_TOKEN \+ SKRUN_RUNNERS_APP/);
      },
    );
  });
});

/**
 * Set/unset env vars for the duration of `fn`, then restore exactly — including
 * variables that were absent to begin with (`null` here means "delete it").
 */
async function withEnv(
  vars: Record<string, string | null>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("cleanup-machines app-name resolution", () => {
  // The failure this guards against is silent: inside a Fly machine, Fly sets
  // FLY_APP_NAME to that machine's own app, so a reaper reading it sweeps the
  // wrong app, destroys nothing, and reports success.
  it("prefers SKRUN_RUNNERS_APP — the name the api-server reads — over FLY_APP_NAME", async () => {
    await withEnv(
      { SKRUN_RUNNERS_APP: "runners-app", FLY_APP_NAME: "the-app-i-run-in" },
      async () => {
        const { api } = makeFlyApi([]);
        const lines: string[] = [];
        await cleanupMachines({ flyApi: api, now: () => FIXED_NOW, log: (l) => lines.push(l) });

        expect(lines.some((l) => l.includes("app=runners-app"))).toBe(true);
        expect(lines.some((l) => l.includes("the-app-i-run-in"))).toBe(false);
        expect(lines.some((l) => l.startsWith("WARNING"))).toBe(false);
      },
    );
  });

  it("still accepts FLY_APP_NAME, but says so — an unset SKRUN_RUNNERS_APP is the risky case", async () => {
    await withEnv({ SKRUN_RUNNERS_APP: null, FLY_APP_NAME: "legacy-app" }, async () => {
      const { api } = makeFlyApi([]);
      const lines: string[] = [];
      await cleanupMachines({ flyApi: api, now: () => FIXED_NOW, log: (l) => lines.push(l) });

      expect(lines.some((l) => l.startsWith("WARNING") && l.includes("FLY_APP_NAME"))).toBe(true);
      expect(lines.some((l) => l.includes("app=legacy-app"))).toBe(true);
    });
  });

  it("--app wins over both env vars and silences the warning", async () => {
    await withEnv({ SKRUN_RUNNERS_APP: "env-app", FLY_APP_NAME: "injected-app" }, async () => {
      const { api } = makeFlyApi([]);
      const lines: string[] = [];
      await cleanupMachines({
        flyApi: api,
        appName: "explicit-app",
        now: () => FIXED_NOW,
        log: (l) => lines.push(l),
      });

      expect(lines.some((l) => l.includes("app=explicit-app"))).toBe(true);
      expect(lines.some((l) => l.startsWith("WARNING"))).toBe(false);
    });
  });
});

describe("cleanup-machines and pre-created (pooled) machines", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();

  function run(
    machines: Array<Record<string, unknown>>,
    opts: { olderThan?: number; includePool?: boolean } = {},
  ) {
    const destroyed: string[] = [];
    const lines: string[] = [];
    const flyApi = {
      list: async () => machines,
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    } as unknown as FlyMachinesApi;
    return {
      destroyed,
      lines,
      result: cleanupMachines({
        flyApi,
        olderThan: opts.olderThan ?? 600,
        includePool: opts.includePool,
        now: () => NOW,
        log: (l: string) => lines.push(l),
      }),
    };
  }

  // THE case this branch exists for. A pooled machine's creation time is when the
  // pool was filled — hours before any run touches it — so the age rule that is
  // sound for per-run machines would destroy a live run here.
  it("does NOT destroy a long-created pooled machine that is serving a run", async () => {
    const { destroyed, result } = run([
      {
        id: "serving",
        name: "skrun-pool-a",
        state: "started",
        created_at: at(NOW - 50 * HOUR),
        updated_at: at(NOW - 30_000),
      },
    ]);
    await result;
    expect(destroyed).toEqual([]);
  });

  /**
   * The measured failure: an idle suspended pooled machine IS unused stock, and
   * an earlier version of this command destroyed it once it passed the cutoff.
   * On the five-minute schedule the docs recommend, that emptied the pool every
   * pass — no run ever broke, the feature simply stopped paying off. Age cannot
   * answer "is this stock or waste": only the server that made it knows, and this
   * process cannot ask.
   */
  it("leaves an idle suspended pooled machine alone, however old — it is live stock", async () => {
    const { destroyed, lines, result } = run([
      {
        id: "idle",
        name: "skrun-pool-b",
        state: "suspended",
        created_at: at(NOW - 50 * HOUR),
        updated_at: at(NOW - 2 * HOUR),
      },
    ]);
    await result;
    expect(destroyed).toEqual([]);
    // Skipping must be visible: a silent skip reads exactly like an empty app.
    expect(lines.some((l) => l.includes("left alone") && l.includes("--include-pool"))).toBe(true);
  });

  it("leaves a long-abandoned started pooled machine alone too, by default", async () => {
    const { destroyed, result } = run([
      {
        id: "abandoned",
        name: "skrun-pool-c",
        state: "started",
        created_at: at(NOW - 50 * HOUR),
        updated_at: at(NOW - 10 * HOUR),
      },
    ]);
    await result;
    expect(destroyed).toEqual([]);
  });

  it("sweeps suspended pooled machines with --include-pool, at any age", async () => {
    const { destroyed, result } = run(
      [
        {
          id: "fresh",
          name: "skrun-pool-d",
          state: "suspended",
          created_at: at(NOW - 50 * HOUR),
          updated_at: at(NOW - 1_000), // filled a second ago — a teardown takes it anyway
        },
      ],
      { includePool: true },
    );
    await result;
    expect(destroyed).toEqual(["fresh"]);
  });

  // The safety property survives the flag: even a deliberate sweep cannot take a
  // machine that might have a run on it right now.
  it("still refuses a started pooled machine that was touched recently, even with the flag", async () => {
    const { destroyed, result } = run(
      [
        {
          id: "serving",
          name: "skrun-pool-e",
          state: "started",
          created_at: at(NOW - 50 * HOUR),
          updated_at: at(NOW - 30_000),
        },
        {
          id: "abandoned",
          name: "skrun-pool-f",
          state: "started",
          created_at: at(NOW - 50 * HOUR),
          updated_at: at(NOW - 10 * HOUR),
        },
      ],
      { includePool: true },
    );
    await result;
    expect(destroyed).toEqual(["abandoned"]);
  });

  it("still cleans up per-run machines by age, unchanged", async () => {
    const { destroyed, result } = run([
      { id: "orphan-run", name: "skrun-run-x", state: "started", created_at: at(NOW - 2 * HOUR) },
      { id: "recent-run", name: "skrun-run-y", state: "started", created_at: at(NOW - 60_000) },
    ]);
    await result;
    expect(destroyed).toEqual(["orphan-run"]);
  });
});

const REFUSED_IN_STATE =
  '{"error":"failed_precondition: unable to destroy machine, not currently stopped, suspended, failed, pending, or archived"}';

/**
 * The real platform client, on a platform that answers as measured: a DELETE
 * with force destroys any machine; one without, only a stopped, suspended or
 * failed one.
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
  const quiet = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as unknown as FlyMachinesApiOptions["logger"];
  const flyApi = new FlyMachinesApi("token", "app", {
    fetchImpl,
    sleepImpl: async () => {},
    logger: quiet,
  });
  return { live, deletes, flyApi };
}

// The listing is old by the time each destruction leaves, and the server that
// owns a suspended pooled machine may wake it for a run in between. Under
// --include-pool a suspended one is destroyed without force, which the platform
// refuses for a machine running by then (measured against it on 2026-10-23):
// that one is spared, and the output says so. Through the real client, against
// a platform that answers as measured.
describe("cleanup-machines --include-pool and a pooled machine woken since the listing", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();

  const stock = (id: string) => ({
    id,
    name: `skrun-pool-${id}`,
    state: "suspended",
    created_at: at(NOW - 50 * HOUR),
    updated_at: at(NOW - 2 * HOUR),
  });

  it("spares a suspended pooled machine its server woke before the destruction: one line says so, neither cleaned nor failed", async () => {
    // The server wakes p2 for a run while p1 is being destroyed.
    const fly = platform([stock("p1"), stock("p2")], (id, live) => {
      if (id !== "p1") return;
      const woken = live.get("p2");
      if (woken) Object.assign(woken, { state: "started", updated_at: at(NOW) });
    });
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi: fly.flyApi,
      includePool: true,
      now: () => NOW,
      log: (l) => lines.push(l),
    });

    expect(fly.deletes).toEqual(["p1", "p2"]);
    expect([...fly.live.keys()]).toEqual(["p2"]);
    expect(result.cleaned).toEqual(["p1"]);
    expect(lines.filter((l) => l.includes("p2"))).toEqual([
      "spared p2 (name=skrun-pool-p2, state=suspended, idle=7200s): the platform refused to " +
        "destroy it in its current state — woken since it was listed, it may be serving a run",
    ]);
    expect(lines.some((l) => l.startsWith("FAILED"))).toBe(false);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=2 cleaned=1( |$)/);
  });

  it("destroys a run's machine and a long-untouched started pooled machine with force, as before", async () => {
    const fly = platform([
      {
        id: "orphan-run",
        name: "skrun-run-x",
        state: "started",
        created_at: at(NOW - 2 * HOUR),
      },
      {
        id: "abandoned",
        name: "skrun-pool-f",
        state: "started",
        created_at: at(NOW - 50 * HOUR),
        updated_at: at(NOW - 10 * HOUR),
      },
    ]);

    const result = await cleanupMachines({
      flyApi: fly.flyApi,
      olderThan: 600,
      includePool: true,
      now: () => NOW,
      log: () => {},
    });

    expect(fly.deletes).toEqual(["orphan-run?force=true", "abandoned?force=true"]);
    expect(result.cleaned).toEqual(["orphan-run", "abandoned"]);
  });
});

// A destruction that fails says what the platform answered — its status and
// its answer, or why none came —, never the message written for a run's
// caller. A pooled machine listed not running that the platform refused
// without a reason the command reads — its answer cut on every attempt — may
// have been woken for a run since the listing: its line says to check it
// before destroying it by hand.
describe("cleanup-machines — a destruction that fails says what the platform answered", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();
  const BOUND_MS = 25;

  /** The real client, each attempt bounded at 25 ms, on a platform that lists `machines`. */
  function client(
    machines: Array<Record<string, unknown>>,
    onDelete: (id: string, forced: boolean, signal?: AbortSignal | null) => Response,
  ) {
    const deletes: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method !== "DELETE") {
        return new Response(JSON.stringify(machines), { status: 200 });
      }
      const id = url.pathname.split("/").pop() ?? "";
      const forced = url.searchParams.get("force") === "true";
      deletes.push(forced ? `${id}?force=true` : id);
      return onDelete(id, forced, init.signal);
    }) as typeof fetch;
    const quiet = {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as FlyMachinesApiOptions["logger"];
    const flyApi = new FlyMachinesApi("token", "app", {
      fetchImpl,
      sleepImpl: async () => {},
      attemptTimeoutsMs: {
        create: BOUND_MS,
        start: BOUND_MS,
        suspend: BOUND_MS,
        stop: BOUND_MS,
        destroy: BOUND_MS,
        list: BOUND_MS,
        listByLabel: BOUND_MS,
      },
      logger: quiet,
    });
    return { flyApi, deletes };
  }

  it("a pooled machine refused without a reason it reads — its answer cut on every attempt —: FAILED, with the 412, and to check it before destroying it by hand", async () => {
    const { flyApi, deletes } = client(
      [
        {
          id: "p-woken",
          name: "skrun-pool-woken",
          state: "suspended",
          created_at: at(NOW - 50 * HOUR),
          updated_at: at(NOW - 2 * HOUR),
        },
      ],
      (_id, _forced, signal) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(REFUSED_IN_STATE));
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return new Response(body, { status: 412 });
      },
    );
    const lines: string[] = [];

    const result = await cleanupMachines({
      flyApi,
      includePool: true,
      now: () => NOW,
      log: (l) => lines.push(l),
    });

    expect(deletes).toEqual(Array(4).fill("p-woken"));
    expect(result.cleaned).toEqual([]);
    expect(lines.filter((l) => l.startsWith("FAILED"))).toEqual([
      "FAILED to destroy p-woken (name=skrun-pool-woken): Fly.io API DELETE " +
        "/apps/app/machines/p-woken: 412, its body unread — refused without a reason this " +
        "command reads: woken since it was listed, it may be serving a run; check it before " +
        "destroying it by hand",
    ]);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=1 cleaned=0 left=0( |$)/);
  });

  it("any other failed destruction — a 412 to one with force, another status to one without —: FAILED, with the platform's status and answer, nothing more", async () => {
    const { flyApi, deletes } = client(
      [
        { id: "r-old", name: "skrun-run-old", state: "started", created_at: at(NOW - 2 * HOUR) },
        {
          id: "p-down",
          name: "skrun-pool-down",
          state: "suspended",
          created_at: at(NOW - 50 * HOUR),
          updated_at: at(NOW - 2 * HOUR),
        },
      ],
      (id) =>
        id === "r-old"
          ? new Response('{"error":"refused"}', { status: 412 })
          : new Response("unavailable", { status: 503 }),
    );
    const lines: string[] = [];

    await cleanupMachines({
      flyApi,
      olderThan: 600,
      includePool: true,
      now: () => NOW,
      log: (l) => lines.push(l),
    });

    expect(deletes).toEqual(["r-old?force=true", "p-down"]);
    expect(lines.filter((l) => l.startsWith("FAILED"))).toEqual([
      "FAILED to destroy r-old (name=skrun-run-old): Fly.io API DELETE " +
        '/apps/app/machines/r-old?force=true: 412 {"error":"refused"}',
      "FAILED to destroy p-down (name=skrun-pool-down): Fly.io API DELETE " +
        "/apps/app/machines/p-down: 503 unavailable",
    ]);
  });
});

// Without --older-than, a run's machine is judged on the lifetime it declares
// — the hold of its run's seat plus a grace, written into its environment when
// it was created —, plus that grace again: past it, no run can still be on it.
// One that declares none, made by an older server, may carry a run this command
// cannot see — it reads no run —: it is left, and named. --older-than, given,
// judges every run's machine on that age instead.
describe("cleanup-machines — a run's machine judged on the lifetime it declares", () => {
  const NOW = 100 * 3_600_000;
  const at = (ms: number) => new Date(ms).toISOString();
  const GRACE_S = MACHINE_LIFETIME_GRACE_MS / 1000;
  const FALLBACK_S = undeclaredLifetimeFallbackMs() / 1000;

  /** A run's machine of `ageS` seconds, declaring `declaredS` seconds of lifetime, or none. */
  function runMachine(id: string, ageS: number, declaredS?: number): Record<string, unknown> {
    return {
      id,
      name: `skrun-run-${id}`,
      state: "started",
      created_at: at(NOW - ageS * 1000),
      ...(declaredS !== undefined && {
        config: { image: "img", env: { RUNNER_LIFETIME_S: String(declaredS) } },
      }),
    };
  }

  /** A pre-created machine, started, untouched for `idleS` seconds. */
  function startedPooled(id: string, idleS: number): Record<string, unknown> {
    return {
      id,
      name: `skrun-pool-${id}`,
      state: "started",
      created_at: at(NOW - 50 * 3_600_000),
      updated_at: at(NOW - idleS * 1000),
    };
  }

  /**
   * A pre-created machine, started, assigned to a run: labelled with it and with
   * the end of its life, `endInS` seconds from now (negative: past), its last
   * update — the labels' write — `idleS` seconds ago.
   */
  function assignedPooled(id: string, endInS: number, idleS = 60): Record<string, unknown> {
    return {
      ...startedPooled(id, idleS),
      config: {
        image: "img",
        metadata: {
          skrun_pool_id: id,
          skrun_run_id: `run-${id}`,
          skrun_lifetime_end: at(NOW + endInS * 1000),
        },
      },
    };
  }

  async function designated(
    machines: Array<Record<string, unknown>>,
    opts: { olderThan?: number; includePool?: boolean } = {},
  ) {
    const flyApi = { list: async () => machines, destroy: vi.fn() } as unknown as FlyMachinesApi;
    const lines: string[] = [];
    const result = await cleanupMachines({
      flyApi,
      dryRun: true,
      now: () => NOW,
      log: (line) => lines.push(line),
      ...opts,
    });
    return { cleaned: result.cleaned, left: result.left, lines };
  }

  it("the lifetime a machine declares, and the grace: one within it spared, one past it designated", async () => {
    const { cleaned } = await designated([
      runMachine("within", 1250 + GRACE_S - 1, 1250),
      runMachine("past", 1250 + GRACE_S + 1, 1250),
      // A long run: past the fallback, well within its own lifetime.
      runMachine("long-run", 3600, 7200),
    ]);
    expect(cleaned).toEqual(["past"]);
  });

  it("never designates the machine of a run still in flight — past the 600 s this command once took by default", async () => {
    // A run of the default timeout, fifteen minutes in.
    const { cleaned } = await designated([runMachine("in-flight", 900, 1233)]);
    expect(cleaned).toEqual([]);
  });

  it("without --older-than, a machine that declares no lifetime — or one it cannot read — is left at any age, and named", async () => {
    const { cleaned, left, lines } = await designated([
      runMachine("young", FALLBACK_S - 1),
      // Past the fallback this command once judged such a machine on, and far past it.
      runMachine("old", FALLBACK_S + 1),
      runMachine("ancient", 50 * 3_600),
      {
        ...runMachine("unreadable", FALLBACK_S + 1),
        config: { image: "img", env: { RUNNER_LIFETIME_S: "1e3" } },
      },
    ]);
    expect(cleaned).toEqual([]);
    expect(left).toEqual(["young", "old", "ancient", "unreadable"]);
    expect(lines.filter((line) => line.startsWith("left "))).toHaveLength(4);
    expect(lines).toContain(
      "left ancient (name=skrun-run-ancient, state=started, age=180000s): declares no lifetime — " +
        "this command does not read the runs and cannot tell whether one is on it; pass " +
        "--older-than to judge it on its age",
    );
  });

  it("--older-than given judges every run's machine on that age, whatever it declares", async () => {
    const { cleaned } = await designated(
      [
        runMachine("declared", 61, 7200),
        runMachine("undeclared", 61),
        runMachine("fresh", 59, 7200),
      ],
      { olderThan: 60 },
    );
    expect(cleaned).toEqual(["declared", "undeclared"]);
  });

  it("a started pre-created machine, with --include-pool, is left without --older-than however long untouched, and judged on four times the age given with it", async () => {
    const without = await designated(
      [
        startedPooled("idle-short", 60),
        // Past the wait this command once took without --older-than, and far past it.
        startedPooled("idle-long", 4 * FALLBACK_S + 1),
        startedPooled("idle-ancient", 50 * 3_600),
      ],
      { includePool: true },
    );
    expect(without.cleaned).toEqual([]);
    expect(without.left).toEqual(["idle-short", "idle-long", "idle-ancient"]);
    expect(without.lines).toContain(
      "left idle-ancient (name=skrun-pool-idle-ancient, state=started, idle=180000s): started " +
        "and declaring no end of life, it may be serving a run — this command does not read the " +
        "runs; pass --older-than to judge it (destroyed once untouched 4 times that age)",
    );
    const given = await designated(
      [startedPooled("idle-short", 4 * 60 - 1), startedPooled("idle-long", 4 * 60 + 1)],
      { includePool: true, olderThan: 60 },
    );
    expect(given.cleaned).toEqual(["idle-long"]);
    expect(given.left).toEqual([]);
  });

  it("an assigned pre-created machine, with --include-pool and without --older-than, is judged on the end of life it declares plus the grace: one past it designated, one within it spared — never left", async () => {
    const { cleaned, left, lines } = await designated(
      [
        assignedPooled("past", -(GRACE_S + 1)),
        assignedPooled("within-grace", -(GRACE_S - 1)),
        // A long run, its machine ending in an hour: however long untouched.
        assignedPooled("serving", 3_600, 50 * 3_600),
        // Unassigned, or its end unreadable: nothing declared, left as before.
        startedPooled("unassigned", 50 * 3_600),
        {
          ...assignedPooled("unreadable", -(GRACE_S + 1)),
          config: { image: "img", metadata: { skrun_lifetime_end: "an hour ago" } },
        },
      ],
      { includePool: true },
    );
    expect(cleaned).toEqual(["past"]);
    expect(left).toEqual(["unassigned", "unreadable"]);
    expect(lines).toContain(
      "Found 5 pre-created machine(s); 1 reclaimable (suspended, stopped or failed when listed — " +
        "the platform refuses one woken since —, or started and past the end of life it declares " +
        `plus a grace of ${GRACE_S}s), 2 within it, 2 left: pass --older-than to judge one started ` +
        "that declares none, or one never started.",
    );
  });

  it("an assigned pre-created machine past the end of life it declares goes with force; --older-than given judges it on its age instead, whatever end it declares; without --include-pool it is not judged", async () => {
    const machines = [
      assignedPooled("past", -(GRACE_S + 1)),
      assignedPooled("fresh", 3_600, 4 * 60 + 1),
    ];
    const destroy = vi.fn(async () => "destroyed" as const);
    const flyApi = { list: async () => machines, destroy } as unknown as FlyMachinesApi;
    const result = await cleanupMachines({
      flyApi,
      now: () => NOW,
      log: () => {},
      includePool: true,
    });
    expect(result.cleaned).toEqual(["past"]);
    // With force: the client's default — a started machine refuses a destruction without it.
    expect(destroy.mock.calls).toEqual([["past"]]);

    const given = await designated(
      [
        assignedPooled("past-but-touched", -(GRACE_S + 1), 4 * 60 - 1),
        assignedPooled("fresh", 3_600, 4 * 60 + 1),
      ],
      { includePool: true, olderThan: 60 },
    );
    expect(given.cleaned).toEqual(["fresh"]);

    const notAsked = await designated([assignedPooled("past", -(GRACE_S + 1))]);
    expect(notAsked.cleaned).toEqual([]);
    expect(notAsked.left).toEqual([]);
  });

  it("says the criterion it judged on, and counts each machine once: past it, within it, or left", async () => {
    const without = await designated([
      runMachine("old", 1250 + GRACE_S + 1, 1250),
      runMachine("young", 60, 1250),
      runMachine("legacy", FALLBACK_S + 1),
    ]);
    expect(without.lines).toContain(
      `Found 3 runner machine(s); 1 past the lifetime it declares plus a grace of ${GRACE_S}s, ` +
        "1 within it, 1 left — without --older-than this command destroys only a machine its " +
        "listing shows no run can be on: it does not read the runs.",
    );
    const given = await designated(
      [
        runMachine("old", FALLBACK_S + 1),
        runMachine("young", 59),
        { ...runMachine("undated", 0), created_at: undefined },
      ],
      { olderThan: 60 },
    );
    expect(given.lines).toContain(
      "Found 3 runner machine(s); 1 older than 60s (--older-than), 1 younger, 1 left.",
    );
  });

  it("under --include-pool, says the pooled machines' criterion — one listed not running taken when listed, a started one past the end of life it declares, a never-started or started one that declares none left without --older-than, their rules with it — counts the pooled machines left apart from the runs' — and promises no run is safe", async () => {
    const machines = [
      // A run's machine left too: the pooled line counts the pooled machines alone.
      runMachine("legacy", FALLBACK_S + 1),
      startedPooled("idle-long", 4 * FALLBACK_S + 1),
      startedPooled("idle-short", 60),
      { ...startedPooled("stock", 7_200), state: "suspended" },
      { ...startedPooled("exited", 7_200), state: "stopped" },
    ];
    const without = await designated(machines, { includePool: true });
    expect(without.lines).toContain(
      "Found 4 pre-created machine(s); 2 reclaimable (suspended, stopped or failed when listed — " +
        "the platform refuses one woken since —, or started and past the end of life it declares " +
        `plus a grace of ${GRACE_S}s), 0 within it, 2 left: pass --older-than to judge one started ` +
        "that declares none, or one never started.",
    );
    const given = await designated(machines, { includePool: true, olderThan: 60 });
    expect(given.lines).toContain(
      "Found 4 pre-created machine(s); 3 reclaimable (suspended, stopped or failed when listed — " +
        "the platform refuses one woken since —, never started and created 60s ago or more, or " +
        "started and untouched for 240s or more), 1 younger, 0 left.",
    );
    expect(without.lines.join("\n")).not.toContain("no run can be on it");
  });
});

// The command reads the platform's listing, never the runs: it cannot tell
// whether a run is on a machine. Without --older-than it destroys only a machine
// its listing shows no run can be on, and names — never destroys — one it cannot
// judge: a run's machine that declares no lifetime, a started pre-created one
// under --include-pool. Through the real client, against a platform that answers
// as measured.
describe("cleanup-machines without --older-than — a machine it cannot judge is left, and named", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();
  const MACHINES = [
    // Its lifetime declared, two hours old: long past it plus the grace.
    {
      id: "orphan",
      name: "skrun-run-orphan",
      state: "started",
      created_at: at(NOW - 2 * HOUR),
      config: { image: "img", env: { RUNNER_LIFETIME_S: "1233" } },
    },
    // No lifetime declared — an older server's, which may still serve a run on it.
    { id: "legacy", name: "skrun-run-legacy", state: "started", created_at: at(NOW - 2 * HOUR) },
    // Pre-created stock, paused.
    {
      id: "stock",
      name: "skrun-pool-stock",
      state: "suspended",
      created_at: at(NOW - 50 * HOUR),
      updated_at: at(NOW - 2 * HOUR),
    },
    // Pre-created, started — it may be serving a run —, untouched for ten hours.
    {
      id: "awake",
      name: "skrun-pool-awake",
      state: "started",
      created_at: at(NOW - 50 * HOUR),
      updated_at: at(NOW - 10 * HOUR),
    },
  ];

  async function sweep(opts: { olderThan?: number; dryRun?: boolean } = {}) {
    const fly = platform(MACHINES);
    const lines: string[] = [];
    const result = await cleanupMachines({
      flyApi: fly.flyApi,
      includePool: true,
      now: () => NOW,
      log: (line) => lines.push(line),
      ...opts,
    });
    return { fly, lines, result };
  }

  it("destroys the run's machine past the lifetime it declares and the paused stock, and leaves the two it cannot judge — a line each, neither cleaned nor failed, counted in the PASS line", async () => {
    const { fly, lines, result } = await sweep();

    expect(fly.deletes).toEqual(["orphan?force=true", "stock"]);
    expect([...fly.live.keys()]).toEqual(["legacy", "awake"]);
    expect(result.cleaned).toEqual(["orphan", "stock"]);
    expect(result.left).toEqual(["legacy", "awake"]);
    expect(lines.filter((line) => line.startsWith("left "))).toEqual([
      "left legacy (name=skrun-run-legacy, state=started, age=7200s): declares no lifetime — " +
        "this command does not read the runs and cannot tell whether one is on it; pass " +
        "--older-than to judge it on its age",
      "left awake (name=skrun-pool-awake, state=started, idle=36000s): started and declaring " +
        "no end of life, it may be serving a run — this command does not read the runs; pass " +
        "--older-than to judge it (destroyed once untouched 4 times that age)",
    ]);
    expect(lines.some((line) => line.startsWith("FAILED"))).toBe(false);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=4 cleaned=2 left=2( |$)/);
  });

  it("leaves the same two under --dry-run", async () => {
    const { fly, result, lines } = await sweep({ dryRun: true });
    expect(fly.deletes).toEqual([]);
    expect(result.cleaned).toEqual(["orphan", "stock"]);
    expect(result.left).toEqual(["legacy", "awake"]);
    expect(lines.at(-1)).toMatch(
      /^PASS cleanup-machines: scanned=4 cleaned=2 left=2 .*\(dry-run\)$/,
    );
  });

  it("with --older-than, judges every machine on that age — the operator's call: the two go with force, nothing is left", async () => {
    const { fly, lines, result } = await sweep({ olderThan: 3_600 });

    expect(fly.deletes).toEqual([
      "orphan?force=true",
      "legacy?force=true",
      "stock",
      "awake?force=true",
    ]);
    expect(result.left).toEqual([]);
    expect(lines.some((line) => line.startsWith("left "))).toBe(false);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=4 cleaned=4 left=0( |$)/);
  });
});

// Under --include-pool, taking a deployment down, nothing listed is passed over
// in silence: each machine is destroyed, spared, failed, named and left, or
// counted as not yet past the age given. One listed not running — paused,
// stopped or failed — has no run on it: it goes without force, at any age, and
// the platform refuses one started since. One never started, which the platform
// destroys only with force, goes only on an age given, as a started one does on
// four times it. One whose listing gives no time to judge it on, or in a state
// the command does not act on, is named and left. Through the real client,
// against a platform that answers as measured.
describe("cleanup-machines --include-pool — every machine listed ends in one category", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const at = (ms: number) => new Date(ms).toISOString();
  const MONTH = 30 * 24 * HOUR;

  /** A pre-created machine in `state`, created and last touched `ageMs` ago. */
  const pooled = (id: string, state: string, ageMs = MONTH): Record<string, unknown> => ({
    id,
    name: `skrun-pool-${id}`,
    state,
    created_at: at(NOW - ageMs),
    updated_at: at(NOW - ageMs),
  });

  async function sweep(
    machines: Array<Record<string, unknown>>,
    opts: { olderThan?: number } = {},
    onDelete?: (id: string, live: Map<string, Record<string, unknown>>) => void,
  ) {
    const fly = platform(machines, onDelete);
    const lines: string[] = [];
    const result = await cleanupMachines({
      flyApi: fly.flyApi,
      includePool: true,
      now: () => NOW,
      log: (line) => lines.push(line),
      ...opts,
    });
    return { fly, lines, result };
  }

  it("destroys a pooled machine listed stopped or failed without force, at any age, and spares one started since", async () => {
    // The server starts s2 while s1 is being destroyed.
    const { created_at: _created, updated_at: _updated, ...undated } = pooled("f2", "failed");
    const { fly, lines, result } = await sweep(
      [pooled("s1", "stopped", 1_000), pooled("f1", "failed"), undated, pooled("s2", "stopped")],
      {},
      (id, live) => {
        if (id !== "s1") return;
        const woken = live.get("s2");
        if (woken) Object.assign(woken, { state: "started", updated_at: at(NOW) });
      },
    );

    expect(fly.deletes).toEqual(["s1", "f1", "f2", "s2"]);
    expect([...fly.live.keys()]).toEqual(["s2"]);
    expect(result.cleaned).toEqual(["s1", "f1", "f2"]);
    expect(result.left).toEqual([]);
    expect(lines).toContain(
      `spared s2 (name=skrun-pool-s2, state=stopped, idle=${MONTH / 1000}s): the platform refused ` +
        "to destroy it in its current state — woken since it was listed, it may be serving a run",
    );
    // No time to read is no time needed here: its line says none.
    expect(lines).toContain("destroyed f2 (name=skrun-pool-f2, state=failed)");
    expect(lines.some((line) => line.startsWith("FAILED"))).toBe(false);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=4 cleaned=3 left=0( |$)/);
  });

  it("names and leaves a pooled machine never started without --older-than; with it, destroys it with force once created that long ago", async () => {
    const without = await sweep([pooled("c-old", "created")]);
    expect(without.fly.deletes).toEqual([]);
    expect(without.result.left).toEqual(["c-old"]);
    expect(without.lines).toContain(
      `left c-old (name=skrun-pool-c-old, state=created, age=${MONTH / 1000}s): never started — ` +
        "the platform destroys it only with force, and the server that made it may be starting " +
        "it; pass --older-than to judge it on its age",
    );

    // Judged on its creation time, never its last update.
    const given = await sweep(
      [
        { ...pooled("c-old", "created", 61_000), updated_at: at(NOW - 1_000) },
        pooled("c-young", "created", 59_000),
      ],
      { olderThan: 60 },
    );
    expect(given.fly.deletes).toEqual(["c-old?force=true"]);
    expect(given.result.cleaned).toEqual(["c-old"]);
    expect(given.result.left).toEqual([]);
    expect(given.lines.some((line) => line.includes("c-young"))).toBe(false);
    expect(given.lines).toContain(
      "Found 2 pre-created machine(s); 1 reclaimable (suspended, stopped or failed when listed — " +
        "the platform refuses one woken since —, never started and created 60s ago or more, or " +
        "started and untouched for 240s or more), 1 younger, 0 left.",
    );
  });

  it.each([
    ["without --older-than", {}],
    ["with --older-than", { olderThan: 60 }],
  ] as const)("names and leaves a machine whose listing gives no time to judge it on, %s", async (_what, opts) => {
    const undated = (machine: Record<string, unknown>) => {
      const { created_at: _created, updated_at: _updated, ...rest } = machine;
      return rest;
    };
    const { fly, lines, result } = await sweep(
      [
        undated({
          ...pooled("run-undated", "stopped"),
          name: "skrun-run-undated",
          config: { image: "img", env: { RUNNER_LIFETIME_S: "600" } },
        }),
        undated(pooled("started-undated", "started")),
        undated(pooled("created-undated", "created")),
      ],
      opts,
    );

    expect(fly.deletes).toEqual([]);
    expect(result.left).toEqual(["run-undated", "started-undated", "created-undated"]);
    expect(lines.filter((line) => line.startsWith("left "))).toEqual(
      [
        ["run-undated", "skrun-run-undated", "stopped"],
        ["started-undated", "skrun-pool-started-undated", "started"],
        ["created-undated", "skrun-pool-created-undated", "created"],
      ].map(
        ([id, name, state]) =>
          `left ${id} (name=${name}, state=${state}): its listing gives no time to judge it on — ` +
          "this command never destroys a machine on a time it cannot read",
      ),
    );
  });

  it.each([
    ["without --older-than", {}],
    ["with --older-than", { olderThan: 60 }],
  ] as const)("names and leaves a pooled machine in a state it does not act on, %s", async (_what, opts) => {
    const { fly, lines, result } = await sweep(
      [
        pooled("starting", "starting"),
        pooled("suspending", "suspending"),
        pooled("replacing", "replacing"),
        // A state the client does not know reads as "unknown".
        pooled("new-state", "a-state-not-yet-documented"),
      ],
      opts,
    );

    expect(fly.deletes).toEqual([]);
    expect(result.left).toEqual(["starting", "suspending", "replacing", "new-state"]);
    expect(lines).toContain(
      "left new-state (name=skrun-pool-new-state, state=unknown): a state this command does not " +
        "act on — run it again once the machine has left it",
    );
  });

  it.each([
    ["without --older-than", {}],
    ["with --older-than", { olderThan: 60 }],
  ] as const)("accounts for every machine it lists, %s: each cleaned, spared, failed or left — or counted, in its line, as within its time", async (_what, opts) => {
    const machines = [
      ...["created", "started", "stopped", "suspended", "failed", "starting"].map((state) =>
        pooled(`p-${state}`, state),
      ),
      pooled("p-young", "started", 30_000),
      { ...pooled("r-legacy", "started"), name: "skrun-run-legacy" },
      {
        ...pooled("r-young", "started", 30_000),
        name: "skrun-run-young",
        config: { image: "img", env: { RUNNER_LIFETIME_S: "1233" } },
      },
      {
        ...pooled("r-old", "started"),
        name: "skrun-run-old",
        config: { image: "img", env: { RUNNER_LIFETIME_S: "1233" } },
      },
    ];
    // p-stopped is started as its destruction arrives: the platform refuses it.
    const { lines, result } = await sweep(machines, opts, (id, live) => {
      const woken = live.get(id);
      if (id === "p-stopped" && woken) Object.assign(woken, { state: "started" });
    });

    const spared = lines.filter((l) => l.startsWith("spared ")).map((l) => l.split(" ")[1]);
    const failed = lines.filter((l) => l.startsWith("FAILED ")).map((l) => l.split(" ")[3]);
    const decided = [...result.cleaned, ...spared, ...failed, ...result.left];
    // Each machine in one category at most…
    expect(new Set(decided).size).toBe(decided.length);
    // …and the rest counted, in the two lines, as within their time.
    const within = (lines.join("\n").match(/(\d+) (?:within it|younger)/g) ?? [])
      .map((match) => Number.parseInt(match, 10))
      .reduce((a, b) => a + b, 0);
    expect(decided.length + within).toBe(machines.length);
    expect(result.scanned).toBe(machines.length);
    expect(spared).toEqual(["p-stopped"]);
  });
});

// The command line itself: no age is taken by default — what reaches the
// function without --older-than is no age at all, and a machine of a run still
// in flight is never designated.
describe("skrun admin cleanup-machines — the command line", () => {
  /** The command, run on a platform that lists `machines`; what it printed. */
  async function command(args: string[], machines: Array<Record<string, unknown>>) {
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(parts.map(String).join(" "));
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(machines), { status: 200 })),
    );
    const log = vi.spyOn(console, "log").mockImplementation(record);
    const error = vi.spyOn(console, "error").mockImplementation(record);
    const program = new Command();
    program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
    registerAdminCommand(program);
    let exitCode: number | undefined;
    try {
      await program.parseAsync(
        ["admin", "cleanup-machines", "--app", "runners", "--token", "t", ...args],
        { from: "user" },
      );
    } catch (err) {
      if (err instanceof CliExit) exitCode = err.code;
      else if (err instanceof CommanderError) exitCode = err.exitCode;
      else throw err;
    } finally {
      log.mockRestore();
      error.mockRestore();
      vi.unstubAllGlobals();
    }
    return { lines, exitCode };
  }

  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const MACHINES = [
    // A run of the default timeout, fifteen minutes in: its machine in use.
    {
      id: "m-in-flight",
      name: "skrun-run-a",
      state: "started",
      created_at: ago(900),
      config: { image: "img", env: { RUNNER_LIFETIME_S: "1233" } },
    },
    // Two hours old, its lifetime long past.
    {
      id: "m-orphan",
      name: "skrun-run-b",
      state: "started",
      created_at: ago(7200),
      config: { image: "img", env: { RUNNER_LIFETIME_S: "1233" } },
    },
  ];

  it("without --older-than, a run's machine within its lifetime is never designated", async () => {
    const { lines, exitCode } = await command(["--dry-run"], MACHINES);
    expect(exitCode).toBeUndefined();
    expect(lines.filter((line) => line.startsWith("[dry-run] would destroy"))).toEqual([
      expect.stringContaining("would destroy m-orphan"),
    ]);
  });

  it("--older-than given wins: every run's machine past that age is designated", async () => {
    const { lines } = await command(["--dry-run", "--older-than", "60"], MACHINES);
    expect(lines.filter((line) => line.startsWith("[dry-run] would destroy"))).toEqual([
      expect.stringContaining("would destroy m-in-flight"),
      expect.stringContaining("would destroy m-orphan"),
    ]);
  });

  it("its help says the criterion, and gives --older-than no default", async () => {
    const { lines } = await command(["--help"], []);
    // Read across the help's wrapping.
    const help = lines.join(" ").replace(/\s+/g, " ");
    expect(help).toContain("the lifetime it declares");
    // Commander says an option's default in the help; --older-than has none.
    expect(help).not.toMatch(/\(default: \d+\)/);
    expect(help).not.toContain("MAX_RUN_TIMEOUT");
    // The criterion: it reads no run, so without an age it destroys only what a
    // machine's listing shows, and names what it cannot judge.
    expect(help).toContain(
      "It reads the platform's listing, never the runs: without --older-than it destroys only a " +
        "machine its listing shows no run can be on, and names, without destroying it, one it " +
        "cannot judge.",
    );
    // No absolute promise: --older-than takes a run's machine whatever it
    // declares, and a started pre-created one past its rule.
    expect(help).not.toContain("never touched");
    // Unset, a run's machine is still judged on its age — against the lifetime
    // it declares: what no age given means is that none replaces the listing.
    expect(help).not.toContain("no machine is judged on an age");
    expect(help).toContain(
      "Unset, no age replaces what the listing shows: one it cannot judge is named and left.",
    );
    expect(help).toContain("a run still on it included");
    expect(help).toContain("cutting a run on it that has lasted longer");
  });

  it("without --older-than, a run's machine that declares no lifetime is named, never designated", async () => {
    const legacy = { id: "m-legacy", name: "skrun-run-c", state: "started", created_at: ago(7200) };
    const { lines } = await command(["--dry-run"], [...MACHINES, legacy]);
    expect(lines.filter((line) => line.startsWith("[dry-run] would destroy"))).toEqual([
      expect.stringContaining("would destroy m-orphan"),
    ]);
    expect(lines.filter((line) => line.startsWith("left "))).toEqual([
      expect.stringContaining("left m-legacy (name=skrun-run-c, state=started, age="),
    ]);
    expect(lines.at(-1)).toMatch(/^PASS cleanup-machines: scanned=3 cleaned=1 left=1 app=runners/);
  });
});
