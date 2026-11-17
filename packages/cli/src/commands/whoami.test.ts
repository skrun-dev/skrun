import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession, writeSignInFile } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { registerWhoamiCommand } from "./whoami.js";

// The command reads the sign-in file of a throwaway profile, never the file of
// the machine running the tests.

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Run `skrun whoami` through the real command: fetch is recorded (and answers
 * with `respond`), the output is captured, colours stripped, and neither
 * commander nor the command may end the test process.
 */
async function skrunWhoami(
  respond: () => Response = () => Response.json({}),
): Promise<{ lines: string[]; exitCode: number | undefined; requests: string[] }> {
  const run = { lines: [] as string[], exitCode: undefined as number | undefined };
  const requests: string[] = [];
  const record = (...parts: unknown[]): void => {
    run.lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return respond();
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerWhoamiCommand(program);
  try {
    await program.parseAsync(["whoami"], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) run.exitCode = err.code;
    else if (err instanceof CommanderError) run.exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { ...run, requests };
}

describe("skrun whoami — the server it would talk to, signed in or not", () => {
  it("without a session, prints the server the next command would use, then that it is not logged in, and ends with 1", async () => {
    useThrowawayProfile();

    const run = await skrunWhoami();

    expect(run.lines).toEqual([
      "ℹ Registry:  http://localhost:4000",
      "✗ Not logged in. Sign in: skrun login --registry http://localhost:4000",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
  });

  it("without a session for the server SKRUN_REGISTRY_URL names, prints that server, and advises a sign-in that names no address", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: "https://a.example", token: "token-a", username: "alice" });
    vi.stubEnv("SKRUN_REGISTRY_URL", "https://b.example/");

    const run = await skrunWhoami();

    expect(run.lines).toEqual([
      "ℹ Registry:  https://b.example",
      "✗ Not logged in. Sign in: skrun login (SKRUN_REGISTRY_URL names this server)",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
  });

  it("with a session, prints its namespace and its server", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: "https://a.example", token: "token-a", username: "alice" });

    const run = await skrunWhoami();

    expect(run.lines).toEqual(["ℹ Namespace: alice", "ℹ Registry:  https://a.example"]);
    expect(run.exitCode).toBeUndefined();
  });

  it.each([
    [
      "an older CLI's file",
      { token: "older-token", registry_url: "https://a.example" },
      "✗ Signed in with an older CLI — sign in again: skrun login --registry <url>",
    ],
    [
      "a file that cannot be read",
      "{ not json",
      "✗ The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>",
    ],
  ])("with %s, prints the server, then why it cannot be used, sends nothing, and ends with 1", async (_what, content, refusal) => {
    writeSignInFile(useThrowawayProfile(), content);

    const run = await skrunWhoami();

    expect(run.lines).toEqual(["ℹ Registry:  http://localhost:4000", refusal]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
  });

  it.each([
    [
      "an older CLI's file",
      { token: "older-token", registry_url: "https://a.example" },
      "✗ Signed in with an older CLI — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
    [
      "a file that cannot be read",
      "{ not json",
      "✗ The CLI's sign-in file cannot be read — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
  ])("with %s and the server SKRUN_REGISTRY_URL names, prints that server, then why the file cannot be used, advising a sign-in that names no address", async (_what, content, refusal) => {
    writeSignInFile(useThrowawayProfile(), content);
    vi.stubEnv("SKRUN_REGISTRY_URL", "https://b.example/");

    const run = await skrunWhoami();

    expect(run.lines).toEqual(["ℹ Registry:  https://b.example", refusal]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
  });
});
