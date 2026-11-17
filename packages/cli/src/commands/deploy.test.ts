import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packAgentTar, unpackAgentTar } from "@skrun-dev/schema";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession, writeSignInFile } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { registerDeployCommand } from "./deploy.js";
import { registerRunCommand } from "./run.js";

// A witness, starting like an API key and never a real one: whatever the
// command prints must not carry it.
const WITNESS_TOKEN = "skrun_sk_witness_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

// The command reads the sign-in file of a throwaway profile — a session for
// this server, with its namespace, as signing in writes it — and never the
// file of the machine running the tests.
const REGISTRY = "http://registry.test";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "skrun-deploy-test-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writeIn(relativePath: string, content: string): void {
  const full = join(agentDir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A valid agent that draws two warnings: a retired field in its agent.yaml,
 * and a script importing a package with no manifest to resolve it.
 */
function writeWarningAgent(): void {
  writeIn("SKILL.md", "---\nname: warn-fixture\ndescription: Draws two warnings.\n---\n\n# W\n");
  writeIn(
    "agent.yaml",
    [
      "name: warn-fixture",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      "  sandbox: strict",
      "",
    ].join("\n"),
  );
  writeIn("scripts/fetch.py", "import requests\n");
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface DeployCall {
  printed: string;
  /** The code the command ended with (its `CliExit`, or commander's); undefined when it succeeded. */
  exitCode: number | undefined;
  /** Whether anything called `process.exit()` — never, since commands end by throwing. */
  processExitCalled: boolean;
  requests: Array<{ url: string; method: string; body: unknown; authorization: string | null }>;
}

/**
 * Run `skrun <argv>` — `deploy`, or the `run` it prints — through the real
 * commands, from `agentDir`: fetch answers with `respond`, every output is
 * captured — the console, and anything written to stdout or stderr directly —
 * and neither commander nor the command may end the test process. Unless
 * `signedIn` is false (the case wrote its own sign-in file), the command reads
 * a throwaway profile signed in to REGISTRY.
 */
async function skrun(
  argv: string[],
  respond: (url: string, method: string) => Response,
  opts: { signedIn?: boolean } = {},
): Promise<DeployCall> {
  const call: DeployCall = {
    printed: "",
    exitCode: undefined,
    processExitCalled: false,
    requests: [],
  };
  const lines: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  if (opts.signedIn !== false) {
    writeSession(useThrowawayProfile(), {
      address: REGISTRY,
      token: WITNESS_TOKEN,
      username: "dev",
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      call.requests.push({
        url,
        method,
        body: init?.body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return respond(url, method);
    }),
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir);
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    record(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    record(chunk);
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerDeployCommand(program);
  registerRunCommand(program);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) call.exitCode = err.code;
    else if (err instanceof ExitCalled) {
      call.exitCode = err.code;
      call.processExitCalled = true;
    } else if (err instanceof CommanderError) call.exitCode = err.exitCode;
    else throw err;
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    error.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
  call.printed = lines.join("\n");
  return call;
}

/** Run `skrun deploy <args>`, signed in to REGISTRY. */
function skrunDeploy(
  args: string[],
  respond: (url: string, method: string) => Response,
): Promise<DeployCall> {
  return skrun(["deploy", ...args], respond);
}

/** The registry's answer to a push: the agent's metadata, one version. */
function pushed(): Response {
  return Response.json({ name: "warn-fixture", versions: ["1.0.0"] });
}

describe("skrun deploy — validation warnings are printed", () => {
  it("prints both warnings, by code, and still deploys", async () => {
    writeWarningAgent();

    const call = await skrunDeploy([], () => pushed());

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).toContain("RETIRED_FIELD");
    expect(call.printed).toContain("environment.sandbox");
    expect(call.printed).toContain("SCRIPTS_NO_MANIFEST");
    expect(call.printed).toContain("Pushed dev/warn-fixture@1.0.0");
  });
});

describe("skrun deploy — builds in its own process, from any directory", () => {
  it("builds the bundle and pushes it, from a directory outside the repository", async () => {
    writeWarningAgent();
    // The premise: nothing resolves a CLI relative to this directory.
    expect(existsSync(join(agentDir, "..", "..", "packages", "cli", "bin", "skrun.js"))).toBe(
      false,
    );

    const call = await skrunDeploy([], () => pushed());

    expect(call.printed).not.toContain("Build failed");
    expect(call.exitCode).toBeUndefined();
    expect(call.printed).toContain("Built warn-fixture-1.0.0.agent");
    expect(existsSync(join(agentDir, "warn-fixture-1.0.0.agent"))).toBe(true);
    const push = call.requests.find((r) => r.method === "POST" && r.url.includes("/push"));
    const body = push?.body as Uint8Array | undefined;
    // A gzipped tar: the bundle the build command produces.
    expect([body?.[0], body?.[1]]).toEqual([0x1f, 0x8b]);
  });
});

describe("skrun deploy — builds every time, from the agent.yaml it validated", () => {
  it("pushes a fresh build, never a bundle already on disk for that version", async () => {
    writeWarningAgent();
    // Built before agent.yaml was edited: the same name and version, older content.
    const stale = await packAgentTar([
      {
        name: "agent.yaml",
        content: Buffer.from("name: warn-fixture\nversion: 1.0.0\n# before the edit\n"),
      },
      { name: "SKILL.md", content: Buffer.from("# stale\n") },
    ]);
    writeFileSync(join(agentDir, "warn-fixture-1.0.0.agent"), stale);

    const call = await skrunDeploy([], () => pushed());

    expect(call.exitCode).toBeUndefined();
    const push = call.requests.find((r) => r.method === "POST" && r.url.includes("/push"));
    const entries = await unpackAgentTar(Buffer.from(push?.body as Uint8Array), {
      maxBytes: 1024 * 1024,
    });
    const sent = entries.find((e) => e.name === "agent.yaml")?.content.toString("utf-8");
    expect(sent).toBe(readFileSync(join(agentDir, "agent.yaml"), "utf-8"));
  });
});

describe("skrun deploy — never prints the token", () => {
  it("shows a placeholder where the token goes, and the token nowhere in its output", async () => {
    writeWarningAgent();

    const call = await skrunDeploy([], () => pushed());

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).not.toContain(WITNESS_TOKEN);
    expect(call.printed).toContain("  Auth: Bearer <your-token>");
  });
});

describe("skrun deploy — the closing note follows the server's verification policy", () => {
  /** The registry: the push is accepted, and GET /api/me says `me` (or fails). */
  function registry(me: Response): (url: string, method: string) => Response {
    return (url) => (url.endsWith("/api/me") ? me.clone() : pushed());
  }

  it("under admin, it says the version must be verified first — and never that it is live", async () => {
    writeWarningAgent();

    const call = await skrunDeploy(
      [],
      registry(Response.json({ verification_policy: "admin", role: "user" })),
    );

    expect(call.exitCode).toBeUndefined();
    expect({
      live: call.printed.includes("is live"),
      note: call.printed.includes(
        "An admin of this server must run `skrun verify dev/warn-fixture@1.0.0` before it can be called.",
      ),
    }).toEqual({ live: false, note: true });
  });

  it.each([
    ["owner", "can be called now. Verifying it is optional on this server"],
    ["disabled", "can be called now. This server does not gate runs on verification."],
  ])("under %s, the version is live, and the note says so", async (policy, note) => {
    writeWarningAgent();

    const call = await skrunDeploy(
      [],
      registry(Response.json({ verification_policy: policy, role: "user" })),
    );

    expect(call.printed).toContain("Your agent is live");
    expect(call.printed).toContain(note);
  });

  it("a server that does not say gets the generic reminder, and no claim that it is live", async () => {
    writeWarningAgent();

    const call = await skrunDeploy([], registry(new Response("not found", { status: 404 })));

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).toContain("(admin only) before it can be called");
    expect(call.printed).not.toContain("is live");
  });
});

describe("skrun deploy — a failure ends the command, not the process", () => {
  it("ends with 1 after a refused push, by throwing, and never calls process.exit", async () => {
    writeWarningAgent();
    const refused = (): Response =>
      Response.json(
        { error: { code: "VERSION_EXISTS", message: "Version 1.0.0 already exists" } },
        { status: 409 },
      );

    const call = await skrunDeploy([], refused);

    expect(call.processExitCalled).toBe(false);
    expect(call.exitCode).toBe(1);
    expect(call.printed).toContain("Push failed (409)");
  });
});

/** A valid agent, `try-fixture`: the given input declarations (agent.yaml lines), and its tests when given. */
function writeTryAgent(inputs: string[], tests: string[] = []): void {
  writeIn("SKILL.md", "---\nname: try-fixture\ndescription: An agent to try.\n---\n\n# T\n");
  writeIn(
    "agent.yaml",
    [
      "name: try-fixture",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-3.8-flash",
      "inputs:",
      ...inputs,
      "outputs:",
      "  - name: answer",
      "    type: string",
      ...tests,
      "",
    ].join("\n"),
  );
}

/** A required input, `query`, and an optional one, `n`. */
const QUERY_AND_N = [
  "  - name: query",
  "    type: string",
  "    required: true",
  "  - name: n",
  "    type: number",
  "    required: false",
];

/** The registry's answer to a streamed POST /run: a run that completes. */
function streamedRun(): Response {
  const events = [
    { type: "run_start", run_id: "r1", timestamp: "t", agent: "dev/try-fixture" },
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

/** The registry: a push accepted, `GET /api/me` saying the verification policy, a run streamed to its end. */
function registryWith(policy: "owner" | "admin"): (url: string, method: string) => Response {
  return (url) =>
    url.endsWith("/api/me")
      ? Response.json({ verification_policy: policy, role: "user" })
      : url.endsWith("/run")
        ? streamedRun()
        : pushed();
}

/** What deploy printed from `first` (a line it starts with) to its end. */
function printedFrom(printed: string, first: RegExp): string[] {
  const lines = printed.split("\n");
  const start = lines.findIndex((line) => first.test(line));
  return start < 0 ? [] : lines.slice(start);
}

/** The lines deploy prints to try the agent, its closing blank line left out. */
function tryIt(printed: string): string[] {
  const lines = printedFrom(printed, /^ {2}(Try it|Once the version can be called)/);
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The words of a command line as a POSIX shell splits them: blanks, '…' quoting, a backslash outside quotes. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`an unclosed quote in: ${line}`);
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === "\\") {
      i++;
      word = (word ?? "") + line.charAt(i);
    } else if (c === " ") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

describe("skrun deploy — the command it prints to try the agent", () => {
  it("prints two lines to try it, from a file then inline, with an example of the required input only — no token, no curl", async () => {
    writeTryAgent(QUERY_AND_N);

    const call = await skrunDeploy([], registryWith("owner"));

    expect(call.exitCode).toBeUndefined();
    expect(printedFrom(call.printed, /^ {2}🚀/)).toEqual([
      "  🚀 Deployed! Your agent is live:",
      "",
      "  POST http://registry.test/api/agents/dev/try-fixture/run",
      "  Auth: Bearer <your-token>",
      "",
      "  Try it — save this input as input.json:",
      '    {"query":"hello"}',
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      `    skrun run dev/try-fixture -i '{"query":"hello"}'`,
      "",
    ]);
    expect(call.printed).not.toContain(WITNESS_TOKEN);
    expect(call.printed).not.toContain("curl");
  });

  it("an agent with no required input: the example is an empty object", async () => {
    writeTryAgent(["  - name: n", "    type: number", "    required: false"]);

    const call = await skrunDeploy([], registryWith("owner"));

    expect(tryIt(call.printed)).toEqual([
      "  Try it — save this input as input.json:",
      "    {}",
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      "    skrun run dev/try-fixture -i '{}'",
    ]);
  });

  it("an agent with tests: the example is the input of its first test", async () => {
    writeTryAgent(QUERY_AND_N, [
      "tests:",
      "  - name: first",
      "    input:",
      "      query: what is an agent",
      "      n: 2",
      "    assert: output.answer != null",
      "  - name: second",
      "    input:",
      "      query: another",
      "    assert: output.answer != null",
    ]);

    const call = await skrunDeploy([], registryWith("owner"));

    expect(tryIt(call.printed)).toEqual([
      "  Try it — save this input as input.json:",
      '    {"query":"what is an agent","n":2}',
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      `    skrun run dev/try-fixture -i '{"query":"what is an agent","n":2}'`,
    ]);
  });

  it("each required input gets an example of its type; a required file input is left out, and named", async () => {
    writeTryAgent([
      "  - name: text",
      "    type: string",
      "  - name: count",
      "    type: number",
      "  - name: flag",
      "    type: boolean",
      "  - name: options",
      "    type: object",
      "  - name: items",
      "    type: array",
      "  - name: report",
      "    type: file",
      "    media: document",
      "  - name: note",
      "    type: string",
      "    required: false",
    ]);

    const call = await skrunDeploy([], registryWith("owner"));

    const lines = tryIt(call.printed);
    expect(lines).toEqual([
      "  Try it — save this input as input.json:",
      '    {"text":"hello","count":1,"flag":true,"options":{},"items":[]}',
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      `    skrun run dev/try-fixture -i '{"text":"hello","count":1,"flag":true,"options":{},"items":[]}'`,
      '  Not in this example: "report", which takes a file (a file_id, base64 data or a URL).',
    ]);
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      text: "hello",
      count: 1,
      flag: true,
      options: {},
      items: [],
    });
  });

  it("a required input the agent names __proto__ gets its example as any other: the input carries it", async () => {
    writeTryAgent([
      "  - name: __proto__",
      "    type: object",
      "  - name: query",
      "    type: string",
    ]);

    const call = await skrunDeploy([], registryWith("owner"));

    const lines = tryIt(call.printed);
    expect(lines.slice(0, 2)).toEqual([
      "  Try it — save this input as input.json:",
      '    {"__proto__":{},"query":"hello"}',
    ]);
    expect(Object.hasOwn(JSON.parse(lines[1] ?? ""), "__proto__")).toBe(true);
  });

  it("an agent with tests whose first test carries an input named __proto__: the example carries it, as the test does", async () => {
    writeTryAgent(
      ["  - name: __proto__", "    type: object", "  - name: query", "    type: string"],
      [
        "tests:",
        "  - name: named-proto",
        "    input:",
        "      __proto__:",
        "        a: 1",
        "      query: hi",
        "    assert: output.answer != null",
      ],
    );

    const call = await skrunDeploy([], registryWith("owner"));

    const lines = tryIt(call.printed);
    expect(lines.slice(0, 2)).toEqual([
      "  Try it — save this input as input.json:",
      '    {"__proto__":{"a":1},"query":"hi"}',
    ]);
    expect(Object.hasOwn(JSON.parse(lines[1] ?? ""), "__proto__")).toBe(true);
  });

  it("a quote in the example is escaped for the shell on the inline line, and left as it is in the file", async () => {
    writeTryAgent(QUERY_AND_N, [
      "tests:",
      "  - name: a quote",
      "    input:",
      `      query: "it's here"`,
      "    assert: output.answer != null",
    ]);

    const call = await skrunDeploy([], registryWith("owner"));

    const lines = tryIt(call.printed);
    expect(lines[1]).toBe(`    {"query":"it's here"}`);
    expect(lines[5]).toBe(`    skrun run dev/try-fixture -i '{"query":"it'\\''s here"}'`);
    // What a POSIX shell hands to skrun: the input, whole.
    expect(shellWords(lines[5] ?? "")).toEqual([
      "skrun",
      "run",
      "dev/try-fixture",
      "-i",
      `{"query":"it's here"}`,
    ]);
  });

  it("a version that cannot be called yet: the lines come under the sentence that says so", async () => {
    writeTryAgent(QUERY_AND_N);

    const call = await skrunDeploy([], registryWith("admin"));

    expect(call.exitCode).toBeUndefined();
    expect(tryIt(call.printed)).toEqual([
      "  Once the version can be called (see above), try it — save this input as input.json:",
      '    {"query":"hello"}',
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      `    skrun run dev/try-fixture -i '{"query":"hello"}'`,
    ]);
  });

  it("its lines name no server: run where the deploy ran, they go where it went — the server the variable names; without the variable, the current one", async () => {
    writeTryAgent(QUERY_AND_N);
    const A = "https://a.example";
    const B = "https://b.example";
    writeSignInFile(useThrowawayProfile(), {
      version: 2,
      current: A,
      sessions: {
        [A]: { token: "token-a", username: "dev" },
        [B]: { token: "token-b", username: "dev" },
      },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);

    const deployed = await skrun(["deploy"], registryWith("owner"), { signedIn: false });

    expect(deployed.exitCode).toBeUndefined();
    expect([...new Set(deployed.requests.map((r) => new URL(r.url).origin))]).toEqual([B]);
    const lines = tryIt(deployed.printed);
    expect(lines).toEqual([
      "  Try it — save this input as input.json:",
      '    {"query":"hello"}',
      "  then run:",
      "    skrun run dev/try-fixture -f input.json",
      "  or, in bash or zsh:",
      `    skrun run dev/try-fixture -i '{"query":"hello"}'`,
    ]);

    // The file the first line reads, saved with the input printed for it —
    // under a path this test can name, the line otherwise run as printed.
    const inputFile = join(agentDir, "input.json");
    writeFileSync(inputFile, (lines[1] ?? "").trim());
    const fromFile = shellWords(lines[3] ?? "")
      .slice(1)
      .map((word) => (word === "input.json" ? inputFile : word));
    const inline = shellWords(lines[5] ?? "").slice(1);
    const sent = (call: DeployCall) =>
      call.requests.map(({ method, url, authorization, body }) => ({
        method,
        url,
        authorization,
        body,
      }));
    const runAt = (server: string, token: string) => [
      {
        method: "POST",
        url: `${server}/api/agents/dev/try-fixture/run`,
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ input: { query: "hello" } }),
      },
    ];

    // In the same shell: the variable still names B.
    expect(sent(await skrun(fromFile, registryWith("owner"), { signedIn: false }))).toEqual(
      runAt(B, "token-b"),
    );
    expect(sent(await skrun(inline, registryWith("owner"), { signedIn: false }))).toEqual(
      runAt(B, "token-b"),
    );

    // In a shell without the variable: the current server.
    vi.stubEnv("SKRUN_REGISTRY_URL", undefined);
    expect(sent(await skrun(fromFile, registryWith("owner"), { signedIn: false }))).toEqual(
      runAt(A, "token-a"),
    );
    expect(sent(await skrun(inline, registryWith("owner"), { signedIn: false }))).toEqual(
      runAt(A, "token-a"),
    );
  });
});
