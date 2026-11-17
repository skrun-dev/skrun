import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { buildProgram } from "./program.js";
import {
  type ThrowawayProfile,
  useThrowawayProfile,
  writeSession,
  writeSignInFile,
} from "./test-profile.shared.js";
import { parseSessionFile } from "./utils/auth.js";
import { CliExit } from "./utils/exit.js";

/**
 * A token reaches only the server it was obtained from, seen through the
 * commands themselves: each case runs the real command tree (the one the binary
 * parses) in a throwaway profile, and records every request the CLI sends —
 * where it goes, and the Authorization it carries.
 *
 * No browser is opened (the opener is mocked) and no prompt is answered (one
 * asked fails the case).
 */

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("./utils/prompts.js", () => ({
  askText: () => Promise.reject(new Error("no prompt is expected here")),
  askTextOrCancel: () => Promise.reject(new Error("no prompt is expected here")),
  askModel: () => Promise.reject(new Error("no prompt is expected here")),
  canPrompt: () => true,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One request the CLI sent, as the server sees it. */
interface Sent {
  method: string;
  url: string;
  authorization: string | null;
}

/**
 * What a simulated server answers to a request; throwing is no answer at all.
 * It may also hand the request, as the CLI made it, to the real network.
 */
type Answer = (url: string, method: string, init?: RequestInit) => Response | Promise<Response>;

/** The network itself: the fetch in place before any case replaced it. */
const realFetch = globalThis.fetch;

interface Run {
  /** What the command printed through the console and commander, colours stripped. */
  lines: string[];
  /** What it wrote to stdout directly (the result of a run). */
  stdout: string;
  /** The code the command ended with; undefined when it succeeded. */
  exitCode: number | undefined;
  requests: Sent[];
}

class ProcessExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Every command of the tree, the root first. */
function allCommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap(allCommands)];
}

/**
 * Run `skrun <args>` through the real command tree, in the throwaway profile
 * the case set up: fetch is replaced by a recorder that answers with `answer`,
 * the output is captured, and neither commander nor the command may end the
 * test process. `cwd` is the directory the command runs in.
 */
async function skrun(
  args: string[],
  answer: Answer = () => Response.json({}),
  opts: { cwd?: string } = {},
): Promise<Run> {
  // The command reads and writes the sign-in file: never anywhere but a throwaway profile.
  if (!basename(homedir()).startsWith("skrun-cli-profile-")) {
    throw new Error("skrun() runs only in a throwaway profile (useThrowawayProfile first)");
  }
  const run: Run = { lines: [], stdout: "", exitCode: undefined, requests: [] };
  const record = (...parts: unknown[]): void => {
    run.lines.push(stripVTControlCharacters(parts.map(String).join(" ")));
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      run.requests.push({
        method,
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return answer(url, method, init);
    }),
  );
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      run.stdout += String(chunk);
      return true;
    }),
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ProcessExitCalled(Number(code ?? 0));
    }),
    ...(opts.cwd === undefined ? [] : [vi.spyOn(process, "cwd").mockReturnValue(opts.cwd)]),
  ];
  const program = buildProgram();
  for (const command of allCommands(program)) {
    command.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  }
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) run.exitCode = err.code;
    else if (err instanceof CommanderError) run.exitCode = err.exitCode;
    else throw err;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return run;
}

/** The sign-in file of the profile, read back as the CLI reads it; undefined when there is none. */
function signInFile(profile: ThrowawayProfile): ReturnType<typeof parseSessionFile> | undefined {
  return existsSync(profile.file)
    ? parseSessionFile(readFileSync(profile.file, "utf-8"))
    : undefined;
}

/** A server whose browser sign-in grants `token` for `username` at the first poll. */
function browserSignIn(token: string, username: string): Answer {
  return (url) => {
    const { origin, pathname } = new URL(url);
    if (pathname === "/auth/device/code") {
      return Response.json({
        device_code: "dc",
        user_code: "WXYZ-3456",
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=WXYZ-3456`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (pathname === "/auth/device/token") return Response.json({ token, username });
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  };
}

/** The answer to a streamed run: a run that completes. */
function completedRun(): Response {
  const events = [
    {
      type: "run_start",
      run_id: "r1",
      timestamp: "t",
      agent: "alice/agent",
      agent_version: "1.0.0",
    },
    {
      type: "run_complete",
      run_id: "r1",
      timestamp: "t",
      output: { answer: "ok" },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: { estimated: 0 },
      duration_ms: 3,
      files: [],
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * A server that answers what the commands of these cases ask: its profile
 * (for `namespace`), a run, a push, the caller's keys. Anything else is a 404.
 */
function server(namespace: string): Answer {
  return (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json({ namespace });
    if (path.endsWith("/run")) return completedRun();
    if (path.endsWith("/push")) return Response.json({ name: "probe-agent", versions: ["1.0.0"] });
    if (path === "/api/keys") return Response.json([]);
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  };
}

/** A directory holding a valid agent and its built bundle, removed when the case ends. */
function agentToPush(): string {
  const dir = mkdtempSync(join(tmpdir(), "skrun-isolation-agent-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const write = (relativePath: string, content: string): void => {
    mkdirSync(join(dir, relativePath, ".."), { recursive: true });
    writeFileSync(join(dir, relativePath), content);
  };
  write("SKILL.md", "---\nname: probe-agent\ndescription: A probe.\n---\n\n# Probe\n");
  write(
    "agent.yaml",
    [
      "name: probe-agent",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-5-5",
      "inputs:",
      "  - name: query",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "",
    ].join("\n"),
  );
  write("probe-agent-1.0.0.agent", "bundle-bytes");
  return dir;
}

const RUN = ["run", "alice/agent", "-i", '{"query":"hello"}'];
const PUSH = ["push"];
const KEYS_LIST = ["keys", "list"];

describe("signing in to a server, then calling it: every request goes there, with its token", () => {
  it("login --registry A --token, then run, push and keys list: each request goes to A with that token, and the file holds A in its normalized form", async () => {
    const profile = useThrowawayProfile();
    const agentDir = agentToPush();
    const A = "https://a.example";

    const login = await skrun(
      ["login", "--registry", "HTTPS://A.example:443/", "--token", "skrun_sk_a"],
      server("alice"),
    );
    expect(login.lines).toEqual([`✓ Logged in to ${A} as alice`]);
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: { [A]: { token: "skrun_sk_a", username: "alice" } },
      },
    });

    const calls = [
      await skrun(RUN, server("alice")),
      await skrun(PUSH, server("alice"), { cwd: agentDir }),
      await skrun(KEYS_LIST, server("alice")),
    ];

    expect(calls.map((call) => call.exitCode)).toEqual([undefined, undefined, undefined]);
    const requests = [login, ...calls].flatMap((call) => call.requests);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${A}/api/me`,
      `POST ${A}/api/agents/alice/agent/run`,
      `POST ${A}/api/agents/alice/probe-agent/push?version=1.0.0`,
      `GET ${A}/api/me`,
      `GET ${A}/api/keys`,
    ]);
    expect(requests.map((request) => request.authorization)).toEqual(
      requests.map(() => "Bearer skrun_sk_a"),
    );
  });
});

describe("a sign-in file this CLI cannot use sends nothing, and logout removes it sending nothing", () => {
  const OLDER = "✗ Signed in with an older CLI — sign in again: skrun login --registry <url>";
  const UNREADABLE =
    "✗ The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>";

  it.each([
    ["an older CLI's file holding a token", { token: "older-token" }, OLDER],
    [
      "an older CLI's file holding a token and an address",
      { token: "older-token", registry_url: "https://a.example" },
      OLDER,
    ],
    ["a file that cannot be read", '{ "token": "older-token", ', UNREADABLE],
  ] as Array<
    [string, unknown, string]
  >)("%s: run, push and keys list refuse, sending no request; logout removes it, sending none", async (_what, content, refusal) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    const before = readFileSync(profile.file, "utf-8");

    for (const args of [RUN, PUSH, KEYS_LIST]) {
      const call = await skrun(args, server("alice"));
      expect({ args, lines: call.lines, exitCode: call.exitCode, requests: call.requests }).toEqual(
        { args, lines: [refusal], exitCode: 1, requests: [] },
      );
    }
    expect(readFileSync(profile.file, "utf-8")).toBe(before);

    const logout = await skrun(["logout"], server("alice"));
    expect(logout.lines).toEqual(["✓ Removed the sign-in saved by an older CLI."]);
    expect(logout.requests).toEqual([]);
    expect(existsSync(profile.file)).toBe(false);
  });

  it.each([
    ["an older CLI's file", { token: "older-token", registry_url: "https://a.example" }],
    ["a file that cannot be read", '{ "token": "older-token", '],
  ] as Array<
    [string, unknown]
  >)("%s, SKRUN_REGISTRY_URL naming B: the sign-in the refusal advises, followed as printed, signs in to B and makes no server the current one", async (_what, content) => {
    const B = "https://b.example";
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const refused = await skrun(RUN, server("alice"));
    expect(refused.exitCode).toBe(1);
    expect(refused.requests).toEqual([]);
    // The command the refusal advises, as printed, less a closing remark in
    // brackets; an address to fill in, `<url>`, filled with the one the variable names.
    const advised = /sign in again: (skrun [^(]*?)\s*(?:\([^)]*\))?$/.exec(
      refused.lines[0] ?? "",
    )?.[1];
    expect(advised).toBeDefined();

    const signIn = await skrun(
      (advised as string).replace("<url>", B).split(" ").slice(1),
      browserSignIn("token-b", "bob"),
    );
    expect(signIn.lines.at(-1)).toBe(`✓ Logged in to ${B} as bob`);
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b", username: "bob" } } },
    });
  });
});

describe("SKRUN_REGISTRY_URL names the server: it gets its own token, or no request at all", () => {
  const A = "https://a.example";
  const B = "https://b.example";

  it("a token saved for A, the variable naming B, which has no session: run, push and keys list refuse naming B, and no request leaves", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    for (const args of [RUN, PUSH, KEYS_LIST]) {
      const call = await skrun(args, server("alice"));
      expect({ args, lines: call.lines, exitCode: call.exitCode, requests: call.requests }).toEqual(
        {
          args,
          lines: [
            `✗ Not logged in to ${B}. Sign in: skrun login (SKRUN_REGISTRY_URL names this server)`,
          ],
          exitCode: 1,
          requests: [],
        },
      );
    }
  });

  it("A the current server, the variable naming B, which has no session: the sign-in the refusal advises, typed as it is, signs in to B and leaves A the current server — without the variable, a run goes to A with A's token", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const refused = await skrun(RUN, server("alice"));
    expect(refused.exitCode).toBe(1);
    expect(refused.requests).toEqual([]);
    // The command the refusal advises, as printed, less a closing remark in brackets.
    const advised = /Sign in: (skrun [^(]*?)\s*(?:\([^)]*\))?$/.exec(refused.lines[0] ?? "")?.[1];
    expect(advised).toBeDefined();

    const signIn = await skrun(
      (advised as string).split(" ").slice(1),
      browserSignIn("token-b", "bob"),
    );
    expect(signIn.lines.at(-1)).toBe(`✓ Logged in to ${B} as bob`);
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
    const elsewhere = await skrun(RUN, server("alice"));
    expect(elsewhere.requests).toEqual([
      { method: "POST", url: `${A}/api/agents/alice/agent/run`, authorization: "Bearer token-a" },
    ]);
  });

  it("sessions for A, the current one, and for B, the variable naming B: each request goes to B with B's token, never A's", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: {
        [A]: { token: "token-a", username: "alice" },
        [B]: { token: "token-b", username: "bob" },
      },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const calls = [await skrun(RUN, server("bob")), await skrun(KEYS_LIST, server("bob"))];

    expect(calls.map((call) => call.exitCode)).toEqual([undefined, undefined]);
    expect(calls.flatMap((call) => call.requests)).toEqual([
      { method: "POST", url: `${B}/api/agents/alice/agent/run`, authorization: "Bearer token-b" },
      { method: "GET", url: `${B}/api/keys`, authorization: "Bearer token-b" },
    ]);
  });
});

/** The eleven commands that talk to a server, each with arguments that reach it. */
const NETWORK_COMMANDS: Array<[string, string[]]> = [
  ["deploy", ["deploy"]],
  ["push", PUSH],
  ["run", RUN],
  ["pull", ["pull", "alice/agent"]],
  ["logs", ["logs", "alice/agent"]],
  ["keys list", KEYS_LIST],
  ["llm-key list", ["llm-key", "list", "--agent", "alice/agent"]],
  ["verify", ["verify", "alice/agent@1.0.0"]],
  ["unverify", ["unverify", "alice/agent@1.0.0"]],
  ["visibility", ["visibility", "alice/agent", "private"]],
  ["whoami", ["whoami"]],
];

/**
 * The ways a command can be pointed at a server B that holds no session, while
 * a token is saved for A: by the variable (A the current server), by a current
 * server written by hand with no session behind it, and by the default (no
 * current server, a session for A only). With each, the sign-in the refusal
 * advises: under the variable, one that names no address — `--registry` would
 * make that server the current one.
 */
const ELSEWHERE: Array<{
  how: string;
  target: string;
  advised: string;
  arrange: (profile: ThrowawayProfile) => void;
}> = [
  {
    how: "SKRUN_REGISTRY_URL",
    target: "https://b.example",
    advised: "skrun login (SKRUN_REGISTRY_URL names this server)",
    arrange: (profile) => {
      writeSession(profile, { address: "https://a.example", token: "token-a", username: "alice" });
      vi.stubEnv("SKRUN_REGISTRY_URL", "https://b.example");
    },
  },
  {
    how: "a current server with no session",
    target: "https://b.example",
    advised: "skrun login --registry https://b.example",
    arrange: (profile) =>
      writeSignInFile(profile, {
        version: 2,
        current: "https://b.example",
        sessions: { "https://a.example": { token: "token-a", username: "alice" } },
      }),
  },
  {
    how: "the default",
    target: "http://localhost:4000",
    advised: "skrun login --registry http://localhost:4000",
    arrange: (profile) =>
      writeSession(profile, {
        address: "https://a.example",
        token: "token-a",
        username: "alice",
        current: false,
      }),
  },
];

describe("a token saved for one server never reaches another, whatever names the other", () => {
  it.each(
    NETWORK_COMMANDS.flatMap(([command, args]) =>
      ELSEWHERE.map((way) => ({ command, args, ...way })),
    ),
  )("$command, the server named by $how: no request at all, the refusal names it", async ({
    command,
    args,
    target,
    advised,
    arrange,
  }) => {
    const profile = useThrowawayProfile();
    arrange(profile);
    const before = readFileSync(profile.file, "utf-8");

    const call = await skrun(args, server("alice"));

    expect(call.requests).toEqual([]);
    expect(call.exitCode).toBe(1);
    expect(call.lines).toEqual(
      command === "whoami"
        ? [`ℹ Registry:  ${target}`, `✗ Not logged in. Sign in: ${advised}`]
        : [`✗ Not logged in to ${target}. Sign in: ${advised}`],
    );
    expect(readFileSync(profile.file, "utf-8")).toBe(before);
  });

  it.each([
    [
      "a session saved under https://a.example/, the variable naming https://a.example",
      { version: 2, sessions: { "https://a.example/": { token: "token-a" } } },
      "https://a.example",
    ],
    [
      "a session saved under https://a.example, the variable naming https://a.example/",
      { version: 2, sessions: { "https://a.example": { token: "token-a" } } },
      "https://a.example/",
    ],
    [
      "a session saved under https://a.example, the current server written https://a.example/",
      {
        version: 2,
        current: "https://a.example/",
        sessions: { "https://a.example": { token: "token-a" } },
      },
      undefined,
    ],
  ] as Array<
    [string, unknown, string | undefined]
  >)("%s: that server gets its token, however its address is written", async (_what, content, variable) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    if (variable !== undefined) vi.stubEnv("SKRUN_REGISTRY_URL", variable);

    const call = await skrun(KEYS_LIST, server("alice"));

    expect(call.exitCode).toBeUndefined();
    expect(call.requests).toEqual([
      { method: "GET", url: "https://a.example/api/keys", authorization: "Bearer token-a" },
    ]);
  });
});

describe("two sessions, two accounts", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  /** Each server names the account of the token it receives: alice at A, bob at B. */
  const twoServers: Answer = (url) =>
    Response.json({ namespace: new URL(url).origin === A ? "alice" : "bob" });

  it("each server is asked its own namespace, with its own token, and keeps it; logout of the current one leaves none current, the other session intact", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });

    const atA = await skrun(["whoami"], twoServers);
    vi.stubEnv("SKRUN_REGISTRY_URL", B);
    const atB = await skrun(["whoami"], twoServers);
    vi.stubEnv("SKRUN_REGISTRY_URL", undefined);

    expect([atA.lines, atB.lines]).toEqual([
      ["ℹ Namespace: alice", `ℹ Registry:  ${A}`],
      ["ℹ Namespace: bob", `ℹ Registry:  ${B}`],
    ]);
    expect([...atA.requests, ...atB.requests]).toEqual([
      { method: "GET", url: `${A}/api/me`, authorization: "Bearer token-a" },
      { method: "GET", url: `${B}/api/me`, authorization: "Bearer token-b" },
    ]);
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

    const logout = await skrun(["logout"], twoServers);
    expect(logout.lines).toEqual([`✓ Logged out of ${A}.`]);
    expect(logout.requests).toEqual([]);
    expect(signInFile(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b", username: "bob" } } },
    });

    const afterLogout = await skrun(["whoami"], twoServers);
    expect(afterLogout.lines).toEqual([
      "ℹ Registry:  http://localhost:4000",
      "✗ Not logged in. Sign in: skrun login --registry http://localhost:4000",
    ]);
    expect(afterLogout.exitCode).toBe(1);
    vi.stubEnv("SKRUN_REGISTRY_URL", B);
    const stillAtB = await skrun(["whoami"], twoServers);
    expect(stillAtB.lines).toEqual(["ℹ Namespace: bob", `ℹ Registry:  ${B}`]);
    expect([...afterLogout.requests, ...stillAtB.requests]).toEqual([]);
  });
});

/** One request a real server received. */
interface Received {
  method: string;
  path: string;
  authorization: string | undefined;
  modelKey: string | undefined;
  body: string;
}

/** A real server on this machine: its address, and every request it received. */
interface Listener {
  address: string;
  received: Received[];
}

describe("a redirect carries neither token, model key nor body: its target receives nothing", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** A real server on 127.0.0.1, on a free port, that records each request and answers it with `reply`. */
  async function listen(reply: (res: ServerResponse) => void): Promise<Listener> {
    const received: Received[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({
          method: req.method ?? "",
          path: req.url ?? "",
          authorization: req.headers.authorization,
          modelKey: req.headers["x-llm-api-key"] as string | undefined,
          body,
        });
        reply(res);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { address: `http://127.0.0.1:${port}`, received };
  }

  /** A, which answers every request with `status` towards B; and B, which answers 200 to anything. */
  async function redirectingPair(status: number): Promise<{ A: Listener; B: Listener }> {
    const B = await listen((res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    const A = await listen((res) => {
      res.writeHead(status, { Location: `${B.address}/elsewhere` }).end();
    });
    return { A, B };
  }

  /** The refusal the CLI prints for A's redirect towards B. */
  const refusal = (A: Listener, B: Listener): string =>
    `The server at ${A.address} answered with a redirect to ${B.address}, which the CLI does not follow. To use that server: skrun login --registry ${B.address}`;

  /** The real network, through the CLI's recorder. */
  const network: Answer = (url, _method, init) => realFetch(url, init);

  it.each([
    301, 302, 303, 307, 308,
  ])("skrun run with a model key and a body, A answering %i towards B: B receives no request, the refusal names B, exit 1", async (status) => {
    const profile = useThrowawayProfile();
    const { A, B } = await redirectingPair(status);
    writeSession(profile, { address: A.address, token: "token-a", username: "alice" });
    vi.stubEnv("GOOGLE_TEST_KEY", "model-key-under-test");

    const call = await skrun(
      ["run", "alice/agent", "-i", '{"query":"hello"}', "--llm-key-env", "google=GOOGLE_TEST_KEY"],
      network,
    );

    expect(B.received).toEqual([]);
    expect(A.received).toEqual([
      {
        method: "POST",
        path: "/api/agents/alice/agent/run",
        authorization: "Bearer token-a",
        modelKey: JSON.stringify({ google: "model-key-under-test" }),
        body: JSON.stringify({ input: { query: "hello" } }),
      },
    ]);
    expect(call.lines).toEqual([`✗ ${refusal(A, B)}`]);
    expect(call.exitCode).toBe(1);
  });

  it("skrun run, A named by SKRUN_REGISTRY_URL and answering 307 towards B on the same host: B receives no request, the refusal says to set the variable to B, exit 1", async () => {
    const profile = useThrowawayProfile();
    const { A, B } = await redirectingPair(307);
    writeSession(profile, { address: A.address, token: "token-a", username: "alice" });
    vi.stubEnv("SKRUN_REGISTRY_URL", A.address);

    const call = await skrun(["run", "alice/agent", "-i", '{"query":"hello"}'], network);

    expect(B.received).toEqual([]);
    expect(call.lines).toEqual([
      `✗ The server at ${A.address} answered with a redirect to ${B.address}, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to ${B.address}`,
    ]);
    expect(call.exitCode).toBe(1);
  });

  it.each([
    301, 302, 303, 307, 308,
  ])("skrun login --registry A, the browser sign-in, A answering %i towards B: B receives no request, the refusal names B, exit 1, nothing saved", async (status) => {
    const profile = useThrowawayProfile();
    const { A, B } = await redirectingPair(status);

    const call = await skrun(["login", "--registry", A.address], network);

    expect(B.received).toEqual([]);
    expect(
      A.received.map(({ method, path, authorization }) => ({ method, path, authorization })),
    ).toEqual([{ method: "POST", path: "/auth/device/code", authorization: undefined }]);
    expect(call.lines).toEqual([`✗ ${refusal(A, B)}`]);
    expect(call.exitCode).toBe(1);
    expect(signInFile(profile)).toBeUndefined();
  });
});
