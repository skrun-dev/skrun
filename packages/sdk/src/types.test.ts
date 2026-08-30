import { describe, expect, it } from "vitest";
import type { RunEvent, RunnerSpawnedEvent, SpawnPhases } from "./types.js";

// Shape lock for the runner_spawned cold-start telemetry event. The SDK
// re-declares its event types (no workspace dep on @skrun-dev/runtime), so this
// test documents and locks the SDK-side shape. The runtime package is the
// source of truth: any field change there must be mirrored here, and this test
// is the trip-wire that a reviewer/CI notices the SDK copy drifted.
describe("RunnerSpawnedEvent shape (SDK mirror)", () => {
  it("is a RunEvent-union member carrying a phases map, durations only", () => {
    const phases: SpawnPhases = {
      create_api_ms: 12,
      host_schedule_pull_ms: 4800,
      vm_boot_ms: 3200,
      entrypoint_egress_ms: 90,
      init_bundle_ms: 210,
      init_extract_ms: 140,
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
    // Durations only — no operator-internal fields on the wire event.
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
