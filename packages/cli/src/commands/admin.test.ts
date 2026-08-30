import type { FlyMachinesApi, Machine } from "@skrun-dev/runtime";
import { describe, expect, it, vi } from "vitest";
import { cleanupMachines } from "./admin.js";

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

  it("skips machines with missing or unparseable created_at (safer to leave + log nothing)", async () => {
    const noTimestamp = makeMachine({
      id: "m-no-ts",
      name: "skrun-run-no-ts",
      created_at: undefined,
    });
    const { api, destroySpy } = makeFlyApi([noTimestamp]);

    const result = await cleanupMachines({
      flyApi: api,
      now: () => FIXED_NOW,
      log: () => {},
      olderThan: 600,
    });

    expect(result.cleaned).toEqual([]);
    expect(destroySpy).not.toHaveBeenCalled();
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
