/**
 * E2E: the `skrun admin cleanup-machines` reaper.
 *
 * Plants run machines in a mocked platform listing — each declaring the
 * lifetime it was created with, or none, as a machine made by an older server
 * does —, runs the cleanup helper with no age given, and asserts that a machine
 * past the lifetime it declares plus the grace is destroyed, while the machine
 * of a run still in flight is not, and one that declares none — which the
 * command, reading no run, cannot judge — is left and counted, whatever its
 * age. The finer cases of `cleanupMachines` — `--older-than`, the pre-created
 * machines — are in `packages/cli/src/commands/admin.test.ts`; this file adds
 * the end-to-end framing: an orphan is reaped, a running agent is not.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanupMachines } from "../../packages/cli/src/commands/admin.js";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";
import {
  MACHINE_LIFETIME_GRACE_MS,
  undeclaredLifetimeFallbackMs,
} from "../../packages/runtime/src/adapter/flyio/index.js";

const NOW_MS = 1_770_000_000_000;
const RUNNER_PREFIX = "skrun-run-";
const GRACE_S = MACHINE_LIFETIME_GRACE_MS / 1000;
const FALLBACK_S = undeclaredLifetimeFallbackMs() / 1000;
/** The lifetime a run of the default timeout's machine declares, in seconds. */
const DECLARED_S = 1233;

function makeMachine(opts: {
  id: string;
  ageS: number;
  name?: string;
  declaredS?: number;
}): Machine {
  return {
    id: opts.id,
    name: opts.name ?? `${RUNNER_PREFIX}${opts.id}`,
    state: "started",
    created_at: new Date(NOW_MS - opts.ageS * 1000).toISOString(),
    ...(opts.declaredS !== undefined && {
      config: { image: "img", env: { RUNNER_LIFETIME_S: String(opts.declaredS) } },
    }),
  } as Machine;
}

function makeFlyMock(machines: Machine[]): {
  api: FlyMachinesApi;
  destroyed: () => string[];
} {
  const destroyed: string[] = [];
  const api = {
    list: vi.fn().mockResolvedValue(machines),
    destroy: vi.fn().mockImplementation(async (id: string) => {
      destroyed.push(id);
    }),
    create: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as FlyMachinesApi;
  return { api, destroyed: () => [...destroyed] };
}

describe("cleanup-machines destroys a run's machine past the lifetime it declares, never a running one", () => {
  it("an orphan past its lifetime plus the grace is reaped; a running agent, one within its grace, and one that declares none are spared", async () => {
    const machines = [
      // A run in flight, half a minute in.
      makeMachine({ id: "active", ageS: 30, declaredS: DECLARED_S }),
      // Fifteen minutes in: past the 600 s this command once took by default, still running.
      makeMachine({ id: "running-long", ageS: 900, declaredS: DECLARED_S }),
      // Past its lifetime, within the grace: spared.
      makeMachine({ id: "within-grace", ageS: DECLARED_S + GRACE_S - 1, declaredS: DECLARED_S }),
      // Past its lifetime and the grace: reaped.
      makeMachine({ id: "orphan-leak", ageS: DECLARED_S + GRACE_S + 1, declaredS: DECLARED_S }),
      // A machine of an older server, declaring none — which may still serve a run
      // on it —: left, at any age, past the fallback this command once took too.
      makeMachine({ id: "undeclared-old", ageS: FALLBACK_S + 1 }),
      makeMachine({ id: "undeclared-young", ageS: FALLBACK_S - 1 }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
    });

    expect(result.cleaned).toEqual(["orphan-leak"]);
    expect(fly.destroyed()).toEqual(["orphan-leak"]);
    expect(result.left).toEqual(["undeclared-old", "undeclared-young"]);
    expect(result.scanned).toBe(6);
  });

  it("--older-than given reaps a machine that declares none too — the operator's call", async () => {
    const machines = [
      makeMachine({ id: "undeclared-old", ageS: 7200 }),
      makeMachine({ id: "running-long", ageS: 900, declaredS: DECLARED_S }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      olderThan: 3600,
    });

    expect(result.cleaned).toEqual(["undeclared-old"]);
    expect(fly.destroyed()).toEqual(["undeclared-old"]);
    expect(result.left).toEqual([]);
  });

  it("ignores machines whose name does not match the runner prefix", async () => {
    const machines = [
      makeMachine({ id: "api-server-1", ageS: 86_400, name: "skrun-cloud-api" }),
      makeMachine({ id: "unrelated", ageS: 86_400, name: "neighbor-app-vm" }),
      makeMachine({ id: "orphan-runner", ageS: 7200, declaredS: DECLARED_S }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
    });

    expect(result.scanned).toBe(1); // only the runner-named one counts
    expect(result.cleaned).toEqual(["orphan-runner"]);
    expect(fly.destroyed()).toEqual(["orphan-runner"]);
  });

  it("dry-run lists candidates without destroying — operator can preview before action", async () => {
    const machines = [
      makeMachine({ id: "orphan-1", ageS: 7200, declaredS: DECLARED_S }),
      makeMachine({ id: "orphan-2", ageS: 7200 }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      dryRun: true,
    });

    expect(result.cleaned).toEqual(["orphan-1"]);
    expect(result.left).toEqual(["orphan-2"]);
    expect(result.dryRun).toBe(true);
    // No destroy actually called in dry-run.
    expect(fly.destroyed()).toEqual([]);
  });

  it("under --include-pool, an assigned pre-created machine past the end of life it declares plus the grace is reaped; one within it, and a started one that declares none, are spared", async () => {
    const assigned = (id: string, endInS: number): Machine =>
      ({
        id,
        name: `skrun-pool-${id}`,
        state: "started",
        created_at: new Date(NOW_MS - 86_400_000).toISOString(),
        updated_at: new Date(NOW_MS - 3_600_000).toISOString(),
        config: {
          image: "img",
          metadata: {
            skrun_pool_id: id,
            skrun_run_id: `run-${id}`,
            skrun_lifetime_end: new Date(NOW_MS + endInS * 1000).toISOString(),
          },
        },
      }) as Machine;
    const machines = [
      assigned("ended", -(GRACE_S + 1)),
      assigned("ending", -(GRACE_S - 1)),
      assigned("serving", 3_600),
      {
        ...makeMachine({ id: "unassigned", ageS: 86_400, name: "skrun-pool-unassigned" }),
        updated_at: new Date(NOW_MS - 86_400_000).toISOString(),
      } as Machine,
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      includePool: true,
    });

    expect(result.cleaned).toEqual(["ended"]);
    expect(fly.destroyed()).toEqual(["ended"]);
    expect(result.left).toEqual(["unassigned"]);
    expect(result.scanned).toBe(4);
  });

  it("emits the PASS line so cron / log aggregators can grep — the machines left counted in it", async () => {
    const machines = [
      makeMachine({ id: "orphan-a", ageS: 7200, declaredS: DECLARED_S }),
      makeMachine({ id: "undeclared", ageS: 7200 }),
    ];
    const fly = makeFlyMock(machines);
    const lines: string[] = [];

    await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: (l) => lines.push(l),
    });

    const passLine = lines.find((l) => l.startsWith("PASS cleanup-machines:"));
    expect(passLine).toBeDefined();
    expect(passLine).toContain("scanned=2");
    expect(passLine).toContain("cleaned=1");
    expect(passLine).toContain("left=1");
  });
});
