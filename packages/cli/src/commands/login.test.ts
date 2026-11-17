import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ThrowawayProfile,
  useThrowawayProfile,
  writeSession,
  writeSignInFile,
} from "../test-profile.shared.js";
import { parseSessionFile, RedirectRefused } from "../utils/auth.js";
import { CliExit, runCli } from "../utils/exit.js";
import { deviceLogin, openBrowser, pollForToken, registerLoginCommand } from "./login.js";
import { registerWhoamiCommand } from "./whoami.js";

// The read of the sign-in file and the rename that puts it in place, wrapped:
// the real ones run unless a case makes one fail.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readFileSync: vi.fn(real.readFileSync), renameSync: vi.fn(real.renameSync) };
});

// SEC-002 (audit/006): intercept the child-process layer so the ARGV shape is
// assertable. `openBrowser` reaches it through a dynamic import, which vi.mock
// still intercepts. No browser is ever opened by these tests.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// The token prompt of `skrun login`, answered by each case (undefined: the
// user cancelled it), and whether a prompt can be answered at all — a
// terminal by default; a case without one says so.
const askTextMock = vi.fn();
let terminal = true;
vi.mock("../utils/prompts.js", () => ({
  askTextOrCancel: (...args: unknown[]) => askTextMock(...args),
  canPrompt: () => terminal,
}));

// The sign-in requests leave through the CLI's single sender, which reads the
// global fetch at each call: each case puts its own answers there.
afterEach(() => {
  vi.unstubAllGlobals();
  askTextMock.mockReset();
  terminal = true;
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("pollForToken", () => {
  const base = {
    registryUrl: "http://x",
    deviceCode: "dc",
    verifier: "v",
    interval: 1,
    sleepFn: async () => {},
  };

  it("returns the token when the poll succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token: "skrun_sk_x", username: "bob" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await pollForToken(base);
    expect(r).toEqual({ token: "skrun_sk_x", username: "bob" });
  });

  it("returns null on a terminal error (expired_token)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: "expired_token" } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await pollForToken(base);
    expect(r).toBeNull();
  });

  it("keeps polling through authorization_pending / slow_down / 429, then returns the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: "authorization_pending" } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: "slow_down" } }))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { token: "skrun_sk_y" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await pollForToken(base);
    expect(r?.token).toBe("skrun_sk_y");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a poll that gets no answer is tried again after the interval, and the sign-in goes on", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { token: "skrun_sk_w", username: "dana" }));
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => {});

    const outcome = await pollForToken({ ...base, sleepFn }).catch((e: unknown) => e);

    expect(outcome).toEqual({ token: "skrun_sk_w", username: "dana" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn.mock.calls).toEqual([[1000]]);
  });

  it("returns null when the deadline passes (timeout)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: "authorization_pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    const nows = [0, 50, 100, 150];
    let i = 0;
    const nowFn = () => nows[i++] ?? 999_999;
    const r = await pollForToken({ ...base, nowFn, deadlineMs: 100 });
    expect(r).toBeNull();
  });

  it("a redirect while polling ends the sign-in at once, naming its target: one request, no further poll, no wait", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://elsewhere.example/auth/device/token" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => {});
    let now = 0;
    const nowFn = () => {
      now += 10;
      return now;
    };

    const outcome = await pollForToken({ ...base, sleepFn, nowFn, deadlineMs: 100 }).catch(
      (e: unknown) => e,
    );

    expect(outcome).toBeInstanceOf(RedirectRefused);
    expect((outcome as Error).message).toBe(
      "The server at http://x answered with a redirect to https://elsewhere.example, which the CLI does not follow.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

describe("deviceLogin", () => {
  const baseDeps = () => ({
    registryUrl: "http://x",
    sleepFn: async () => {},
    openBrowser: vi.fn(),
    canPrompt: () => true,
    promptToken: vi.fn().mockResolvedValue("manual-token"),
    save: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
  });

  it("runs the device flow: prints the user_code, opens the browser, polls, saves the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "WXYZ-3456",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?user_code=WXYZ-3456",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { token: "skrun_sk_z", username: "carol" }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = baseDeps();
    await deviceLogin(deps);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://x/device?user_code=WXYZ-3456");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("WXYZ-3456"));
    expect(deps.save).toHaveBeenCalledWith("skrun_sk_z", "carol");
    expect(deps.promptToken).not.toHaveBeenCalled();
  });

  it("falls back to the token prompt when OAuth is not configured (404): it names the server, and offers no default token to a server elsewhere", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: "OAUTH_NOT_CONFIGURED" } }))
      .mockResolvedValueOnce(jsonResponse(200, { namespace: "carol" }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = baseDeps();
    await deviceLogin(deps);
    expect(deps.promptToken).toHaveBeenCalledWith(
      "The server at http://x has no browser sign-in. API token for http://x:",
      undefined,
    );
    expect(deps.save).toHaveBeenCalledWith("manual-token", "carol");
    // No poll — the device flow short-circuited; the one other request checks
    // the typed token before it is saved.
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://x/auth/device/code",
      "http://x/api/me",
    ]);
  });

  it("no terminal to type a token after a 404: the message, before any prompt, gives the command with the token; nothing saved, exit 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: "OAUTH_NOT_CONFIGURED" } }))
      .mockResolvedValue(jsonResponse(200, { namespace: "carol" }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = { ...baseDeps(), canPrompt: () => false };

    const outcome = await deviceLogin(deps).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(deps.fail.mock.calls).toEqual([
      [
        "No terminal to type a token for http://x — give it: skrun login --registry http://x --token <token>",
      ],
    ]);
    expect(deps.promptToken).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://x/auth/device/code",
    ]);
    expect(outcome).toBeInstanceOf(CliExit);
    expect((outcome as CliExit).code).toBe(1);
  });

  it("a token prompt the user cancels: nothing saved, nothing sent, exit 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: "OAUTH_NOT_CONFIGURED" } }))
      .mockResolvedValue(jsonResponse(200, { namespace: "carol" }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = { ...baseDeps(), promptToken: vi.fn().mockResolvedValue(undefined) };

    const outcome = await deviceLogin(deps).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(deps.fail.mock.calls).toEqual([["Nothing was saved."]]);
    expect(deps.save).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://x/auth/device/code",
    ]);
    expect(outcome).toBeInstanceOf(CliExit);
    expect((outcome as CliExit).code).toBe(1);
  });

  it("an unreachable server is a failure that names it: no token asked, nothing saved, exit 1", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: refused }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = baseDeps();

    const outcome = await deviceLogin(deps).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(deps.promptToken).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      "Could not reach http://x (ECONNREFUSED). Nothing was saved. To sign in elsewhere: skrun login --registry <url>",
    );
    expect(outcome).toBeInstanceOf(CliExit);
    expect((outcome as CliExit).code).toBe(1);
  });

  it("a sign-in that times out is a failure: the message names the server and the command that signs in there, nothing saved, exit 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "WXYZ-3456",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/d",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValue(jsonResponse(400, { error: { code: "authorization_pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    const nows = [0, 50, 100, 150];
    let i = 0;
    const deps = {
      ...baseDeps(),
      nowFn: () => nows[i++] ?? 999_999,
      deadlineMs: 100,
    };

    const outcome = await deviceLogin(deps).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(deps.fail).toHaveBeenCalledWith(
      "Login to http://x timed out or was not completed. Run: skrun login --registry http://x",
    );
    expect(deps.save).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(CliExit);
    expect((outcome as CliExit).code).toBe(1);
  });
});

describe("deviceLogin — the browser sign-in waits as long as the server keeps its code", () => {
  /**
   * A clock that moves only when the sign-in waits: each wait of the poll moves
   * it by the interval, so a case reads at what time each poll left, and at
   * what time the sign-in gave up. No real time passes.
   */
  function simulatedClock() {
    const clock = {
      now: 0,
      nowFn: () => clock.now,
      sleepFn: async (ms: number) => {
        clock.now += ms;
      },
    };
    return clock;
  }

  /** The device code's answer, with the `expires_in` written as given (raw JSON text). */
  const deviceCode = (expiresIn: string | undefined): Response =>
    new Response(
      `{"device_code":"dc","user_code":"WXYZ-3456","verification_uri":"http://x/device","verification_uri_complete":"http://x/d",${
        expiresIn === undefined ? "" : `"expires_in":${expiresIn},`
      }"interval":5}`,
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  /**
   * A server whose device code lives `expiresIn` (raw JSON, or absent), and
   * whose user approves at `approvedAt` (never, by default): each poll before
   * then is answered `authorization_pending`. Records the time of each poll.
   */
  function server(clock: { now: number }, expiresIn: string | undefined, approvedAt = Infinity) {
    const polls: number[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/device/code")) return deviceCode(expiresIn);
      polls.push(clock.now);
      return clock.now >= approvedAt
        ? jsonResponse(200, { token: "skrun_sk_late", username: "erin" })
        : jsonResponse(400, { error: { code: "authorization_pending" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return polls;
  }

  const deps = (clock: ReturnType<typeof simulatedClock>) => ({
    registryUrl: "http://x",
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    openBrowser: vi.fn(),
    canPrompt: () => true,
    promptToken: vi.fn(),
    save: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
  });

  const TIMED_OUT =
    "Login to http://x timed out or was not completed. Run: skrun login --registry http://x";

  it("a code the server keeps 600 seconds: the sign-in still polls past two minutes, and succeeds when the user approves at five", async () => {
    const clock = simulatedClock();
    const polls = server(clock, "600", 300_000);
    const d = deps(clock);

    const outcome = await deviceLogin(d).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(d.save).toHaveBeenCalledWith("skrun_sk_late", "erin");
    expect(d.success).toHaveBeenCalledWith("Logged in to http://x as erin");
    expect(d.fail).not.toHaveBeenCalled();
    expect(outcome).toBeUndefined();
    expect(polls.at(-1)).toBe(300_000);
  });

  it("a code the server keeps an hour: the sign-in gives up at fifteen minutes, with the timed-out failure, exit 1", async () => {
    const clock = simulatedClock();
    const polls = server(clock, "3600");
    const d = deps(clock);

    const outcome = await deviceLogin(d).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(clock.now).toBe(900_000);
    expect(polls.at(-1)).toBe(895_000);
    expect(d.fail.mock.calls).toEqual([[TIMED_OUT]]);
    expect(d.save).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(CliExit);
    expect((outcome as CliExit).code).toBe(1);
  });

  // A lifetime the CLI cannot read as a positive number of seconds: the
  // two-minute wait of a server that says nothing. `1e999` is valid JSON that
  // reads as Infinity, a number that is not finite.
  it.each([
    ["absent", undefined],
    ["null", "null"],
    ["zero", "0"],
    ["negative", "-60"],
    ["a string", '"600"'],
    ["a number too large to be finite (1e999)", "1e999"],
  ])("an expires_in %s: the sign-in waits two minutes, then fails as timed out", async (_label, expiresIn) => {
    const clock = simulatedClock();
    const polls = server(clock, expiresIn);
    const d = deps(clock);

    const outcome = await deviceLogin(d).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(clock.now).toBe(120_000);
    expect(polls.at(-1)).toBe(115_000);
    expect(d.fail.mock.calls).toEqual([[TIMED_OUT]]);
    expect(d.save).not.toHaveBeenCalled();
    expect((outcome as CliExit).code).toBe(1);
  });

  it("a lifetime that is not a number (NaN) given to the poll: it waits two minutes", async () => {
    const clock = simulatedClock();
    const polls = server(clock, undefined);

    const result = await pollForToken({
      registryUrl: "http://x",
      deviceCode: "dc",
      verifier: "v",
      interval: 5,
      expiresIn: Number.NaN,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
    });

    expect(result).toBeNull();
    expect(clock.now).toBe(120_000);
    expect(polls.at(-1)).toBe(115_000);
  });

  it("a deadline given to the poll wins over the server's lifetime of the code: thirty seconds against a code kept 600, it gives up at thirty", async () => {
    const clock = simulatedClock();
    const polls = server(clock, undefined);

    const result = await pollForToken({
      registryUrl: "http://x",
      deviceCode: "dc",
      verifier: "v",
      interval: 5,
      expiresIn: 600,
      deadlineMs: 30_000,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
    });

    expect(result).toBeNull();
    expect(clock.now).toBe(30_000);
    expect(polls.at(-1)).toBe(25_000);
  });
});

/** One request the CLI sent: where, and the Authorization it carried. */
interface Sent {
  url: string;
  authorization: string | undefined;
}

/** What a simulated server answers to a request, by its URL; throwing is no answer at all. */
type Answer = (url: string) => Response;

/**
 * Run `skrun <args>` through the real `login` and `whoami` commands, in the
 * throwaway profile the case set up: fetch is replaced by a recorder that
 * answers with `answer`, the output is captured, colours stripped, and neither
 * commander nor the command may end the test process.
 */
async function skrun(
  args: string[],
  answer: Answer = () => Response.json({}),
): Promise<{ lines: string[]; exitCode: number | undefined; requests: Sent[] }> {
  // The command writes the sign-in file: never anywhere but a throwaway profile.
  if (!basename(homedir()).startsWith("skrun-cli-profile-")) {
    throw new Error("skrun() runs only in a throwaway profile (useThrowawayProfile first)");
  }
  const run = { lines: [] as string[], exitCode: undefined as number | undefined };
  const requests: Sent[] = [];
  const record = (...parts: unknown[]): void => {
    run.lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: String(input), authorization: headers.Authorization });
      return answer(String(input));
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerLoginCommand(program);
  registerWhoamiCommand(program);
  try {
    await program.parseAsync(args, { from: "user" });
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

describe("skrun login — a token the user typed is checked by the server before it is saved", () => {
  const A = "https://a.example";

  it("a typed token the server refuses (401) is not saved: the command ends with 1, the session already saved for that server untouched", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-before", username: "alice" });
    const before = readFileSync(profile.file, "utf-8");

    const run = await skrun(["login", "--registry", A, "--token", "typed-token"], () =>
      Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    );

    expect(run.lines).toEqual([
      `✗ The server at ${A} refused this token (HTTP 401). Nothing was saved.`,
    ]);
    expect(run.exitCode).toBe(1);
    expect(readFileSync(profile.file, "utf-8")).toBe(before);
    expect(run.requests).toEqual([{ url: `${A}/api/me`, authorization: "Bearer typed-token" }]);
  });
});

/** The sign-in file of the profile, read back as the CLI reads it; undefined when there is none. */
function signInFile(profile: ThrowawayProfile): ReturnType<typeof parseSessionFile> | undefined {
  return existsSync(profile.file)
    ? parseSessionFile(readFileSync(profile.file, "utf-8"))
    : undefined;
}

/** A request that gets no answer: the connection refused. */
function noAnswer(): never {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  throw new TypeError("fetch failed", { cause: refused });
}

/** The path of a request URL. */
const pathOf = (url: string): string => new URL(url).pathname;

/** A server whose browser sign-in grants `token` for `username` at the first poll. */
function browserSignIn(token: string, username: string): Answer {
  return (url) => {
    if (pathOf(url) === "/auth/device/code") {
      return Response.json({
        device_code: "dc",
        user_code: "WXYZ-3456",
        verification_uri: `${new URL(url).origin}/device`,
        verification_uri_complete: `${new URL(url).origin}/device?user_code=WXYZ-3456`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (pathOf(url) === "/auth/device/token") return Response.json({ token, username });
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  };
}

/** A server with no browser sign-in (404), that accepts a typed token for `namespace` at GET /api/me. */
function tokenOnly(namespace: string): Answer {
  return (url) =>
    pathOf(url) === "/api/me"
      ? Response.json({ namespace })
      : Response.json({ error: { code: "OAUTH_NOT_CONFIGURED" } }, { status: 404 });
}

describe("skrun login — a server that cannot be reached, or has no browser sign-in", () => {
  const A = "https://a.example";
  const C = "https://c.example";

  it("a server that cannot be reached: exit 1, the message names it and the cause, no token is asked, nothing is saved", async () => {
    const profile = useThrowawayProfile();

    const run = await skrun(["login", "--registry", A], noAnswer);

    expect(run.lines).toEqual([
      `✗ Could not reach ${A} (ECONNREFUSED). Nothing was saved. To sign in elsewhere: skrun login --registry <url>`,
    ]);
    expect(run.exitCode).toBe(1);
    expect(askTextMock).not.toHaveBeenCalled();
    expect(signInFile(profile)).toBeUndefined();
  });

  it("no browser sign-in on this machine's server: the prompt names it and offers dev-token, which is checked before it is saved", async () => {
    const profile = useThrowawayProfile();
    const local = "http://localhost:4000";
    askTextMock.mockResolvedValue("dev-token");

    const run = await skrun(["login", "--registry", local], tokenOnly("dev"));

    expect(askTextMock.mock.calls).toEqual([
      [`The server at ${local} has no browser sign-in. API token for ${local}:`, "dev-token"],
    ]);
    expect(run.requests).toEqual([
      { url: `${local}/auth/device/code`, authorization: undefined },
      { url: `${local}/api/me`, authorization: "Bearer dev-token" },
    ]);
    expect(run.lines).toEqual([`✓ Logged in to ${local} as dev`]);
    expect(run.exitCode).toBeUndefined();
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: local,
        sessions: { [local]: { token: "dev-token", username: "dev" } },
      },
    });
  });

  it("no browser sign-in on a server elsewhere: the prompt names it and offers no default token", async () => {
    useThrowawayProfile();
    askTextMock.mockResolvedValue("skrun_sk_typed");

    const run = await skrun(["login", "--registry", A], tokenOnly("alice"));

    expect(askTextMock.mock.calls).toEqual([
      [`The server at ${A} has no browser sign-in. API token for ${A}:`, undefined],
    ]);
    expect(run.lines).toEqual([`✓ Logged in to ${A} as alice`]);
  });

  it.each([
    [
      "a server the user named",
      ["login", "--registry", A],
      undefined,
      `✗ No terminal to type a token for ${A} — give it: skrun login --registry ${A} --token <token>`,
    ],
    [
      "the server SKRUN_REGISTRY_URL names",
      ["login"],
      A,
      `✗ No terminal to type a token for ${A} — give it: skrun login --token <token> (SKRUN_REGISTRY_URL names this server)`,
    ],
  ])("no browser sign-in at %s, and no terminal to type a token: exit 1, the message gives the command with the token, no prompt, nothing saved", async (_what, args, variable, message) => {
    const profile = useThrowawayProfile();
    if (variable !== undefined) vi.stubEnv("SKRUN_REGISTRY_URL", variable);
    terminal = false;

    const run = await skrun(args, tokenOnly("alice"));

    expect(run.lines).toEqual([message]);
    expect(run.exitCode).toBe(1);
    expect(askTextMock).not.toHaveBeenCalled();
    expect(run.requests).toEqual([{ url: `${A}/auth/device/code`, authorization: undefined }]);
    expect(signInFile(profile)).toBeUndefined();
  });

  it("no browser sign-in, and the token prompt cancelled: exit 1, nothing saved, nothing sent, the session already saved for that server untouched", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-before", username: "alice" });
    const before = readFileSync(profile.file, "utf-8");
    askTextMock.mockResolvedValue(undefined);

    const run = await skrun(["login", "--registry", A], tokenOnly("alice"));

    expect(run.lines).toEqual(["✗ Nothing was saved."]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([{ url: `${A}/auth/device/code`, authorization: undefined }]);
    expect(readFileSync(profile.file, "utf-8")).toBe(before);
  });

  it("no browser sign-in at the current session's server: exit 1, the message says how to give the address, no token is asked, nothing changes", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: C, token: "token-c", username: "carol" });
    const before = readFileSync(profile.file, "utf-8");

    const run = await skrun(["login"], tokenOnly("carol"));

    expect(run.lines).toEqual([
      `✗ The server at ${C} has no browser sign-in — to use a token: skrun login --registry ${C} --token <token>`,
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([{ url: `${C}/auth/device/code`, authorization: undefined }]);
    expect(askTextMock).not.toHaveBeenCalled();
    expect(readFileSync(profile.file, "utf-8")).toBe(before);
  });

  describe("the local development token is offered by default to this machine's addresses only", () => {
    it.each([
      ["http://localhost:4000", "dev-token"],
      ["http://127.0.0.1:4000", "dev-token"],
      ["http://127.1.2.3:4000", "dev-token"],
      ["http://[::1]:4000", "dev-token"],
      ["http://192.168.1.10:4000", undefined],
      ["https://example.com", undefined],
      ["http://localhost.example.com:4000", undefined],
    ])("%s: %s", async (address, offered) => {
      useThrowawayProfile();
      askTextMock.mockResolvedValue("typed");

      await skrun(["login", "--registry", address], tokenOnly("someone"));

      expect(askTextMock.mock.calls.map((call) => call[1])).toEqual([offered]);
    });
  });
});

/** A server whose browser sign-in starts, then ends at the first poll with the terminal error `code`. */
function browserSignInEnded(code: string): Answer {
  return (url) =>
    pathOf(url) === "/auth/device/token"
      ? Response.json({ error: { code } }, { status: 400 })
      : browserSignIn("unused", "unused")(url);
}

describe("skrun login — a browser sign-in that does not succeed ends with 1, nothing saved", () => {
  const A = "https://a.example";

  it.each([
    [
      "the device-code request answered 500",
      () => Response.json({}, { status: 500 }),
      [
        `✗ Login failed (${A}/auth/device/code returned 500). To use a token instead: skrun login --registry ${A} --token <token>`,
      ],
    ],
    [
      "the device-code request answered 429",
      () => Response.json({}, { status: 429 }),
      [
        `✗ Login failed (${A}/auth/device/code returned 429). To use a token instead: skrun login --registry ${A} --token <token>`,
      ],
    ],
    [
      "the server ends the sign-in at its first poll (expired_token)",
      browserSignInEnded("expired_token"),
      [
        "ℹ Your one-time code: WXYZ-3456",
        `ℹ Open ${A}/device and enter it (opening your browser…)`,
        `✗ Login to ${A} timed out or was not completed. Run: skrun login --registry ${A}`,
      ],
    ],
  ] as Array<[string, Answer, string[]]>)("%s", async (_what, answer, expected) => {
    const profile = useThrowawayProfile();

    const run = await skrun(["login", "--registry", A], answer);

    expect(run.lines).toEqual(expected);
    expect(run.exitCode).toBe(1);
    expect(signInFile(profile)).toBeUndefined();
  });

  it.each([
    [
      "the device-code request answered 500",
      () => Response.json({}, { status: 500 }),
      [
        `✗ Login failed (${A}/auth/device/code returned 500). To use a token instead: skrun login --token <token> (SKRUN_REGISTRY_URL names this server)`,
      ],
    ],
    [
      "the server ends the sign-in at its first poll (expired_token)",
      browserSignInEnded("expired_token"),
      [
        "ℹ Your one-time code: WXYZ-3456",
        `ℹ Open ${A}/device and enter it (opening your browser…)`,
        `✗ Login to ${A} timed out or was not completed. Run: skrun login (SKRUN_REGISTRY_URL names this server)`,
      ],
    ],
  ] as Array<
    [string, Answer, string[]]
  >)("%s, the server named by SKRUN_REGISTRY_URL: the command advised names no address", async (_what, answer, expected) => {
    const profile = useThrowawayProfile();
    vi.stubEnv("SKRUN_REGISTRY_URL", A);

    const run = await skrun(["login"], answer);

    expect(run.lines).toEqual(expected);
    expect(run.exitCode).toBe(1);
    expect(signInFile(profile)).toBeUndefined();
  });
});

describe("skrun login — a token given empty is refused, and never sent", () => {
  const A = "https://a.example";

  it.each([
    ["--token empty, a current server saved", ["login", "--token", ""]],
    ["--token blank, an address given", ["login", "--registry", A, "--token", "   "]],
  ])("%s: exit 1, no request at all, nothing changes", async (_what, args) => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-before", username: "alice" });
    const before = readFileSync(profile.file, "utf-8");

    const run = await skrun(args, browserSignIn("token-new", "alice"));

    expect(run.lines).toEqual(["✗ No token was given. Nothing was sent."]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
    expect(readFileSync(profile.file, "utf-8")).toBe(before);
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
  ])("a token typed %s at the prompt after a 404: exit 1, the token is not sent, nothing is saved — and the message does not say nothing was sent, since the device-code request was", async (_what, typed) => {
    const profile = useThrowawayProfile();
    askTextMock.mockResolvedValue(typed);

    const run = await skrun(["login", "--registry", A], tokenOnly("alice"));

    expect(run.lines).toEqual(["✗ No token was given. Nothing was saved."]);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([{ url: `${A}/auth/device/code`, authorization: undefined }]);
    expect(signInFile(profile)).toBeUndefined();
  });
});

describe("skrun login — a sign-in file that cannot be written", () => {
  it("on Windows, a rename refused every time: the command ends with 1 and says so in one line, without the file's path; the old file whole, no temporary file", async () => {
    const profile = useThrowawayProfile();
    const A = "https://a.example";
    writeSession(profile, { address: A, token: "token-before", username: "alice" });
    const before = readFileSync(profile.file);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ namespace: "alice" })),
    );
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation(() => {
      throw Object.assign(new Error("rename refused (simulated, EPERM)"), { code: "EPERM" });
    });
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
    };
    const log = vi.spyOn(console, "log").mockImplementation(record);
    const error = vi.spyOn(console, "error").mockImplementation(record);
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    const exitCodeBefore = process.exitCode;
    const program = new Command();
    program.exitOverride();
    registerLoginCommand(program);
    let exitCode: typeof process.exitCode;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.exitCode = undefined;
      await runCli(program, ["login", "--registry", A, "--token", "token-new"]);
      exitCode = process.exitCode;
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.exitCode = exitCodeBefore;
      vi.mocked(renameSync).mockImplementation(actual.renameSync);
      log.mockRestore();
      error.mockRestore();
    }

    expect(lines).toEqual([
      "✗ Could not write the CLI's sign-in file (EPERM): it is in use, or cannot be written. It is left as it was — try again.",
    ]);
    expect(exitCode).toBe(1);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
  }, 20_000);

  it("a sign-in file another program holds when the token is to be saved: the command ends with 1 and says so in one line, without the file's path; the file whole", async () => {
    const profile = useThrowawayProfile();
    const A = "https://a.example";
    writeSession(profile, { address: A, token: "token-before", username: "alice" });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const before = actual.readFileSync(profile.file);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ namespace: "alice" })),
    );
    vi.mocked(readFileSync).mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (path === profile.file) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${profile.file}'`), {
          code: "EBUSY",
        });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof readFileSync);
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
    };
    const log = vi.spyOn(console, "log").mockImplementation(record);
    const error = vi.spyOn(console, "error").mockImplementation(record);
    const exitCodeBefore = process.exitCode;
    const program = new Command();
    program.exitOverride();
    registerLoginCommand(program);
    let exitCode: typeof process.exitCode;
    try {
      process.exitCode = undefined;
      await runCli(program, ["login", "--registry", A, "--token", "token-new"]);
      exitCode = process.exitCode;
    } finally {
      process.exitCode = exitCodeBefore;
      vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
      log.mockRestore();
      error.mockRestore();
    }

    expect(lines).toEqual([
      "✗ Could not read the CLI's sign-in file (EBUSY): it is in use, or cannot be read. It is left as it was — try again.",
    ]);
    expect(exitCode).toBe(1);
    expect(actual.readFileSync(profile.file).equals(before)).toBe(true);
  });
});

describe("skrun login --token — refused, unreachable, then accepted", () => {
  it("nothing is saved and the command ends with 1 on a 401, a 500 and no answer; a 200 saves the token with its namespace", async () => {
    const profile = useThrowawayProfile();
    const A = "https://a.example";
    const attempt = (answer: Answer) =>
      skrun(["login", "--registry", A, "--token", "typed-token"], answer);

    const refused = await attempt(() => Response.json({}, { status: 401 }));
    const failing = await attempt(() => Response.json({}, { status: 500 }));
    const unreachable = await attempt(noAnswer);
    expect([refused, failing, unreachable].map((run) => [run.lines, run.exitCode])).toEqual([
      [[`✗ The server at ${A} refused this token (HTTP 401). Nothing was saved.`], 1],
      [[`✗ The server at ${A} refused this token (HTTP 500). Nothing was saved.`], 1],
      [
        [
          `✗ Could not reach ${A} (ECONNREFUSED). Nothing was saved. To sign in elsewhere: skrun login --registry <url>`,
        ],
        1,
      ],
    ]);
    expect(signInFile(profile)).toBeUndefined();

    const accepted = await attempt(() => Response.json({ namespace: "alice" }));
    expect(accepted.lines).toEqual([`✓ Logged in to ${A} as alice`]);
    expect(accepted.exitCode).toBeUndefined();
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: { [A]: { token: "typed-token", username: "alice" } },
      },
    });
  });
});

describe("skrun login — the server it contacts: the browser sign-in inherits the current one, a typed token never does", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  const C = "https://c.example";
  const DEFAULT = "http://localhost:4000";

  it.each([
    ["neither option, variable nor current server", DEFAULT, DEFAULT, {}],
    ["a current server only", C, DEFAULT, { current: true }],
    ["the variable and a current server", B, B, { env: B, current: true }],
    ["the option, the variable and a current server", A, A, { option: A, env: B, current: true }],
    ["the option and a current server", A, A, { option: A, current: true }],
  ] as Array<
    [string, string, string, { option?: string; env?: string; current?: boolean }]
  >)("%s: the browser sign-in asks %s, a typed token goes to %s", async (_what, browser, typed, given) => {
    const profile = useThrowawayProfile();
    if (given.current) writeSession(profile, { address: C, token: "token-c" });
    if (given.env !== undefined) vi.stubEnv("SKRUN_REGISTRY_URL", given.env);
    const option = given.option === undefined ? [] : ["--registry", given.option];
    const refuse = () => Response.json({}, { status: 503 });

    const viaBrowser = await skrun(["login", ...option], refuse);
    const viaToken = await skrun(["login", ...option, "--token", "typed-token"], refuse);

    expect(viaBrowser.requests).toEqual([
      { url: `${browser}/auth/device/code`, authorization: undefined },
    ]);
    expect(viaToken.requests).toEqual([
      { url: `${typed}/api/me`, authorization: "Bearer typed-token" },
    ]);
  });

  it("signed in to a server as the current one, a token typed with neither option nor variable goes to the default: that server receives no request", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: C, token: "token-c", username: "carol" });

    const run = await skrun(["login", "--token", "skrun_sk_typed"], () =>
      Response.json({ namespace: "dev" }),
    );

    expect(run.requests).toEqual([
      { url: `${DEFAULT}/api/me`, authorization: "Bearer skrun_sk_typed" },
    ]);
    expect(run.requests.filter((request) => request.url.startsWith(C))).toEqual([]);
    expect(run.lines).toEqual([`✓ Logged in to ${DEFAULT} as dev`]);
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: DEFAULT,
        sessions: {
          [C]: { token: "token-c", username: "carol" },
          [DEFAULT]: { token: "skrun_sk_typed", username: "dev" },
        },
      },
    });
  });
});

describe("skrun login — the current server, and a sign-in under SKRUN_REGISTRY_URL alone", () => {
  const A = "https://a.example";
  const B = "https://b.example";

  it.each([
    ["the browser sign-in", [] as string[], browserSignIn("token-b", "bob")],
    ["a typed token", ["--token", "token-b"], () => Response.json({ namespace: "bob" })],
  ])("%s under the variable alone saves that server's session, and the current server stays the same", async (_what, args, answer) => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const run = await skrun(["login", ...args], answer);

    expect(run.lines.at(-1)).toBe(`✓ Logged in to ${B} as bob`);
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: {
          [A]: { token: "token-a", username: "alice" },
          [B]: { token: "token-b", username: "bob" },
        },
      },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", undefined);
    const whoami = await skrun(["whoami"]);
    expect(whoami.lines).toEqual(["ℹ Namespace: alice", `ℹ Registry:  ${A}`]);
  });

  it("a first sign-in under the variable alone leaves no current server: without the variable, whoami prints the default and that it is not logged in", async () => {
    const profile = useThrowawayProfile();
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    await skrun(["login", "--token", "token-b"], () => Response.json({ namespace: "bob" }));

    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b", username: "bob" } } },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", undefined);
    const whoami = await skrun(["whoami"]);
    expect(whoami.lines).toEqual([
      "ℹ Registry:  http://localhost:4000",
      "✗ Not logged in. Sign in: skrun login --registry http://localhost:4000",
    ]);
    expect(whoami.exitCode).toBe(1);
  });

  it("a sign-in with --registry makes that server the current one", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });

    await skrun(["login", "--registry", B], browserSignIn("token-b", "bob"));

    const read = signInFile(profile);
    expect(read?.kind === "sessions" ? read.file.current : read).toBe(B);
    const whoami = await skrun(["whoami"]);
    expect(whoami.lines).toEqual(["ℹ Namespace: bob", `ℹ Registry:  ${B}`]);
  });
});

describe("each failure tied to a server names it, in its normalized form, and says what to do", () => {
  const C = "https://c.example";

  it.each([
    [
      "a server that cannot be reached",
      () => {},
      ["login", "--registry", "HTTPS://A.example:443/"],
      noAnswer,
      [
        "✗ Could not reach https://a.example (ECONNREFUSED). Nothing was saved. To sign in elsewhere: skrun login --registry <url>",
      ],
    ],
    [
      "no browser sign-in at the current session's server",
      (profile: ThrowawayProfile) => writeSession(profile, { address: C, token: "token-c" }),
      ["login"],
      tokenOnly("carol"),
      [
        `✗ The server at ${C} has no browser sign-in — to use a token: skrun login --registry ${C} --token <token>`,
      ],
    ],
    [
      "a typed token refused",
      () => {},
      ["login", "--registry", "HTTPS://A.example:443/", "--token", "typed-token"],
      () => Response.json({}, { status: 403 }),
      ["✗ The server at https://a.example refused this token (HTTP 403). Nothing was saved."],
    ],
    [
      "a redirect to another host: no sign-in advised there",
      () => {},
      ["login", "--registry", "HTTPS://A.example:443/"],
      () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://b.example/auth/device/code" },
        }),
      [
        "✗ The server at https://a.example answered with a redirect to https://b.example, which the CLI does not follow.",
      ],
    ],
    [
      "a redirect to the same host, the address given by --registry",
      () => {},
      ["login", "--registry", "HTTP://A.example:80/"],
      () =>
        new Response(null, {
          status: 301,
          headers: { Location: "https://a.example/auth/device/code" },
        }),
      [
        "✗ The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: skrun login --registry https://a.example",
      ],
    ],
    [
      "a redirect to the same host, the address from SKRUN_REGISTRY_URL",
      () => vi.stubEnv("SKRUN_REGISTRY_URL", "HTTP://A.example:80/"),
      ["login"],
      () =>
        new Response(null, {
          status: 301,
          headers: { Location: "https://a.example/auth/device/code" },
        }),
      [
        "✗ The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to https://a.example",
      ],
    ],
    [
      "a typed token met by a redirect to the same host, the address from SKRUN_REGISTRY_URL",
      () => vi.stubEnv("SKRUN_REGISTRY_URL", "http://a.example"),
      ["login", "--token", "typed-token"],
      () =>
        new Response(null, {
          status: 308,
          headers: { Location: "https://a.example/api/me" },
        }),
      [
        "✗ The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to https://a.example",
      ],
    ],
    [
      "a redirect met while polling for the browser sign-in, to the same host, the address from SKRUN_REGISTRY_URL",
      () => vi.stubEnv("SKRUN_REGISTRY_URL", "http://a.example"),
      ["login"],
      (url: string) =>
        pathOf(url) === "/auth/device/token"
          ? new Response(null, {
              status: 307,
              headers: { Location: "https://a.example/auth/device/token" },
            })
          : browserSignIn("unused", "unused")(url),
      [
        "ℹ Your one-time code: WXYZ-3456",
        "ℹ Open http://a.example/device and enter it (opening your browser…)",
        "✗ The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to https://a.example",
      ],
    ],
    [
      "an invalid --registry (the value, which can carry a password, is not repeated)",
      () => {},
      ["login", "--registry", "ftp://user:secret@a.example"],
      () => Response.json({}),
      [
        "✗ --registry must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com",
      ],
    ],
    [
      "an invalid SKRUN_REGISTRY_URL",
      () => vi.stubEnv("SKRUN_REGISTRY_URL", "https://user:secret@a.example"),
      ["login"],
      () => Response.json({}),
      [
        "✗ SKRUN_REGISTRY_URL must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com",
      ],
    ],
    [
      "an older CLI's sign-in file",
      (profile: ThrowawayProfile) =>
        writeSignInFile(profile, { token: "older-token", registry_url: C }),
      ["whoami"],
      () => Response.json({}),
      [
        "ℹ Registry:  http://localhost:4000",
        "✗ Signed in with an older CLI — sign in again: skrun login --registry <url>",
      ],
    ],
    [
      "a sign-in file that cannot be read",
      (profile: ThrowawayProfile) => writeSignInFile(profile, "{ not json"),
      ["whoami"],
      () => Response.json({}),
      [
        "ℹ Registry:  http://localhost:4000",
        "✗ The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>",
      ],
    ],
    [
      "no session for the server",
      () => vi.stubEnv("SKRUN_REGISTRY_URL", "HTTPS://B.example:443/"),
      ["whoami"],
      () => Response.json({}),
      [
        "ℹ Registry:  https://b.example",
        "✗ Not logged in. Sign in: skrun login (SKRUN_REGISTRY_URL names this server)",
      ],
    ],
  ])("%s", async (_what, arrange, args, answer, expected) => {
    const profile = useThrowawayProfile();
    arrange(profile);
    const before = existsSync(profile.file) ? readFileSync(profile.file, "utf-8") : undefined;

    const run = await skrun(args, answer);

    expect(run.lines).toEqual(expected);
    expect(run.exitCode).toBe(1);
    expect(run.lines.join("\n")).not.toContain("secret");
    expect(existsSync(profile.file) ? readFileSync(profile.file, "utf-8") : undefined).toBe(before);
  });
});

describe("openBrowser — command injection (SEC-002, audit/006)", () => {
  /**
   * The URL comes from the registry's JSON response through a bare TypeScript
   * cast — no schema, no type guard — and the server address the CLI resolves
   * has no TLS requirement and defaults to plaintext. So a hostile or MITM'd registry
   * chooses this string. Before the fix it was interpolated into a shell
   * command line; all three payloads below were reproduced executing.
   *
   * The fix stops them at two different places, which is why they are split:
   * `new URL()` rejects the quote-bearing ones outright, and the quote-free one
   * — which parses fine, keeping `$( )` intact — is stopped only by handing the
   * value to the opener as an argv entry. That second class is the reason a URL
   * parse is NOT a substitute for argument-array execution.
   */
  const UNPARSEABLE = [
    // POSIX, closing the double quote the old code wrapped the URL in
    'http://x"; echo INJECTED; echo "',
    // Windows: `;` is an argument delimiter on cmd.exe, `&` is the separator
    'http://x" & echo INJECTED & rem "',
  ];
  const PARSES_BUT_HARMLESS_AS_ARGV = [
    // Survives `new URL()`, which encodes the space but leaves `$`, `(`, `)`
    "http://x/?a=$(echo INJECTED)",
    // Windows command separator, inside the authority
    "http://x&calc",
  ];

  const PLATFORMS = [
    { platform: "win32", bin: "rundll32" },
    { platform: "darwin", bin: "open" },
    { platform: "linux", bin: "xdg-open" },
  ] as const;

  function openOn(platform: string, url: string): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      openBrowser(url);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  }

  beforeEach(() => {
    execFileMock.mockClear();
  });

  it("VT-12: a payload that parses reaches the opener as ONE argv entry, with no shell", () => {
    for (const { platform, bin } of PLATFORMS) {
      for (const payload of PARSES_BUT_HARMLESS_AS_ARGV) {
        execFileMock.mockClear();
        openOn(platform, payload);

        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
        expect(file).toBe(bin);
        // No interpreter, and no `-c` / `/c` that would turn an argument into a
        // command line. The old code passed a single string to a shell; this
        // passes a vector to an executable.
        expect(file).not.toMatch(/^(sh|bash|cmd|cmd\.exe|powershell|pwsh)$/);
        expect(args).not.toContain("-c");
        expect(args).not.toContain("/c");
        // The payload is exactly one argument — nothing was split on `;`, `&`
        // or `$( )`.
        const urlArgs = args.filter((a) => a.includes("x"));
        expect(urlArgs).toHaveLength(1);
      }
    }
  });

  it("VT-12b: the Windows branch is rundll32, NOT `cmd /c start`", () => {
    // `cmd /c start` was the first proposed fix and does not close the hole:
    // libuv quotes an argv entry only when it contains a space, tab or quote,
    // so `http://x&calc` reaches cmd.exe unquoted and `&` still separates.
    // Verified by the audit's own isolated verifier before this was written.
    openOn("win32", "http://x&calc");

    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("rundll32");
    expect(args[0]).toBe("url.dll,FileProtocolHandler");
  });

  it("VT-12c: the quote-bearing payloads never reach a spawn at all", () => {
    // `new URL()` rejects these — the quote is illegal in the authority. Not the
    // load-bearing defence (VT-12 is), but worth pinning: it is the reason the
    // reproduced POSIX and cmd.exe payloads die before any platform branch runs.
    for (const payload of UNPARSEABLE) {
      expect(() => new URL(payload)).toThrow();
      execFileMock.mockClear();
      openOn("linux", payload);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it("VT-13: a non-http(s) scheme spawns nothing", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://evil.example/x"]) {
      execFileMock.mockClear();
      openOn("linux", url);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it("VT-13b: a legitimate https URL still opens", () => {
    // The whole point is that the feature keeps working.
    openOn("darwin", "https://registry.example/device?user_code=WXYZ-3456");
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("open");
    expect(args[0]).toBe("https://registry.example/device?user_code=WXYZ-3456");
  });
});
