import { Agent, createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { LocalAdapter, type Logger, type RunEvent, type RunRequest } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { SERVER_STOPPING_REFUSAL } from "../routes/_helpers.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  _resetShutdownForTests,
  inFlightRunIds,
  installShutdownHandlers,
  type ShutdownProcess,
} from "./in-flight-runs.js";

/**
 * A run sent while the server stops, through the HTTP server the API runs on
 * (`@hono/node-server`), not through `app.request`: the window is only visible
 * on a real connection. `server.close()` takes no new connection, but a
 * connection kept alive across the signal — busy then, free once its answer is
 * out — still carries the next request, and the SDK's client and a proxy keep
 * theirs. Such a request reaches the run route at any point of the stop: after
 * the stop has ended its runs, while the server waits for its last answers to
 * go out, or once the stop has written its provisional failures, while it
 * waits for a run that ignores it. Either way it is refused before anything of
 * it is written, `503 SERVER_STOPPED`, and its connection closed.
 *
 * The stop's bounds are cut short for the case (a drain of 100 ms, a grace of
 * 3 s) and its signal comes from a process the case hands the handlers: the
 * real server, the real route, the real clock. Loopback only, on a port the
 * system picks; every connection is destroyed and the server closed after
 * each case.
 */

const { routeLines } = vi.hoisted(() => ({
  /** Every line the API's own loggers write, parsed: kept off the test's output. */
  routeLines: [] as Array<Record<string, unknown>>,
}));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const destination = {
    write(line: string) {
      routeLines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { ...actual, createLogger: (name: string) => actual.createLogger(name, destination) };
});

const DRAIN_MS = 100;
const GRACE_MS = 3_000;
const DEV_AUTH = { Authorization: "Bearer dev-token" };
const RUN_PATH = "/api/agents/dev/stops/run";

const savedRequest = globalThis.Request;
const savedResponse = globalThis.Response;

interface Answer {
  status: number;
  connection: string | undefined;
  body: string;
  /** Whether the request went out on a connection an earlier request had used. */
  reusedSocket: boolean;
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** A logger for the handlers: lines kept, a flush that answers at once. */
function handlerLogger(): { lines: Array<Record<string, unknown>>; log: Logger } {
  const lines: Array<Record<string, unknown>> = [];
  const record = (line: Record<string, unknown>) => {
    lines.push(line);
  };
  const log = {
    info: vi.fn(record),
    warn: vi.fn(record),
    error: vi.fn(record),
    flush: (cb: () => void) => cb(),
  };
  return { lines, log: log as unknown as Logger };
}

/** A process the handlers listen on: its signal sent by the case, its exits recorded. */
function fakeProcess() {
  const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
  const exits: number[] = [];
  const proc: ShutdownProcess = {
    on(signal, listener) {
      listeners.set(signal, listener);
    },
    exit(code) {
      exits.push(code);
    },
  };
  return { proc, exits, send: (signal: NodeJS.Signals) => listeners.get(signal)?.(signal) };
}

describe("a run sent while the server stops, on a connection kept alive across the signal", () => {
  let db: MemoryDb;
  let server: Server;
  let port: number;
  let executeStream: MockInstance;
  /** Released by the case: a run started through the route waits for it, the stop's signal ignored. */
  let runHold: ReturnType<typeof gate>;
  /** Released by the case: the slow route's answer waits for it. */
  let slowHold: ReturnType<typeof gate>;
  let slowEntered: ReturnType<typeof gate>;
  const agents: Agent[] = [];

  beforeEach(async () => {
    routeLines.length = 0;
    db = new MemoryDb();
    runHold = gate();
    slowHold = gate();
    slowEntered = gate();
    const app = createApp(new MemoryStorage(), db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
    });
    // A request still in progress as the stop begins: its connection is busy
    // at the signal, and free again once its answer is out. Added before the
    // app's first request, which builds its routes.
    app.get("/stop-probe/slow", async (c) => {
      slowEntered.open();
      await slowHold.opened;
      return c.text("slow done");
    });
    await pushLocalAgent(app);
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      // As the local runtime does: the stop's signal is not listened to.
      await runHold.opened;
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
        files_excluded: {},
      } satisfies RunEvent;
    });
    // As the server entry points do (`serve`): this listener also installs the
    // server's own Request and Response classes, restored after each case.
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // Whatever the case left going ends: its runs, its slow answer, its connections.
    try {
      runHold.open();
      slowHold.open();
      await vi.waitFor(() => expect(inFlightRunIds()).toEqual([]), { timeout: 5_000 });
    } finally {
      for (const agent of agents.splice(0)) agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.restoreAllMocks();
      bundleCache.clear();
      Object.defineProperty(globalThis, "Request", { value: savedRequest });
      Object.defineProperty(globalThis, "Response", { value: savedResponse });
      // Last: it throws on a stop still under way, and skips nothing then.
      _resetShutdownForTests();
    }
  });

  async function pushLocalAgent(app: ReturnType<typeof createApp>): Promise<void> {
    const agentYaml = [
      "name: stops",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from("# stops\n") },
    ]);
    const res = await app.request("/api/agents/dev/stops/push?version=1.0.0", {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** A connection pool of one, kept alive: each request after the first reuses its connection. */
  function keptAlive(): Agent {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    return agent;
  }

  function send(agent: Agent | false, method: "GET" | "POST", path: string): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      const body = method === "POST" ? JSON.stringify({ input: { q: "hello" } }) : undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          agent,
          headers: {
            ...DEV_AUTH,
            ...(body !== undefined && {
              "Content-Type": "application/json",
              "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
            }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              connection: res.headers.connection,
              body: text,
              reusedSocket: req.reusedSocket,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  /** The stop's handlers on the real server, the stop's bounds cut short; the signal is the case's to send. */
  function handlers() {
    const { proc, exits, send: signal } = fakeProcess();
    const { lines, log } = handlerLogger();
    installShutdownHandlers({ server, log, proc, drainMs: DRAIN_MS, graceMs: GRACE_MS });
    return { exits, lines, signal };
  }

  function refusal(answer: Answer): void {
    expect(answer.reusedSocket).toBe(true);
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({
      error: { code: "SERVER_STOPPED", message: SERVER_STOPPING_REFUSAL },
    });
    expect(answer.connection).toBe("close");
  }

  it("once the stop has ended its runs, while the server waits for its last answers: refused 503 SERVER_STOPPED before its row, its connection closed", async () => {
    const { exits, lines, signal } = handlers();
    const agent = keptAlive();
    const slow = send(agent, "GET", "/stop-probe/slow");
    await slowEntered.opened;

    signal("SIGTERM");
    // Nothing in flight: the stop returns at once, and the handlers wait for
    // the server's close — which waits for the slow answer's connection.
    await vi.waitFor(() => expect(lines.map((line) => line.event)).toContain("server_shutdown"), {
      timeout: 5_000,
    });
    slowHold.open();
    expect(await slow).toMatchObject({ status: 200, body: "slow done", reusedSocket: false });

    // A run started here would end at once: what is read is whether it starts.
    runHold.open();
    const run = await send(agent, "POST", RUN_PATH);

    expect(await db.listRuns()).toEqual([]);
    expect(executeStream).not.toHaveBeenCalled();
    refusal(run);
    // With that connection closed, the server is: the process exits well
    // before the grace's end, which a connection left open would have waited for.
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: GRACE_MS / 2 });
    expect(inFlightRunIds()).toEqual([]);
  });

  it("once the stop has written its provisional failures, while it waits for a run that ignores it: refused 503 SERVER_STOPPED before its row", async () => {
    const { exits, signal } = handlers();
    // A run in flight at the signal, on a connection of its own: it ignores the stop.
    const first = send(false, "POST", RUN_PATH);
    await vi.waitFor(() => expect(inFlightRunIds()).toHaveLength(1), { timeout: 5_000 });
    const [firstId] = inFlightRunIds();
    const agent = keptAlive();
    const slow = send(agent, "GET", "/stop-probe/slow");
    await slowEntered.opened;

    signal("SIGTERM");
    // The drain is over: the run in flight holds the stop's provisional failure.
    await vi.waitFor(
      async () =>
        expect(await db.getRun(String(firstId))).toMatchObject({
          status: "failed",
          error: SHUTDOWN_RUN_ERROR,
        }),
      { timeout: 5_000 },
    );
    slowHold.open();
    expect(await slow).toMatchObject({ status: 200, reusedSocket: false });

    const late = send(agent, "POST", RUN_PATH);
    // The process exits at the grace's end: the run in flight never settled.
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: GRACE_MS + 2_000 });

    // Nothing of the late run was written: the first run's row is the only one.
    expect((await db.listRuns()).map((row) => row.id)).toEqual([firstId]);
    expect(executeStream).toHaveBeenCalledTimes(1);
    refusal(await late);

    // The first run, let go once the process would have exited, still answers its caller.
    runHold.open();
    expect((await first).status).toBe(200);
  }, 15_000);
});
