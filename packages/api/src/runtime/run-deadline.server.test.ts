import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { LocalAdapter, type RunEvent, type RunRequest } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import type { Run } from "../db/schema.js";
import { createApp } from "../index.js";
import { RUN_DEADLINE_ERROR } from "../routes/_helpers.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  _resetShutdownForTests,
  DEADLINE_STREAM_GRACE_MS,
  inFlightRunIds,
} from "./in-flight-runs.js";

/**
 * A streamed run whose caller stops reading, through the HTTP server the API
 * runs on (`@hono/node-server`), not through `app.request`: the wait is only
 * real on a real connection. The run writes its events; the socket's buffers
 * fill; the server waits for the caller to drain them, the route for the
 * server, and the run — its adapter pulled one event at a time — for the
 * route: nothing of it moves on, its own timeout included, and on the cloud
 * runtime its machine stays up. At its seat's deadline the server stops it:
 * its row failed with the deadline's phrase and charged from its admission,
 * its signal aborted; and, the grace a caller who reads has to get its final
 * event passed, its stream closed, its adapter stopped — the machine
 * destroyed.
 *
 * The case's clock (fake `setTimeout`, `clearTimeout` and `Date`) drives the
 * admission, the deadline's timer and the run's own timeout; the server, the
 * socket and the route are real. Every wait is for a condition — the one that
 * says the run's wait has settled holding for a while of real time, since the
 * system's buffers settle on their own clock (`untilSettled`). Loopback only,
 * on a port the system picks; every connection is destroyed and the server
 * closed after the case.
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

const DEV_AUTH = { Authorization: "Bearer dev-token" };
const MIB = 1024 * 1024;
/** More than the socket's buffers hold on any system this runs on: the run waits long before. */
const MAX_EVENTS = 64;
/** What the cloud adapter's loop yields once its signal is aborted. */
const ABANDONED = "Run aborted by caller mid-iteration";
/** Generous: a slow machine runs these cases too. */
const CONDITION_TIMEOUT_MS = 20_000;
/**
 * How long, in real time, the run's wait must stay as it is to count as
 * settled — and in how many looks at least. A few turns of the event loop are
 * not enough: under load, the system's buffers still took in a write of the
 * server tens of milliseconds after its socket first read full and held still
 * for five turns — the route then handed on the event it held, and the run
 * moved on by one event, or by four. Ten times the longest such delay measured.
 */
const SETTLED_MS = 500;
const SETTLED_LOOKS = 10;

/** The timer the case's clock does not replace: what a wait in real time is made of. */
const realSetTimeout = globalThis.setTimeout;

/**
 * A look at the run's wait, once the event loop has polled its I/O: a real
 * timer, then a turn to the loop's check phase, which comes after the poll — a
 * write of the socket the system completed meanwhile is counted.
 */
async function afterThePoll(): Promise<void> {
  await new Promise((resolve) => realSetTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
}

const savedRequest = globalThis.Request;
const savedResponse = globalThis.Response;

describe("a streamed run whose caller stops reading, on a real connection", () => {
  let db: MemoryDb;
  let server: Server;
  let port: number;
  let executeStream: MockInstance;
  const serverSockets: Socket[] = [];
  let response: IncomingMessage | undefined;
  let clientSocket: Socket | undefined;
  /** The adapter's run: how many events it yielded, how many the route took, whether its machine was destroyed. */
  let adapter: { yielded: number; resumed: number; destroyed: boolean };

  beforeEach(async () => {
    routeLines.length = 0;
    db = new MemoryDb();
    adapter = { yielded: 0, resumed: 0, destroyed: false };
    const app = createApp(new MemoryStorage(), db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
    });
    await pushAgent(app);
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    // As the cloud adapter goes: run_start, then its loop's events, each pull
    // watching the run's signal — aborted, the abort's failure —, its machine
    // destroyed once its run is over. A tool result can be 1 MiB.
    executeStream.mockImplementation(async function* (request: RunRequest) {
      try {
        yield {
          type: "run_start",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          agent: request.agentConfig.name,
          agent_version: request.agent_version ?? "unknown",
        } satisfies RunEvent;
        for (let i = 0; i < MAX_EVENTS; i++) {
          if (request.abortSignal?.aborted) throw new Error(ABANDONED);
          adapter.yielded++;
          yield {
            type: "tool_result",
            run_id: request.runId,
            timestamp: new Date().toISOString(),
            tool: "big",
            result: "x".repeat(MIB),
            is_error: false,
          } satisfies RunEvent;
          adapter.resumed++;
        }
        await new Promise<void>((resolve) => {
          if (request.abortSignal?.aborted) resolve();
          request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error(ABANDONED);
      } catch {
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code: "ABORTED", message: ABANDONED },
        } satisfies RunEvent;
      } finally {
        adapter.destroyed = true;
      }
    });
    // As the server entry points do (`serve`): this listener also installs the
    // server's own Request and Response classes, restored after each case.
    server = createServer(getRequestListener(app.fetch));
    server.on("connection", (socket) => serverSockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      response?.destroy();
      clientSocket?.destroy();
      await vi.waitFor(() => expect(inFlightRunIds()).toEqual([]), { timeout: 5_000 });
    } finally {
      server.closeAllConnections();
      serverSockets.length = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.restoreAllMocks();
      bundleCache.clear();
      Object.defineProperty(globalThis, "Request", { value: savedRequest });
      Object.defineProperty(globalThis, "Response", { value: savedResponse });
      _resetShutdownForTests();
    }
  });

  async function pushAgent(app: ReturnType<typeof createApp>): Promise<void> {
    const agentYaml = [
      "name: stalled",
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
      { name: "SKILL.md", content: Buffer.from("# stalled\n") },
    ]);
    const res = await app.request("/api/agents/dev/stalled/push?version=1.0.0", {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** Send the run, read its stream until run_start, then stop reading it. */
  function startAndStopReading(): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const body = JSON.stringify({ input: { q: "hello" } });
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/agents/dev/stalled/run",
          method: "POST",
          agent: false,
          headers: {
            ...DEV_AUTH,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
          },
        },
        (res) => {
          let seen = "";
          const onData = (chunk: Buffer) => {
            seen += chunk.toString("latin1");
            if (seen.includes("event: run_start")) {
              res.off("data", onData);
              res.pause();
              resolve(res);
            }
          };
          res.on("data", onData);
        },
      );
      req.on("socket", (socket) => {
        clientSocket = socket;
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  /** What the run's wait is made of: the events the adapter yielded, the bytes each server socket holds unsent. */
  function waitState(): string {
    return `${adapter.yielded} ${serverSockets.map((socket) => socket.writableLength).join(",")}`;
  }

  /**
   * Wait until the run's wait has settled — the server's socket full, the
   * adapter held at an event the route has not taken (it yielded one more
   * than it was resumed), and neither the events yielded nor the bytes the
   * socket holds unsent changing for `SETTLED_MS` of real time and
   * `SETTLED_LOOKS` looks, each after the loop's poll —; hand back the events
   * it yielded.
   */
  async function untilSettled(): Promise<number> {
    const giveUpAt = performance.now() + CONDITION_TIMEOUT_MS;
    let seen = "";
    let since = 0;
    let looks = 0;
    for (;;) {
      await afterThePoll();
      const held =
        serverSockets.some((socket) => socket.writableNeedDrain) &&
        adapter.yielded === adapter.resumed + 1;
      const state = held ? waitState() : "";
      if (state === "" || state !== seen) {
        seen = state;
        since = performance.now();
        looks = 0;
      } else if (++looks >= SETTLED_LOOKS && performance.now() - since >= SETTLED_MS) {
        return adapter.yielded;
      }
      if (performance.now() > giveUpAt) {
        throw new Error(`the run's wait did not settle within ${CONDITION_TIMEOUT_MS} ms`);
      }
    }
  }

  it(
    "waits on its write until its seat's deadline, where its row is failed with the deadline's phrase and charged from its admission to its deadline; 10 s later its stream is closed and its adapter stopped — its machine destroyed",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      response = await startAndStopReading();
      expect(response.statusCode).toBe(200);
      const [row] = await db.listRuns();
      const { id } = row as Run;
      const deadlineMs = Date.parse(String(row?.deadline_at));
      const createdMs = Date.parse(String(row?.created_at));

      // The run waits: the server's socket full, the adapter held at an event
      // the route has not taken — and it stays so while nothing reads.
      const waitedAt = await untilSettled();
      expect(waitedAt).toBeLessThan(MAX_EVENTS);

      // Up to a millisecond before its deadline, nothing moves.
      await vi.advanceTimersByTimeAsync(deadlineMs - 1 - Date.now());
      expect(adapter.yielded).toBe(waitedAt);
      expect(adapter.destroyed).toBe(false);
      expect(await db.getRun(id)).toMatchObject({ status: "running" });

      // At its deadline its row is failed, charged from its admission to its deadline.
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(
        async () =>
          expect(await db.getRun(id)).toMatchObject({
            status: "failed",
            error: RUN_DEADLINE_ERROR,
            completed_at: new Date(deadlineMs).toISOString(),
            charged_ms: deadlineMs - createdMs,
          }),
        { timeout: CONDITION_TIMEOUT_MS },
      );
      // The grace for a caller who reads passes: still held at its write.
      await vi.advanceTimersByTimeAsync(deadlineMs + DEADLINE_STREAM_GRACE_MS - 1 - Date.now());
      expect(adapter.destroyed).toBe(false);
      expect(adapter.yielded).toBe(waitedAt);

      // Then its stream is closed: the run moves on, its machine destroyed.
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(adapter.destroyed).toBe(true), {
        timeout: CONDITION_TIMEOUT_MS,
      });
      await vi.waitFor(() => expect(inFlightRunIds()).toEqual([]), {
        timeout: CONDITION_TIMEOUT_MS,
      });

      // The caller who reads again gets what was on its way, then the stream's end.
      const ended = new Promise<void>((resolve) => response?.on("end", resolve));
      response.on("data", () => {});
      response.resume();
      await vi.waitFor(
        async () => {
          await Promise.race([ended, new Promise((resolve) => setImmediate(resolve))]);
          expect(response?.complete).toBe(true);
        },
        { timeout: CONDITION_TIMEOUT_MS },
      );
    },
    4 * CONDITION_TIMEOUT_MS,
  );

  /**
   * Whether the run's next write will wait for its caller: the server's socket
   * full, and the last tool result the run yielded not yet handed to it —
   * waiting in the stream behind the socket, the one place it can wait (a
   * write of the route returns only once its event is in that place) —, and
   * so for `SETTLED_MS` of real time and `SETTLED_LOOKS` looks, each after the
   * loop's poll, nothing handed to the socket and nothing it holds unsent
   * moving meanwhile. No at the first look that says otherwise: the run yields
   * one more. The socket counts every byte it was handed, its own buffer
   * included (`bytesWritten`).
   */
  async function nextWriteWaits(resultsYielded: number): Promise<boolean> {
    if (resultsYielded === 0) return false;
    const handed = () => Math.max(0, ...serverSockets.map((socket) => socket.bytesWritten));
    const state = () => `${handed()} ${waitState()}`;
    const first = state();
    const since = performance.now();
    for (let looks = 1; ; looks++) {
      await afterThePoll();
      const full = serverSockets.some((socket) => socket.writableNeedDrain);
      if (!full || state() !== first || handed() >= resultsYielded * MIB) return false;
      if (looks >= SETTLED_LOOKS && performance.now() - since >= SETTLED_MS) return true;
    }
  }

  /**
   * The two final events a run ends on, each closing its adapter: its
   * completion, and a failure of its own — the one its loop yields past the
   * agent's cost ceiling, for instance.
   */
  const FINAL_EVENTS: ReadonlyArray<
    readonly [
      ends: string,
      status: string,
      eventName: string,
      finalEvent: (runId: string) => RunEvent,
    ]
  > = [
    [
      "completes",
      "completed",
      "run_complete",
      (runId) => ({
        type: "run_complete",
        run_id: runId,
        timestamp: new Date().toISOString(),
        output: { answer: "done" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      }),
    ],
    [
      "fails",
      "failed",
      "run_error",
      (runId) => ({
        type: "run_error",
        run_id: runId,
        timestamp: new Date().toISOString(),
        error: { code: "COST_EXCEEDED", message: "The run's estimated cost exceeded its ceiling." },
      }),
    ],
  ];

  it.each(FINAL_EVENTS)(
    "that %s while its caller has stopped reading: its machine is destroyed as its status is written, its final event still waiting on the caller — and no deadline waited for",
    async (_ends, status, eventName, finalEvent) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      // As the cloud adapter goes, its machine destroyed in its `finally` once
      // its run is over: tool results of 1 MiB until the run's next write would
      // wait for its caller, then its final event — so that this event is the
      // write the caller who stopped reading holds.
      executeStream.mockImplementation(async function* (request: RunRequest) {
        try {
          yield {
            type: "run_start",
            run_id: request.runId,
            timestamp: new Date().toISOString(),
            agent: request.agentConfig.name,
            agent_version: request.agent_version ?? "unknown",
          } satisfies RunEvent;
          while (adapter.yielded < MAX_EVENTS && !(await nextWriteWaits(adapter.yielded))) {
            adapter.yielded++;
            yield {
              type: "tool_result",
              run_id: request.runId,
              timestamp: new Date().toISOString(),
              tool: "big",
              result: "x".repeat(MIB),
              is_error: false,
            } satisfies RunEvent;
            adapter.resumed++;
          }
          yield finalEvent(request.runId);
        } finally {
          adapter.destroyed = true;
        }
      });

      response = await startAndStopReading();
      expect(response.statusCode).toBe(200);
      const [row] = await db.listRuns();
      const { id } = row as Run;

      // The run ends: its row is written with its final status, and its
      // machine is destroyed — while its final event still waits on the
      // caller, the run not settled, and no time has passed.
      await vi.waitFor(async () => expect(await db.getRun(id)).toMatchObject({ status }), {
        timeout: CONDITION_TIMEOUT_MS,
      });
      expect(adapter.yielded).toBeLessThan(MAX_EVENTS);
      await vi.waitFor(() => expect(adapter.destroyed).toBe(true), {
        timeout: CONDITION_TIMEOUT_MS,
      });
      expect(inFlightRunIds()).toEqual([id]);
      expect(serverSockets.some((socket) => socket.writableNeedDrain)).toBe(true);

      // The caller who reads again gets the final event, then the stream's end.
      let received = "";
      const ended = new Promise<void>((resolve) => response?.on("end", resolve));
      response.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
      });
      response.resume();
      await vi.waitFor(
        async () => {
          await Promise.race([ended, new Promise((resolve) => setImmediate(resolve))]);
          expect(response?.complete).toBe(true);
        },
        { timeout: CONDITION_TIMEOUT_MS },
      );
      expect(received).toContain(`event: ${eventName}`);
      await vi.waitFor(() => expect(inFlightRunIds()).toEqual([]), {
        timeout: CONDITION_TIMEOUT_MS,
      });
    },
    4 * CONDITION_TIMEOUT_MS,
  );
});
