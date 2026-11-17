import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import {
  AGENT_YAML_READ_BUDGET_MS,
  AgentYamlReader,
  AgentYamlReaderBusyError,
  AgentYamlReaderError,
  sharedAgentYamlReader,
} from "../services/agent-yaml-reader.js";
import { RegistryService } from "../services/registry.js";
import { MemoryStorage } from "../storage/memory.js";
import { minimalAgentYaml, validBundle } from "./agent-bundle.shared.js";
import { createRegistryRoutes } from "./registry.js";
import { createScanRoutes } from "./scan.js";

// The logger factory is replaced by one that records every call: a case reads
// the line the app wrote. vi.mock is hoisted above every import: what its
// factory reads is declared with vi.hoisted.
const { logged } = vi.hoisted(() => ({ logged: [] as { level: string; args: unknown[] }[] }));

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
const trackedAgentYaml = (agent: string) =>
  readFileSync(join(REPO_ROOT, "agents", agent, "agent.yaml"), "utf-8");

/**
 * A valid agent.yaml whose read takes longer than its budget on the machines
 * measured: an input's default made of lines of 2,000 compact sequences
 * (`- - - … 1`), up to the 128 KB an agent.yaml may weigh — 2.5 to 4 s on the
 * main thread (Windows, 2026-11-16). On a machine fast enough to read it within
 * the budget, its read ends in a YAML error (nested deeper than the reading
 * thread's stack): refused all the same.
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

type App = ReturnType<typeof createApp>;

async function push(
  app: App | Hono,
  name: string,
  agentYaml: string,
  signal?: AbortSignal,
): Promise<Response> {
  return app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
    body: new Uint8Array(await validBundle(name, agentYaml)),
    signal,
  });
}

/** A push from the agents directory: the agent there named `name`. */
function pushScanned(app: App | Hono, name: string, signal?: AbortSignal): Promise<Response> {
  return app.request(`/api/agents/scan/${name}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token" },
    signal,
  });
}

/** The lines of `event` the app wrote. */
const linesOf = (event: string) =>
  logged.filter(
    ({ args: [fields] }) => (fields as { event?: string } | undefined)?.event === event,
  );

/** What a refusal's body says. */
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

const PUSH_BUSY_MESSAGE =
  "The server is busy with other pushes right now, and stored nothing of this one. Push it again in a few seconds.";

/** How long `promise` takes to settle, and its value. */
async function timed<T>(promise: Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await promise;
  return { ms: performance.now() - start, value };
}

// The push reads agent.yaml in a thread of its own (AgentYamlReader): however
// long a read takes, the API answers its other requests meanwhile, and a read
// past its budget ends in the push's refusal.
describe("POST /api/agents/:namespace/:name/push — agent.yaml read off the event loop", () => {
  let app: App;

  beforeEach(async () => {
    logged.length = 0;
    app = createApp(new MemoryStorage(), new MemoryDb());
    // The process's reading threads started: what follows times reads, not starts.
    const warmUp = await Promise.all([
      push(app, "code-review", trackedAgentYaml("code-review")),
      push(app, "data-analyst", trackedAgentYaml("data-analyst")),
    ]);
    expect(warmUp.map((res) => res.status)).toEqual([200, 200]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers other requests while it reads, and refuses the push within its budget: 400 INVALID_CONFIG", async () => {
    let pushing = true;
    const pushed = timed(push(app, "slow", slowAgentYaml("slow"))).finally(() => {
      pushing = false;
    });
    // GET /health every 50 ms meanwhile: how late each answer comes after it was due.
    const lateness: number[] = [];
    while (pushing) {
      const due = performance.now() + 50;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const health = await app.request("/health");
      expect(health.status).toBe(200);
      lateness.push(performance.now() - due);
    }
    const { ms, value: res } = await pushed;

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CONFIG");
    expect(ms).toBeLessThan(AGENT_YAML_READ_BUDGET_MS + 1_000);
    expect(lateness.length).toBeGreaterThanOrEqual(10);
    // A read on the event loop would hold every answer for as long as it lasts.
    expect(Math.max(...lateness)).toBeLessThan(500);
  }, 20_000);

  it("stores a normal agent at once beside a push it is still reading", async () => {
    // Both timed from the same start: the normal push is sent 20 ms after the
    // slow one, which has its thread by then.
    const [slow, normal] = await Promise.all([
      timed(push(app, "slow", slowAgentYaml("slow"))),
      timed(
        new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          push(app, "email-drafter", trackedAgentYaml("email-drafter")),
        ),
      ),
    ]);
    expect(normal.value.status).toBe(200);
    expect(normal.ms).toBeLessThan(500);
    expect(slow.value.status).toBe(400);
  }, 20_000);

  it("answers a reader's failure with the bare 500, its line naming the error", async () => {
    vi.spyOn(sharedAgentYamlReader, "read").mockRejectedValueOnce(
      new AgentYamlReaderError("The agent.yaml reader failed"),
    );
    const res = await push(app, "web-scraper", trackedAgentYaml("web-scraper"));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    const unhandled = logged.filter(
      ({ args: [fields] }) =>
        (fields as { event?: string } | undefined)?.event === "unhandled_error",
    );
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]?.args[0]).toMatchObject({
      route: "/api/agents/:namespace/:name/push",
      error_name: "AgentYamlReaderError",
    });
  });
});

// The reads that wait for a thread are bounded: past them a push is refused
// 503 PUSH_BUSY, with a Retry-After, nothing stored. And a push whose client
// hangs up while its agent.yaml waits leaves the line, never read. Both push
// routes, mounted on a reader of one thread and a line of one read.
describe("both push routes — the reads that may wait, and a client gone while its read waits", () => {
  let db: MemoryDb;
  let storage: MemoryStorage;
  let reader: AgentYamlReader;
  let app: Hono;
  let dir: string;

  beforeEach(() => {
    logged.length = 0;
    db = new MemoryDb();
    storage = new MemoryStorage();
    reader = new AgentYamlReader({ budgetMs: 500, readsAtOnce: 1, waitingAtMost: 1 });
    const service = new RegistryService(storage, db, reader);
    const devUser = async (
      c: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("user", { id: "dev-user", namespace: "dev", username: "dev" });
      return next();
    };
    app = new Hono();
    // As the app mounts them: the agents directory's route first.
    app.route("/api", createScanRoutes(db, devUser as never, service, parseQuotaEnv({})));
    app.route(
      "/api",
      createRegistryRoutes(service, devUser as never, db, "admin", parseQuotaEnv({})),
    );
    dir = mkdtempSync(join(tmpdir(), "skrun-push-busy-"));
    mkdirSync(join(dir, "scanned"));
    writeFileSync(join(dir, "scanned", "agent.yaml"), minimalAgentYaml("scanned"));
    vi.stubEnv("SKRUN_AGENTS_DIR", dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A slow push holding the one thread, and an ordinary one waiting in the one place. */
  async function fillTheLine(): Promise<{ slow: Promise<Response>; waiting: Promise<Response> }> {
    const slow = push(app, "slow", slowAgentYaml("slow"));
    await vi.waitFor(() => expect(reader.load.reading).toBe(1));
    const waiting = push(app, "email-drafter", trackedAgentYaml("email-drafter"));
    await vi.waitFor(() => expect(reader.load.waiting).toBe(1));
    return { slow, waiting };
  }

  it("refuses a push past the reads that may wait 503 PUSH_BUSY, Retry-After: 3, nothing stored — at both routes", async () => {
    const { slow, waiting } = await fillTheLine();

    for (const res of [
      await push(app, "web-scraper", trackedAgentYaml("web-scraper")),
      await pushScanned(app, "scanned"),
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("3");
      expect(await errorOf(res)).toEqual({ code: "PUSH_BUSY", message: PUSH_BUSY_MESSAGE });
    }
    expect(await db.getAgent("dev", "web-scraper")).toBeNull();
    expect(await db.getAgent("dev", "scanned")).toBeNull();
    expect(await storage.get("dev/web-scraper/1.0.0.agent")).toBeNull();
    expect(linesOf("push_busy").map(({ args: [fields] }) => fields)).toEqual([
      { event: "push_busy", agent: "dev/web-scraper", agent_version: "1.0.0", waiting_at_most: 1 },
      { event: "push_busy", agent: "dev/scanned", agent_version: "1.0.0", waiting_at_most: 1 },
    ]);

    // The push in the line, within the bound, is read once the thread is free.
    expect((await slow).status).toBe(400);
    expect((await waiting).status).toBe(200);
    expect(await db.getAgent("dev", "email-drafter")).not.toBeNull();
  }, 15_000);

  it.each([
    [
      "the registry's push",
      (signal: AbortSignal) => push(app, "gone", minimalAgentYaml("gone"), signal),
      "gone",
    ],
    [
      "the push from the agents directory",
      (signal: AbortSignal) => pushScanned(app, "scanned", signal),
      "scanned",
    ],
  ])(
    "drops %s when its client hangs up while its read waits: its place freed at once, nothing stored, never read",
    async (_route, send, name) => {
      const slow = push(app, "slow", slowAgentYaml("slow"));
      await vi.waitFor(() => expect(reader.load.reading).toBe(1));
      const client = new AbortController();
      const gone = send(client.signal);
      await vi.waitFor(() => expect(reader.load.waiting).toBe(1));

      client.abort();
      expect(reader.load.waiting).toBe(0);
      // Nobody is left to answer: 499, no body — never the 500 of an error no
      // route handles.
      const res = await gone;
      expect(res.status).toBe(499);
      expect(await res.text()).toBe("");
      expect(linesOf("unhandled_error")).toEqual([]);

      // Its place is free: the next push waits in it, and is stored.
      const next = push(app, "email-drafter", trackedAgentYaml("email-drafter"));
      await vi.waitFor(() => expect(reader.load.waiting).toBe(1));
      expect((await slow).status).toBe(400);
      expect((await next).status).toBe(200);
      expect(await db.getAgent("dev", name)).toBeNull();
      expect(await storage.get(`dev/${name}/1.0.0.agent`)).toBeNull();
    },
    15_000,
  );
});

// Through the app as it serves: the request a route reads is the one the body
// limit rebuilt — its signal follows the client's —, and a refusal goes out
// with its Retry-After.
describe("POST push, through the app — the reads that may wait, and a client gone", () => {
  let app: App;
  let db: MemoryDb;

  beforeEach(() => {
    logged.length = 0;
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("answers a push past the reads that may wait 503 PUSH_BUSY with its Retry-After, at both routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-push-busy-app-"));
    try {
      mkdirSync(join(dir, "scanned"));
      writeFileSync(join(dir, "scanned", "agent.yaml"), minimalAgentYaml("scanned"));
      vi.stubEnv("SKRUN_AGENTS_DIR", dir);
      const read = vi.spyOn(sharedAgentYamlReader, "read");
      read.mockRejectedValue(new AgentYamlReaderBusyError(16));

      for (const res of [
        await push(app, "web-scraper", trackedAgentYaml("web-scraper")),
        await pushScanned(app, "scanned"),
      ]) {
        expect(res.status).toBe(503);
        expect(res.headers.get("Retry-After")).toBe("3");
        expect(await errorOf(res)).toEqual({ code: "PUSH_BUSY", message: PUSH_BUSY_MESSAGE });
      }
      // Each read was handed its request's signal.
      for (const [, signal] of read.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
      expect(await db.getAgent("dev", "web-scraper")).toBeNull();
      expect(linesOf("push_busy")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a push whose client hangs up while its read waits for the process's threads: 499, nothing stored, no unhandled_error", async () => {
    // Both of the process's threads hold a slow read.
    const slow = [
      push(app, "slow-a", slowAgentYaml("slow-a")),
      push(app, "slow-b", slowAgentYaml("slow-b")),
    ];
    await vi.waitFor(() => expect(sharedAgentYamlReader.load.reading).toBe(2), { timeout: 5_000 });
    const client = new AbortController();
    const gone = push(app, "gone", minimalAgentYaml("gone"), client.signal);
    await vi.waitFor(() => expect(sharedAgentYamlReader.load.waiting).toBe(1));

    client.abort();
    expect(sharedAgentYamlReader.load.waiting).toBe(0);
    expect((await gone).status).toBe(499);
    expect(linesOf("unhandled_error")).toEqual([]);
    for (const res of await Promise.all(slow)) expect(res.status).toBe(400);
    expect(await db.getAgent("dev", "gone")).toBeNull();
  }, 20_000);
});
