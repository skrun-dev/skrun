/**
 * E2E: the clients' blocking run, through the real route and a real HTTP
 * server, against the cloud runtime.
 *
 * The cloud runtime refuses a synchronous run: its adapter only streams. Both
 * clients' blocking run — the SDK's `client.run()` and the CLI's
 * `RegistryClient.run()`, behind `skrun run` — therefore read the event stream
 * and collect the result from it, and must succeed there with the result the
 * synchronous call returns locally. Each client holds its own copy of that
 * collection (the CLI does not depend on the SDK): this file holds both copies
 * to the same shape.
 *
 * What is simulated: the cloud adapter's stream (a spy on the built runtime's
 * `FlyioAdapter`, the module the API resolves, so it reaches the route) — it
 * plays the events of a cold start (the acquisition heartbeat, the spawned
 * runner), one output file kept and one left out as too large, without a
 * machine or a model — and, for the
 * local reference, the model (a spy on the router's call). Its cloud
 * dependencies are the in-memory fakes of the route's own cloud tests. What is
 * real: the HTTP server, the route and its checks, the registry, the clients.
 */
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import {
  fakeFlyioDeps,
  pushRunnableAgent,
} from "../../packages/api/src/routes/flyio-run-harness.shared.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
import { resolveCallerKeys } from "../../packages/cli/src/commands/run.js";
import { useThrowawayProfile, writeSession } from "../../packages/cli/src/test-profile.shared.js";
import { connect, type RegistryClient } from "../../packages/cli/src/utils/registry-client.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import {
  FlyioAdapter,
  LLMRouter,
  type RunEvent,
  type RunRequest,
  runOutputKey,
} from "../../packages/runtime/dist/index.js";
import { SkrunClient } from "../../packages/sdk/src/index.js";

const NS = "dev";
const TOKEN = "dev-token";
const CALLER_KEY = "sk-ant-fake-caller-key";

let server: Server;
let baseUrl: string;
let storage: MemoryStorage;
let db: MemoryDb;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  storage = new MemoryStorage();
  db = new MemoryDb();
  app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });

  // A real HTTP server in front of the app, the response body passed on as it
  // is produced: the clients read a stream over a socket, as they do in use.
  server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const honoRes = await app.fetch(
      new Request(`${baseUrl}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      }),
    );
    res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
    if (honoRes.body) {
      for await (const chunk of honoRes.body) res.write(chunk);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

/**
 * The CLI client of this server, as `skrun run` gets it: a session for the
 * server, written in a throwaway profile, and the client from `connect()`.
 */
function cliClient(): RegistryClient {
  writeSession(useThrowawayProfile(), { address: baseUrl, token: TOKEN });
  return connect();
}

/** The caller keys each cloud run was handed, in order. */
let seenCallerKeys: Array<Record<string, string> | undefined>;

beforeEach(() => {
  seenCallerKeys = [];
  vi.spyOn(FlyioAdapter.prototype, "executeStream").mockImplementation(async function* (
    request: RunRequest,
  ): AsyncGenerator<RunEvent> {
    seenCallerKeys.push(request.callerKeys);
    const at = () => new Date().toISOString();
    const runId = request.runId;
    yield {
      type: "run_start",
      run_id: runId,
      timestamp: at(),
      agent: request.agentConfig.name,
      agent_version: request.agent_version ?? "unknown",
    };
    yield { type: "run_heartbeat", run_id: runId, timestamp: at(), stage: "acquiring_runner" };
    yield { type: "runner_spawned", run_id: runId, timestamp: at(), phases: { create_api_ms: 1 } };
    const key = runOutputKey(runId, "report.txt");
    await storage.put(key, Buffer.from("hello"));
    yield {
      type: "run_complete",
      run_id: runId,
      timestamp: at(),
      output: { answer: "scripted" },
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      cost: { estimated: 0.001 },
      duration_ms: 7,
      files: [{ name: "report.txt", size: 5, url: `https://objects.invalid/${key}` }],
      files_excluded: { too_large: 1 },
    };
  });
  // The local reference runs the real local adapter; only the model is simulated.
  vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
    content: '{"answer":"local"}',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    estimatedCost: 0.001,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    durationMs: 1,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The shape of a run result, values aside: each key with the type of its
 * value, and one level down for the `usage` and `cost` objects.
 */
function shapeOf(result: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  for (const [key, value] of Object.entries(result)) {
    shape[key] = typeOf(value);
    if (key === "usage" || key === "cost") {
      for (const [inner, v] of Object.entries(value as Record<string, unknown>)) {
        shape[`${key}.${inner}`] = typeOf(v);
      }
    }
  }
  return shape;
}

/** The synchronous result of the same agent on the local runtime: the reference shape. */
async function localSyncResult(name: string): Promise<Record<string, unknown>> {
  const localDb = new MemoryDb();
  const localApp = createApp(new MemoryStorage(), localDb);
  await pushRunnableAgent(localApp, localDb, NS, name);
  const res = await localApp.request(`/api/agents/${NS}/${name}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ anthropic: CALLER_KEY }),
    },
    body: JSON.stringify({ input: { q: "hello" } }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()) as Record<string, unknown>;
  expect(result.status).toBe("completed");
  return result;
}

describe("E2E: a blocking run against the cloud runtime", () => {
  it("client.run() reads the stream and returns the completed result", async () => {
    await pushRunnableAgent(app, db, NS, "stream-sdk-run");
    const client = new SkrunClient({ baseUrl, token: TOKEN });

    const result = await client.run(
      `${NS}/stream-sdk-run`,
      { q: "hello" },
      { llmKeys: { anthropic: CALLER_KEY } },
    );

    expect(result).toMatchObject({
      status: "completed",
      agent_version: "1.0.0",
      output: { answer: "scripted" },
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      cost: { estimated: 0.001 },
      duration_ms: 7,
    });
    expect(result.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.files).toEqual([
      { name: "report.txt", size: 5, url: expect.stringContaining("report.txt") },
    ]);
    expect(result.files_excluded).toEqual({ too_large: 1 });
    expect(result.error).toBeUndefined();
    expect(seenCallerKeys).toEqual([{ anthropic: CALLER_KEY }]);
  });

  it("the CLI's client reads the stream too, with the key read from --llm-key-env", async () => {
    await pushRunnableAgent(app, db, NS, "stream-cli-run");
    // The reader skrun run uses for --llm-key-env anthropic=<VARIABLE>.
    const llmKeys = await resolveCallerKeys(
      { llmKeyEnv: ["anthropic=SKRUN_E2E_ANTHROPIC_KEY"] },
      { SKRUN_E2E_ANTHROPIC_KEY: CALLER_KEY },
      async () => {
        throw new Error("stdin is not read for --llm-key-env");
      },
    );

    const result = await cliClient().run(NS, "stream-cli-run", { q: "hello" }, { llmKeys });

    expect(result).toMatchObject({
      status: "completed",
      agent_version: "1.0.0",
      output: { answer: "scripted" },
      duration_ms: 7,
      files_excluded: { too_large: 1 },
    });
    expect(seenCallerKeys).toEqual([{ anthropic: CALLER_KEY }]);
  });

  it("both clients return the shape of the local synchronous result", async () => {
    await pushRunnableAgent(app, db, NS, "stream-shape");
    const reference = shapeOf(await localSyncResult("stream-shape"));

    const bySdk = await new SkrunClient({ baseUrl, token: TOKEN }).run(
      `${NS}/stream-shape`,
      { q: "hello" },
      { llmKeys: { anthropic: CALLER_KEY } },
    );
    const byCli = await cliClient().run(
      NS,
      "stream-shape",
      { q: "hello" },
      { llmKeys: { anthropic: CALLER_KEY } },
    );

    expect(reference.status).toBe("string");
    expect(shapeOf(bySdk as unknown as Record<string, unknown>)).toEqual(reference);
    expect(shapeOf(byCli)).toEqual(reference);
  });

  it("the raw synchronous call is refused by name on the cloud runtime, with what works instead, before any run is written", async () => {
    await pushRunnableAgent(app, db, NS, "stream-raw-sync");
    const agent = await db.getAgent(NS, "stream-raw-sync");
    expect(agent?.id).toEqual(expect.any(String));

    const res = await fetch(`${baseUrl}/api/agents/${NS}/stream-raw-sync/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ anthropic: CALLER_KEY }),
      },
      body: JSON.stringify({ input: { q: "hello" } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "SYNC_MODE_UNSUPPORTED",
        message:
          "This server's runtime does not run an agent synchronously: read the run's event stream instead — an HTTP request with the 'Accept: text/event-stream' header, skrun run, or the SDK's client.run() (both return the one-shot result) — or send a webhook_url to receive the result when the run ends.",
      },
    });
    // The store is the whole file's: none of its rows is this agent's.
    expect((await db.listRuns()).filter((run) => run.agent_id === agent?.id)).toEqual([]);
  });
});
