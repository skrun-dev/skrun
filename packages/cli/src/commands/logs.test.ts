import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { registerLogsCommand } from "./logs.js";

// The command reads the sign-in file of a throwaway profile — a session for
// this server, as signing in writes it — and never the file of the machine
// running the tests.
const REGISTRY = "http://registry.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Run `skrun logs <args>` through the real command: fetch answers with
 * `respond`, the output is captured, and neither commander nor the command may
 * end the test process.
 */
async function skrunLogs(
  args: string[],
  respond: () => Response,
): Promise<{ lines: string[]; exitCode?: number; processExitCalled: boolean }> {
  const lines: string[] = [];
  let exitCode: number | undefined;
  let processExitCalled = false;
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  writeSession(useThrowawayProfile(), { address: REGISTRY, token: "test-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    processExitCalled = true;
    exitCode = Number(code ?? 0);
    return undefined as never;
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerLogsCommand(program);
  try {
    await program.parseAsync(["logs", ...args], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) exitCode = err.code;
    else if (err instanceof CommanderError) exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { lines, exitCode, processExitCalled };
}

describe("skrun logs — a failure ends the command once, not the process", () => {
  it("says an unknown agent has no logs, once, and ends with 1", async () => {
    const run = await skrunLogs(["dev/missing"], () =>
      Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
    );

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    // One line: the catch around the request hands the exit on, it does not
    // report it as a connection failure.
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain("Agent dev/missing not found or no logs available.");
  });

  it("reports a connection failure, naming the server, and ends with 1", async () => {
    const run = await skrunLogs(["dev/agent"], () => {
      throw new TypeError("fetch failed");
    });

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.lines.join("\n")).toContain(`Could not reach ${REGISTRY} (fetch failed).`);
  });

  it("prints the recent runs", async () => {
    const run = await skrunLogs(["dev/agent"], () =>
      Response.json({
        logs: [{ run_id: "r1", status: "completed", duration_ms: 12, cost: 0.001, timestamp: "t" }],
      }),
    );

    expect(run.exitCode).toBeUndefined();
    expect(run.lines.join("\n")).toContain("r1 | 12ms");
  });
});
