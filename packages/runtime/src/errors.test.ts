import { describe, expect, it } from "vitest";
import { MachineSpawnError, type MachineSpawnPhase } from "./errors.js";
import { INIT_STAGES } from "./runner-contract.js";

describe("MachineSpawnError", () => {
  const base = { machineName: "skrun-run-abc", machineId: "fdmach_1", httpStatus: null } as const;

  // The message is what a run's caller reads, and what its row keeps: the phase,
  // in fixed words — never the machine's name or id, which stay in the details
  // for the logs.
  it("names the failing phase, and neither the machine's name nor its id", () => {
    const err = new MachineSpawnError({ ...base, phase: "boot-probe" });
    expect(err.message).toBe('The run\'s machine could not be started (phase "boot-probe").');
    expect(err.message).not.toContain("fdmach_1");
    expect(err.message).not.toContain("skrun-run-abc");
    expect(err.details).toMatchObject({ machineName: "skrun-run-abc", machineId: "fdmach_1" });
    expect(err.code).toBe("MACHINE_SPAWN_FAILED");
  });

  it("carries the platform's HTTP status when creation itself failed, and says nothing of a machine", () => {
    const err = new MachineSpawnError({
      machineName: "skrun-run-abc",
      machineId: null,
      phase: "create",
      httpStatus: 400,
    });
    expect(err.message).toBe('The run\'s machine could not be started (phase "create", HTTP 400).');
  });

  // Each phase, a machine named and identified, and a status: the platform's is
  // told, the runner's — its answer to /init or /claim — is not.
  it.each([
    ["create", 400, ", HTTP 400"],
    ["boot-probe", 503, ", HTTP 503"],
    ["presign", null, ""],
    ["init-rpc", 500, ""],
    ["pool-resume", 422, ", HTTP 422"],
    ["pool-claim", 409, ""],
  ] as const)("at %s, with status %s: the phase in fixed words, no machine named", (phase, httpStatus, told) => {
    const err = new MachineSpawnError({
      machineName: "skrun-pool-4f2a",
      machineId: "e7843d3c9d1e08",
      phase,
      httpStatus,
    });
    expect(err.message).toBe(`The run's machine could not be started (phase "${phase}"${told}).`);
    expect(err.message).not.toMatch(/e7843d3c9d1e08|skrun-pool-4f2a|skrun-run-/);
  });

  // A failed /init is told by the step the runner named, in fixed words of the
  // harness's own: never the runner's text, never the machine.
  it.each([
    ["bundle-network", "the agent's bundle could not be downloaded: no answer came"],
    ["bundle-status", "the agent's bundle could not be downloaded: its download was refused"],
    ["bundle-incomplete", "the agent's bundle could not be downloaded: it arrived incomplete"],
    ["bundle-checksum", "the agent's bundle does not match its recorded checksum"],
    ["bundle-extract", "the agent's bundle could not be extracted"],
    ["disk-full", "the machine's disk was full"],
    ["mcp-connect", "the connection to one of the agent's MCP servers failed"],
    ["other", "the machine could not prepare the agent"],
  ] as const)("at init-rpc, step %s: the phase, the step and its fixed words, no machine named", (stage, words) => {
    const err = new MachineSpawnError({
      machineName: "skrun-pool-4f2a",
      machineId: "e7843d3c9d1e08",
      phase: "init-rpc",
      httpStatus: 500,
      stage,
    });
    expect(err.message).toBe(
      `The run's machine could not be started (phase "init-rpc", step "${stage}"): ${words}.`,
    );
    expect(err.message).not.toMatch(/e7843d3c9d1e08|skrun-pool-4f2a|skrun-run-/);
    expect(err.details.stage).toBe(stage);
  });

  it("gives every step of a failed /init words of its own", () => {
    const told = INIT_STAGES.map(
      (stage) =>
        new MachineSpawnError({ ...base, phase: "init-rpc", httpStatus: 500, stage }).message,
    );
    expect(new Set(told).size).toBe(INIT_STAGES.length);
  });

  it("at init-rpc without a step — an older runner, no answer — names the phase alone", () => {
    expect(new MachineSpawnError({ ...base, phase: "init-rpc", httpStatus: 500 }).message).toBe(
      'The run\'s machine could not be started (phase "init-rpc").',
    );
  });

  // Waking a pre-created machine and assigning it are distinct failures, and both
  // differ from having no machine to wake. Kept apart so a pool that is full but
  // entirely unwakeable cannot be mistaken for a pool that is empty.
  it("distinguishes the pre-created machine phases from the create-per-run ones", () => {
    const phases: MachineSpawnPhase[] = [
      "create",
      "boot-probe",
      "presign",
      "init-rpc",
      "pool-resume",
      "pool-claim",
    ];
    for (const phase of phases) {
      expect(new MachineSpawnError({ ...base, phase }).message).toContain(`phase "${phase}"`);
    }
    expect(new Set(phases).size).toBe(phases.length);
  });

  // Read by the log fields, as any error's HTTP status is: the synthetic message
  // no longer reaches a log line, and with it the "(HTTP n)" it carries.
  it("exposes the platform's HTTP status as status, and no status when there was none", () => {
    const answered = new MachineSpawnError({ ...base, phase: "create", httpStatus: 400 });
    expect(answered.status).toBe(400);
    expect(new MachineSpawnError({ ...base, phase: "boot-probe" })).not.toHaveProperty("status");
  });

  it("keeps the cause reachable for operator diagnosis", () => {
    const cause = new Error("manifest unknown");
    const err = new MachineSpawnError({ ...base, phase: "create" }, cause);
    expect(err.cause).toBe(cause);
  });
});
