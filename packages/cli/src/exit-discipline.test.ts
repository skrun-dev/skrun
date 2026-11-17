import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliExit, exitWith, runCli } from "./utils/exit.js";

/**
 * No command of the CLI ends the process itself, save the declared cases.
 *
 * A command that fails calls `exitWith()`, which throws; `runCli()` sets the
 * exit code and the process ends on its own. `process.exit()` called while a
 * network connection is still closing aborts the process on Windows (status
 * 3221226505 instead of 1), a crash no Linux CI sees — so this guard reads the
 * sources instead of waiting for one.
 *
 * The rule, read in the text: a reference to `process.exit` — a call, the
 * method taken as a value, or `process["exit"]` — on a line of
 * `packages/cli/src/**\/*.ts` that is not a comment line (one that starts with
 * `//`, `/*` or `*`). Test files (`*.test.ts`) are not sources. `exitCode` is
 * not `exit`.
 *
 * A site the CLI keeps on purpose is declared in PERMANENT, keyed by file and
 * the text of its line, with how many lines carry it and why. PENDING is the
 * ratchet: the files not yet moved to `exitWith()`, with their number of sites;
 * it empties as they move, and no entry of it reaches the main branch. Both are
 * closed: an entry that finds fewer or more sites than it declares fails, so
 * the change that removes a site takes its entry out, and a new site is never
 * covered by an old entry.
 *
 * What it does not see: an alias that never names `process` (`const { exit } =
 * process` is seen, `globalThis.process.exit` too, but not a function handed
 * the process object); a site on a line that also opens a comment; any code
 * outside `packages/cli/src`.
 */

const SRC_ROOT = import.meta.dirname;
const EXIT_REFERENCE =
  /\bprocess\s*(?:\.\s*exit\b|\[\s*["'`]exit["'`]\s*\])|\{\s*exit\s*\}\s*=\s*process\b/g;

/** One line of a source that references `process.exit`. */
interface ExitSite {
  file: string;
  line: number;
  text: string;
}

/** A site kept on purpose: how many lines carry it, and why. */
interface Declared {
  sites: number;
  reason: string;
}

const PERMANENT: Readonly<Record<string, Declared>> = {
  "utils/prompts.ts#process.exit(0);": {
    sites: 1,
    reason:
      "The author cancelled one of init's prompts (Ctrl+C): nothing was sent anywhere yet, no connection is open. The token prompt of login, which follows a request, does not come here: a cancel there fails the sign-in with 1.",
  },
  "commands/dev.ts#process.exit(0);": {
    sites: 1,
    reason:
      "SIGINT or SIGTERM stops the local dev server: the server's own connections are closed first, and nothing else is in flight.",
  },
};

/** The ratchet: files still ending the process themselves, and how many sites each. */
const PENDING: Readonly<Record<string, number>> = {};

/** The sites of one source: every non-comment line that references `process.exit`. */
function exitSites(file: string, source: string): ExitSite[] {
  const sites: ExitSite[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) return;
    EXIT_REFERENCE.lastIndex = 0;
    if (EXIT_REFERENCE.test(text)) sites.push({ file, line: index + 1, text });
  });
  return sites;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function allSites(): ExitSite[] {
  return sourceFiles(SRC_ROOT).flatMap((path) =>
    exitSites(relative(SRC_ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf8")),
  );
}

const keyOf = (site: ExitSite): string => `${site.file}#${site.text}`;

describe("what the exit rule sees in a source", () => {
  it("sees a call, the method taken as a value, and the bracket form", () => {
    const sites = exitSites(
      "witness.ts",
      [
        "process.exit(1);",
        "if (bad) process.exit (2);",
        "const quit = process.exit;",
        'process["exit"](3);',
        "const { exit } = process;",
      ].join("\n"),
    );
    expect(sites.map((site) => site.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not see exitCode, exitWith, or a comment line", () => {
    const sites = exitSites(
      "witness.ts",
      [
        "process.exitCode = 1;",
        "exitWith(1);",
        "// process.exit(1) would abort the process on Windows",
        "/* process.exit(1) */",
        " * then process.exit(1) in a doc comment",
      ].join("\n"),
    );
    expect(sites).toEqual([]);
  });
});

describe("the CLI's sources", () => {
  const sites = allSites();
  const undeclared = sites.filter(
    (site) => !Object.hasOwn(PERMANENT, keyOf(site)) && !Object.hasOwn(PENDING, site.file),
  );

  it("are read: the declared sites are found", () => {
    expect(sites.some((site) => keyOf(site) === "utils/prompts.ts#process.exit(0);")).toBe(true);
  });

  it("end the process nowhere, save the declared sites", () => {
    expect(undeclared.map((site) => `${site.file}:${site.line} ${site.text}`)).toEqual([]);
  });

  it("keep each permanent entry to the sites it declares", () => {
    const wrong = Object.entries(PERMANENT).flatMap(([key, { sites: declared }]) => {
      const found = sites.filter((site) => keyOf(site) === key).length;
      return found === declared ? [] : [`${key}: ${declared} declared, ${found} found`];
    });
    expect(wrong).toEqual([]);
  });

  it("keep the ratchet closed: each pending file still has exactly the sites it declares", () => {
    const wrong = Object.entries(PENDING).flatMap(([file, declared]) => {
      const found = sites.filter(
        (site) => site.file === file && !Object.hasOwn(PERMANENT, keyOf(site)),
      ).length;
      return found === declared ? [] : [`${file}: ${declared} declared, ${found} found`];
    });
    expect(wrong).toEqual([]);
  });
});

describe("runCli", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(() => {
    exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit was called");
    });
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    error.mockRestore();
    process.exitCode = exitCodeBefore;
  });

  /** A program with one command whose action is `action`. */
  function programRunning(action: () => Promise<void>): Command {
    const program = new Command();
    program.command("act").action(action);
    return program;
  }

  it("sets the exit code a command ends with, after an await, and never calls process.exit", async () => {
    await runCli(
      programRunning(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        exitWith(3);
      }),
      ["act"],
    );

    expect(process.exitCode).toBe(3);
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("uses 1 by default", async () => {
    await runCli(
      programRunning(async () => exitWith()),
      ["act"],
    );

    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints any other error, its message only, and sets 1", async () => {
    await runCli(
      programRunning(async () => {
        throw new Error("the registry is unreachable");
      }),
      ["act"],
    );

    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("the registry is unreachable");
  });

  it("leaves the exit code alone when the command succeeds", async () => {
    await runCli(
      programRunning(async () => {}),
      ["act"],
    );

    expect(process.exitCode).toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("throws a CliExit carrying the code", () => {
    expect(() => exitWith(2)).toThrow(CliExit);
    try {
      exitWith(2);
    } catch (err) {
      expect((err as CliExit).code).toBe(2);
    }
  });
});
