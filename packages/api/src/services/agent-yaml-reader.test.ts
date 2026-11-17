import { getEventListeners } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TransferListItem, WorkerOptions } from "node:worker_threads";
import { parseAgentYaml, ValidationError } from "@skrun-dev/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_YAML_BUSY_RETRY_AFTER_S,
  AGENT_YAML_READ_BUDGET_MS,
  AGENT_YAML_READS_AT_ONCE,
  AGENT_YAML_READS_WAITING,
  AgentYamlReadAbandonedError,
  AgentYamlReader,
  AgentYamlReaderBusyError,
  AgentYamlReaderError,
  AgentYamlTooComplexError,
} from "./agent-yaml-reader.js";

// A reading thread can be made to fail: while `sabotage.code` is set, a thread
// the reader starts runs that script instead of its module; while
// `sabotage.cannotStart` is set, none can be created. And every text a thread
// is given to read is recorded, in order, in `posted`: what reached a thread;
// a thread told to end is in `ending` until it has. vi.mock is hoisted above
// every import: what its factory reads is declared with vi.hoisted.
const { sabotage, posted, ending } = vi.hoisted(() => ({
  sabotage: { code: undefined as string | undefined, cannotStart: false },
  posted: [] as unknown[],
  ending: new Set<unknown>(),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    constructor(file: URL | string, options?: WorkerOptions) {
      if (sabotage.cannotStart) throw new Error("no thread can be created");
      if (sabotage.code === undefined) super(file, options);
      else super(sabotage.code, { ...options, eval: true });
    }

    override postMessage(value: unknown, transferList?: readonly TransferListItem[]): void {
      posted.push(value);
      super.postMessage(value, transferList);
    }

    override terminate(): Promise<number> {
      ending.add(this);
      this.once("exit", () => ending.delete(this));
      return super.terminate();
    }
  }
  return { ...actual, Worker };
});

afterEach(() => {
  sabotage.code = undefined;
  sabotage.cannotStart = false;
  posted.length = 0;
});

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** Every `agent.yaml` of the repository's agents, fixtures and test agents. */
function trackedAgentYamls(): string[] {
  const found: string[] = [
    join(REPO_ROOT, "packages", "schema", "tests", "fixtures", "valid-agent.yaml"),
  ];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "agent.yaml") found.push(path);
    }
  };
  for (const root of ["agents", join("packages", "schema", "tests", "fixtures"), "tests"]) {
    walk(join(REPO_ROOT, root));
  }
  return found;
}

const HEAD = [
  "name: slow",
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

/**
 * The slow shape of the `yaml` library: lines of `depth` compact sequences
 * (`- - - … 1`), as many as fit in `bytes`. At 128 KB and a depth of 2,000,
 * its read took 2.5 to 4 s on the main thread (Windows, 2026-11-16); its time
 * grows with the number of lines and the square of the depth.
 */
function deepCompactSequences(bytes: number, depth = 2000): string {
  const line = `        - ${"- ".repeat(depth)}1\n`;
  let text = HEAD;
  while (text.length + line.length <= bytes) text += line;
  return text;
}

const KB = 1024;

/** How long `promise` takes to settle, and how. */
async function timed<T>(promise: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const start = performance.now();
  try {
    const value = await promise;
    return { ms: performance.now() - start, value };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
}

/** A thread started and free in `reader`: the start is then out of what a test times. */
async function warm(reader: AgentYamlReader, threads = 1): Promise<void> {
  const text = readFileSync(join(REPO_ROOT, "agents", "code-review", "agent.yaml"), "utf-8");
  await Promise.all(Array.from({ length: threads }, () => reader.read(text)));
}

describe("AgentYamlReader — the read of a pushed agent.yaml, off the event loop", () => {
  it("reads every agent.yaml of the repository as parseAgentYaml does — the configuration as JSON records it", async () => {
    const reader = new AgentYamlReader();
    await warm(reader);
    const files = trackedAgentYamls();
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const expected = parseAgentYaml(text);
      const { ms, value } = await timed(reader.read(text));
      expect(value, relative(REPO_ROOT, file)).toEqual({
        config: JSON.parse(JSON.stringify(expected.config)),
        configJson: JSON.stringify(expected.config),
        warnings: expected.warnings,
      });
      // The JSON as a string: its keys in the parse's order, which toEqual does not see.
      expect(value?.configJson, relative(REPO_ROOT, file)).toBe(JSON.stringify(expected.config));
      // Far within the budget: every one of them reads in a few milliseconds.
      expect(ms, relative(REPO_ROOT, file)).toBeLessThan(AGENT_YAML_READ_BUDGET_MS / 4);
    }
  }, 30_000);

  it("refuses what parseAgentYaml refuses, with its issues", async () => {
    const reader = new AgentYamlReader();
    const base = readFileSync(join(REPO_ROOT, "agents", "code-review", "agent.yaml"), "utf-8");
    for (const text of [
      `${base}\nextra: &a 1\nmore: *a\n`,
      `%YAML 1.1\n---\n${base}`,
      `${base}\nextra: !!omap [a: 1]\n`,
      "name: [unclosed",
      `${base}\nname: twice\n`,
      "just a string",
      base.replace(/^version: .*$/m, "version: not-a-version"),
    ]) {
      let expected: unknown;
      try {
        parseAgentYaml(text);
      } catch (err) {
        expected = err;
      }
      expect(expected).toBeInstanceOf(ValidationError);
      const { error } = await timed(reader.read(text));
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe((expected as ValidationError).message);
      expect((error as ValidationError).issues).toEqual((expected as ValidationError).issues);
    }
  }, 30_000);

  it("stops a read past its budget and refuses it: YAML_TOO_COMPLEX, nothing of the file in the message", async () => {
    const budgetMs = 250;
    const reader = new AgentYamlReader({ budgetMs });
    await warm(reader);
    const { ms, error } = await timed(reader.read(deepCompactSequences(128 * KB)));
    expect(error).toBeInstanceOf(AgentYamlTooComplexError);
    const refusal = error as AgentYamlTooComplexError;
    expect(refusal.budgetMs).toBe(budgetMs);
    expect(refusal.issues).toEqual([
      {
        code: "YAML_TOO_COMPLEX",
        message:
          "This bundle's agent.yaml is too complex to read: reading it took longer than 0.25 s, and the read was stopped. Simplify it and push it again.",
      },
    ]);
    // Stopped at the budget, not when the read would have ended.
    expect(ms).toBeGreaterThanOrEqual(budgetMs - 5);
    expect(ms).toBeLessThan(budgetMs + 500);
  }, 15_000);

  it("counts the budget from the read's start, never the thread's", async () => {
    // A thread that takes 600 ms to start — then loads the reading module —,
    // twice the budget; the read of a small file takes a few milliseconds.
    const module = new URL("./agent-yaml-worker.mjs", import.meta.url).href;
    sabotage.code = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); import(${JSON.stringify(module)});`;
    const reader = new AgentYamlReader({ budgetMs: 300 });
    const { ms, value, error } = await timed(
      reader.read(readFileSync(join(REPO_ROOT, "agents", "code-review", "agent.yaml"), "utf-8")),
    );
    expect(error).toBeUndefined();
    expect(value?.config.name).toBe("code-review");
    expect(ms).toBeGreaterThanOrEqual(600);
  }, 15_000);

  it("gives a read 2 s by default", async () => {
    expect(AGENT_YAML_READ_BUDGET_MS).toBe(2_000);
    const reader = new AgentYamlReader();
    await warm(reader);
    // Four times the size at the same depth: far longer than the budget anywhere.
    const { ms, error } = await timed(reader.read(deepCompactSequences(512 * KB)));
    expect(error).toBeInstanceOf(AgentYamlTooComplexError);
    expect((error as AgentYamlTooComplexError).budgetMs).toBe(2_000);
    expect(ms).toBeGreaterThanOrEqual(2_000 - 5);
    expect(ms).toBeLessThan(2_000 + 1_000);
  }, 15_000);

  it("reads with the main thread's stack: a configuration nested deeper than it holds is refused, as it was", async () => {
    const reader = new AgentYamlReader();
    // 2,500 nested flow sequences: past what the main thread read, started or
    // not (about 770 and 1,500 levels); a thread of Node's default stack read it.
    const text = `${HEAD.replace(/ {6}l:\n$/, "")}      ${"[".repeat(2500)}1${"]".repeat(2500)}\n`;
    const { error } = await timed(reader.read(text));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues[0]?.code).toBe("INVALID_YAML");
    expect((error as ValidationError).issues[0]?.message).toContain(
      "Maximum call stack size exceeded",
    );
  }, 15_000);

  it("reads a file beside a slow one without waiting for it", async () => {
    const reader = new AgentYamlReader({ budgetMs: 1_500 });
    await warm(reader, AGENT_YAML_READS_AT_ONCE);
    const slow = timed(reader.read(deepCompactSequences(128 * KB)));
    const normal = await timed(
      reader.read(readFileSync(join(REPO_ROOT, "agents", "data-analyst", "agent.yaml"), "utf-8")),
    );
    expect(normal.value?.config.name).toBe("data-analyst");
    expect(normal.ms).toBeLessThan(500);
    expect((await slow).error).toBeInstanceOf(AgentYamlTooComplexError);
  }, 15_000);

  it("reads at most readsAtOnce files at once; the others wait their turn, their budget from their own start", async () => {
    const budgetMs = 300;
    const reader = new AgentYamlReader({ budgetMs, readsAtOnce: 2 });
    let mostThreads = 0;
    const sample = setInterval(() => {
      mostThreads = Math.max(mostThreads, reader.load.threads);
    }, 5);
    const reads = [1, 2, 3].map(() => timed(reader.read(deepCompactSequences(128 * KB))));
    // A file that reads fast, behind three slow ones: it waits, then is read —
    // never refused for the time it waited.
    const normal = timed(
      reader.read(readFileSync(join(REPO_ROOT, "agents", "email-drafter", "agent.yaml"), "utf-8")),
    );
    const results = await Promise.all(reads);
    const last = await normal;
    clearInterval(sample);
    expect(mostThreads).toBe(2);
    for (const { error } of results) expect(error).toBeInstanceOf(AgentYamlTooComplexError);
    // The third read began once one of the first two had ended.
    const [first, second, third] = results.map(({ ms }) => ms);
    expect(third).toBeGreaterThanOrEqual(Math.min(first ?? 0, second ?? 0) + budgetMs - 5);
    expect(last.value?.config.name).toBe("email-drafter");
    expect(last.ms).toBeGreaterThanOrEqual(budgetMs);
  }, 20_000);

  it("starts another thread once a stopped one has ended", async () => {
    const reader = new AgentYamlReader({ budgetMs: 200, readsAtOnce: 1 });
    await warm(reader);
    expect(reader.load).toEqual({ threads: 1, reading: 0, waiting: 0 });
    const { error } = await timed(reader.read(deepCompactSequences(128 * KB)));
    expect(error).toBeInstanceOf(AgentYamlTooComplexError);
    await vi.waitFor(() => expect(reader.load.threads).toBe(0));
    const { value } = await timed(
      reader.read(readFileSync(join(REPO_ROOT, "agents", "web-scraper", "agent.yaml"), "utf-8")),
    );
    expect(value?.config.name).toBe("web-scraper");
    expect(reader.load).toEqual({ threads: 1, reading: 0, waiting: 0 });
  }, 15_000);

  describe("a thread that fails is the reader's failure, never a hang", () => {
    const text = "name: any\n";

    it("one that throws as it loads", async () => {
      sabotage.code = "throw new Error('the thread broke as it loaded')";
      const reader = new AgentYamlReader();
      const { error } = await timed(reader.read(text));
      expect(error).toBeInstanceOf(AgentYamlReaderError);
      expect((error as AgentYamlReaderError).message).toBe("The agent.yaml reader failed");
      expect(((error as AgentYamlReaderError).cause as Error).message).toBe(
        "the thread broke as it loaded",
      );
      await vi.waitFor(() => expect(reader.load.threads).toBe(0));
    });

    it("one that ends without answering", async () => {
      sabotage.code =
        "require('node:worker_threads').parentPort.on('message', () => process.exit(3))";
      const reader = new AgentYamlReader();
      const { error } = await timed(reader.read(text));
      expect(error).toBeInstanceOf(AgentYamlReaderError);
      expect((error as AgentYamlReaderError).message).toBe(
        "The agent.yaml reader ended (exit code 3) without answering",
      );
    });

    it("one that throws once it has started a read, outside it", async () => {
      sabotage.code = [
        "const { parentPort } = require('node:worker_threads');",
        "parentPort.on('message', () => {",
        "  parentPort.postMessage({ type: 'started' });",
        "  setImmediate(() => { throw new Error('the thread broke mid-read'); });",
        "});",
      ].join("\n");
      const reader = new AgentYamlReader();
      const { error, ms } = await timed(reader.read(text));
      expect(error).toBeInstanceOf(AgentYamlReaderError);
      expect(((error as AgentYamlReaderError).cause as Error).message).toBe(
        "the thread broke mid-read",
      );
      expect(ms).toBeLessThan(AGENT_YAML_READ_BUDGET_MS);
    });

    it("and the next read, in a new thread, reads", async () => {
      sabotage.code = "throw new Error('broken')";
      const reader = new AgentYamlReader({ readsAtOnce: 1 });
      const failed = reader.read(text);
      // Waits for the one thread, then gets a new one once the broken thread has ended.
      sabotage.code = undefined;
      const next = reader.read(
        readFileSync(join(REPO_ROOT, "agents", "seo-audit", "agent.yaml"), "utf-8"),
      );
      expect((await timed(failed)).error).toBeInstanceOf(AgentYamlReaderError);
      expect((await next).config.name).toBe("seo-audit");
    });

    it("one that cannot be created fails its read, and each read waiting behind it", async () => {
      sabotage.code = "throw new Error('broken')";
      const reader = new AgentYamlReader({ readsAtOnce: 1 });
      const reads = [reader.read(text), reader.read(text), reader.read(text)].map((read) =>
        timed(read),
      );
      // The two waiting reads find, once the broken thread has ended, that no
      // thread can be created: each is failed, none left waiting.
      sabotage.code = undefined;
      sabotage.cannotStart = true;
      const [first, second, third] = await Promise.all(reads);
      expect(first?.error).toBeInstanceOf(AgentYamlReaderError);
      for (const waited of [second, third]) {
        expect(waited?.error).toBeInstanceOf(AgentYamlReaderError);
        expect((waited?.error as AgentYamlReaderError).message).toBe(
          "The agent.yaml reader could not start",
        );
      }
      expect(reader.load).toEqual({ threads: 0, reading: 0, waiting: 0 });
      sabotage.cannotStart = false;
      const { value } = await timed(
        reader.read(
          readFileSync(join(REPO_ROOT, "agents", "pdf-processing", "agent.yaml"), "utf-8"),
        ),
      );
      expect(value?.config.name).toBe("pdf-processing");
    });
  });
});

/** The `agent.yaml` of one of the repository's agents. */
const agentYaml = (agent: string): string =>
  readFileSync(join(REPO_ROOT, "agents", agent, "agent.yaml"), "utf-8");

/** Whether `text` was ever given to a thread to read. */
const reached = (text: string): boolean => posted.includes(text);

describe("AgentYamlReader — the line of reads waiting for a thread", () => {
  // A run's read is never refused for the line: it waits its turn behind the
  // reads ahead of it, and counts among those a push's read finds waiting.
  it("lets a run's read wait past the reads that may wait, in turn; a push's read behind it is refused", async () => {
    const reader = new AgentYamlReader({ budgetMs: 400, readsAtOnce: 1, waitingAtMost: 1 });
    await warm(reader);
    const slow = timed(reader.read(deepCompactSequences(128 * KB)));
    const order: string[] = [];
    const push = reader.read(agentYaml("adr-writer")).then((read) => order.push(read.config.name));
    // The line is full for a push's read: a run's read joins it all the same.
    const runs = ["seo-audit", "email-drafter"].map((agent) =>
      reader.readInTurn(agentYaml(agent)).then((read) => {
        order.push(read.config.name);
        return read;
      }),
    );
    expect(reader.load).toEqual({ threads: 1, reading: 1, waiting: 3 });
    const refused = await timed(reader.read(agentYaml("web-scraper")));
    expect(refused.error).toBeInstanceOf(AgentYamlReaderBusyError);

    expect((await slow).error).toBeInstanceOf(AgentYamlTooComplexError);
    await push;
    const [seo] = await Promise.all(runs);
    expect(order).toEqual(["adr-writer", "seo-audit", "email-drafter"]);
    expect(seo?.configJson).toBe(JSON.stringify(parseAgentYaml(agentYaml("seo-audit")).config));
    expect(reached(agentYaml("web-scraper"))).toBe(false);
    expect(reader.load).toEqual({ threads: 1, reading: 0, waiting: 0 });
  }, 15_000);

  it("refuses a read past the reads that may wait, at once and never read; those within wait their turn, in order", async () => {
    const reader = new AgentYamlReader({ budgetMs: 400, readsAtOnce: 1, waitingAtMost: 2 });
    await warm(reader);
    const slow = timed(reader.read(deepCompactSequences(128 * KB)));
    const order: string[] = [];
    const inLine = ["adr-writer", "seo-audit"].map((agent) =>
      reader.read(agentYaml(agent)).then((read) => {
        order.push(read.config.name);
      }),
    );
    expect(reader.load).toEqual({ threads: 1, reading: 1, waiting: 2 });

    const refused = await timed(reader.read(agentYaml("web-scraper")));
    expect(refused.error).toBeInstanceOf(AgentYamlReaderBusyError);
    expect((refused.error as AgentYamlReaderBusyError).waitingAtMost).toBe(2);
    // At once: it waited for nothing, and took no place.
    expect(refused.ms).toBeLessThan(100);
    expect(reader.load).toEqual({ threads: 1, reading: 1, waiting: 2 });

    expect((await slow).error).toBeInstanceOf(AgentYamlTooComplexError);
    await Promise.all(inLine);
    expect(order).toEqual(["adr-writer", "seo-audit"]);
    expect(reached(agentYaml("web-scraper"))).toBe(false);
    expect(reader.load).toEqual({ threads: 1, reading: 0, waiting: 0 });
  }, 15_000);

  it("lets sixteen reads wait in a process and refuses the seventeenth, which is to try again 3 s later", async () => {
    expect(AGENT_YAML_READS_WAITING).toBe(16);
    expect(AGENT_YAML_BUSY_RETRY_AFTER_S).toBe(3);
    // The line and the threads of every reader; a budget short enough for a test.
    const reader = new AgentYamlReader({ budgetMs: 300 });
    await warm(reader, AGENT_YAML_READS_AT_ONCE);
    const slow = [1, 2].map(() => timed(reader.read(deepCompactSequences(128 * KB))));
    const inLine = Array.from({ length: 16 }, () => timed(reader.read(agentYaml("email-drafter"))));
    expect(reader.load).toEqual({ threads: 2, reading: 2, waiting: 16 });

    const refused = await timed(reader.read(agentYaml("data-analyst")));
    expect(refused.error).toBeInstanceOf(AgentYamlReaderBusyError);
    expect((refused.error as AgentYamlReaderBusyError).waitingAtMost).toBe(16);

    for (const { error } of await Promise.all(slow)) {
      expect(error).toBeInstanceOf(AgentYamlTooComplexError);
    }
    for (const { value } of await Promise.all(inLine)) {
      expect(value?.config.name).toBe("email-drafter");
    }
    expect(reader.load.waiting).toBe(0);
  }, 15_000);

  it("drops a waiting read whose signal aborts: it leaves the line at once, never read, and its place goes to the next", async () => {
    const reader = new AgentYamlReader({ budgetMs: 400, readsAtOnce: 1, waitingAtMost: 1 });
    await warm(reader);
    const slow = timed(reader.read(deepCompactSequences(128 * KB)));
    const client = new AbortController();
    const dropped = timed(reader.read(agentYaml("adr-writer"), client.signal));
    // The line is full: a read past it is refused.
    expect((await timed(reader.read(agentYaml("seo-audit")))).error).toBeInstanceOf(
      AgentYamlReaderBusyError,
    );

    client.abort();
    // Out of the line as the signal aborts, not when a thread comes free.
    expect(reader.load).toEqual({ threads: 1, reading: 1, waiting: 0 });
    expect((await dropped).error).toBeInstanceOf(AgentYamlReadAbandonedError);

    // Its place is free: the next read waits in it, and is read.
    const next = timed(reader.read(agentYaml("web-scraper")));
    expect(reader.load.waiting).toBe(1);
    expect((await slow).error).toBeInstanceOf(AgentYamlTooComplexError);
    expect((await next).value?.config.name).toBe("web-scraper");
    expect(reached(agentYaml("adr-writer"))).toBe(false);
  }, 15_000);

  it("never starts a read whose signal has already aborted, though a thread is free", async () => {
    const reader = new AgentYamlReader();
    await warm(reader);
    const { error } = await timed(reader.read(agentYaml("adr-writer"), AbortSignal.abort()));
    expect(error).toBeInstanceOf(AgentYamlReadAbandonedError);
    expect(reached(agentYaml("adr-writer"))).toBe(false);
    expect(reader.load).toEqual({ threads: 1, reading: 0, waiting: 0 });
  });

  it("lets a read whose signal aborts once it has started end as it would, and serves the reads behind it", async () => {
    const reader = new AgentYamlReader({ budgetMs: 300, readsAtOnce: 1, waitingAtMost: 2 });
    await warm(reader);
    const ahead = timed(reader.read(deepCompactSequences(128 * KB)));
    const client = new AbortController();
    // A slow file of its own, so that its start can be seen.
    const startedText = deepCompactSequences(128 * KB, 1999);
    const started = timed(reader.read(startedText, client.signal));
    const behind = timed(reader.read(agentYaml("seo-audit")));
    expect(reader.load.waiting).toBe(2);

    // The read ahead stopped, its thread replaced: the second read has started.
    await vi.waitFor(() => expect(reached(startedText)).toBe(true));
    // Given a thread, it no longer listens to its signal.
    expect(getEventListeners(client.signal, "abort")).toHaveLength(0);
    client.abort();
    expect(reader.load.waiting).toBe(1);

    // Ended at its budget, as without the abort — never dropped.
    expect((await started).error).toBeInstanceOf(AgentYamlTooComplexError);
    expect((await behind).value?.config.name).toBe("seo-audit");
    expect((await ahead).error).toBeInstanceOf(AgentYamlTooComplexError);
  }, 15_000);

  it("holds no place after aborts and budget stops interleaved: every read answered once, the line and its bound as they were", async () => {
    const reader = new AgentYamlReader({ budgetMs: 200, readsAtOnce: 2, waitingAtMost: 4 });
    const slowText = deepCompactSequences(128 * KB);
    const normal = agentYaml("email-drafter");
    for (let round = 0; round < 3; round++) {
      const clients = Array.from({ length: 6 }, () => new AbortController());
      // Two slow reads running, four waiting — slow and ordinary in turn.
      const reads = clients.map((client, i) =>
        timed(reader.read(i % 2 === 0 ? slowText : normal, client.signal)),
      );
      expect(reader.load).toMatchObject({ reading: 2, waiting: 4 });
      // A running read and a waiting one abort at once; two more waiting ones
      // around the first budget stop — before it, and as its thread is handed on.
      clients[0]?.abort();
      clients[3]?.abort();
      setTimeout(() => clients[4]?.abort(), 190 + round * 10);
      setTimeout(() => clients[5]?.abort(), 210 + round * 10);

      const settled = await Promise.all(reads);
      for (const { error, value } of settled) {
        const answered =
          value !== undefined ||
          error instanceof AgentYamlTooComplexError ||
          error instanceof AgentYamlReadAbandonedError;
        expect(answered).toBe(true);
      }
      // A running read ends as it would; a waiting one is dropped.
      expect(settled[0]?.error).toBeInstanceOf(AgentYamlTooComplexError);
      expect(settled[3]?.error).toBeInstanceOf(AgentYamlReadAbandonedError);
      await vi.waitFor(() => expect(reader.load).toMatchObject({ reading: 0, waiting: 0 }));
      expect(reader.load.threads).toBeLessThanOrEqual(2);
      // A stopped thread holds its place until it has ended: the next round
      // starts once none is ending, from a line it can know.
      await vi.waitFor(() => expect(ending.size).toBe(0));
    }

    // The bound where it was: two read, four wait, the fifth is refused.
    const fill = [slowText, slowText, normal, normal, normal, normal].map((text) =>
      timed(reader.read(text)),
    );
    expect(reader.load).toMatchObject({ reading: 2, waiting: 4 });
    expect((await timed(reader.read(normal))).error).toBeInstanceOf(AgentYamlReaderBusyError);
    await Promise.all(fill);
    await vi.waitFor(() => expect(reader.load).toMatchObject({ reading: 0, waiting: 0 }));
  }, 30_000);
});
