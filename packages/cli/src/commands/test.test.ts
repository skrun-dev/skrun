import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliExit } from "../utils/exit.js";
import { registerTestCommand } from "./test.js";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "skrun-test-cmd-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function writeIn(relativePath: string, content: string): void {
  const full = join(agentDir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * An agent whose `tests` section holds `tests` (YAML lines, already indented),
 * and `extra` top-level YAML lines after it.
 */
function writeAgent(tests: string[], extra: string[] = []): void {
  writeIn("SKILL.md", "---\nname: test-fixture\ndescription: A test fixture.\n---\n\n# T\n");
  writeIn(
    "agent.yaml",
    [
      "name: test-fixture",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: score",
      "    type: number",
      ...(tests.length > 0 ? ["tests:", ...tests] : []),
      ...extra,
      "",
    ].join("\n"),
  );
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * Run `skrun test` through the real command, from `agentDir`: the output is
 * captured, and neither commander nor the command may end the test process.
 */
async function skrunTest(args: string[] = ["test"]): Promise<{
  printed: string;
  lines: string[];
  exitCode?: number;
  processExitCalled: boolean;
}> {
  const lines: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir);
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerTestCommand(program);
  let exitCode: number | undefined;
  let processExitCalled = false;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) exitCode = err.code;
    else if (err instanceof ExitCalled) {
      exitCode = err.code;
      processExitCalled = true;
    } else if (err instanceof CommanderError) exitCode = err.exitCode;
    else throw err;
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { printed: lines.join("\n"), lines, exitCode, processExitCalled };
}

const SIMULATED =
  "Outputs are simulated — no model is called. Each test checks that its input carries each " +
  "input the agent requires — null, or an empty list for a file input, counts as missing —, " +
  "then its assertion against placeholder outputs. For a real run: skrun deploy, then skrun run.";

describe("skrun test — it says what it checks: simulated outputs, no model call", () => {
  it("says it once, after the line that announces the tests and before the first result", async () => {
    writeAgent([
      "  - name: first",
      "    input:",
      "      q: hello",
      "    assert: output.score >= 0",
      "  - name: second",
      "    input:",
      "      q: again",
      "    assert: output.score >= 0",
    ]);

    const run = await skrunTest();

    expect(run.exitCode).toBe(0);
    const said = run.lines.filter((line) => line.includes(SIMULATED));
    expect(said).toHaveLength(1);
    const announced = run.lines.findIndex((line) =>
      line.includes("Running 2 test(s) for test-fixture..."),
    );
    const simulated = run.lines.findIndex((line) => line.includes(SIMULATED));
    const firstResult = run.lines.findIndex((line) => line.includes("✓ first"));
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(simulated).toBe(announced + 1);
    expect(firstResult).toBeGreaterThan(simulated);
    expect(run.printed).toContain("2 passed, 0 failed");
  });

  it("says it in its help, too", async () => {
    const run = await skrunTest(["test", "--help"]);

    // Read across the help's wrapping.
    const help = run.printed.replace(/\s+/g, " ");
    expect(help).toContain("Check tests against simulated outputs (no model call)");
    expect(help).not.toContain("Run tests defined in agent.yaml");
  });
});

describe("skrun test — the result is the exit code, set without ending the process", () => {
  it("ends with 0 when every test passes", async () => {
    writeAgent([
      "  - name: scores",
      "    input:",
      "      q: hello",
      "    assert: output.score >= 0",
    ]);

    const run = await skrunTest();

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.printed).toContain("1 passed, 0 failed");
  });

  it("ends with 1 when a test fails", async () => {
    writeAgent([
      "  - name: too-high",
      "    input:",
      "      q: hello",
      "    assert: output.score > 1",
    ]);

    const run = await skrunTest();

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.printed).toContain("0 passed, 1 failed");
  });

  it("fails a test whose input carries a required input as null, in the API's words, and ends with 1", async () => {
    writeAgent([
      "  - name: no-query",
      "    input:",
      "      q: null",
      "    assert: output.score >= 0",
    ]);

    const run = await skrunTest();

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.printed).toContain("no-query: Missing required input: q");
    expect(run.printed).toContain("0 passed, 1 failed");
  });

  it("passes a test whose input carries a required input the agent names __proto__, as the API would accept it", async () => {
    writeIn("SKILL.md", "---\nname: test-fixture\ndescription: A test fixture.\n---\n\n# T\n");
    writeIn(
      "agent.yaml",
      [
        "name: test-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        "  - name: __proto__",
        "    type: object",
        "outputs:",
        "  - name: score",
        "    type: number",
        "tests:",
        "  - name: named-proto",
        "    input:",
        "      __proto__:",
        "        a: 1",
        "    assert: output.score >= 0",
        "",
      ].join("\n"),
    );

    const run = await skrunTest();

    expect(run.printed).not.toContain("Missing required input");
    expect(run.exitCode).toBe(0);
    expect(run.printed).toContain("1 passed, 0 failed");
  });

  it("ends with 0 when no test is defined", async () => {
    writeAgent([]);

    const run = await skrunTest();

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.printed).toContain("No tests defined");
  });

  it("ends with 1 on an invalid agent", async () => {
    writeIn("agent.yaml", "name: no-skill\n");

    const run = await skrunTest();

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.printed).toContain("Fix errors before testing.");
  });
});

describe("skrun test — the validation warnings are printed", () => {
  it("prints a warning, by code, and still runs the tests", async () => {
    writeAgent(
      ["  - name: scores", "    input:", "      q: hello", "    assert: output.score >= 0"],
      ["environment:", "  sandbox: strict"],
    );

    const run = await skrunTest();

    expect(run.printed).toContain("RETIRED_FIELD");
    expect(run.printed).toContain("environment.sandbox");
    expect(run.exitCode).toBe(0);
    expect(run.printed).toContain("1 passed, 0 failed");
  });
});
