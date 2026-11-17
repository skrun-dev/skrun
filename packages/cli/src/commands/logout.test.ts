import { existsSync, readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ThrowawayProfile,
  useThrowawayProfile,
  writeSession,
  writeSignInFile,
} from "../test-profile.shared.js";
import { parseSessionFile } from "../utils/auth.js";
import { CliExit } from "../utils/exit.js";
import { registerLogoutCommand } from "./logout.js";

// The command reads and writes the sign-in file of a throwaway profile, never
// the file of the machine running the tests.

const A = "https://a.example";
const B = "https://b.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Run `skrun logout` through the real command: fetch is recorded, the output
 * is captured, colours stripped, and neither commander nor the command may end
 * the test process.
 */
async function skrunLogout(): Promise<{
  lines: string[];
  exitCode: number | undefined;
  requests: number;
}> {
  const run = { lines: [] as string[], exitCode: undefined as number | undefined, requests: 0 };
  const record = (...parts: unknown[]): void => {
    run.lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      run.requests++;
      return Response.json({});
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerLogoutCommand(program);
  try {
    await program.parseAsync(["logout"], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) run.exitCode = err.code;
    else if (err instanceof CommanderError) run.exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return run;
}

function readBack(profile: ThrowawayProfile): ReturnType<typeof parseSessionFile> {
  return parseSessionFile(readFileSync(profile.file, "utf-8"));
}

/** Two sessions, A the current one. */
function twoSessions(profile: ThrowawayProfile): void {
  writeSignInFile(profile, {
    version: 2,
    current: A,
    sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
  });
}

describe("skrun logout — the session of one server, and no other", () => {
  it("removes the current server's session, leaves the other, and makes no other server current", async () => {
    const profile = useThrowawayProfile();
    twoSessions(profile);

    const run = await skrunLogout();

    expect(run.lines).toEqual([`✓ Logged out of ${A}.`]);
    expect(run.exitCode).toBeUndefined();
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b" } } },
    });
    expect(run.requests).toBe(0);
  });

  it("under SKRUN_REGISTRY_URL, removes that server's session, and the current server stays", async () => {
    const profile = useThrowawayProfile();
    twoSessions(profile);
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const run = await skrunLogout();

    expect(run.lines).toEqual([`✓ Logged out of ${B}.`]);
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, current: A, sessions: { [A]: { token: "token-a" } } },
    });
  });

  it("with no session for that server, says there is nothing to remove, changes nothing, and ends with 0", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", current: false });
    const before = readFileSync(profile.file);

    const run = await skrunLogout();

    expect(run.lines).toEqual(["ℹ No session for http://localhost:4000 — nothing to remove."]);
    expect(run.exitCode).toBeUndefined();
    expect(readFileSync(profile.file).equals(before)).toBe(true);
  });

  it.each([
    ["an older CLI's file", { token: "older-token", registry_url: A }],
    ["a file that cannot be read", "{ not json"],
  ])("removes %s, without sending anything", async (_what, content) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);

    const run = await skrunLogout();

    expect(run.lines).toEqual(["✓ Removed the sign-in saved by an older CLI."]);
    expect(run.exitCode).toBeUndefined();
    expect(existsSync(profile.file)).toBe(false);
    expect(run.requests).toBe(0);
  });
});
