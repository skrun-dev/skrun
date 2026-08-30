/**
 * E2E: skrun admin cleanup-machines reaper (#15 VT-25).
 *
 * Plants a leaked sandbox machine in the mocked Fly state (created_at
 * older than 2× MAX_RUN_TIMEOUT_S = 600 s), runs the cleanup CLI helper,
 * asserts the machine was destroyed AND fresher runner-named machines
 * stayed alive. Cross-reference: the more granular `cleanupMachines`
 * helper itself has 6 dedicated unit tests in
 * `packages/cli/src/commands/admin.test.ts` (shipped with task 6.1) —
 * this file adds the E2E framing assertion: an orphan beyond the age
 * threshold IS reaped, an active run within the threshold is NOT.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanupMachines } from "../../packages/cli/src/commands/admin.js";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";

const NOW_MS = 1_770_000_000_000;
const RUNNER_PREFIX = "skrun-run-";

function makeMachine(opts: { id: string; ageS: number; name?: string }): Machine {
  return {
    id: opts.id,
    name: opts.name ?? `${RUNNER_PREFIX}${opts.id}`,
    state: "started",
    created_at: new Date(NOW_MS - opts.ageS * 1000).toISOString(),
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

describe("VT-25: cleanup-machines destroys orphans beyond age threshold", () => {
  it("a stub machine older than 2× MAX_RUN_TIMEOUT_S IS reaped, fresh ones spared", async () => {
    // MAX_RUN_TIMEOUT_S default = 300s. cleanup default threshold = 600s.
    const machines = [
      makeMachine({ id: "fresh-active", ageS: 30 }), // active run, well under
      makeMachine({ id: "fresh-borderline", ageS: 500 }), // still under 600s
      makeMachine({ id: "orphan-leak", ageS: 1800 }), // 30 min old → destroy
      makeMachine({ id: "orphan-old", ageS: 3600 }), // 1 h old → destroy
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      olderThan: 600,
    });

    // Two leaks destroyed, two fresh untouched.
    expect(result.cleaned).toEqual(["orphan-leak", "orphan-old"]);
    expect(fly.destroyed()).toEqual(["orphan-leak", "orphan-old"]);
    expect(result.scanned).toBe(4);
  });

  it("ignores machines whose name does not match the runner prefix", async () => {
    const machines = [
      makeMachine({ id: "api-server-1", ageS: 86_400, name: "skrun-cloud-api" }),
      makeMachine({ id: "unrelated", ageS: 86_400, name: "neighbor-app-vm" }),
      makeMachine({ id: "orphan-runner", ageS: 1800 }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      olderThan: 600,
    });

    expect(result.scanned).toBe(1); // only the runner-named one counts
    expect(result.cleaned).toEqual(["orphan-runner"]);
    expect(fly.destroyed()).toEqual(["orphan-runner"]);
  });

  it("dry-run lists candidates without destroying — operator can preview before action", async () => {
    const machines = [
      makeMachine({ id: "orphan-1", ageS: 1800 }),
      makeMachine({ id: "orphan-2", ageS: 3600 }),
    ];
    const fly = makeFlyMock(machines);

    const result = await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: () => {},
      olderThan: 600,
      dryRun: true,
    });

    expect(result.cleaned).toEqual(["orphan-1", "orphan-2"]);
    expect(result.dryRun).toBe(true);
    // No destroy actually called in dry-run.
    expect(fly.destroyed()).toEqual([]);
  });

  it("emits the D-1 PASS line so cron / log aggregators can grep", async () => {
    const machines = [makeMachine({ id: "orphan-a", ageS: 1800 })];
    const fly = makeFlyMock(machines);
    const lines: string[] = [];

    await cleanupMachines({
      flyApi: fly.api,
      now: () => NOW_MS,
      log: (l) => lines.push(l),
      olderThan: 600,
    });

    const passLine = lines.find((l) => l.startsWith("PASS cleanup-machines:"));
    expect(passLine).toBeDefined();
    expect(passLine).toContain("scanned=1");
    expect(passLine).toContain("cleaned=1");
  });
});
