import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { validBundle } from "../routes/agent-bundle.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  AgentYamlReadAbandonedError,
  AgentYamlReader,
  AgentYamlReaderBusyError,
  AgentYamlReaderError,
} from "./agent-yaml-reader.js";
import { RegistryError, RegistryService } from "./registry.js";

// The logger factory is replaced by one that records every call: a case reads
// the lines a push wrote. vi.mock is hoisted above every import: what its
// factory reads is declared with vi.hoisted.
interface LoggedCall {
  level: string;
  args: unknown[];
}

const { logged } = vi.hoisted(() => ({ logged: [] as LoggedCall[] }));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const logger = (): unknown => {
    const write =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push({ level, args });
      };
    return {
      trace: write("trace"),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      fatal: write("fatal"),
      level: "info",
      child: () => logger(),
    };
  };
  return { ...actual, createLogger: () => logger() };
});

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * A valid agent.yaml whose read outlasts any budget of a test: an input's
 * default made of lines of 2,000 compact sequences (`- - - … 1`), up to the
 * 128 KB an agent.yaml may weigh. Its read took 2.5 to 4 s on the main thread
 * (Windows, 2026-11-16).
 */
function slowAgentYaml(name: string): string {
  let text = [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: anthropic",
    "  name: claude-sonnet-4-6",
    "outputs:",
    "  - name: a",
    "    type: string",
    "inputs:",
    "  - name: q",
    "    type: object",
    "    default:",
    "      l:",
    "",
  ].join("\n");
  const line = `        - ${"- ".repeat(2000)}1\n`;
  while (text.length + line.length <= 128 * 1024) text += line;
  return text;
}

const readStoppedLines = () =>
  logged.filter(
    ({ args: [fields] }) =>
      (fields as { event?: string } | undefined)?.event === "agent_yaml_read_stopped",
  );

// A push whose agent.yaml takes longer to read than its budget is refused —
// nothing stored —, with one log line; the reader's failure is no refusal.
describe("RegistryService.push — an agent.yaml too complex to read", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    logged.length = 0;
    storage = new MemoryStorage();
    db = new MemoryDb();
  });

  it("is refused, 400 INVALID_CONFIG, nothing stored, one warn line — the agent, its version, the budget", async () => {
    const service = new RegistryService(storage, db, new AgentYamlReader({ budgetMs: 250 }));
    const bundle = await validBundle("slow", slowAgentYaml("slow"));

    const refusal = await service.push("acme", "slow", "1.0.0", bundle, "user-1").catch((e) => e);

    expect(refusal).toBeInstanceOf(RegistryError);
    expect(refusal).toMatchObject({
      code: "INVALID_CONFIG",
      status: 400,
      message:
        "This bundle's agent.yaml is too complex to read: reading it took longer than 0.25 s, and the read was stopped. Simplify it and push it again.",
    });
    expect(await db.getAgent("acme", "slow")).toBeNull();
    expect(await storage.get("acme/slow/1.0.0.agent")).toBeNull();
    expect(readStoppedLines()).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "agent_yaml_read_stopped",
            agent: "acme/slow",
            agent_version: "1.0.0",
            budget_ms: 250,
          },
          "A pushed agent.yaml took longer to read than its budget: the read was stopped, the push refused",
        ],
      },
    ]);
  }, 15_000);

  it("writes no such line for an agent.yaml read within its budget", async () => {
    const service = new RegistryService(storage, db, new AgentYamlReader({ budgetMs: 250 }));
    const agentYaml = readFileSync(join(REPO_ROOT, "agents", "code-review", "agent.yaml"), "utf-8");
    const metadata = await service.push(
      "acme",
      "code-review",
      "1.0.0",
      await validBundle("code-review", agentYaml),
      "user-1",
    );
    expect(metadata.latest_version).toBe("1.0.0");
    expect(readStoppedLines()).toEqual([]);
  });

  it("throws the reader's failure as it is — no refusal of the push, nothing stored", async () => {
    const failing = {
      read: () => Promise.reject(new AgentYamlReaderError("The agent.yaml reader failed")),
    } as unknown as AgentYamlReader;
    const service = new RegistryService(storage, db, failing);

    const error = await service
      .push("acme", "any", "1.0.0", await validBundle("any"), "user-1")
      .catch((e) => e);

    expect(error).toBeInstanceOf(AgentYamlReaderError);
    expect(error).not.toBeInstanceOf(RegistryError);
    expect(await db.getAgent("acme", "any")).toBeNull();
    expect(readStoppedLines()).toEqual([]);
  });
});

// Before its read starts, a push can meet two ends that are not the file's: a
// line of reads as long as may wait — refused 503 PUSH_BUSY, to send again —,
// and its request aborted — the read dropped, nobody to answer.
describe("RegistryService.push — the reads that may wait, and a request aborted", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    logged.length = 0;
    storage = new MemoryStorage();
    db = new MemoryDb();
  });

  it("is refused 503 PUSH_BUSY with its Retry-After, nothing stored, one warn line — the agent, its version, how many may wait", async () => {
    const busy = {
      read: () => Promise.reject(new AgentYamlReaderBusyError(16)),
    } as unknown as AgentYamlReader;
    const service = new RegistryService(storage, db, busy);

    const refusal = await service
      .push("acme", "busy", "1.0.0", await validBundle("busy"), "user-1")
      .catch((e) => e);

    expect(refusal).toBeInstanceOf(RegistryError);
    expect(refusal).toMatchObject({
      code: "PUSH_BUSY",
      status: 503,
      retryAfterS: 3,
      message:
        "The server is busy with other pushes right now, and stored nothing of this one. Push it again in a few seconds.",
    });
    expect(refusal.cause).toBeInstanceOf(AgentYamlReaderBusyError);
    expect(await db.getAgent("acme", "busy")).toBeNull();
    expect(await storage.get("acme/busy/1.0.0.agent")).toBeNull();
    const busyLines = logged.filter(
      ({ args: [fields] }) => (fields as { event?: string } | undefined)?.event === "push_busy",
    );
    expect(busyLines).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "push_busy",
            agent: "acme/busy",
            agent_version: "1.0.0",
            waiting_at_most: 16,
          },
          "A push was refused 503: as many agent.yaml reads were waiting as may wait",
        ],
      },
    ]);
  });

  it("hands its request's signal to the read; a read dropped ends it as it is — nothing stored, no line", async () => {
    const given: (AbortSignal | undefined)[] = [];
    const dropping = {
      read: (_text: string, signal?: AbortSignal) => {
        given.push(signal);
        return Promise.reject(new AgentYamlReadAbandonedError());
      },
    } as unknown as AgentYamlReader;
    const service = new RegistryService(storage, db, dropping);
    const request = new AbortController();

    const error = await service
      .push(
        "acme",
        "gone",
        "1.0.0",
        await validBundle("gone"),
        "user-1",
        undefined,
        undefined,
        request.signal,
      )
      .catch((e) => e);

    expect(given).toEqual([request.signal]);
    expect(error).toBeInstanceOf(AgentYamlReadAbandonedError);
    expect(error).not.toBeInstanceOf(RegistryError);
    expect(await db.getAgent("acme", "gone")).toBeNull();
    expect(await storage.get("acme/gone/1.0.0.agent")).toBeNull();
    expect(logged).toEqual([]);
  });
});
