import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentYaml } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCache, configObject, ownedExtractionDirs } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import {
  AGENT_YAML_READ_BUDGET_MS,
  AgentYamlReaderError,
  AgentYamlTooComplexError,
  sharedAgentYamlReader,
} from "../services/agent-yaml-reader.js";
import { MemoryStorage } from "../storage/memory.js";
import { minimalAgentYaml, validBundle } from "./agent-bundle.shared.js";
import { fakeFlyioDeps } from "./flyio-run-harness.shared.js";
import { storeVersion } from "./stored-version.shared.js";

// Watched without being changed: the parse on this thread — a run must never
// call it —, the object a run makes of its entry's configuration, and every
// line the app logs. vi.mock is hoisted above every import: what its
// factories read is declared with vi.hoisted.
const { logged } = vi.hoisted(() => ({ logged: [] as { level: string; args: unknown[] }[] }));

vi.mock("@skrun-dev/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/schema")>();
  return { ...actual, parseAgentYaml: vi.fn(actual.parseAgentYaml) };
});

vi.mock("../cache/bundle-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cache/bundle-cache.js")>();
  return { ...actual, configObject: vi.fn(actual.configObject) };
});

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

// A run reads its bundle's agent.yaml in a reading thread, within the push's
// budget, once for the bundle's cache entry — never on this thread. Every case
// runs without a model key anywhere: a run that gets past its configuration is
// refused for the key (400 LLM_KEY_REQUIRED), before any model is called.
const DEV_TOKEN = "dev-token";
const VERSION = "1.0.0";
type Runtime = "local" | "flyio";
const RUNTIMES = ["local", "flyio"] as const;

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/** Every demo agent of the repository, by name, with its agent.yaml. */
const DEMOS = readdirSync(join(REPO_ROOT, "agents"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    agentYaml: readFileSync(join(REPO_ROOT, "agents", entry.name, "agent.yaml"), "utf-8"),
  }));

/** An agent.yaml today's parser refuses: an alias. */
const WITH_ALIAS = minimalAgentYaml("aliased", [
  "tools:",
  "  - name: first",
  "    description: &same Looks things up.",
  "    input_schema: { type: object }",
  "  - name: second",
  "    description: *same",
  "    input_schema: { type: object }",
]);

/**
 * A valid agent.yaml of 128 KB whose read takes longer than the budget on the
 * machines measured: an input's default made of lines of 2,000 compact
 * sequences (`- - - … 1`), 2.5 to 4 s on the main thread (Windows,
 * 2026-11-16). On a machine fast enough to read it within the budget, its read
 * ends in a YAML error (nested deeper than the reading thread's stack): a
 * refusal all the same.
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

/** The lines of `event` the app wrote. */
const linesOf = (event: string) =>
  logged.filter(
    ({ args: [fields] }) => (fields as { event?: string } | undefined)?.event === event,
  );

describe("POST /run — the configuration of the bundle's agent.yaml, read once in a reading thread", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    logged.length = 0;
    // No server key for any provider the demos or the minimal agent use.
    for (const key of ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"]) {
      vi.stubEnv(key, "");
    }
    bundleCache.clear();
  });

  afterEach(() => {
    bundleCache.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.mocked(parseAgentYaml).mockClear();
    vi.mocked(configObject).mockClear();
  });

  function appFor(runtime: Runtime) {
    const quotaConfig = parseQuotaEnv({});
    return runtime === "flyio"
      ? createApp(storage, db, {
          runtimeMode: "flyio",
          flyioDeps: fakeFlyioDeps(storage),
          verificationPolicy: "owner",
          quotaConfig,
        })
      : createApp(storage, db, { runtimeMode: "local", verificationPolicy: "owner", quotaConfig });
  }

  async function run(app: ReturnType<typeof createApp>, runtime: Runtime, name: string) {
    const res = await app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        ...(runtime === "flyio" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify({ input: { q: "hi" } }),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  const errorOf = (text: string) =>
    (JSON.parse(text) as { error: { code: string; message: string } }).error;

  const stored = (app: ReturnType<typeof createApp>, name: string) => ({
    app,
    storage,
    db,
    token: DEV_TOKEN,
    namespace: "dev",
    name,
    version: VERSION,
  });

  it.each(
    RUNTIMES,
  )("%s: reads the agent.yaml once in a reading thread, never on this one, for every run while the cache keeps the bundle", async (runtime) => {
    const app = appFor(runtime);
    await storeVersion({ ...stored(app, "plain"), agentYaml: minimalAgentYaml("plain") });
    vi.mocked(parseAgentYaml).mockClear();
    const inTurn = vi.spyOn(sharedAgentYamlReader, "readInTurn");
    const asPush = vi.spyOn(sharedAgentYamlReader, "read");

    for (let i = 0; i < 3; i++) {
      const { status, text } = await run(app, runtime, "plain");
      expect(status).toBe(400);
      expect(errorOf(text).code).toBe("LLM_KEY_REQUIRED");
    }
    expect(inTurn).toHaveBeenCalledTimes(1);
    expect(inTurn).toHaveBeenCalledWith(minimalAgentYaml("plain"));
    // A run's read is never a push's: it is never refused for the reads waiting.
    expect(asPush).not.toHaveBeenCalled();
    expect(vi.mocked(parseAgentYaml)).not.toHaveBeenCalled();
    // Each run its own object, from the one JSON the entry keeps.
    const objects = vi.mocked(configObject).mock.results.map((result) => result.value);
    expect(objects).toHaveLength(3);
    expect(new Set(objects).size).toBe(3);
  });

  // What the run makes of the configuration is what the parse returns — the
  // same values, and the same keys in the same order: a tool's input_schema
  // reaches the model as its author wrote it. Compared as JSON strings: toEqual
  // ignores the order of keys.
  it.each(
    RUNTIMES,
  )("%s: runs every demo agent with the configuration parseAgentYaml gives its agent.yaml, keys in their order", async (runtime) => {
    expect(DEMOS.length).toBeGreaterThanOrEqual(14);
    const app = appFor(runtime);
    for (const demo of DEMOS) {
      await storeVersion({ ...stored(app, demo.name), agentYaml: demo.agentYaml });
      vi.mocked(configObject).mockClear();

      const { status, text } = await run(app, runtime, demo.name);
      expect(status, demo.name).toBe(400);
      expect(errorOf(text).code, demo.name).toBe("LLM_KEY_REQUIRED");
      const [made] = vi.mocked(configObject).mock.results;
      expect(JSON.stringify(made?.value), demo.name).toBe(
        JSON.stringify(parseAgentYaml(demo.agentYaml).config),
      );
    }
  }, 30_000);

  it.each(
    RUNTIMES,
  )("%s: answers a refused agent.yaml 500 INVALID_CONFIG at every run, its message the parse's, read once", async (runtime) => {
    const app = appFor(runtime);
    await storeVersion({
      ...stored(app, "aliased"),
      bundle: await validBundle("aliased", WITH_ALIAS),
    });
    const inTurn = vi.spyOn(sharedAgentYamlReader, "readInTurn");

    for (let i = 0; i < 2; i++) {
      const { status, text } = await run(app, runtime, "aliased");
      expect(status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: { code: "INVALID_CONFIG", message: "agent.yaml uses a YAML alias" },
      });
    }
    expect(inTurn).toHaveBeenCalledTimes(1);
  });

  it.each(
    RUNTIMES,
  )("%s: answers a read past its budget 500 INVALID_CONFIG at every run, nothing of the file said, read once, its line written", async (runtime) => {
    const app = appFor(runtime);
    await storeVersion({ ...stored(app, "complex"), agentYaml: minimalAgentYaml("complex") });
    const inTurn = vi
      .spyOn(sharedAgentYamlReader, "readInTurn")
      .mockRejectedValueOnce(new AgentYamlTooComplexError(AGENT_YAML_READ_BUDGET_MS));

    for (let i = 0; i < 2; i++) {
      const { status, text } = await run(app, runtime, "complex");
      expect(status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: { code: "INVALID_CONFIG", message: "agent.yaml is too complex to read" },
      });
    }
    expect(inTurn).toHaveBeenCalledTimes(1);
    const lines = linesOf("agent_yaml_read_stopped");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.args[0]).toEqual({
      event: "agent_yaml_read_stopped",
      agent: "dev/complex",
      agent_version: VERSION,
      budget_ms: AGENT_YAML_READ_BUDGET_MS,
    });
  });

  // A version stored before the push read agent.yaml within its budget: its
  // run reads it within the budget too, off this thread, and is refused.
  it("refuses within its budget, off the event loop, a stored agent.yaml slow to read", async () => {
    const app = appFor("local");
    await storeVersion({
      ...stored(app, "slow"),
      bundle: await validBundle("slow", slowAgentYaml("slow")),
    });
    // The reading threads started: what follows times a read, not a start.
    await sharedAgentYamlReader.readInTurn(minimalAgentYaml("warm"));

    let running = true;
    const start = performance.now();
    const ran = run(app, "local", "slow").finally(() => {
      running = false;
    });
    const lateness: number[] = [];
    while (running) {
      const due = performance.now() + 50;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await app.request("/health")).status).toBe(200);
      lateness.push(performance.now() - due);
    }
    const { status, text } = await ran;
    expect(status).toBe(500);
    expect(errorOf(text).code).toBe("INVALID_CONFIG");
    expect(performance.now() - start).toBeLessThan(AGENT_YAML_READ_BUDGET_MS + 1_000);
    expect(Math.max(...lateness)).toBeLessThan(500);
  }, 20_000);

  // The reader's failure judged nothing: a fault of the server, its bare 500,
  // nothing kept — the next run reads the file again.
  it.each(
    RUNTIMES,
  )("%s: answers a reader's failure with the bare 500, keeps nothing, and the next run reads again", async (runtime) => {
    const app = appFor(runtime);
    await storeVersion({ ...stored(app, "fault"), agentYaml: minimalAgentYaml("fault") });
    const owned = ownedExtractionDirs().length;
    const inTurn = vi
      .spyOn(sharedAgentYamlReader, "readInTurn")
      .mockRejectedValueOnce(new AgentYamlReaderError("The agent.yaml reader failed"));

    const failed = await run(app, runtime, "fault");
    expect(failed.status).toBe(500);
    expect(failed.text).toBe("Internal Server Error");
    expect(bundleCache.size).toBe(0);
    expect(ownedExtractionDirs()).toHaveLength(owned);

    const next = await run(app, runtime, "fault");
    expect(next.status).toBe(400);
    expect(errorOf(next.text).code).toBe("LLM_KEY_REQUIRED");
    expect(inTurn).toHaveBeenCalledTimes(2);
  });

  // The cache weighs what an entry keeps: its manifests, and its configuration's JSON.
  it.each(
    RUNTIMES,
  )("%s: weighs the configuration the entry keeps in the cache's budget", async (runtime) => {
    const app = appFor(runtime);
    const agentYaml = minimalAgentYaml("weighed");
    const bundle = await validBundle("weighed", agentYaml);
    await storeVersion({ ...stored(app, "weighed"), bundle });

    await run(app, runtime, "weighed");
    const entry = bundleCache.get(createHash("sha256").update(bundle).digest("hex"));
    const json = JSON.stringify(parseAgentYaml(agentYaml).config);
    expect(entry?.config).toEqual({ json });
    const manifests = Object.values(entry?.files ?? {}).reduce((sum, text) => sum + text.length, 0);
    expect(bundleCache.bytes).toBe(manifests + json.length);
  });
});
