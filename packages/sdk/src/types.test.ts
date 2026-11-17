import { describe, expect, it } from "vitest";
import type {
  EnvironmentOverride,
  RunCompleteEvent,
  RunEvent,
  RunnerSpawnedEvent,
  SdkFilesExcluded,
  SdkRunResult,
  SpawnPhases,
} from "./types.js";

// The SDK's build type-checks its tests (`tsc --noEmit -p tsconfig.json`,
// `include: src/**/*`) before it emits without them (tsconfig.build.json): each
// directive below makes the build fail the day its field comes back to the
// override type, because the error it expects would no longer happen. One
// object per field: an object literal reports its first unknown field only.
describe("EnvironmentOverride — the retired sandbox field", () => {
  it("is not part of the override type", () => {
    const override: EnvironmentOverride = {
      timeout: "600s",
      // @ts-expect-error — `sandbox` was retired: the server refuses it with 400 RETIRED_FIELD.
      sandbox: "strict",
    };
    expect(override.timeout).toBe("600s");
  });
});

describe("EnvironmentOverride — the retired filesystem field", () => {
  it("is not part of the override type", () => {
    const override: EnvironmentOverride = {
      timeout: "600s",
      // @ts-expect-error — `filesystem` was retired: the server refuses it with 400 RETIRED_FIELD.
      filesystem: "read-only",
    };
    expect(override.timeout).toBe("600s");
  });
});

describe("EnvironmentOverride — secrets, not yet supported", () => {
  it("is not part of the override type", () => {
    const override: EnvironmentOverride = {
      timeout: "600s",
      // @ts-expect-error — `secrets` is not yet supported: no secret is injected into a run.
      secrets: ["API_KEY"],
    };
    expect(override.timeout).toBe("600s");
  });
});

// Shape lock for the runner_spawned cold-start telemetry event. The SDK
// re-declares its event types (no workspace dep on @skrun-dev/runtime), so this
// test documents and locks the SDK-side shape. It compares the copy with
// itself only: a change in the runtime, the source of truth, leaves it green.
// The comparison with the runtime is wire-parity.test.ts, which reads both
// unions and fails when an event type or a heartbeat stage exists in the
// runtime alone. It does not compare fields, such as the phases below.
describe("RunnerSpawnedEvent shape (SDK mirror)", () => {
  it("is a RunEvent-union member carrying a phases map, never the machine or its address", () => {
    const phases: SpawnPhases = {
      create_api_ms: 12,
      host_schedule_pull_ms: 4800,
      vm_boot_ms: 3200,
      entrypoint_egress_ms: 90,
      init_bundle_ms: 210,
      init_extract_ms: 140,
      init_deps_ms: 18_000,
      init_mcp_ms: 0,
    };
    const event: RunnerSpawnedEvent = {
      type: "runner_spawned",
      run_id: "run_1",
      timestamp: new Date().toISOString(),
      phases,
    };
    // Compile-time: assignable to the discriminated union.
    const asEvent: RunEvent = event;
    expect(asEvent.type).toBe("runner_spawned");
    // The phases only — no operator-internal fields on the wire event.
    expect(Object.keys(event)).not.toContain("machineId");
    expect(Object.keys(event)).not.toContain("private_ip");
    expect(event.phases.create_api_ms).toBe(12);
  });

  it("accepts create_api_ms alone (older-runner skew — optional fields absent)", () => {
    const event: RunnerSpawnedEvent = {
      type: "runner_spawned",
      run_id: "run_2",
      timestamp: new Date().toISOString(),
      phases: { create_api_ms: 9 },
    };
    expect(event.phases.vm_boot_ms).toBeUndefined();
    expect(event.phases.host_schedule_pull_ms).toBeUndefined();
  });
});

describe("SpawnPhases — pool fields mirror the runtime type", () => {
  it("accepts a pool-served shape, with the fill-time phases absent", () => {
    // On a resumed machine the fill-time phases describe when the POOL was
    // filled, not this run, so they are omitted rather than reported.
    const phases: SpawnPhases = {
      create_api_ms: 1130,
      pool_hit: true,
      pool_resume_ms: 1130,
      pool_claim_ms: 420,
      pool_resumed_from_snapshot: true,
      init_bundle_ms: 90,
      init_extract_ms: 40,
      init_mcp_ms: 0,
    };
    expect(phases.pool_hit).toBe(true);
    expect(phases.vm_boot_ms).toBeUndefined();
    expect(phases.host_schedule_pull_ms).toBeUndefined();
  });

  it("still accepts the create-per-run shape unchanged", () => {
    const phases: SpawnPhases = {
      create_api_ms: 4100,
      host_schedule_pull_ms: 38000,
      vm_boot_ms: 13500,
      entrypoint_egress_ms: 1600,
      module_load_ms: 10900,
    };
    expect(phases.pool_hit).toBeUndefined();
    expect(phases.vm_boot_ms).toBe(13500);
  });
});

// Shape lock for the counts of a run's output files left out. Like the other
// locks of this file, it compares the copy with itself; holding both clients
// to the server's result is the end-to-end test that compares their results
// with the synchronous one, key by key.
describe("files_excluded — how many of a run's output files were left out (SDK mirror)", () => {
  it("is on every run_complete and every run result, a count by one of five reasons", () => {
    const counts: SdkFilesExcluded = {
      name_refused: 1,
      too_large: 2,
      over_count: 3,
      pull_failed: 4,
      upload_budget: 5,
    };
    const event: RunCompleteEvent = {
      type: "run_complete",
      run_id: "run_1",
      timestamp: new Date().toISOString(),
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      files: [],
      files_excluded: counts,
    };
    const result: SdkRunResult = {
      run_id: "run_1",
      status: "completed",
      agent_version: "1.0.0",
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      // Nothing left out: an empty object, never absent.
      files_excluded: {},
    };
    const asEvent: RunEvent = event;
    expect(asEvent.type).toBe("run_complete");
    expect(Object.keys(event.files_excluded)).toEqual([
      "name_refused",
      "too_large",
      "over_count",
      "pull_failed",
      "upload_budget",
    ]);
    expect(result.files_excluded).toEqual({});
  });

  it("refuses a reason the server never sends, and a run_complete without the counts", () => {
    // @ts-expect-error — not one of the five reasons.
    const unknownReason: SdkFilesExcluded = { lost_in_transit: 1 };
    // @ts-expect-error — `files_excluded` is always present on run_complete.
    const withoutCounts: RunCompleteEvent = {
      type: "run_complete",
      run_id: "run_2",
      timestamp: new Date().toISOString(),
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      files: [],
    };
    expect(unknownReason).toBeDefined();
    expect(withoutCounts.type).toBe("run_complete");
  });
});
