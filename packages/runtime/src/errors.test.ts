import { describe, expect, it } from "vitest";
import { MachineSpawnError, type MachineSpawnPhase } from "./errors.js";

describe("MachineSpawnError", () => {
  const base = { machineName: "skrun-run-abc", machineId: "fdmach_1", httpStatus: null } as const;

  it("names the failing phase in the message so a log line is diagnosable on its own", () => {
    const err = new MachineSpawnError({ ...base, phase: "boot-probe" });
    expect(err.message).toContain('phase "boot-probe"');
    expect(err.message).toContain("machine fdmach_1");
    expect(err.code).toBe("MACHINE_SPAWN_FAILED");
  });

  it("says 'no machine' when creation itself failed, and carries the HTTP status", () => {
    const err = new MachineSpawnError({
      machineName: "skrun-run-abc",
      machineId: null,
      phase: "create",
      httpStatus: 400,
    });
    expect(err.message).toContain("no machine");
    expect(err.message).toContain("(HTTP 400)");
  });

  // Waking a pre-created machine and assigning it are distinct failures, and both
  // differ from having no machine to wake. Kept apart so a pool that is full but
  // entirely unwakeable cannot be mistaken for a pool that is empty.
  it("distinguishes the pre-created machine phases from the create-per-run ones", () => {
    const phases: MachineSpawnPhase[] = [
      "create",
      "boot-probe",
      "init-rpc",
      "pool-resume",
      "pool-claim",
    ];
    for (const phase of phases) {
      expect(new MachineSpawnError({ ...base, phase }).message).toContain(`phase "${phase}"`);
    }
    expect(new Set(phases).size).toBe(phases.length);
  });

  it("keeps the cause reachable for operator diagnosis", () => {
    const cause = new Error("manifest unknown");
    const err = new MachineSpawnError({ ...base, phase: "create" }, cause);
    expect(err.cause).toBe(cause);
  });
});
