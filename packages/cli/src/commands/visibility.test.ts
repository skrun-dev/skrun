import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { registerVisibilityCommand } from "./visibility.js";

// The command reads the sign-in file of a throwaway profile — a session for
// this server, as signing in writes it — and never the file of the machine
// running the tests.
const REGISTRY = "http://registry.test";

/** `skrun <args>`: what it printed, its exit code, and whether it called the API. */
async function runVisibility(args: string[]) {
  const run = { lines: [] as string[], exitCode: 0, requests: 0 };
  const record = (...parts: unknown[]) => {
    run.lines.push(parts.map(String).join(" "));
  };
  writeSession(useThrowawayProfile(), { address: REGISTRY, token: "test-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      run.requests++;
      return new Response("{}", { status: 200 });
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerVisibilityCommand(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) run.exitCode = err.code;
    else if (err instanceof CommanderError) run.exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    vi.unstubAllGlobals();
  }
  return { ...run, program };
}

describe("skrun visibility — public is not available for now", () => {
  it("refuses public before calling the API, and promises nothing in its place", async () => {
    const run = await runVisibility(["visibility", "dev/my-agent", "public"]);

    expect(run.exitCode).toBe(1);
    expect(run.requests).toBe(0);
    const printed = run.lines.join("\n");
    expect(printed).toContain(
      "Public visibility is not available for now; agents are private-only.",
    );
    expect(printed).not.toMatch(/marketplace/i);
  });

  it("says so in its help, too", async () => {
    const { program } = await runVisibility(["visibility", "--help"]);
    const command = program.commands.find((c) => c.name() === "visibility");

    expect(command?.description()).toContain("public is not available for now");
    expect(command?.description()).not.toMatch(/marketplace/i);
  });
});
