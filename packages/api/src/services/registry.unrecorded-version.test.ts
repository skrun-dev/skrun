import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { minimalAgentYaml, validBundle } from "../routes/agent-bundle.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import type { AgentYamlReader } from "./agent-yaml-reader.js";
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

const BUNDLE_KEY = "acme/agent/1.0.0.agent";

/** The `event` of every line logged, in order. */
const events = (): unknown[] =>
  logged.map(({ args: [fields] }) => (fields as { event?: unknown } | undefined)?.event);

/** What `push` threw — or `undefined` when it did not. */
async function pushError(
  service: RegistryService,
  bundle: Buffer,
  version = "1.0.0",
): Promise<unknown> {
  return service.push("acme", "agent", version, bundle, "user-1").then(
    () => undefined,
    (err: unknown) => err,
  );
}

/** The message of the refusal a push of `yaml` gets. */
async function refusalOf(yaml: string): Promise<string> {
  const err = await pushError(
    new RegistryService(new MemoryStorage(), new MemoryDb()),
    await validBundle("agent", yaml),
  );
  expect(err).toBeInstanceOf(RegistryError);
  expect((err as RegistryError).code).toBe("INVALID_CONFIG");
  return (err as RegistryError).message;
}

/** A minimal agent's agent.yaml, with one test whose `input` is the flow mapping `input`. */
const withTestInput = (input: string): string =>
  minimalAgentYaml("agent", ["tests:", "  - name: t", `    input: ${input}`, '    assert: "true"']);

// A version's object is stored before its row is written. When the row's
// write fails, the object is taken back — only when the store refused the
// write for certain, and the row is read absent: a write that throws may have
// committed all the same, and an object its row names must stay. Every way of
// not knowing keeps it, with a line naming its key.
describe("RegistryService.push — a version whose row is not written", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let service: RegistryService;
  let bundle: Buffer;
  const writeFailure = new Error("value refused");

  beforeEach(async () => {
    logged.length = 0;
    storage = new MemoryStorage();
    db = new MemoryDb();
    service = new RegistryService(storage, db);
    bundle = await validBundle("agent");
  });

  it("refused for certain, no row written: the object is deleted, and the write's own error is what the push throws", async () => {
    vi.spyOn(db, "createVersion").mockRejectedValueOnce(writeFailure);
    const unknown = vi.spyOn(db, "writeOutcomeUnknown");

    expect(await pushError(service, bundle)).toBe(writeFailure);
    expect(unknown).toHaveBeenCalledWith(writeFailure);
    expect(await storage.list("acme/")).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("the row written, then the write throws: the object stays, its version's, nothing logged, and the write's error is thrown", async () => {
    const createVersion = db.createVersion.bind(db);
    vi.spyOn(db, "createVersion").mockImplementationOnce(async (agentId, data) => {
      await createVersion(agentId, data);
      throw writeFailure;
    });

    expect(await pushError(service, bundle)).toBe(writeFailure);
    expect(await storage.get(BUNDLE_KEY)).toEqual(bundle);
    const pulled = await service.pull("acme", "agent", "1.0.0");
    expect(pulled.buffer.equals(bundle)).toBe(true);
    expect(events()).toEqual([]);
  });

  it("a write whose outcome is unknown: the row is not read, the object stays, a warn line names its key and the write's error, which is thrown", async () => {
    const reset = Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "ECONNRESET",
    });
    vi.spyOn(db, "createVersion").mockRejectedValueOnce(reset);
    vi.spyOn(db, "writeOutcomeUnknown").mockImplementation((err) => err === reset);
    const reads = vi.spyOn(db, "getVersionByNumber");

    expect(await pushError(service, bundle)).toBe(reset);
    expect(reads).not.toHaveBeenCalled();
    expect(await storage.get(BUNDLE_KEY)).toEqual(bundle);
    expect(logged).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "bundle_kept_unverified",
            bundle_key: BUNDLE_KEY,
            cause: "write_outcome_unknown",
            error_name: "Error",
            error_code: "ECONNRESET",
          },
          expect.stringContaining("may have been committed all the same"),
        ],
      },
    ]);
  });

  it("the row cannot be read after the failure: the object stays, a warn line names its key, and the write's error is thrown", async () => {
    vi.spyOn(db, "createVersion").mockRejectedValueOnce(writeFailure);
    const readFailure = Object.assign(new Error("still no connection"), { code: "ECONNRESET" });
    vi.spyOn(db, "getVersionByNumber").mockRejectedValueOnce(readFailure);

    expect(await pushError(service, bundle)).toBe(writeFailure);
    expect(await storage.get(BUNDLE_KEY)).toEqual(bundle);
    expect(logged).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "bundle_kept_unverified",
            bundle_key: BUNDLE_KEY,
            cause: "row_unreadable",
            error_name: "Error",
            error_code: "ECONNRESET",
          },
          expect.stringContaining("its bundle is kept"),
        ],
      },
    ]);
  });

  it("the delete fails: a warn line names the key, and the write's error — not the delete's — is thrown", async () => {
    vi.spyOn(db, "createVersion").mockRejectedValueOnce(writeFailure);
    const deleteFailure = Object.assign(new Error("R2 unavailable"), { status: 503 });
    const deleted = vi.spyOn(storage, "delete").mockRejectedValueOnce(deleteFailure);

    expect(await pushError(service, bundle)).toBe(writeFailure);
    expect(deleted).toHaveBeenCalledWith(BUNDLE_KEY);
    expect(logged).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "bundle_delete_failed",
            bundle_key: BUNDLE_KEY,
            error_name: "Error",
            error_status: "503",
          },
          expect.stringContaining("after a push's version write failed"),
        ],
      },
    ]);
  });

  it("a version written: nothing is deleted, nothing logged", async () => {
    const deleted = vi.spyOn(storage, "delete");

    expect(await pushError(service, bundle)).toBeUndefined();
    expect(deleted).not.toHaveBeenCalled();
    expect(await storage.get(BUNDLE_KEY)).toEqual(bundle);
    expect(events()).toEqual([]);
  });
});

// The version names the object's key and the version's row: anything but
// strict semver is refused before anything is read or written — the value
// never quoted back. The same expression a run names a version with: a
// leading zero passes there, and here.
describe("RegistryService.push — a version that is not strict semver", () => {
  const refused: Array<[string, string]> = [
    ["a path out of the namespace", "../../victim/agent/1.0.0"],
    ["a NUL character", "1.0.0\u0000"],
    ["a keyword", "latest"],
    ["two numbers", "1.0"],
    ["a range", "^1.0.0"],
    ["a pre-release", "1.0.0-beta"],
    ["a trailing newline", "1.0.0\n"],
  ];

  it.each(
    refused,
  )("%s: 400 INVALID_VERSION_FORMAT, the value never quoted, agent.yaml never read, no agent looked up, nothing stored", async (_label, version) => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const reader = { read: vi.fn(), readInTurn: vi.fn() };
    const writes = {
      getAgent: vi.spyOn(db, "getAgent"),
      createAgent: vi.spyOn(db, "createAgent"),
      put: vi.spyOn(storage, "put"),
    };
    const err = await pushError(
      new RegistryService(storage, db, reader as unknown as AgentYamlReader),
      await validBundle("agent"),
      version,
    );
    expect(reader.read).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).status).toBe(400);
    expect((err as RegistryError).code).toBe("INVALID_VERSION_FORMAT");
    expect((err as RegistryError).message).toBe(
      'version must be strict semver (e.g. "1.0.0"): three whole numbers separated by dots. Nothing was stored.',
    );
    expect(writes.getAgent).not.toHaveBeenCalled();
    expect(writes.createAgent).not.toHaveBeenCalled();
    expect(writes.put).not.toHaveBeenCalled();
    expect(await storage.list("acme/")).toEqual([]);
    expect(await storage.list("victim/")).toEqual([]);
  });

  it.each(["1.0.0", "01.0.0", "10.20.300"])("%s is stored, under its own key", async (version) => {
    const storage = new MemoryStorage();
    const err = await pushError(
      new RegistryService(storage, new MemoryDb()),
      await validBundle("agent"),
      version,
    );
    expect(err).toBeUndefined();
    expect(await storage.list("acme/")).toEqual([`acme/agent/${version}.agent`]);
  });
});

// The refusal of a text no version row could record — U+0000 or a lone
// surrogate — comes before the settings refused by name, as the refusals of an
// agent.yaml that does not load do. The cases of every backend are in the
// shared contract (`db/db-contract.shared.ts`).
describe("RegistryService.push — a configuration holding U+0000 or a lone surrogate", () => {
  it("is refused INVALID_CONFIG before a setting no code honours is judged", async () => {
    const yaml = minimalAgentYaml("agent", [
      "mcp_servers:",
      "  - name: s",
      "    url: https://mcp.example.com",
      "    auth: api_key",
      "tests:",
      "  - name: t",
      '    input: { q: "a\\0b" }',
      '    assert: "true"',
    ]);
    const storage = new MemoryStorage();
    const service = new RegistryService(storage, new MemoryDb());

    const err = await pushError(service, await validBundle("agent", yaml));
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe("INVALID_CONFIG");
    expect((err as RegistryError).message).toBe(
      "agent.yaml is not valid: tests[0].input.q holds U+0000, the NUL character (an escape such as \\0 or \\u0000 in a double-quoted string, or the character itself), which an agent's configuration cannot be stored with. Remove it, and push it again.",
    );
    expect(await storage.list("acme/")).toEqual([]);
  });

  it("tells a lone surrogate's fix, past a key named __proto__", async () => {
    // `__proto__` stays a key of the test's input, walked like any other.
    expect(await refusalOf(withTestInput('{ __proto__: { "x": 1 }, q: "\\uDBFF" }'))).toBe(
      "agent.yaml is not valid: tests[0].input.q holds a lone surrogate, half of a UTF-16 pair without its other half (an escape such as \\uD800 in a double-quoted string, written without its other half), which an agent's configuration cannot be stored with. Write the whole character, or remove it, and push it again.",
    );
  });

  it("names one field when two hold one: the first in the schema's order of fields, not the file's", async () => {
    // `tests` is written above `inputs`; the schema reads `inputs` first.
    const yaml = [
      "name: agent",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
      "tests:",
      "  - name: t",
      '    input: { q: "late\\0" }',
      '    assert: "true"',
      "inputs:",
      "  - name: q",
      "    type: string",
      '    description: "early\\0"',
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const message = await refusalOf(yaml);
    expect(message).toContain("inputs[0].description holds U+0000");
    expect(message).not.toContain("tests[0]");
  });

  it("in a free-form mapping, an integer-like key comes first, as JavaScript orders keys", async () => {
    const message = await refusalOf(withTestInput('{ b: "B\\0", "1": "ONE\\0" }'));
    expect(message).toContain("tests[0].input.1 holds U+0000");
  });

  it("a key and its value both holding one: the key is named", async () => {
    const message = await refusalOf(withTestInput('{ "k\\0": "v\\0" }'));
    expect(message).toContain("agent.yaml is not valid: a key of tests[0].input holds U+0000");
  });

  it("quotes a long key of the path cut to 64 characters, then …", async () => {
    const long = "x".repeat(100);
    const message = await refusalOf(withTestInput(`{ ${long}: { q: "\\0" } }`));
    expect(message).toContain(`tests[0].input.${"x".repeat(64)}….q holds U+0000`);
    expect(message).not.toContain("x".repeat(65));
  });

  it("never cuts a key inside a surrogate pair", async () => {
    // 63 characters, then an emoji — the 64th —, then more: the cut keeps the whole emoji.
    const key = `${"x".repeat(63)}\u{1F600}yyy`;
    const message = await refusalOf(withTestInput(`{ "${key}": { q: "\\0" } }`));
    expect(message).toContain(`tests[0].input.${"x".repeat(63)}\u{1F600}….q holds U+0000`);
  });
});
