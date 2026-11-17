import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliExit } from "../utils/exit.js";
import { registerDevCommand } from "./dev.js";

// The command watches SKILL.md and agent.yaml. The watchers are recorded here
// instead of being armed on the disk, so a test fires one when it chooses.
const { watchers } = vi.hoisted(() => ({
  watchers: new Map<string, (event: string, file: string) => unknown>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn((path: string, listener: (event: string, file: string) => unknown) => {
      watchers.set(basename(path), listener);
      return { close: () => {} };
    }),
  };
});

let agentDir: string;
let blocker: Server | undefined;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "skrun-dev-test-"));
  watchers.clear();
});

afterEach(async () => {
  const held = blocker;
  blocker = undefined;
  if (held) await new Promise<void>((resolve) => held.close(() => resolve()));
  rmSync(agentDir, { recursive: true, force: true });
});

function writeIn(relativePath: string, content: string): void {
  const full = join(agentDir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** A port some other server already holds. */
async function takenPort(): Promise<number> {
  const server = createServer();
  blocker = server;
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("skrun dev — a port in use ends the command, not the process", () => {
  it("says the port is in use, once, and ends with 1 by throwing", async () => {
    writeIn("SKILL.md", "---\nname: dev-fixture\ndescription: A dev server fixture.\n---\n\n# D\n");
    writeIn(
      "agent.yaml",
      [
        "name: dev-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        "  - name: q",
        "    type: string",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "",
      ].join("\n"),
    );
    const port = await takenPort();
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
    registerDevCommand(program);
    let exitCode: number | undefined;
    try {
      await program.parseAsync(["dev", "--port", String(port)], { from: "user" });
    } catch (err) {
      if (err instanceof CliExit) exitCode = err.code;
      else if (!(err instanceof CommanderError)) throw err;
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
    // An exit called from the server's error event would land after the
    // command returned: give it the time to, before looking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const processExitCalls = exit.mock.calls.length;
    exit.mockRestore();

    expect(processExitCalls).toBe(0);
    expect(exitCode).toBe(1);
    expect(lines.filter((line) => line.includes(`Port ${port} is in use`))).toHaveLength(1);
  });
});

/** A port free a moment ago: held by a server of this test, then given back. */
async function freedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("skrun dev — POST /run reads the agent's input under input, as the API does", () => {
  const NOT_AN_OBJECT =
    'The request body must be a JSON object with an "input" field, e.g. {"input": {"query": "hello"}}.';
  const NO_INPUT =
    'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.';
  const INPUT_NULL =
    '"input" is null: send the agent\'s input as an object, e.g. {"input": {"query": "hello"}}.';

  type Post = (bodyText: string) => Promise<{ status: number; body: unknown }>;

  /**
   * Starts the command's server for an agent with these inputs — by default
   * one required input, `q` —, on a port the test freed, hands `use` a way to
   * POST /run, then stops the server through the command's own signal handler.
   */
  async function withDevServer(
    use: (post: Post) => Promise<void>,
    inputs: string[] = ["  - name: q", "    type: string"],
  ): Promise<void> {
    writeIn("SKILL.md", "---\nname: dev-fixture\ndescription: A dev server fixture.\n---\n\n# D\n");
    writeIn(
      "agent.yaml",
      [
        "name: dev-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        ...inputs,
        "outputs:",
        "  - name: answer",
        "    type: string",
        "",
      ].join("\n"),
    );
    const port = await freedPort();
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(parts.map(String).join(" "));
    };
    const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir);
    const log = vi.spyOn(console, "log").mockImplementation(record);
    const error = vi.spyOn(console, "error").mockImplementation(record);
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitCalled(Number(code ?? 0));
    });
    const program = new Command();
    program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
    registerDevCommand(program);
    const post: Post = async (bodyText) => {
      const res = await fetch(`http://127.0.0.1:${port}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      // The command returns once its server listens.
      await program.parseAsync(["dev", "--port", String(port)], { from: "user" });
      await use(post);
    } finally {
      // Stop the server through the command's own signal handler, then drop
      // the handlers it added to this process.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (signals[signal].includes(listener)) continue;
          if (signal === "SIGINT") {
            try {
              (listener as () => void)();
            } catch {
              // It closes the server, then calls the stubbed process.exit, which throws.
            }
          }
          process.removeListener(signal, listener);
        }
      }
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  }

  it("refuses a body without input 400 INVALID_REQUEST, in the API's words, and runs the input sent under input", async () => {
    await withDevServer(async (post) => {
      for (const [bodyText, message] of [
        ['{"q":"x"}', NO_INPUT],
        ["{}", NO_INPUT],
        ['{"input":null,"q":"x"}', INPUT_NULL],
        ["5", NOT_AN_OBJECT],
        ["[1]", NOT_AN_OBJECT],
      ] as const) {
        expect({ bodyText, ...(await post(bodyText)) }).toEqual({
          bodyText,
          status: 400,
          body: { error: { code: "INVALID_REQUEST", message } },
        });
      }

      const ran = await post('{"input":{"q":"x"}}');
      expect(ran.status).toBe(200);
      expect(ran.body).toMatchObject({ status: "completed" });
    });
  });

  it("refuses an input that is a number, a string or a boolean 400 INVALID_INPUT_TYPE, the type named in the API's words", async () => {
    await withDevServer(async (post) => {
      for (const [bodyText, type] of [
        ['{"input":5}', "number"],
        ['{"input":"x"}', "string"],
        ['{"input":true}', "boolean"],
      ] as const) {
        expect({ bodyText, ...(await post(bodyText)) }).toEqual({
          bodyText,
          status: 400,
          body: {
            error: { code: "INVALID_INPUT_TYPE", message: `Input expected object, got ${type}` },
          },
        });
      }
    });
  });

  it("refuses an input that misses a required input 400 MISSING_INPUT, naming it in the API's words — an array input misses it too", async () => {
    await withDevServer(async (post) => {
      for (const bodyText of ['{"input":{}}', '{"input":{"other":"x"}}', '{"input":[1]}']) {
        expect({ bodyText, ...(await post(bodyText)) }).toEqual({
          bodyText,
          status: 400,
          body: { error: { code: "MISSING_INPUT", message: "Missing required input: q" } },
        });
      }
    });
  });

  it("judges each input the agent declares as the API does, in its order and its words: its absence, then its type", async () => {
    await withDevServer(
      async (post) => {
        for (const [bodyText, error] of [
          [
            '{"input":{"a":5}}',
            { code: "INVALID_INPUT_TYPE", message: 'Input "a" expected string, got number' },
          ],
          ['{"input":{"b":"x"}}', { code: "MISSING_INPUT", message: "Missing required input: a" }],
          ['{"input":{"a":"x"}}', { code: "MISSING_INPUT", message: "Missing required input: b" }],
          [
            '{"input":{"a":"x","b":true}}',
            { code: "INVALID_INPUT_TYPE", message: 'Input "b" expected string, got boolean' },
          ],
        ] as const) {
          expect({ bodyText, ...(await post(bodyText)) }).toEqual({
            bodyText,
            status: 400,
            body: { error },
          });
        }

        const ran = await post('{"input":{"a":"x","b":"y"}}');
        expect(ran.status).toBe(200);
      },
      ["  - name: a", "    type: string", "  - name: b", "    type: string"],
    );
  });

  it.each([
    ["toString", '{"input":{}}'],
    ["filter", '{"input":[1]}'],
  ])("counts a required input named %s present only as the input's own field, never one its prototype carries: 400 MISSING_INPUT", async (name, bodyText) => {
    await withDevServer(
      async (post) => {
        expect(await post(bodyText)).toEqual({
          status: 400,
          body: { error: { code: "MISSING_INPUT", message: `Missing required input: ${name}` } },
        });
      },
      [`  - name: ${name}`, "    type: string"],
    );
  });

  it("serves an optional input named toString that the input does not carry as a field of its own: the prototype's is none of the agent's inputs", async () => {
    await withDevServer(
      async (post) => {
        const ran = await post('{"input":{}}');
        expect({ status: ran.status, body: ran.body }).toMatchObject({
          status: 200,
          body: { status: "completed" },
        });
      },
      ["  - name: toString", "    type: string", "    required: false"],
    );
  });

  it("judges a required file input's absence as the API does — no field of its own, null, an empty list —, never its content: it reads no file", async () => {
    await withDevServer(
      async (post) => {
        for (const bodyText of ['{"input":{}}', '{"input":{"doc":null}}', '{"input":{"doc":[]}}']) {
          expect({ bodyText, ...(await post(bodyText)) }).toEqual({
            bodyText,
            status: 400,
            body: { error: { code: "MISSING_INPUT", message: "Missing required input: doc" } },
          });
        }
        // Present, whatever its value: what a file input holds is judged by
        // the API when it reads the file, which this server never does.
        expect((await post('{"input":{"doc":5}}')).status).toBe(200);
      },
      ["  - name: doc", "    type: file", "    media: document"],
    );
  });

  it("refuses a required string input sent as null 400 MISSING_INPUT, as the API does, and serves an optional one sent as null", async () => {
    await withDevServer(
      async (post) => {
        expect(await post('{"input":{"q":null,"o":"x"}}')).toEqual({
          status: 400,
          body: { error: { code: "MISSING_INPUT", message: "Missing required input: q" } },
        });
        const ran = await post('{"input":{"q":"x","o":null}}');
        expect({ status: ran.status, body: ran.body }).toMatchObject({
          status: 200,
          body: { status: "completed" },
        });
      },
      ["  - name: q", "    type: string", "  - name: o", "    type: string", "    required: false"],
    );
  });
});

describe("skrun dev — a reload prints the validation warnings", () => {
  const agentYaml = (extra: string[] = []): string =>
    [
      "name: dev-fixture",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
      ...extra,
      "",
    ].join("\n");

  it("prints the warning an edited agent.yaml now draws, when it reloads", async () => {
    writeIn("SKILL.md", "---\nname: dev-fixture\ndescription: A dev server fixture.\n---\n\n# D\n");
    writeIn("agent.yaml", agentYaml());
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(parts.map(String).join(" "));
    };
    const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir);
    const log = vi.spyOn(console, "log").mockImplementation(record);
    const error = vi.spyOn(console, "error").mockImplementation(record);
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitCalled(Number(code ?? 0));
    });
    const program = new Command();
    program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
    registerDevCommand(program);
    try {
      // Any free port: the command returns once its server listens.
      await program.parseAsync(["dev", "--port", "0"], { from: "user" });
      const started = lines.length;
      expect(lines.some((line) => line.includes("RETIRED_FIELD"))).toBe(false);

      writeIn("agent.yaml", agentYaml(["environment:", "  sandbox: strict"]));
      await watchers.get("agent.yaml")?.("change", "agent.yaml");

      const reloaded = lines.slice(started).join("\n");
      expect(reloaded).toContain("Reloaded — agent.yaml changed");
      expect(reloaded).toContain("RETIRED_FIELD");
      expect(reloaded).toContain("environment.sandbox");
    } finally {
      // Stop the server through the command's own signal handler, then drop
      // the handlers it added to this process.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (signals[signal].includes(listener)) continue;
          if (signal === "SIGINT") {
            try {
              (listener as () => void)();
            } catch {
              // It closes the server, then calls the stubbed process.exit, which throws.
            }
          }
          process.removeListener(signal, listener);
        }
      }
      cwd.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });
});
