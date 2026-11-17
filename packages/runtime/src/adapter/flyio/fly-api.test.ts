import { beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSpawnError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import {
  CREATE_DIRECT_RETRY_WAITS_MS,
  type CreateMachineRequest,
  type CreateProgress,
  classifyCreateFailure,
  createWorstCaseMs,
  DUPLICATE_NAME_STATUS,
  FLY_429_BACKOFF_MS,
  FLY_429_MAX_RETRIES,
  FLY_APP_ACTION_BURST,
  FLY_APP_ACTION_RATE_PER_S,
  FLY_ATTEMPT_TIMEOUT_MS,
  FLY_RETRY_AFTER_CAP_MS,
  FlyMachinesApi,
  type FlyMachinesApiOptions,
  MachineSchema,
  SEARCH_READS,
  SEARCH_SPACING_MS,
} from "./fly-api.js";
import { buildMachineConfig, buildPoolMachineConfig } from "./machine-config.js";
import { RunnerPool } from "./pool.js";

const SAMPLE_MACHINE = {
  id: "fdmach_abc123",
  name: "skrun-run-test",
  state: "created" as const,
  region: "cdg",
  instance_id: "01234567",
  private_ip: "fdaa:0:1::1",
  image_ref: { registry: "ghcr.io", repository: "skrun-dev/skrun-runtime", tag: "v0.9.0" },
};

/**
 * A clock for the client's waits that no real timer drives: `now` reads it,
 * `sleep` books a wake-up on it, and `settle` moves it — each time the work in
 * flight has run out, it jumps to the earliest wake-up and wakes that sleeper —
 * until the given promise settles.
 *
 * A wait the client made outside this clock leaves nothing to wake: real time is
 * then given in small steps, up to a bound, after which `settle` fails by name
 * rather than hanging.
 */
function virtualClock(start = 0) {
  let now = start;
  let seq = 0;
  const sleepers: Array<{ at: number; seq: number; wake: () => void }> = [];
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, seq: seq++, wake: resolve });
      }),
    async settle<T>(work: Promise<T>): Promise<T> {
      let settled = false;
      work.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const realBound = Date.now() + 3_000;
      for (;;) {
        await flush();
        if (settled) return work;
        sleepers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = sleepers.shift();
        if (next) {
          now = Math.max(now, next.at);
          next.wake();
          continue;
        }
        if (Date.now() >= realBound) {
          throw new Error("the client still waits on something this clock does not drive");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

function runMachine(runId: string): CreateMachineRequest {
  return buildMachineConfig({
    runId,
    image: "img",
    allowedHosts: [],
  });
}

function poolMachine(poolId: string): CreateMachineRequest {
  return buildPoolMachineConfig({ poolId, image: "img", claimToken: "c".repeat(64) });
}

/** A `fetch` failure the way Node reports one: a TypeError, the cause carrying the code. */
function networkFailure(code?: string): TypeError {
  const cause = Object.assign(new Error(`network failure ${code ?? ""}`.trim()), { code });
  return new TypeError("fetch failed", { cause });
}

/** Every address of the host tried, each failing with its own code. */
function everyAddressFailing(...codes: string[]): TypeError {
  const errors = codes.map((code) => Object.assign(new Error(`connect ${code}`), { code }));
  const cause = Object.assign(new AggregateError(errors, ""), { code: codes[0] });
  return new TypeError("fetch failed", { cause });
}

/** A machine as the platform holds it. */
interface HeldMachine {
  id: string;
  name: string;
  state: string;
  private_ip?: string;
  config: CreateMachineRequest["config"];
  created_at: string;
}

/**
 * What one creation request gets: its machine made and returned; made, then the
 * connection reset before the answer; the connection reset before the platform
 * got it; or an answer of a status, a machine made or not.
 */
type CreationAnswer =
  | "answer"
  | "made-then-reset"
  | "lost"
  | { status: number; body?: string; made?: boolean };

/**
 * The platform, for the cases where a creation's outcome turns unknown. A
 * creation makes the machine its body asks for — in `stateOnMake`, with a fresh
 * id and private address — unless the case says it never got there, then
 * answers as the case says. A listing filtered on a label returns the machines
 * that carry it, as the platform does — or every machine, when it ignores the
 * filter; `show` lets a case decide what each read sees, or answer it with a
 * status. Every request is recorded with the clock time it left at.
 */
class RecoveryPlatform {
  readonly held: HeldMachine[] = [];
  readonly sent: Array<{ method: string; path: string; at: number }> = [];
  readonly destroyed: string[] = [];
  /** What each creation request gets, in turn; past the list, its machine. */
  creations: CreationAnswer[] = [];
  stateOnMake = "created";
  addressOnMake = true;
  ignoreFilter = false;
  /** What the nth labelled read (from 1) sees: by default, every machine held. */
  show: (read: number, held: HeldMachine[]) => HeldMachine[] | Response = (_read, held) => held;
  private reads = 0;
  private seq = 0;

  constructor(private readonly clock: { now: () => number }) {}

  /** A machine already on the platform, made by an earlier request or by someone else. */
  hold(name: string, metadata: Record<string, string>, extra: Partial<HeldMachine> = {}) {
    const machine = this.make({ name, config: { image: "img", metadata } });
    Object.assign(machine, extra);
    return machine;
  }

  posts(): number {
    return this.sent.filter((s) => s.method === "POST").length;
  }

  gets(): Array<{ path: string; at: number }> {
    return this.sent.filter((s) => s.method === "GET").map(({ path, at }) => ({ path, at }));
  }

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.sent.push({ method, path: `${url.pathname}${url.search}`, at: this.clock.now() });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as CreateMachineRequest;
      const how = this.creations.shift() ?? "answer";
      if (how === "lost") throw networkFailure("ECONNRESET");
      const made = typeof how === "string" || how.made === true ? this.make(body) : undefined;
      if (how === "answer") return new Response(JSON.stringify(made), { status: 200 });
      if (how === "made-then-reset") throw networkFailure("ECONNRESET");
      return new Response(how.body ?? "", { status: how.status });
    }
    if (method === "DELETE") {
      const id = url.pathname.split("/").pop() ?? "";
      this.destroyed.push(id);
      const at = this.held.findIndex((m) => m.id === id);
      if (at >= 0) this.held.splice(at, 1);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    this.reads += 1;
    const shown = this.show(this.reads, [...this.held]);
    if (shown instanceof Response) return shown;
    const filters = [...url.searchParams].filter(([key]) => key.startsWith("metadata."));
    const listed = this.ignoreFilter
      ? shown
      : shown.filter((m) =>
          filters.every(
            ([key, value]) => m.config.metadata?.[key.slice("metadata.".length)] === value,
          ),
        );
    return new Response(JSON.stringify(listed), { status: 200 });
  }) as typeof fetch;

  private make(body: CreateMachineRequest): HeldMachine {
    this.seq += 1;
    const machine: HeldMachine = {
      id: `m-${this.seq}`,
      name: body.name ?? `unnamed-${this.seq}`,
      state: this.stateOnMake,
      private_ip: this.addressOnMake ? `fdaa:0:1::${this.seq}` : undefined,
      config: body.config,
      created_at: new Date(Date.UTC(2026, 9, 13, 12, 0, this.seq)).toISOString(),
    };
    this.held.push(machine);
    return machine;
  }
}

/** A client of the recovery platform, on a virtual clock. */
function recoveringClient(
  platform: RecoveryPlatform,
  clock: ReturnType<typeof virtualClock>,
  logger?: Logger,
): FlyMachinesApi {
  return new FlyMachinesApi("token", "app", {
    fetchImpl: platform.fetch,
    nowImpl: clock.now,
    sleepImpl: clock.sleep,
    logger,
  });
}

/** A logger that keeps what each line says, and drops the words. */
function recordingLogger() {
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const at = (level: string) => (fields: Record<string, unknown>) => {
    lines.push({ level, fields });
  };
  const logger = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  } as unknown as Logger;
  return { logger, lines };
}

/** How one request of {@link silentPlatform} is answered. */
type SilentAnswer =
  /** Never — until its signal aborts. */
  | "silent"
  /** A status and headers at once, then a body that never ends — until its signal aborts. */
  | "headers"
  /** What the function returns, at once. */
  | (() => Response);

/**
 * A platform that keeps silent: a request is never answered until its signal
 * aborts, which rejects it — or ends the body it was reading — with the
 * signal's reason, as Node's fetch does; a signal already aborted when the
 * request leaves rejects it at once. `answers` scripts the requests from the
 * first, each kept silent past the list. `onSend` is told each request as it
 * leaves (its number, from 1). Records each request with the signal it
 * carried, and whether that signal had already aborted when it left.
 */
function silentPlatform(answers: SilentAnswer[] = [], onSend?: (n: number) => void) {
  const sent: Array<{
    method: string;
    path: string;
    signal?: AbortSignal | null;
    abortedWhenSent: boolean;
  }> = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const signal = init?.signal;
    sent.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      signal,
      abortedWhenSent: signal?.aborted === true,
    });
    onSend?.(sent.length);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const how = answers[sent.length - 1] ?? "silent";
    if (typeof how === "function") return Promise.resolve(how());
    if (how === "headers") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

/** Real time, in ms: the bound of every attempt is a real timer, never a simulated clock's. */
function realWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LABELLED_LISTING = "/v1/apps/app/machines?metadata.skrun_run_id=r1";

describe("FlyMachinesApi", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  function recordingSleep(waits: number[]) {
    return async (ms: number) => {
      waits.push(ms);
    };
  }

  // Scripted answers, then `rest` on every later call — up to a cap, past which
  // the platform accepts. A loop that stops counting its retries then fails the
  // test on what it asserts instead of spinning forever: the recorded waits are
  // instant, so no test timeout would ever fire. A fresh response per call, as
  // the platform sends — a body reads once.
  function answerInTurn(first: Array<() => Response>, rest: () => Response) {
    fetchSpy.mockImplementation(async () => {
      const n = fetchSpy.mock.calls.length; // this call included
      if (n > 50) return new Response("", { status: 200 });
      return (first[n - 1] ?? rest)();
    });
  }

  /** Answers every call at once; records each request with the clock time it left at. */
  function platformRecording(clock: { now: () => number }) {
    const sent: Array<{ method: string; at: number; name?: string }> = [];
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const name = method === "POST" ? JSON.parse(String(init.body)).name : undefined;
      sent.push({ method, at: clock.now(), name });
      const body = method === "GET" ? [SAMPLE_MACHINE] : SAMPLE_MACHINE;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return sent;
  }

  describe("create", () => {
    it("POSTs to /apps/{app}/machines with Bearer auth + JSON body", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 }));
      const api = new FlyMachinesApi("test-token", "skrun-app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const result = await api.create({
        name: "skrun-run-test",
        region: "cdg",
        config: { image: "ghcr.io/skrun-dev/skrun-runtime:latest" },
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/skrun-app/machines");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer test-token");
      expect(init.headers["Content-Type"]).toBe("application/json");
      const sent = JSON.parse(init.body);
      expect(sent.name).toBe("skrun-run-test");
      expect(sent.config.image).toBe("ghcr.io/skrun-dev/skrun-runtime:latest");

      expect(result.id).toBe("fdmach_abc123");
      expect(result.state).toBe("created");
    });

    it("throws MachineSpawnError on 4xx with HTTP status + body in cause", async () => {
      fetchSpy.mockResolvedValue(new Response("Invalid image", { status: 422 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await expect(
        api.create({ name: "skrun-run-bad", config: { image: "bogus" } }),
      ).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: {
          httpStatus: 422,
          phase: "create",
          machineId: null,
          machineName: "skrun-run-bad",
        },
      });
    });

    it("throws MachineSpawnError when response schema mismatches", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 123, state: "alien" }), { status: 200 }),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await expect(
        api.create({ name: "skrun-run-x", config: { image: "img" } }),
      ).rejects.toBeInstanceOf(MachineSpawnError);
    });
  });

  describe("start / stop / destroy", () => {
    it("start POSTs to /machines/{id}/start", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.start("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/start");
      expect(init.method).toBe("POST");
    });

    it("suspend POSTs to /machines/{id}/suspend", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.suspend("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/suspend");
      expect(init.method).toBe("POST");
    });

    // The pool's resume path reuses start() unchanged — Fly documents the standard
    // start endpoint as what resumes a suspended machine. Asserted so a future
    // refactor cannot quietly introduce a separate "resume" call.
    it("resumes a suspended machine through start, not a separate endpoint", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.suspend("fdmach_abc123");
      await api.start("fdmach_abc123");
      expect(fetchSpy.mock.calls.map(([url]) => String(url).split("/").pop())).toEqual([
        "suspend",
        "start",
      ]);
    });

    it("suspend maps a Fly error to MachineSpawnError like its siblings", async () => {
      fetchSpy.mockResolvedValue(new Response("machine not suspendable", { status: 400 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        maxRetries: 0,
      });
      await expect(api.suspend("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 400 },
      });
    });

    it("stop POSTs to /machines/{id}/stop", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.stop("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/stop");
      expect(init.method).toBe("POST");
    });

    it("destroy DELETEs /machines/{id}?force=true (force needed to destroy a still-started machine)", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.destroy("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123?force=true");
      expect(init.method).toBe("DELETE");
    });
  });

  // One key of a machine's metadata, written: what an assigned pooled machine
  // carries — its run, the end of its life — so that whoever lists the app can
  // judge it. The platform answers 204, and the machine is not restarted.
  describe("setMetadata", () => {
    it("POSTs the value to /machines/{id}/metadata/{key}, and a 204 is the write done", async () => {
      fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
      const api = new FlyMachinesApi("test-token", "skrun-app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const outcome = await api.setMetadata("fdmach_abc123", "skrun_run_id", "r1");

      expect(outcome).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://api.machines.dev/v1/apps/skrun-app/machines/fdmach_abc123/metadata/skrun_run_id",
      );
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer test-token");
      expect(JSON.parse(init.body)).toEqual({ value: "r1" });
    });

    it("encodes the machine and the key in the path, never the value", async () => {
      fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      await api.setMetadata("m/1", "a key", "2026-10-28T12:00:00.000Z");

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/m%2F1/metadata/a%20key");
      expect(JSON.parse(init.body)).toEqual({ value: "2026-10-28T12:00:00.000Z" });
    });

    it.each([
      400, 404, 422,
    ])("a write refused %i fails at once, on that status — never sent again", async (status) => {
      fetchSpy.mockResolvedValue(new Response("refused", { status }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: async () => {},
      });

      const outcome = await api.setMetadata("m1", "skrun_run_id", "r1").catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: status, machineId: "m1" } });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("a write refused for the machine's rate is waited out, as every call on one machine is", async () => {
      const waits: number[] = [];
      answerInTurn(
        [() => new Response("", { status: 429 })],
        () => new Response(null, { status: 204 }),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await api.setMetadata("m1", "skrun_run_id", "r1");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([250]);
    });

    it("two writes at once are two requests, each with its own value — never one shared", async () => {
      const pending: Array<() => void> = [];
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            const answer = () => resolve(new Response(null, { status: 204 }));
            const guard = setTimeout(answer, 2_000);
            pending.push(() => {
              clearTimeout(guard);
              answer();
            });
          }),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const both = Promise.all([
        api.setMetadata("m1", "skrun_run_id", "r1"),
        api.setMetadata("m1", "skrun_run_id", "r2"),
      ]);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      for (const answer of pending.splice(0)) answer();
      await both;

      expect(fetchSpy.mock.calls.map(([, init]) => JSON.parse(init.body).value)).toEqual([
        "r1",
        "r2",
      ]);
    });
  });

  // A machine can be gone before its destruction is asked: destroyed by an
  // earlier request, or by the platform itself. The platform then answers 404 —
  // and the destruction asked for is done, never a failure to report.
  describe("a machine already gone", () => {
    const gone = () => new Response('{"error":"machine not found"}', { status: 404 });

    it("destroy is done when the platform answers that the machine is not there: one line says so, no warning", async () => {
      fetchSpy.mockImplementation(async () => gone());
      const { logger, lines } = recordingLogger();
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        logger,
      });

      const outcome = await api.destroy("m1").then(
        () => "done",
        (e: unknown) => e,
      );

      expect(outcome).toBe("done");
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(lines).toEqual([
        { level: "info", fields: { event: "machine_already_gone", machine_id: "m1" } },
      ]);
    });

    it("two destroys of a machine already gone share one request, and both are done", async () => {
      fetchSpy.mockImplementation(async () => gone());
      const { logger, lines } = recordingLogger();
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        logger,
      });

      const outcomes = await Promise.all(
        [api.destroy("m1"), api.destroy("m1")].map((call) =>
          call.then(
            () => "done",
            (e: unknown) => e,
          ),
        ),
      );

      expect(outcomes).toEqual(["done", "done"]);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(lines.map((l) => l.fields.event)).toEqual(["machine_already_gone"]);
    });

    it.each([
      ["start", (api: FlyMachinesApi) => api.start("m1")],
      ["suspend", (api: FlyMachinesApi) => api.suspend("m1")],
      ["stop", (api: FlyMachinesApi) => api.stop("m1")],
    ])("%s still fails on a 404: only a destruction asks for the machine to be gone", async (_what, call) => {
      fetchSpy.mockImplementation(async () => gone());
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        logger: recordingLogger().logger,
      });

      await expect(call(api)).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 404 },
      });
    });

    it("a destroy refused for another reason still fails", async () => {
      fetchSpy.mockImplementation(async () => new Response("forbidden", { status: 403 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        logger: recordingLogger().logger,
      });

      await expect(api.destroy("m1")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 403 },
      });
    });
  });

  // A destruction without force asks the platform to destroy a machine only if
  // it is not running. Measured against the platform on 2026-10-23: it destroys
  // a stopped or a suspended machine, and refuses a started one, one created and
  // never started, and a suspended one woken just before — 412, with this body.
  // That refusal is the answer the order was sent for, not a failure.
  describe("a destruction without force", () => {
    const REFUSED_IN_STATE_BODY =
      '{"error":"failed_precondition: unable to destroy machine, not currently stopped, suspended, failed, pending, or archived"}';
    const refusedInState = () => new Response(REFUSED_IN_STATE_BODY, { status: 412 });
    const url = (call: number) => String(fetchSpy.mock.calls[call][0]);

    function client(answer: (url: string) => Response) {
      fetchSpy.mockImplementation(async (input: string) => answer(String(input)));
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: async () => {},
        logger: recordingLogger().logger,
      });
    }

    it("is sent without ?force=true when force is false, and with it by default", async () => {
      const api = client(() => new Response('{"ok":true}', { status: 200 }));

      const unforced = await api.destroy("m1", { force: false });
      const byDefault = await api.destroy("m2");
      const forced = await api.destroy("m3", { force: true });

      expect([url(0), url(1), url(2)]).toEqual([
        "https://api.machines.dev/v1/apps/app/machines/m1",
        "https://api.machines.dev/v1/apps/app/machines/m2?force=true",
        "https://api.machines.dev/v1/apps/app/machines/m3?force=true",
      ]);
      expect([unforced, byDefault, forced]).toEqual(["destroyed", "destroyed", "destroyed"]);
    });

    it("resolves refused-in-state when the platform refuses it in the machine's state (412 failed_precondition): one request, never a failure", async () => {
      const api = client(refusedInState);

      const outcome = await api.destroy("m1", { force: false }).then(
        (value) => value,
        (e: unknown) => e,
      );

      expect(outcome).toBe("refused-in-state");
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("is destroyed when the machine is already gone (404)", async () => {
      const api = client(() => new Response('{"error":"machine not found"}', { status: 404 }));

      await expect(api.destroy("m1", { force: false })).resolves.toBe("destroyed");
    });

    it("still fails on another status whose body says failed_precondition", async () => {
      const api = client(() => new Response(REFUSED_IN_STATE_BODY, { status: 400 }));

      await expect(api.destroy("m1", { force: false })).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 400 },
      });
    });

    it("still fails on a 412 of another body", async () => {
      const api = client(() => new Response('{"error":"precondition failed"}', { status: 412 }));

      await expect(api.destroy("m1", { force: false })).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 412 },
      });
    });

    it("with force, the same 412 is still a failure: only a destruction without force asks for the machine's state", async () => {
      const api = client(refusedInState);

      await expect(api.destroy("m1")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 412 },
      });
    });

    // The query is part of what two concurrent calls share: a destruction with
    // force must never hand its answer to one without, nor the other way round.
    it("is never shared with a forced destruction of the same machine", async () => {
      const api = client((target) =>
        target.endsWith("?force=true") ? new Response("", { status: 200 }) : refusedInState(),
      );

      const outcomes = await Promise.all([api.destroy("m1"), api.destroy("m1", { force: false })]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(outcomes).toEqual(["destroyed", "refused-in-state"]);
    });

    it("two destructions without force of one machine share one request, and both read the refusal", async () => {
      const api = client(refusedInState);

      const outcomes = await Promise.all([
        api.destroy("m1", { force: false }),
        api.destroy("m1", { force: false }),
      ]);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(outcomes).toEqual(["refused-in-state", "refused-in-state"]);
    });
  });

  describe("list", () => {
    it("GETs /machines and parses an array of machines", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify([SAMPLE_MACHINE]), { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const result = await api.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("fdmach_abc123");
    });
  });

  // The platform documents seventeen machine states. A listing carries every
  // machine of the app, so one machine in a state the client cannot read must
  // never make the whole listing fail — the pool's reconciliation reads it.
  describe("machine states", () => {
    const DOCUMENTED_STATES = [
      // persistent
      "created",
      "started",
      "stopped",
      "suspended",
      "failed",
      // transient
      "creating",
      "starting",
      "stopping",
      "restarting",
      "suspending",
      "destroying",
      "launch_failed",
      "updating",
      "replacing",
      // terminal
      "destroyed",
      "replaced",
      "migrated",
    ];

    it.each(DOCUMENTED_STATES)("reads a machine in the documented state %s as it is", (state) => {
      const parsed = MachineSchema.safeParse({ ...SAMPLE_MACHINE, state });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.state).toBe(state);
    });

    it("reads a state it does not know as unknown instead of failing", () => {
      const parsed = MachineSchema.safeParse({ ...SAMPLE_MACHINE, state: "hibernating" });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.state).toBe("unknown");
    });

    it("lists machines in states it did not read before, and returns those states", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify([
            { ...SAMPLE_MACHINE, id: "m-creating", state: "creating" },
            { ...SAMPLE_MACHINE, id: "m-failed", state: "failed" },
            { ...SAMPLE_MACHINE, id: "m-odd", state: "hibernating" },
          ]),
          { status: 200 },
        ),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const states = api.list().then((machines) => machines.map((m) => [m.id, m.state]));

      await expect(states).resolves.toEqual([
        ["m-creating", "creating"],
        ["m-failed", "failed"],
        ["m-odd", "unknown"],
      ]);
    });
  });

  // A machine is found again by the label in its configuration, so reading a
  // machine keeps it. The platform may hold other pairs there, of any kind: none
  // of them may fail the machine, nor so the listing that carries it.
  describe("labels read back", () => {
    it("keeps the label a machine carries in its configuration", () => {
      const parsed = MachineSchema.parse({
        ...SAMPLE_MACHINE,
        config: { image: "img", metadata: { skrun_run_id: "r1" } },
      });
      expect(parsed.config?.metadata).toEqual({ skrun_run_id: "r1" });
    });

    it("reads a label pair whose value is not text without failing the machine", () => {
      const parsed = MachineSchema.safeParse({
        ...SAMPLE_MACHINE,
        config: {
          image: "img",
          metadata: { skrun_run_id: "r1", platform_version: 2, nested: { a: 1 } },
        },
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.config?.metadata?.skrun_run_id).toBe("r1");
      expect(parsed.data?.config?.metadata?.platform_version).toBe(2);
    });

    it("reads labels that are not a set of pairs as none, without failing the machine", () => {
      for (const metadata of [null, "skrun_run_id=r1", ["r1"]]) {
        const parsed = MachineSchema.safeParse({
          ...SAMPLE_MACHINE,
          config: { image: "img", metadata },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.config?.image).toBe("img");
        expect(parsed.data?.config?.metadata).toBeUndefined();
      }
    });

    it("lists machines whose labels hold values of any kind, and returns those labels", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              ...SAMPLE_MACHINE,
              id: "m-run",
              config: { image: "img", metadata: { skrun_run_id: "r1" } },
            },
            { ...SAMPLE_MACHINE, id: "m-odd", config: { image: "img", metadata: { count: 3 } } },
            { ...SAMPLE_MACHINE, id: "m-null", config: { image: "img", metadata: null } },
          ]),
          { status: 200 },
        ),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const labels = api.list().then((machines) => machines.map((m) => [m.id, m.config?.metadata]));

      await expect(labels).resolves.toEqual([
        ["m-run", { skrun_run_id: "r1" }],
        ["m-odd", { count: 3 }],
        ["m-null", undefined],
      ]);
    });
  });

  describe("429 backoff retry", () => {
    it("waits out a creation's 429s, one then two seconds when the platform names no wait", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 }));
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });
      const result = await api.create({ name: "skrun-run-r", config: { image: "img" } });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(waits).toEqual([1000, 2000]);
      expect(result.id).toBe("fdmach_abc123");
    });

    it("throws MachineSpawnError when a call on one machine exhausts its 429 retries", async () => {
      fetchSpy.mockImplementation(async () => new Response("rate limited", { status: 429 }));
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        maxRetries: 2,
        sleepImpl: recordingSleep(waits),
      });
      await expect(api.suspend("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 429 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(waits).toEqual([250, 500]);
    });

    it("retries a network error on the same budget, then reports it without a status", async () => {
      const failure = new TypeError("fetch failed");
      answerInTurn([], () => {
        throw failure;
      });
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      const err = await api.start("fdmach_abc123").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MachineSpawnError);
      expect(err).toMatchObject({ details: { httpStatus: null, phase: "boot-probe" } });
      expect((err as MachineSpawnError).cause).toBe(failure);
      // 1 + maxRetries (3) attempts, the 429 waits.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(waits).toEqual([250, 500, 1000]);
    });
  });

  // Fly can list a machine as suspended while it is still writing its snapshot,
  // and refuses a start sent in that interval. The pool wakes a machine with
  // start(), so a refusal there threw the machine away and sent the run down the
  // cold path. Only start() waits it out, and only for that refusal.
  describe("start on a machine still suspending", () => {
    const STILL_ACTIVE = JSON.stringify({
      error: "failed_precondition: machine still active, refusing to start",
    });

    const stillActive = () => new Response(STILL_ACTIVE, { status: 412 });
    const rateLimited = () => new Response("rate limited", { status: 429 });

    // A fresh response per attempt, as the platform sends: a body reads once, so
    // a shared one would read empty from the second attempt and hide a retry.
    function answerEvery(body: string, status: number) {
      answerInTurn([], () => new Response(body, { status }));
    }

    it("retries a 412 'still active' and succeeds once the machine can be woken", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response(STILL_ACTIVE, { status: 412 }))
        .mockResolvedValueOnce(new Response(STILL_ACTIVE, { status: 412 }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await api.start("fdmach_abc123");

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(waits).toEqual([500, 1000]);
    });

    it("gives up after its own margin with today's error, the platform's body in the cause", async () => {
      // Another wording around the same two markers: the match does not hang on
      // the exact sentence.
      answerEvery('{"error":"failed_precondition: unable to start, machine still active"}', 412);
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      const err = await api.start("fdmach_abc123").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MachineSpawnError);
      expect(err).toMatchObject({
        details: { httpStatus: 412, phase: "boot-probe", machineId: "fdmach_abc123" },
      });
      expect(((err as MachineSpawnError).cause as Error).message).toContain("still active");
      // 1 + 4 attempts, 7.5 s of waiting in all.
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect(waits).toEqual([500, 1000, 2000, 4000]);
    });

    it("does not retry another 412", async () => {
      answerEvery('{"error":"failed_precondition: machine is not suspended"}', 412);
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await expect(api.start("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 412, phase: "boot-probe" },
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(waits).toEqual([]);
    });

    // The two margins are counted apart: waiting out the refusal spends nothing
    // of the 429 budget, and the reverse.
    it("keeps the whole 429 budget after waiting out the refusal", async () => {
      answerInTurn([stillActive, stillActive], rateLimited);
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await expect(api.start("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 429 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(6);
      expect(waits).toEqual([500, 1000, 250, 500, 1000]);
    });

    it("keeps its whole margin after 429s", async () => {
      answerInTurn([rateLimited, rateLimited], stillActive);
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await expect(api.start("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 412 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(7);
      expect(waits).toEqual([250, 500, 500, 1000, 2000, 4000]);
    });

    it.each([
      [
        "create",
        (api: FlyMachinesApi) => api.create({ name: "skrun-run-x", config: { image: "img" } }),
      ],
      ["suspend", (api: FlyMachinesApi) => api.suspend("fdmach_abc123")],
      ["stop", (api: FlyMachinesApi) => api.stop("fdmach_abc123")],
      ["destroy", (api: FlyMachinesApi) => api.destroy("fdmach_abc123")],
      ["list", (api: FlyMachinesApi) => api.list()],
    ])("does not retry a 412 'still active' on %s", async (_name, call) => {
      answerEvery(STILL_ACTIVE, 412);
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await expect(call(api)).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 412 },
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(waits).toEqual([]);
    });
  });

  describe("inflight dedup", () => {
    it("returns the same promise for concurrent identical (method, path) calls", async () => {
      let resolveFetch: ((r: Response) => void) | null = null;
      const blockingResponse = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      fetchSpy.mockReturnValue(blockingResponse);
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      // Fire two concurrent list() calls in the same tick — the second should
      // hit the inflight map and reuse the first call's pending promise.
      const p1 = api.list();
      const p2 = api.list();

      // Resolve the single fetch — both list() promises should complete.
      resolveFetch?.(new Response(JSON.stringify([SAMPLE_MACHINE]), { status: 200 }));

      const [a, b] = await Promise.all([p1, p2]);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(a).toEqual(b);
    });

    // Every request held until the test lets them all answer — or, should the test
    // never get there, until a guard answers them — each with a fresh response, so
    // that whatever was sent concurrently is counted while in flight.
    function holdEveryRequest(body: string) {
      const pending: Array<() => void> = [];
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            const answer = () => resolve(new Response(body, { status: 200 }));
            const guard = setTimeout(answer, 2_000);
            pending.push(() => {
              clearTimeout(guard);
              answer();
            });
          }),
      );
      return () => {
        for (const answer of pending.splice(0)) answer();
      };
    }

    it("shares one request between two concurrent destroys of the same machine", async () => {
      const answerAll = holdEveryRequest("");
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const both = Promise.all([api.destroy("m1"), api.destroy("m1")]);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      answerAll();
      await both;

      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("never shares a request between two different machines", async () => {
      const answerAll = holdEveryRequest("");
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const both = Promise.all([api.destroy("m1"), api.destroy("m2")]);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      answerAll();
      await both;

      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.machines.dev/v1/apps/app/machines/m1?force=true",
        "https://api.machines.dev/v1/apps/app/machines/m2?force=true",
      ]);
    });

    // Two creations are two intents, each with its own body: sharing one request
    // handed the second caller the machine — and the credential — of the first.
    it("never shares a request between two concurrent creations", async () => {
      const answerAll = holdEveryRequest(JSON.stringify(SAMPLE_MACHINE));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const both = Promise.all([
        api.create({ name: "skrun-run-a", config: { image: "img" } }),
        api.create({ name: "skrun-pool-b", config: { image: "img" } }),
      ]);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      answerAll();
      await both;

      expect(fetchSpy.mock.calls.map(([, init]) => JSON.parse(init.body).name)).toEqual([
        "skrun-run-a",
        "skrun-pool-b",
      ]);
    });
  });

  // The platform limits creations and listings per app: one per second, three at
  // once. One client serves every caller of a process, so it keeps that rate.
  describe("spacing at the platform's rate", () => {
    function clockedClient(clock: ReturnType<typeof virtualClock>) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });
    }

    it("sends creations three at once, then one per second, a pool machine's among them", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = clockedClient(clock);
      const bodies = [
        runMachine("r1"),
        runMachine("r2"),
        runMachine("r3"),
        poolMachine("p1"),
        runMachine("r4"),
        runMachine("r5"),
      ];

      await clock.settle(Promise.all(bodies.map((body) => api.create(body))));

      expect(sent.map((s) => [s.name, s.at])).toEqual([
        ["skrun-run-r1", 0],
        ["skrun-run-r2", 0],
        ["skrun-run-r3", 0],
        ["skrun-pool-p1", 1000],
        ["skrun-run-r4", 2000],
        ["skrun-run-r5", 3000],
      ]);
    });

    it("sends at once again once the platform's budget has refilled", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = clockedClient(clock);

      await clock.settle(Promise.all([1, 2, 3, 4].map((n) => api.create(runMachine(`a${n}`)))));
      // Idle for a while: the next three leave together again.
      await clock.settle(clock.sleep(10_000));
      await clock.settle(Promise.all([1, 2, 3].map((n) => api.create(runMachine(`b${n}`)))));

      expect(sent.map((s) => s.at)).toEqual([0, 0, 0, 1000, 11_000, 11_000, 11_000]);
    });

    /** Lists `times` times in a row, each listing sent after the previous answered. */
    async function listInARow(api: FlyMachinesApi, times: number) {
      for (let i = 0; i < times; i++) await api.list();
    }

    it("sends listings three at once, then one per second", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = clockedClient(clock);

      await clock.settle(listInARow(api, 6));

      expect(sent.map((s) => [s.method, s.at])).toEqual([
        ["GET", 0],
        ["GET", 0],
        ["GET", 0],
        ["GET", 1000],
        ["GET", 2000],
        ["GET", 3000],
      ]);
    });

    it("takes the pool's reconciliation listing from the same bucket, and creations from another", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = clockedClient(clock);
      const pool = new RunnerPool(api, { size: 1, imageTag: "img", now: clock.now });

      await clock.settle(listInARow(api, 3));
      await clock.settle(Promise.all([pool.reconcile(), api.create(runMachine("r1"))]));

      expect(sent.map((s) => [s.method, s.at])).toEqual([
        ["GET", 0],
        ["GET", 0],
        ["GET", 0],
        ["POST", 0],
        ["GET", 1000],
      ]);
    });

    it("still shares one request between two listings at once, and books one slot for it", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = clockedClient(clock);

      await clock.settle(listInARow(api, 3));
      await clock.settle(Promise.all([api.list(), api.list()]));
      await clock.settle(api.list());

      expect(sent.map((s) => s.at)).toEqual([0, 0, 0, 1000, 2000]);
    });
  });

  // A creation or a listing refused with 429 is the platform telling the whole app
  // to slow down: the client waits as it asks — or 1, 2, 4 then 8 s — four times
  // per operation, each retry taking a slot of its bucket again.
  describe("patience with a refused creation or listing", () => {
    const WITNESS = "witness-of-the-platform-body";

    /** Refuses the first `refusals` requests with 429, then answers; records each send. */
    function refusingPlatform(
      clock: { now: () => number },
      refusals: number,
      retryAfter?: (now: number) => string,
    ) {
      const sent: Array<{ method: string; at: number; name?: string }> = [];
      let refused = 0;
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        const name = method === "POST" ? JSON.parse(String(init.body)).name : undefined;
        sent.push({ method, at: clock.now(), name });
        if (refused < refusals) {
          refused++;
          const headers = retryAfter ? { "Retry-After": retryAfter(clock.now()) } : undefined;
          return new Response(`rate limited ${WITNESS}`, { status: 429, headers });
        }
        const body = method === "GET" ? [SAMPLE_MACHINE] : SAMPLE_MACHINE;
        return new Response(JSON.stringify(body), { status: 200 });
      });
      return sent;
    }

    function patientClient(clock: ReturnType<typeof virtualClock>, logger?: Logger) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
        logger,
      });
    }

    const appActions = [
      ["creation", (api: FlyMachinesApi) => api.create(runMachine("r1"))],
      ["listing", (api: FlyMachinesApi) => api.list()],
      ["labelled listing", (api: FlyMachinesApi) => api.listByLabel("skrun_run_id", "r1")],
    ] as const;

    it.each(
      appActions,
    )("retries a %s after the Retry-After the platform sends", async (_what, call) => {
      const clock = virtualClock();
      const sent = refusingPlatform(clock, 1, () => "2");

      await clock.settle(call(patientClient(clock)));

      expect(sent.map((s) => s.at)).toEqual([0, 2000]);
    });

    it.each(appActions)("reads a Retry-After given as a date for a %s", async (_what, call) => {
      const clock = virtualClock(Date.UTC(2026, 9, 13, 12, 0, 0));
      const start = clock.now();
      const sent = refusingPlatform(clock, 1, (now) => new Date(now + 3000).toUTCString());

      await clock.settle(call(patientClient(clock)));

      expect(sent.map((s) => s.at - start)).toEqual([0, 3000]);
    });

    it.each(
      appActions,
    )("caps a long Retry-After at 10 s, four times, then fails the %s with the status", async (_what, call) => {
      const clock = virtualClock();
      const sent = refusingPlatform(clock, 99, () => "120");

      const outcome = await clock.settle(call(patientClient(clock)).catch((e: unknown) => e));

      expect(sent.map((s) => s.at)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: 429 } });
    });

    it.each(
      appActions,
    )("waits 1, 2, 4 then 8 s without a Retry-After, then fails the %s with the status", async (_what, call) => {
      const clock = virtualClock();
      const sent = refusingPlatform(clock, 99);

      const outcome = await clock.settle(call(patientClient(clock)).catch((e: unknown) => e));

      expect(sent.map((s) => s.at)).toEqual([0, 1000, 3000, 7000, 15_000]);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: 429 } });
    });

    it("takes a slot of its bucket again for each retry", async () => {
      const clock = virtualClock();
      const sent = refusingPlatform(clock, 1, () => "1");
      const api = patientClient(clock);

      await clock.settle(Promise.all([1, 2, 3, 4].map((n) => api.create(runMachine(`r${n}`)))));

      // r1, refused at 0, is asked to wait 1 s; by then r2, r3 (at 0) and r4 (at 1 s)
      // hold the slots up to 1 s, so its retry leaves at the next one.
      expect(sent.map((s) => [s.name, s.at])).toEqual([
        ["skrun-run-r1", 0],
        ["skrun-run-r2", 0],
        ["skrun-run-r3", 0],
        ["skrun-run-r4", 1000],
        ["skrun-run-r1", 2000],
      ]);
    });

    it("logs one warning per refusal — action, attempt, wait — and never the platform's words", async () => {
      const clock = virtualClock();
      refusingPlatform(clock, 99);
      const warnings: unknown[][] = [];
      const logger = {
        warn: (...args: unknown[]) => {
          warnings.push(args);
        },
        info: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as Logger;

      await clock.settle(
        patientClient(clock, logger)
          .create(runMachine("r1"))
          .catch(() => undefined),
      );

      expect(warnings.map(([fields]) => fields)).toEqual([
        { event: "fly_api_rate_limited", action: "create", attempt: 1, wait_ms: 1000 },
        { event: "fly_api_rate_limited", action: "create", attempt: 2, wait_ms: 2000 },
        { event: "fly_api_rate_limited", action: "create", attempt: 3, wait_ms: 4000 },
        { event: "fly_api_rate_limited", action: "create", attempt: 4, wait_ms: 8000 },
        // The last refusal is not waited out: the operation fails with the status.
        { event: "fly_api_rate_limited", action: "create", attempt: 5, wait_ms: null },
      ]);
      expect(JSON.stringify(warnings)).not.toContain(WITNESS);
    });

    it.each([
      ["start", (api: FlyMachinesApi) => api.start("fdmach_abc123")],
      ["destroy", (api: FlyMachinesApi) => api.destroy("fdmach_abc123")],
    ] as const)("keeps the short waits of a call on one machine for a 429 on %s", async (_name, call) => {
      const rateLimited = () => new Response("rate limited", { status: 429 });
      answerInTurn(
        [rateLimited, rateLimited, rateLimited],
        () => new Response("", { status: 200 }),
      );
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await call(api);

      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(waits).toEqual([250, 500, 1000]);
    });
  });

  // Every wait of the client goes through the one injected function — the slots
  // of both buckets, the 429s, the 412 of start — so a caller that injects one it
  // can abandon stops a call wherever it waits.
  describe("one wait function", () => {
    const ABANDONED = "abandoned by its caller";

    /** A client whose next wait, once `abandon.next` is set, is abandoned instead of waited. */
    function abandoningClient(clock: ReturnType<typeof virtualClock>, abandon: { next: boolean }) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: (ms) => {
          if (!abandon.next) return clock.sleep(ms);
          abandon.next = false;
          return Promise.reject(new Error(ABANDONED));
        },
      });
    }

    const outcomeOf = (call: Promise<unknown>) =>
      call.then(
        () => "sent",
        (err: Error) => err.message,
      );

    it("a creation abandoned while it waits for its slot sends nothing, and the next keeps its own slot", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const abandon = { next: false };
      const api = abandoningClient(clock, abandon);
      await clock.settle(Promise.all([1, 2, 3].map((n) => api.create(runMachine(`r${n}`)))));

      // r4 books the slot at 1 s and gives it up; r5, booked at 2 s, neither
      // moves up to the slot given up nor leaves later than its own.
      abandon.next = true;
      const r4 = outcomeOf(api.create(runMachine("r4")));
      const r5 = outcomeOf(api.create(runMachine("r5")));
      await clock.settle(Promise.all([r4, r5]));

      expect(await r4).toBe(ABANDONED);
      expect(await r5).toBe("sent");
      expect(sent.map((s) => [s.name, s.at])).toEqual([
        ["skrun-run-r1", 0],
        ["skrun-run-r2", 0],
        ["skrun-run-r3", 0],
        ["skrun-run-r5", 2000],
      ]);
    });

    it("a creation abandoned while it waits out a 429 sends nothing more", async () => {
      const clock = virtualClock();
      const abandon = { next: false };
      fetchSpy.mockImplementation(async () => {
        abandon.next = true;
        return new Response("rate limited", { status: 429 });
      });

      const outcome = await clock.settle(
        outcomeOf(abandoningClient(clock, abandon).create(runMachine("r1"))),
      );

      expect(outcome).toBe(ABANDONED);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    // Wherever a call waits, an abandoned wait ends it: nothing more is sent, and
    // the call rejects with what the wait function rejected with — an error, or
    // any other value its caller abandons with.
    it.each([
      [
        "a creation waiting to send again a request that never left",
        () => {
          throw networkFailure("ECONNREFUSED");
        },
        (api: FlyMachinesApi) => api.create(runMachine("r1")),
        new Error(ABANDONED),
      ],
      [
        "a start waiting out a machine still suspending",
        () =>
          new Response(
            JSON.stringify({
              error: "failed_precondition: machine still active, refusing to start",
            }),
            { status: 412 },
          ),
        (api: FlyMachinesApi) => api.start("m1"),
        "cancelled",
      ],
      [
        "a listing waiting out a 429",
        () => new Response("rate limited", { status: 429 }),
        (api: FlyMachinesApi) => api.list(),
        new Error(ABANDONED),
      ],
      [
        "a search by label waiting to read again after a 503",
        () => new Response("unavailable", { status: 503 }),
        (api: FlyMachinesApi) => api.listByLabel("skrun_run_id", "r1"),
        { why: "cancelled" },
      ],
      [
        "a destroy waiting out a 429",
        () => new Response("rate limited", { status: 429 }),
        (api: FlyMachinesApi) => api.destroy("m1"),
        "cancelled",
      ],
      [
        "a suspend waiting out a 429",
        () => new Response("rate limited", { status: 429 }),
        (api: FlyMachinesApi) => api.suspend("m1"),
        "cancelled",
      ],
      [
        "a stop waiting out a 429",
        () => new Response("rate limited", { status: 429 }),
        (api: FlyMachinesApi) => api.stop("m1"),
        new Error(ABANDONED),
      ],
    ] as Array<
      [string, () => Response, (api: FlyMachinesApi) => Promise<unknown>, unknown]
    >)("%s, abandoned, sends nothing more and rejects with what its caller abandoned it with", async (_what, answer, call, reason) => {
      const clock = virtualClock();
      const abandon = { next: false };
      fetchSpy.mockImplementation(async () => {
        abandon.next = true;
        return answer();
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: (ms) => {
          if (!abandon.next) return clock.sleep(ms);
          abandon.next = false;
          return Promise.reject(reason);
        },
      });

      const outcome = await clock.settle(
        call(api).then(
          () => ({ rejected: false, with: undefined }),
          (e: unknown) => ({ rejected: true, with: e }),
        ),
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(outcome.rejected).toBe(true);
      expect(outcome.with).toBe(reason);
    });
  });

  // A caller's signal ends that caller's call wherever it stands: nothing more
  // is sent for it, and it rejects with the signal's reason. A shared request
  // goes on for the callers still waiting for it — and stops once none does.
  describe("a caller's signal", () => {
    const REASON = { why: "the caller gave up" };

    /** What `work` came to after the work in flight has run out — never a hang. */
    async function outcomeNow<T>(work: Promise<T>) {
      const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
      work.then(
        (value) => {
          state.settled = true;
          state.value = value;
        },
        (error: unknown) => {
          state.settled = true;
          state.error = error;
        },
      );
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      return state;
    }

    /**
     * A platform whose requests never answer — until their signal aborts, which
     * rejects them with its reason, as Node's fetch does. Records each request and
     * the signal it was sent with.
     */
    function pendingPlatform() {
      const sent: Array<{ method: string; path: string; signal?: AbortSignal | null }> = [];
      fetchSpy.mockImplementation(
        (url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            sent.push({
              method: init.method ?? "GET",
              path: new URL(String(url)).pathname,
              signal: init.signal,
            });
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      return sent;
    }

    function signalledClient(clock: ReturnType<typeof virtualClock>) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });
    }

    it("a creation whose request hangs is cut by its signal: no second send, no search by its label", async () => {
      const clock = virtualClock();
      const sent = pendingPlatform();
      const controller = new AbortController();
      const progress: CreateProgress = { resent: false, adopted: false };

      const call = signalledClient(clock).create(runMachine("r1"), progress, {
        signal: controller.signal,
      });
      await outcomeNow(Promise.resolve());
      controller.abort(REASON);
      const outcome = await outcomeNow(call);

      expect(outcome).toEqual({ settled: true, error: REASON });
      expect(sent.map((s) => s.method)).toEqual(["POST"]);
      // The request itself was interrupted, not merely left behind.
      expect(sent[0]?.signal?.aborted).toBe(true);
      expect(progress.firstSentAt).toBe(0);
    });

    it("a creation whose signal has already aborted sends nothing", async () => {
      const clock = virtualClock();
      const sent = pendingPlatform();
      const progress: CreateProgress = { resent: false, adopted: false };

      const outcome = await outcomeNow(
        signalledClient(clock).create(runMachine("r1"), progress, {
          signal: AbortSignal.abort(REASON),
        }),
      );

      expect(outcome).toEqual({ settled: true, error: REASON });
      expect(sent).toEqual([]);
      expect(progress.firstSentAt).toBeUndefined();
    });

    it("a creation abandoned while it waits for its slot sends nothing and loses the slot; the next keeps its own", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = signalledClient(clock);
      await clock.settle(Promise.all([1, 2, 3].map((n) => api.create(runMachine(`r${n}`)))));

      // r4 books the slot at 1 s, r5 the one at 2 s; r4 gives its up.
      const controller = new AbortController();
      const progress: CreateProgress = { resent: false, adopted: false };
      const r4 = api
        .create(runMachine("r4"), progress, { signal: controller.signal })
        .catch((e: unknown) => e);
      const r5 = api.create(runMachine("r5"));
      controller.abort(REASON);
      await clock.settle(Promise.all([r4, r5]));

      expect(await r4).toBe(REASON);
      expect(progress.firstSentAt).toBeUndefined();
      expect(sent.map((s) => [s.name, s.at])).toEqual([
        ["skrun-run-r1", 0],
        ["skrun-run-r2", 0],
        ["skrun-run-r3", 0],
        ["skrun-run-r5", 2000],
      ]);
    });

    it("a creation abandoned while it waits out a 429 sends nothing more", async () => {
      const clock = virtualClock();
      const controller = new AbortController();
      fetchSpy.mockImplementation(async () => {
        controller.abort(REASON);
        return new Response("rate limited", { status: 429 });
      });

      const outcome = await clock.settle(
        signalledClient(clock)
          .create(runMachine("r1"), undefined, { signal: controller.signal })
          .catch((e: unknown) => e),
      );

      expect(outcome).toBe(REASON);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("a creation abandoned mid-wait ends at the abandon even when its sleepImpl does not listen to the signal: nothing more is sent", async () => {
      // This clock's sleep ignores the signal it is handed: only the client's own
      // race against the signal can end the wait.
      const clock = virtualClock();
      fetchSpy.mockImplementation(async () => new Response("rate limited", { status: 429 }));
      const controller = new AbortController();

      const call = signalledClient(clock)
        .create(runMachine("r1"), undefined, { signal: controller.signal })
        .catch((e: unknown) => e);
      // The 429 is in: the client waits it out — the clock does not move.
      expect((await outcomeNow(call)).settled).toBe(false);
      controller.abort(REASON);

      expect(await outcomeNow(call)).toEqual({ settled: true, value: REASON });
      expect(clock.now()).toBe(0);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it.each([
      ["start", (api: FlyMachinesApi, signal?: AbortSignal) => api.start("m1", { signal })],
      ["destroy", (api: FlyMachinesApi, signal?: AbortSignal) => api.destroy("m1", { signal })],
    ] as const)("a shared %s whose caller's signal has already aborted sends nothing, and leaves nothing to share", async (_what, call) => {
      const clock = virtualClock();
      const sent = pendingPlatform();
      const api = signalledClient(clock);

      const outcome = await outcomeNow(call(api, AbortSignal.abort(REASON)));

      expect(outcome).toEqual({ settled: true, error: REASON });
      expect(sent).toEqual([]);
      // A later call sends its own request.
      const later = call(api);
      await outcomeNow(Promise.resolve());
      expect(sent).toHaveLength(1);
      expect(sent[0]?.signal?.aborted).toBe(false);
      void later.catch(() => {});
    });

    it("a creation whose outcome turned unknown, abandoned during its search, reads and destroys nothing more", async () => {
      const clock = virtualClock();
      const platform = new RecoveryPlatform(clock);
      platform.creations = ["made-then-reset"];
      const controller = new AbortController();
      // The second read: the abandon falls in the spacing before it.
      platform.show = (read, held) => {
        if (read === 1) setImmediate(() => controller.abort(REASON));
        return read === 1 ? [] : held;
      };

      const outcome = await clock.settle(
        recoveringClient(platform, clock)
          .create(runMachine("r1"), undefined, { signal: controller.signal })
          .catch((e: unknown) => e),
      );

      expect(outcome).toBe(REASON);
      expect(platform.posts()).toBe(1);
      expect(platform.gets()).toHaveLength(1);
      expect(platform.destroyed).toEqual([]);
      // The machine the creation made is left to its caller, found by its label.
      expect(platform.held).toHaveLength(1);
    });

    it("keeps the instant the first request left, through a direct retry and a resend", async () => {
      const clock = virtualClock(5_000);
      const platform = new RecoveryPlatform(clock);
      // Refused before it left, sent again directly; then a 503, its outcome
      // unknown: searched for, absent, sent once more.
      let first = true;
      const fetchImpl = platform.fetch;
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (first) {
            first = false;
            throw networkFailure("ECONNREFUSED");
          }
          return fetchImpl(input, init);
        }) as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });
      platform.creations = [{ status: 503 }];
      const progress: CreateProgress = { resent: false, adopted: false };

      await clock.settle(api.create(runMachine("r1"), progress));

      expect(progress.resent).toBe(true);
      expect(clock.now()).toBeGreaterThan(5_000);
      expect(progress.firstSentAt).toBe(5_000);
    });

    it("dates the first request where it leaves, after its wait for a slot", async () => {
      const clock = virtualClock();
      platformRecording(clock);
      const api = signalledClient(clock);
      const progress: CreateProgress = { resent: false, adopted: false };

      await clock.settle(
        Promise.all([
          ...[1, 2, 3].map((n) => api.create(runMachine(`r${n}`))),
          api.create(runMachine("r4"), progress),
        ]),
      );

      expect(progress.firstSentAt).toBe(1000);
    });

    it.each([
      ["start", (api: FlyMachinesApi, signal?: AbortSignal) => api.start("m1", { signal }), ""],
      ["destroy", (api: FlyMachinesApi, signal?: AbortSignal) => api.destroy("m1", { signal }), ""],
      [
        "listByLabel",
        (api: FlyMachinesApi, signal?: AbortSignal) =>
          api.listByLabel("skrun_run_id", "r1", { signal }),
        "[]",
      ],
    ] as const)("a shared %s: one caller abandons, the other still gets the answer — one request", async (_what, call, body) => {
      let answer: ((response: Response) => void) | undefined;
      const sent: Array<AbortSignal | null | undefined> = [];
      fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
        sent.push(init.signal);
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const controller = new AbortController();

      const leaving = call(api, controller.signal).catch((e: unknown) => e);
      const staying = call(api);
      await outcomeNow(Promise.resolve());
      controller.abort(REASON);
      expect(await outcomeNow(leaving)).toEqual({ settled: true, value: REASON });
      // The request goes on for the other caller.
      expect(sent[0]?.aborted).toBe(false);
      answer?.(new Response(body, { status: 200 }));

      const stayed = await outcomeNow(staying);
      expect(stayed.settled).toBe(true);
      expect(stayed.error).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it.each([
      ["start", (api: FlyMachinesApi, signal?: AbortSignal) => api.start("m1", { signal })],
      ["destroy", (api: FlyMachinesApi, signal?: AbortSignal) => api.destroy("m1", { signal })],
      [
        "listByLabel",
        (api: FlyMachinesApi, signal?: AbortSignal) =>
          api.listByLabel("skrun_run_id", "r1", { signal }),
      ],
    ] as const)("a %s its only caller abandons is cut, and the next call sends its own", async (_what, call) => {
      const clock = virtualClock();
      const sent = pendingPlatform();
      const api = signalledClient(clock);
      const controller = new AbortController();

      const leaving = call(api, controller.signal);
      await outcomeNow(Promise.resolve());
      controller.abort(REASON);

      expect(await outcomeNow(leaving)).toEqual({ settled: true, error: REASON });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.signal?.aborted).toBe(true);
      // Nothing more for it: no retry of the request it cut.
      await clock.settle(clock.sleep(30_000));
      expect(sent).toHaveLength(1);
      // A later call is not handed the request that was stopped.
      const later = call(api);
      await outcomeNow(Promise.resolve());
      expect(sent).toHaveLength(2);
      expect(sent[1]?.signal?.aborted).toBe(false);
      void later.catch(() => {});
    });

    it("a start its only caller abandons while it waits out a machine still suspending sends nothing more", async () => {
      const clock = virtualClock();
      const controller = new AbortController();
      fetchSpy.mockImplementation(async () => {
        controller.abort(REASON);
        return new Response(
          JSON.stringify({ error: "failed_precondition: machine still active, refusing to start" }),
          { status: 412 },
        );
      });

      const outcome = await clock.settle(
        signalledClient(clock)
          .start("m1", { signal: controller.signal })
          .catch((e: unknown) => e),
      );
      await clock.settle(clock.sleep(30_000));

      expect(outcome).toBe(REASON);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  // A request the platform never answers used to wait as long as its caller did —
  // forever, for a caller without a signal. Each attempt now has a bound of its
  // own, per kind of call: one that elapses is that attempt failing on the
  // network, retried on the budget of today; a creation's outcome turns unknown
  // and is looked for by its label. The bounds here are real milliseconds.
  describe("a bound on every attempt, per kind of call", () => {
    const BOUND_MS = 25;
    const BOUNDS = {
      create: BOUND_MS,
      start: BOUND_MS,
      suspend: BOUND_MS,
      stop: BOUND_MS,
      destroy: BOUND_MS,
      list: BOUND_MS,
      listByLabel: BOUND_MS,
      metadata: BOUND_MS,
    };
    // Far more than four bounds and three instant waits take; far less than a test's timeout.
    const CEILING_MS = 2_000;

    type OneCall = (api: FlyMachinesApi) => Promise<unknown>;
    const CALLS_BUT_A_CREATION: Array<[string, OneCall, string]> = [
      ["start", (api) => api.start("m1"), ""],
      ["suspend", (api) => api.suspend("m1"), ""],
      ["stop", (api) => api.stop("m1"), ""],
      ["destroy", (api) => api.destroy("m1"), ""],
      ["list", (api) => api.list(), "[]"],
      ["listByLabel", (api) => api.listByLabel("skrun_run_id", "r1"), "[]"],
      ["setMetadata", (api) => api.setMetadata("m1", "skrun_run_id", "r1"), ""],
    ];

    function boundedClient(fetchImpl: typeof fetch, extra: FlyMachinesApiOptions = {}) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl,
        attemptTimeoutsMs: BOUNDS,
        sleepImpl: async () => {},
        logger: recordingLogger().logger,
        ...extra,
      });
    }

    const reasonName = (signal?: AbortSignal | null) =>
      (signal?.reason as { name?: string } | undefined)?.name;

    it.each(
      CALLS_BUT_A_CREATION,
    )("%s, whose caller has no signal, ends after its retries: each attempt cut by its bound", async (_what, call) => {
      const { sent, fetchImpl } = silentPlatform();
      const started = performance.now();

      const outcome = await call(boundedClient(fetchImpl)).catch((e: unknown) => e);

      expect(performance.now() - started).toBeLessThan(CEILING_MS);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: null } });
      expect(((outcome as MachineSpawnError).cause as Error).name).toBe("TimeoutError");
      // The first attempt and the three retries of the network budget.
      expect(sent).toHaveLength(4);
      expect(sent.map((s) => reasonName(s.signal))).toEqual(Array(4).fill("TimeoutError"));
    });

    it.each([
      ["list", (api: FlyMachinesApi) => api.list()],
      ["destroy", (api: FlyMachinesApi) => api.destroy("m1")],
    ])("%s whose answer's body never ends is cut by the same bound", async (_what, call) => {
      const { sent, fetchImpl } = silentPlatform(Array(4).fill("headers"));

      const outcome = await call(boundedClient(fetchImpl)).catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(((outcome as MachineSpawnError).cause as Error).name).toBe("TimeoutError");
      expect(sent).toHaveLength(4);
    });

    /**
     * A platform that answers each request but a label read with `status` at
     * once, then a body that never ends — until the request's signal aborts, as
     * Node's fetch does. A label read answers an empty list at once.
     */
    function bodyNeverEnds(status: number, onAnswer?: () => void) {
      const sent: Array<{ method: string; path: string }> = [];
      const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        sent.push({ method, path: `${url.pathname}${url.search}` });
        if (method === "GET") return Promise.resolve(new Response("[]", { status: 200 }));
        onAnswer?.();
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return Promise.resolve(new Response(body, { status }));
      }) as typeof fetch;
      return { sent, fetchImpl };
    }

    // Once a status that is no success has come, it decides: a body its bound
    // cuts reads as empty. A success needs its body: cut, the attempt has failed.
    it("a destroy answered 404 whose body never ends is done on its status: one request, the machine already gone", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(404);
      const { logger, lines } = recordingLogger();

      const outcome = await boundedClient(fetchImpl, { logger })
        .destroy("m1")
        .then(
          () => "done",
          (e: unknown) => e,
        );

      expect(outcome).toBe("done");
      expect(sent.map((s) => s.method)).toEqual(["DELETE"]);
      expect(lines.map((l) => l.fields.event)).toContain("machine_already_gone");
    });

    it("a creation refused 422 whose body never ends fails on its status: one request, no search, nothing sent again", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(422);

      const outcome = await boundedClient(fetchImpl)
        .create(runMachine("r1"))
        .catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", httpStatus: 422 } });
      expect(sent.map((s) => s.method)).toEqual(["POST"]);
    });

    it("a creation refused 422 whose body its caller abandons while it is read ends with the caller's reason", async () => {
      const controller = new AbortController();
      const reason = { why: "the caller gave up" };
      const { sent, fetchImpl } = bodyNeverEnds(422, () =>
        setImmediate(() => controller.abort(reason)),
      );

      const outcome = await boundedClient(fetchImpl)
        .create(runMachine("r1"), undefined, { signal: controller.signal })
        .catch((e: unknown) => e);

      expect(outcome).toBe(reason);
      expect(sent.map((s) => s.method)).toEqual(["POST"]);
    });

    it("a creation answered 200 whose body never ends keeps an unknown outcome: no answer within its bound, looked for by its label", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(200);

      const outcome = await boundedClient(fetchImpl)
        .create(runMachine("r1"))
        .catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(((outcome as MachineSpawnError).cause as Error).message).toMatch(
        new RegExp(`outcome of the creation is unknown \\(no answer within ${BOUND_MS} ms\\)`),
      );
      expect(sent.filter((s) => s.method === "POST")).toHaveLength(2);
      expect(sent.filter((s) => s.method === "GET")).toHaveLength(2 * SEARCH_READS);
    });

    /**
     * A platform that answers its first request on one machine with `status`
     * and `body`, the whole text sent but the body never ended — until the
     * request's signal aborts, as Node's fetch does —, and every later one with
     * `then`. A listing answers `listed`. Cut by `"network"`, that first body
     * fails at once, the attempt's bound far from elapsed.
     */
    function cutThenWhole(
      status: number,
      body: string,
      then: () => Response,
      listed = "[]",
      cutBy: "bound" | "network" = "bound",
    ) {
      const sent: string[] = [];
      let answered = 0;
      const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        sent.push(`${method} ${url.pathname.split("/").slice(4).join("/")}${url.search}`);
        if (method === "GET") return Promise.resolve(new Response(listed, { status: 200 }));
        answered += 1;
        if (answered > 1) return Promise.resolve(then());
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            if (cutBy === "network") {
              controller.error(new TypeError("terminated"));
              return;
            }
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return Promise.resolve(new Response(stream, { status }));
      }) as typeof fetch;
      return { sent, fetchImpl };
    }

    const REFUSED_IN_STATE =
      '{"error":"failed_precondition: unable to destroy machine, not currently stopped, suspended, failed, pending, or archived"}';
    const STILL_ACTIVE = '{"error":"failed_precondition: machine still active, refusing to start"}';

    // A 412 means what its body says, for a call that reads it: a destruction
    // without force (refused in the machine's state) and a start (a machine
    // still suspending). Its body cut, the attempt has failed — sent again, as a
    // network failure is — rather than read on an empty body.
    it("a destruction without force refused 412 whose body its bound cuts is sent again, and the refusal read then: refused-in-state", async () => {
      const { sent, fetchImpl } = cutThenWhole(
        412,
        REFUSED_IN_STATE,
        () => new Response(REFUSED_IN_STATE, { status: 412 }),
      );

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1", { force: false })
        .catch((e: unknown) => e);

      expect(outcome).toBe("refused-in-state");
      expect(sent).toEqual(["DELETE machines/m1", "DELETE machines/m1"]);
    });

    it("the pool spares a pooled machine whose refusal's body the bound cut once: never a failed destruction", async () => {
      const listed = JSON.stringify([
        {
          id: "p1",
          name: "skrun-pool-a",
          state: "suspended",
          created_at: new Date(Date.now() - 3_600_000).toISOString(),
          updated_at: new Date(Date.now() - 60_000).toISOString(),
          config: { image: "img:1" },
        },
      ]);
      const { sent, fetchImpl } = cutThenWhole(
        412,
        REFUSED_IN_STATE,
        () => new Response(REFUSED_IN_STATE, { status: 412 }),
        listed,
      );
      const { logger, lines } = recordingLogger();
      const pool = new RunnerPool(
        boundedClient(fetchImpl, { logger }),
        { size: 0, imageTag: "img:1" },
        logger,
      );

      const result = await pool.reconcile();

      expect(result).toEqual({ destroyed: 0, forgotten: 0 });
      expect(pool.stats().destroyFailures).toBe(0);
      expect(sent).toEqual(["GET machines", "DELETE machines/p1", "DELETE machines/p1"]);
      expect(
        lines.filter((l) => l.fields.machine_id === "p1").map((l) => [l.level, l.fields.event]),
      ).toEqual([["info", "pool_orphan_spared"]]);
    });

    it("a start refused 412 'still active' whose body its bound cuts is sent again, and waits the machine out", async () => {
      const { sent, fetchImpl } = cutThenWhole(
        412,
        STILL_ACTIVE,
        () => new Response('{"ok":true}', { status: 200 }),
      );

      const outcome = await boundedClient(fetchImpl)
        .start("m1")
        .then(
          () => "started",
          (e: unknown) => e,
        );

      expect(outcome).toBe("started");
      expect(sent).toEqual(["POST machines/m1/start", "POST machines/m1/start"]);
    });

    // A call that reads no 412 by its body keeps the status's verdict, its body
    // cut: a destruction with force is refused at once, never sent again.
    it("a destruction with force refused 412 whose body its bound cuts fails on its status: one request", async () => {
      const { sent, fetchImpl } = cutThenWhole(
        412,
        REFUSED_IN_STATE,
        () => new Response('{"ok":true}', { status: 200 }),
      );

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1")
        .catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: 412 } });
      expect(sent).toEqual(["DELETE machines/m1?force=true"]);
    });

    // Of the calls that read a 412 in its body, only the 412 is read so: any
    // other status they meet decides, its body cut.
    it("a destruction without force answered 404 whose body its bound cuts is done on its status: one request", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(404);

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1", { force: false })
        .catch((e: unknown) => e);

      expect(outcome).toBe("destroyed");
      expect(sent).toEqual([{ method: "DELETE", path: "/v1/apps/app/machines/m1" }]);
    });

    it("a start answered 422 whose body its bound cuts fails on its status: one request", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(422);

      const outcome = await boundedClient(fetchImpl)
        .start("m1")
        .then(
          () => "started",
          (e: unknown) => e,
        );

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { httpStatus: 422 } });
      expect(sent).toEqual([{ method: "POST", path: "/v1/apps/app/machines/m1/start" }]);
    });

    // A 412 read in its body, that body never read on any attempt: the call
    // fails once its retries are spent on that 412 — the last status the
    // platform answered —, never as a call that had no answer.
    it("a destruction without force whose 412 is never read fails on that 412 once its retries are spent: four requests", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(412);

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1", { force: false })
        .catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "boot-probe", httpStatus: 412 } });
      const cause = (outcome as MachineSpawnError).cause as Error;
      expect(cause.message).toBe("Fly.io API DELETE /apps/app/machines/m1: 412, its body unread");
      expect((cause.cause as Error).name).toBe("TimeoutError");
      expect(sent.map((s) => s.method)).toEqual(Array(4).fill("DELETE"));
    });

    it("keeps the last status the platform answered: a 412 never read, then no answer at all", async () => {
      let answered = 0;
      const fetchImpl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        answered += 1;
        const signal = init?.signal;
        if (answered > 1) {
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 412 }));
      }) as typeof fetch;

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1", { force: false })
        .catch((e: unknown) => e);

      expect(answered).toBe(4);
      expect(outcome).toMatchObject({ details: { httpStatus: 412 } });
      const cause = (outcome as MachineSpawnError).cause as Error;
      expect(cause.message).toBe("Fly.io API DELETE /apps/app/machines/m1: 412, its body unread");
      expect((cause.cause as Error).name).toBe("TimeoutError");
    });

    it("the pool counts a pooled machine whose refusal is never read as a failed destruction, and its line says to check the machine — never a manual cleanup", async () => {
      const { sent, fetchImpl } = bodyNeverEnds(412);
      const lines: Array<{ level: string; fields: Record<string, unknown>; msg?: string }> = [];
      const at = (level: string) => (fields: Record<string, unknown>, msg?: string) => {
        lines.push({ level, fields, msg });
      };
      const logger = {
        info: at("info"),
        warn: at("warn"),
        error: at("error"),
        debug: at("debug"),
      } as unknown as Logger;
      const pool = new RunnerPool(
        boundedClient(fetchImpl, { logger }),
        { size: 0, imageTag: "img:1" },
        logger,
      );

      const result = await pool.reconcile({
        sentAt: Date.now(),
        machines: [
          {
            id: "p1",
            name: "skrun-pool-a",
            state: "suspended",
            created_at: new Date(Date.now() - 3_600_000).toISOString(),
            updated_at: new Date(Date.now() - 60_000).toISOString(),
            config: { image: "img:1" },
          },
        ],
      });

      expect(result).toEqual({ destroyed: 0, forgotten: 0 });
      expect(pool.stats().destroyFailures).toBe(1);
      expect(sent.map((s) => s.path)).toEqual(Array(4).fill("/v1/apps/app/machines/p1"));
      expect(lines.filter((l) => l.fields.machine_id === "p1")).toEqual([
        {
          level: "warn",
          fields: {
            event: "pool_destroy_failed",
            machine_id: "p1",
            machine_state: "suspended",
            error_name: "MachineSpawnError",
            error_code: "MACHINE_SPAWN_FAILED",
            error_status: "412",
          },
          msg:
            "orphan destroy refused (412) without a reason this server reads — the machine may " +
            "have been woken since the listing: check it before destroying it by hand",
        },
      ]);
    });

    // A body read for its meaning is unread whatever cut it — the attempt's
    // bound or the network —: the attempt has failed either way.
    it("a destruction without force refused 412 whose body the network cuts is sent again, and the refusal read then: refused-in-state", async () => {
      const { sent, fetchImpl } = cutThenWhole(
        412,
        REFUSED_IN_STATE,
        () => new Response(REFUSED_IN_STATE, { status: 412 }),
        "[]",
        "network",
      );

      const outcome = await boundedClient(fetchImpl)
        .destroy("m1", { force: false })
        .catch((e: unknown) => e);

      expect(outcome).toBe("refused-in-state");
      expect(sent).toEqual(["DELETE machines/m1", "DELETE machines/m1"]);
    });

    it("a start refused 412 'still active' whose body the network cuts is sent again, and waits the machine out", async () => {
      const { sent, fetchImpl } = cutThenWhole(
        412,
        STILL_ACTIVE,
        () => new Response('{"ok":true}', { status: 200 }),
        "[]",
        "network",
      );

      const outcome = await boundedClient(fetchImpl)
        .start("m1")
        .then(
          () => "started",
          (e: unknown) => e,
        );

      expect(outcome).toBe("started");
      expect(sent).toEqual(["POST machines/m1/start", "POST machines/m1/start"]);
    });

    it.each([
      ["a run's machine", () => runMachine("r1"), "skrun_run_id=r1"],
      ["a pool machine", () => poolMachine("p1"), "skrun_pool_id=p1"],
    ])("a creation of %s cut by its bound is looked for by its label, then sent once more", async (_what, request, label) => {
      const clock = virtualClock();
      const nothing = () => new Response("[]", { status: 200 });
      // Both creations silent; every read of both searches answered at once, empty.
      const { sent, fetchImpl } = silentPlatform([
        "silent",
        ...Array(SEARCH_READS).fill(nothing),
        "silent",
        ...Array(SEARCH_READS).fill(nothing),
      ]);
      const progress: CreateProgress = { resent: false, adopted: false };
      const api = boundedClient(fetchImpl, { nowImpl: clock.now, sleepImpl: clock.sleep });

      const outcome = await clock.settle(api.create(request(), progress).catch((e: unknown) => e));

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", httpStatus: null } });
      expect(((outcome as MachineSpawnError).cause as Error).message).toMatch(
        new RegExp(`outcome of the creation is unknown \\(no answer within ${BOUND_MS} ms\\)`),
      );
      const posts = sent.filter((s) => s.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts.map((s) => reasonName(s.signal))).toEqual(["TimeoutError", "TimeoutError"]);
      const reads = sent.filter((s) => s.method === "GET");
      expect(reads).toHaveLength(2 * SEARCH_READS);
      expect(reads.every((s) => s.path === `/v1/apps/app/machines?metadata.${label}`)).toBe(true);
      expect(progress.resent).toBe(true);
    });

    it.each([
      ["a run's machine", () => runMachine("r1")],
      ["a pool machine", () => poolMachine("p1")],
    ])("a creation of %s cut by its bound once the platform made the machine adopts it, found by its label", async (_what, request) => {
      const clock = virtualClock();
      const platform = new RecoveryPlatform(clock);
      let posts = 0;
      // The platform makes the machine, then never answers the creation.
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "POST") return platform.fetch(input, init);
        posts += 1;
        const body = JSON.parse(String(init?.body)) as CreateMachineRequest;
        platform.hold(body.name ?? "", body.config.metadata as Record<string, string>);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }) as typeof fetch;
      const progress: CreateProgress = { resent: false, adopted: false };
      const api = boundedClient(fetchImpl, { nowImpl: clock.now, sleepImpl: clock.sleep });

      const machine = await clock.settle(api.create(request(), progress));

      expect(machine.id).toBe(platform.held[0]?.id);
      expect(progress).toMatchObject({ adopted: true, resent: false });
      expect(posts).toBe(1);
      expect(platform.gets()).toHaveLength(1);
    });

    it.each(
      CALLS_BUT_A_CREATION,
    )("%s whose first attempt is cut by its bound succeeds on the second, under a signal of its own", async (_what, call, body) => {
      const { sent, fetchImpl } = silentPlatform([
        "silent",
        () => new Response(body, { status: 200 }),
      ]);

      const outcome = await call(boundedClient(fetchImpl)).then(
        () => "answered",
        (e: unknown) => e,
      );

      expect(outcome).toBe("answered");
      expect(sent).toHaveLength(2);
      expect(reasonName(sent[0]?.signal)).toBe("TimeoutError");
      expect(sent[1]?.abortedWhenSent).toBe(false);
    });

    it("a creation refused 429, whose next attempt hangs, has that attempt cut by a bound of its own: looked for by its label, then sent once more", async () => {
      const nothing = () => new Response("[]", { status: 200 });
      const { sent, fetchImpl } = silentPlatform([
        () => new Response("", { status: 429 }),
        "silent",
        ...Array(SEARCH_READS).fill(nothing),
        "silent",
        ...Array(SEARCH_READS).fill(nothing),
      ]);
      const progress: CreateProgress = { resent: false, adopted: false };
      // Every wait — the refusal's among them — outlasts the bound: one bound for
      // the whole creation would be spent before its second attempt leaves.
      const api = boundedClient(fetchImpl, { sleepImpl: () => realWait(2 * BOUND_MS) });

      let ceiling: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        api.create(runMachine("r1"), progress).catch((e: unknown) => e),
        new Promise((resolve) => {
          ceiling = setTimeout(() => resolve("still waiting"), CEILING_MS);
        }),
      ]).finally(() => clearTimeout(ceiling));

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(((outcome as MachineSpawnError).cause as Error).message).toMatch(
        new RegExp(`outcome of the creation is unknown \\(no answer within ${BOUND_MS} ms\\)`),
      );
      const posts = sent.filter((s) => s.method === "POST");
      expect(posts).toHaveLength(3);
      expect(posts[1]?.abortedWhenSent).toBe(false);
      expect(reasonName(posts[1]?.signal)).toBe("TimeoutError");
      expect(sent.filter((s) => s.method === "GET")).toHaveLength(2 * SEARCH_READS);
      expect(progress.resent).toBe(true);
    });

    it("a creation whose first attempt is cut by its bound, and found nowhere, is answered when sent again", async () => {
      const clock = virtualClock();
      const nothing = () => new Response("[]", { status: 200 });
      const { sent, fetchImpl } = silentPlatform([
        "silent",
        ...Array(SEARCH_READS).fill(nothing),
        () => new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 }),
      ]);
      const progress: CreateProgress = { resent: false, adopted: false };
      const api = boundedClient(fetchImpl, { nowImpl: clock.now, sleepImpl: clock.sleep });

      const machine = await clock.settle(api.create(runMachine("r1"), progress));

      expect(machine.id).toBe(SAMPLE_MACHINE.id);
      expect(progress).toMatchObject({ resent: true, adopted: false });
      expect(sent.filter((s) => s.method === "POST").map((s) => s.abortedWhenSent)).toEqual([
        false,
        false,
      ]);
    });

    it("clears each attempt's timer once the attempt has ended", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        fetchSpy.mockImplementation(async (_url: string, init: RequestInit) =>
          init.method === "DELETE"
            ? new Response("", { status: 200 })
            : new Response("[]", { status: 200 }),
        );
        const api = new FlyMachinesApi("token", "app", {
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });

        await api.list();
        await api.destroy("m1");
        await api.create({ name: "skrun-run-x", config: { image: "img" } }).catch(() => {});

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The caller's signal ends the call; an attempt's bound ends only that attempt.
  // The two are told apart by which of them aborted — never by the reason's name:
  // a caller may abort with a timeout of its own.
  describe("a caller's abandon, told apart from an attempt's bound", () => {
    const BOUND_MS = 25;
    const REASON = { why: "the caller gave up" };

    function boundedClient(fetchImpl: typeof fetch) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl,
        attemptTimeoutsMs: {
          create: BOUND_MS,
          start: BOUND_MS,
          suspend: BOUND_MS,
          destroy: BOUND_MS,
          list: BOUND_MS,
          listByLabel: BOUND_MS,
          metadata: BOUND_MS,
        },
        sleepImpl: async () => {},
        logger: recordingLogger().logger,
      });
    }

    /** A creation that no label can find again. */
    const unlabelled = (): CreateMachineRequest => ({
      name: "skrun-run-x",
      config: { image: "img" },
    });

    it.each([
      ["a run's machine", () => runMachine("r1")],
      ["a machine no label can find again", unlabelled],
    ])("a creation of %s its caller abandons during an attempt ends there: nothing sent again, no search, whatever the bound does later", async (_what, request) => {
      const controller = new AbortController();
      const { sent, fetchImpl } = silentPlatform([], () =>
        setImmediate(() => controller.abort(REASON)),
      );

      const outcome = await boundedClient(fetchImpl)
        .create(request(), undefined, { signal: controller.signal })
        .catch((e: unknown) => e);
      await realWait(3 * BOUND_MS);

      expect(outcome).toBe(REASON);
      expect(sent.map((s) => s.method)).toEqual(["POST"]);
      expect(sent[0]?.signal?.reason).toBe(REASON);
    });

    it("an abandon whose reason is a timeout of its caller's own is still its caller's: no search, nothing sent again", async () => {
      const controller = new AbortController();
      const own = new DOMException("the caller's own budget ran out", "TimeoutError");
      const { sent, fetchImpl } = silentPlatform([], () =>
        setImmediate(() => controller.abort(own)),
      );

      const outcome = await boundedClient(fetchImpl)
        .create(unlabelled(), undefined, { signal: controller.signal })
        .catch((e: unknown) => e);
      await realWait(3 * BOUND_MS);

      expect(outcome).toBe(own);
      expect(sent.map((s) => s.method)).toEqual(["POST"]);
    });

    it.each([
      ["start", (api: FlyMachinesApi, signal: AbortSignal) => api.start("m1", { signal })],
      ["suspend", (api: FlyMachinesApi, signal: AbortSignal) => api.suspend("m1", { signal })],
      ["destroy", (api: FlyMachinesApi, signal: AbortSignal) => api.destroy("m1", { signal })],
      ["list", (api: FlyMachinesApi, signal: AbortSignal) => api.list({ signal })],
      [
        "listByLabel",
        (api: FlyMachinesApi, signal: AbortSignal) =>
          api.listByLabel("skrun_run_id", "r1", { signal }),
      ],
      [
        "setMetadata",
        (api: FlyMachinesApi, signal: AbortSignal) =>
          api.setMetadata("m1", "skrun_run_id", "r1", { signal }),
      ],
    ])("%s its caller abandons during a retry, after an attempt cut by its bound, sends nothing more and rejects with the caller's reason", async (_what, call) => {
      const controller = new AbortController();
      const { sent, fetchImpl } = silentPlatform([], (n) => {
        if (n === 2) setImmediate(() => controller.abort(REASON));
      });

      const outcome = await call(boundedClient(fetchImpl), controller.signal).catch(
        (e: unknown) => e,
      );
      await realWait(3 * BOUND_MS);

      expect(outcome).toBe(REASON);
      expect(sent).toHaveLength(2);
      expect((sent[0]?.signal?.reason as Error).name).toBe("TimeoutError");
      expect(sent[1]?.signal?.reason).toBe(REASON);
    });
  });

  // A failed creation is sent again directly only when the request provably never
  // reached the platform. When it may have, a machine may exist: sending again
  // would make a second one, so the outcome is first looked for by the label.
  describe("a creation that fails", () => {
    const failWith = (error: Error) => () => {
      throw error;
    };
    const answer =
      (status: number, body = "") =>
      () =>
        new Response(body, { status });
    const machineAnswer = () => new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 });

    function requests() {
      return fetchSpy.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`);
    }

    function clientWithWaits(waits: number[]) {
      return new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });
    }

    const CREATE = "POST https://api.machines.dev/v1/apps/app/machines";

    const neverSent: Array<[string, () => Error]> = [
      ["the connection refused", () => networkFailure("ECONNREFUSED")],
      ["the host not resolved", () => networkFailure("ENOTFOUND")],
      ["the name not resolved for now", () => networkFailure("EAI_AGAIN")],
      ["the connection timed out", () => networkFailure("UND_ERR_CONNECT_TIMEOUT")],
      ["every address refusing", () => everyAddressFailing("ECONNREFUSED", "ECONNREFUSED")],
    ];

    it.each(
      neverSent,
    )("sends again directly after %s, and looks for nothing", async (_what, failure) => {
      answerInTurn([failWith(failure()), failWith(failure())], machineAnswer);
      const waits: number[] = [];

      const machine = await clientWithWaits(waits).create(runMachine("r1"));

      expect(machine.id).toBe(SAMPLE_MACHINE.id);
      expect(requests()).toEqual([CREATE, CREATE, CREATE]);
      expect(waits).toEqual([250, 500]);
    });

    it("gives up after three direct retries, the network error as the cause and no status", async () => {
      const clock = virtualClock();
      const failure = networkFailure("ECONNREFUSED");
      const sentAt: number[] = [];
      fetchSpy.mockImplementation(async () => {
        sentAt.push(clock.now());
        throw failure;
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });

      const outcome = await clock.settle(api.create(runMachine("r1")).catch((e: unknown) => e));

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", httpStatus: null } });
      expect((outcome as MachineSpawnError).cause).toBe(failure);
      expect(requests()).toEqual([CREATE, CREATE, CREATE, CREATE]);
      // 0.25, then 0.5, then 1 s apart.
      expect(sentAt).toEqual([0, 250, 750, 1750]);
    });

    it("takes a slot of its bucket for each direct retry", async () => {
      const clock = virtualClock();
      const sent: Array<[string, number]> = [];
      let refused = false;
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        const name = JSON.parse(String(init.body)).name as string;
        sent.push([name, clock.now()]);
        if (name === "skrun-run-r1" && !refused) {
          refused = true;
          throw networkFailure("ECONNREFUSED");
        }
        return new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 });
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });

      await clock.settle(Promise.all([1, 2, 3].map((n) => api.create(runMachine(`r${n}`)))));

      // r1, refused at 0, would retry at 250 ms; r2 and r3 hold the burst, so
      // its retry leaves at the next slot.
      expect(sent).toEqual([
        ["skrun-run-r1", 0],
        ["skrun-run-r2", 0],
        ["skrun-run-r3", 0],
        ["skrun-run-r1", 1000],
      ]);
    });

    const unknownOutcome: Array<[string, () => Response]> = [
      ["a connection reset once the request left", failWith(networkFailure("ECONNRESET"))],
      ["a network error it does not know", failWith(networkFailure("EWHATEVER"))],
      ["a network error without a code", failWith(new TypeError("fetch failed"))],
      [
        "no answer within the response timeout",
        failWith(networkFailure("UND_ERR_HEADERS_TIMEOUT")),
      ],
      ["the answer cut short", failWith(networkFailure("UND_ERR_SOCKET"))],
      [
        "one address refusing and the other reset",
        failWith(everyAddressFailing("ECONNREFUSED", "ECONNRESET")),
      ],
      ["a 408", answer(408, "request timeout")],
      ["a 500", answer(500, "internal error")],
      ["a 502", answer(502, "bad gateway")],
      ["a 503", answer(503, "unavailable")],
      ["a 200 whose body is not JSON", answer(200, "<html>proxy</html>")],
      ["a 200 with no body", answer(200, "")],
      ["a 200 whose body is not a machine", answer(200, JSON.stringify({ id: 123 }))],
    ];

    it.each(
      unknownOutcome,
    )("never sends again directly after %s: it looks for the machine by its label first, then sends once more", async (_what, first) => {
      const clock = virtualClock();
      // The first request fails as the case says; no machine ever shows under the label.
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        if (fetchSpy.mock.calls.length === 1) return first();
        return (init?.method ?? "GET") === "GET"
          ? new Response("[]", { status: 200 })
          : machineAnswer();
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });

      const progress = { resent: false, adopted: false };

      const outcome = await clock.settle(
        api.create(runMachine("r1"), progress).catch((e: unknown) => e),
      );

      const search = `GET https://api.machines.dev${LABELLED_LISTING}`;
      expect(requests()).toEqual([CREATE, ...Array(SEARCH_READS).fill(search), CREATE]);
      expect(outcome).toMatchObject({ id: SAMPLE_MACHINE.id });
      expect(progress).toEqual({
        resent: true,
        adopted: false,
        firstSentAt: 0,
        lastSentAt: 5_000,
      });
    });

    it("never sends again a creation refused as a duplicate name: it looks for the machine, then fails", async () => {
      const clock = virtualClock();
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        if (fetchSpy.mock.calls.length === 1)
          return new Response("already_exists", { status: 409 });
        return (init?.method ?? "GET") === "GET"
          ? new Response("[]", { status: 200 })
          : machineAnswer();
      });
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });
      const progress = { resent: false, adopted: false };

      const outcome = await clock.settle(
        api.create(runMachine("r1"), progress).catch((e: unknown) => e),
      );

      const search = `GET https://api.machines.dev${LABELLED_LISTING}`;
      expect(requests()).toEqual([CREATE, ...Array(SEARCH_READS).fill(search)]);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({
        details: { phase: "create", machineId: null, httpStatus: DUPLICATE_NAME_STATUS },
      });
      expect(((outcome as MachineSpawnError).cause as Error).message).toMatch(
        /the outcome of the creation is unknown .*no machine with its label appeared/,
      );
      expect(progress).toEqual({
        resent: false,
        adopted: false,
        firstSentAt: 0,
        lastSentAt: 0,
      });
    });

    it("fails a 400 at once: no search, nothing sent again, the platform's answer in the cause", async () => {
      answerInTurn([answer(400, "invalid config")], machineAnswer);
      const waits: number[] = [];

      const outcome = await clientWithWaits(waits)
        .create(runMachine("r1"))
        .catch((e: unknown) => e);

      expect(requests()).toEqual([CREATE]);
      expect(waits).toEqual([]);
      expect(outcome).toMatchObject({ details: { phase: "create", httpStatus: 400 } });
      const cause = (outcome as MachineSpawnError).cause as Error;
      expect(cause.message).toContain("400 invalid config");
      expect(cause.message).not.toMatch(/unknown/);
    });

    it.each([
      ["a connection reset", failWith(networkFailure("ECONNRESET"))],
      ["a 502", answer(502, "bad gateway")],
    ])("fails a creation without a label at once after %s: nothing to find it again by", async (_what, first) => {
      answerInTurn([first], machineAnswer);
      const waits: number[] = [];

      const outcome = await clientWithWaits(waits)
        .create({ name: "smoke-machine", config: { image: "img" } })
        .catch((e: unknown) => e);

      expect(requests()).toEqual([CREATE]);
      expect(waits).toEqual([]);
      expect(outcome).toMatchObject({ details: { phase: "create", machineId: null } });
      expect(((outcome as MachineSpawnError).cause as Error).message).toMatch(
        /the outcome of the creation is unknown .*, and it carries no single label with a value to be found again by — exactly one of skrun_run_id, skrun_pool_id$/,
      );
    });

    // A search keeps only a machine of the label and of the name sent: a creation
    // is found again only by exactly one of the product's labels, holding a
    // non-empty text, and a name — or it is not looked for at all. The error says
    // which of the two is missing.
    const NO_NAME = "it carries no name to be found again by";
    const NO_LABEL =
      "it carries no single label with a value to be found again by — exactly one of skrun_run_id, skrun_pool_id";
    const NEITHER =
      "it carries no name and no single label with a value to be found again by — exactly one of skrun_run_id, skrun_pool_id";
    it.each([
      ["names no machine", { config: { image: "img", metadata: { skrun_run_id: "r1" } } }, NO_NAME],
      ["names no machine and carries no label", { config: { image: "img" } }, NEITHER],
      [
        "carries both labels",
        {
          name: "skrun-run-r1",
          config: { image: "img", metadata: { skrun_run_id: "r1", skrun_pool_id: "p1" } },
        },
        NO_LABEL,
      ],
      [
        "carries a label with no value",
        { name: "skrun-run-r1", config: { image: "img", metadata: { skrun_run_id: "" } } },
        NO_LABEL,
      ],
      [
        "carries a label whose value is not text",
        { name: "skrun-run-r1", config: { image: "img", metadata: { skrun_run_id: 42 } } },
        NO_LABEL,
      ],
    ] as Array<
      [string, CreateMachineRequest, string]
    >)("fails at once after a connection reset a creation that %s: nothing to find it again by", async (_what, request, reason) => {
      answerInTurn([failWith(networkFailure("ECONNRESET"))], machineAnswer);
      const waits: number[] = [];

      const outcome = await clientWithWaits(waits)
        .create(request)
        .catch((e: unknown) => e);

      expect(requests()).toEqual([CREATE]);
      expect(waits).toEqual([]);
      expect(outcome).toMatchObject({ details: { phase: "create", machineId: null } });
      const message = ((outcome as MachineSpawnError).cause as Error).message;
      expect(message).toMatch(
        /the outcome of the creation is unknown \(a network error, ECONNRESET\)/,
      );
      expect(message.split("), and ")[1]).toBe(reason);
    });
  });

  // The machine a creation may have made is looked for by its label: a few
  // reads, a second apart, each checked again here — the label and the name —
  // and what is found is adopted only in a state that is on its way to running.
  describe("a creation whose outcome is unknown, looked for by its label", () => {
    async function createOn(
      platform: RecoveryPlatform,
      logger?: Logger,
      progress: CreateProgress = { resent: false, adopted: false },
    ) {
      const clock = platformClock;
      return clock.settle(
        recoveringClient(platform, clock, logger)
          .create(runMachine("r1"), progress)
          .catch((e: unknown) => e),
      );
    }

    let platformClock: ReturnType<typeof virtualClock>;
    let platform: RecoveryPlatform;
    beforeEach(() => {
      platformClock = virtualClock();
      platform = new RecoveryPlatform(platformClock);
    });

    function causeOf(outcome: unknown): string {
      return ((outcome as MachineSpawnError).cause as Error).message;
    }

    it.each([
      "creating",
      "created",
      "starting",
      "started",
    ])("adopts the machine found %s: the same id and address, one creation sent", async (state) => {
      platform.creations = ["made-then-reset"];
      platform.stateOnMake = state;

      const outcome = await createOn(platform);

      const made = platform.held[0];
      expect(outcome).toMatchObject({ id: made.id, private_ip: made.private_ip, state });
      expect(platform.posts()).toBe(1);
      expect(platform.gets()).toEqual([{ path: LABELLED_LISTING, at: SEARCH_SPACING_MS }]);
      expect(platform.destroyed).toEqual([]);
    });

    it("adopts a machine that shows only at the second read, a second after the first", async () => {
      platform.creations = ["made-then-reset"];
      platform.show = (read, held) => (read < 2 ? [] : held);

      const outcome = await createOn(platform);

      expect(outcome).toMatchObject({ id: platform.held[0].id });
      expect(platform.posts()).toBe(1);
      expect(platform.gets().map((g) => g.at)).toEqual([1000, 2000]);
    });

    it("looks five times, a second apart, then sends the creation once more", async () => {
      platform.creations = ["lost"];
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(platform.gets()).toEqual(
        [1000, 2000, 3000, 4000, 5000].map((at) => ({ path: LABELLED_LISTING, at })),
      );
      expect(platform.sent.filter((s) => s.method === "POST").map((s) => s.at)).toEqual([0, 5000]);
      expect(outcome).toMatchObject({ id: "m-1" });
      expect(progress).toEqual({
        resent: true,
        adopted: false,
        firstSentAt: 0,
        lastSentAt: 5_000,
      });
    });

    it.each([
      "stopping",
      "stopped",
      "suspending",
      "suspended",
      "failed",
      "launch_failed",
      "restarting",
      "updating",
      "replacing",
      "replaced",
      "migrated",
      "hibernating",
    ])("does not adopt a machine found %s: it destroys it and fails, nothing sent again", async (state) => {
      platform.creations = ["made-then-reset"];
      platform.stateOnMake = state;

      const outcome = await createOn(platform);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", machineId: null } });
      expect(causeOf(outcome)).toMatch(/not one to adopt/);
      expect(platform.destroyed).toEqual(["m-1"]);
      expect(platform.posts()).toBe(1);
    });

    it.each([
      "destroying",
      "destroyed",
    ])("reads a machine found %s as no machine at all", async (state) => {
      platform.hold("skrun-run-r1", { skrun_run_id: "r1" }, { state });
      platform.creations = ["lost"];

      const outcome = await createOn(platform);

      expect(platform.gets()).toHaveLength(SEARCH_READS);
      // Sent once more: the machine the second request made.
      expect(outcome).toMatchObject({ id: "m-2" });
      expect(platform.destroyed).toEqual([]);
    });

    it("adopts the oldest of two machines found, and destroys the other", async () => {
      // A machine of the same name and label already there — made later, listed first.
      const later = platform.hold(
        "skrun-run-r1",
        { skrun_run_id: "r1" },
        { created_at: "2026-10-13T12:05:00.000Z" },
      );
      platform.creations = ["made-then-reset"];
      const { logger, lines } = recordingLogger();

      const outcome = await createOn(platform, logger);

      const older = platform.held.find((m) => m.id !== later.id);
      expect(outcome).toMatchObject({ id: older?.id });
      expect(platform.destroyed).toEqual([later.id]);
      expect(lines.map((l) => l.fields)).toContainEqual({
        event: "machine_destroy",
        machine_id: later.id,
        reason: "duplicate_create",
      });
    });

    it("fails without sending again when the search itself fails: a read answered 503 four times", async () => {
      platform.creations = ["made-then-reset"];
      platform.show = () => new Response("unavailable", { status: 503 });

      const outcome = await createOn(platform);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", machineId: null } });
      expect(causeOf(outcome)).toMatch(/the search by its label failed: .*503 unavailable/);
      expect(platform.posts()).toBe(1);
      // The read, then three more, 0.25, 0.5 then 1 s apart: the retries of a network error.
      expect(platform.gets().map((g) => g.at)).toEqual([1000, 1250, 1750, 2750]);
      expect(platform.destroyed).toEqual([]);
    });

    it.each([
      [500, "internal error"],
      [503, "unavailable"],
      [408, "request timeout"],
    ])("reads again after a %i, and adopts the machine the next read shows", async (status, body) => {
      platform.creations = ["made-then-reset"];
      platform.show = (read, held) => (read === 1 ? new Response(body, { status }) : held);
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(outcome).toMatchObject({ id: platform.held[0].id });
      expect(platform.posts()).toBe(1);
      expect(platform.gets().map((g) => g.at)).toEqual([1000, 1250]);
      expect(progress).toEqual({
        resent: false,
        adopted: true,
        firstSentAt: 0,
        lastSentAt: 0,
      });
    });

    it.each([
      ["refused", () => new Response("forbidden", { status: 403 })],
      ["answered 503 four times", () => new Response("unavailable", { status: 503 })],
    ])("destroys the machine it saw before a read %s ended its search", async (_what, answer) => {
      platform.creations = ["made-then-reset"];
      // The first read shows the machine, its address not there yet; every read after it fails.
      platform.addressOnMake = false;
      platform.show = (read, held) => (read === 1 ? held : answer());
      const { logger, lines } = recordingLogger();

      const outcome = await createOn(platform, logger);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/the search by its label failed/);
      expect(platform.destroyed).toEqual(["m-1"]);
      expect(lines.map((l) => l.fields)).toContainEqual({
        event: "machine_destroy",
        machine_id: "m-1",
        reason: "unadoptable_create",
      });
      expect(platform.posts()).toBe(1);
    });

    it("forgets a machine it saw once a later read shows it going away: the search that then fails destroys nothing", async () => {
      platform.creations = ["made-then-reset"];
      // The first read shows the machine, its address not there yet; the second
      // shows it being destroyed; the third is refused, which ends the search.
      platform.addressOnMake = false;
      platform.show = (read, held) => {
        if (read === 1) return held;
        if (read === 2) {
          for (const m of held) m.state = "destroying";
          return held;
        }
        return new Response("forbidden", { status: 403 });
      };

      const outcome = await createOn(platform);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/the search by its label failed/);
      expect(platform.gets()).toHaveLength(3);
      expect(platform.destroyed).toEqual([]);
      expect(platform.posts()).toBe(1);
    });

    it("destroys every machine it saw, not only those of the last read, when what it finds cannot be adopted", async () => {
      // A machine of the same name and label already there, its address not there yet.
      const earlier = platform.hold(
        "skrun-run-r1",
        { skrun_run_id: "r1" },
        { private_ip: undefined },
      );
      platform.creations = ["made-then-reset"];
      platform.addressOnMake = false;
      // The first read shows both; the second only the machine just made, failed.
      platform.show = (read, held) => {
        if (read === 1) return held;
        const made = held.filter((m) => m.id !== earlier.id);
        for (const m of made) m.state = "failed";
        return made;
      };

      const outcome = await createOn(platform);

      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/is failed, not one to adopt/);
      expect([...platform.destroyed].sort()).toEqual([earlier.id, "m-2"].sort());
      expect(platform.posts()).toBe(1);
    });

    // An abandoned wait ends the creation where it waits, its search included:
    // nothing more is sent, nothing is destroyed, and the caller gets back what it
    // abandoned with. A machine the creation may have made carries its label —
    // finding it is the caller's.
    function abandonedCreation(
      abandon: { next: boolean },
      reason: unknown,
      fetchImpl: typeof fetch = platform.fetch,
    ) {
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl,
        nowImpl: platformClock.now,
        sleepImpl: (ms) => {
          if (!abandon.next) return platformClock.sleep(ms);
          abandon.next = false;
          return Promise.reject(reason);
        },
      });
      return platformClock.settle(api.create(runMachine("r1")).catch((e: unknown) => e));
    }

    it.each([
      ["an error", new Error("abandoned by its caller")],
      ["a value that is not an error", "cancelled"],
    ])("sends nothing more and destroys nothing when the wait to read again is abandoned with %s, and rejects with it", async (_what, reason) => {
      platform.creations = ["made-then-reset"];
      // The first read shows the machine, its address not there yet; the second is
      // answered 503, and the wait before reading it again is abandoned.
      platform.addressOnMake = false;
      const abandon = { next: false };
      platform.show = (read, held) => {
        if (read === 1) return held;
        abandon.next = true;
        return new Response("unavailable", { status: 503 });
      };

      const outcome = await abandonedCreation(abandon, reason);

      expect(platform.sent.map((s) => s.method)).toEqual(["POST", "GET", "GET"]);
      expect(platform.destroyed).toEqual([]);
      expect(outcome).toBe(reason);
    });

    it("sends nothing more and destroys nothing when the wait between two reads is abandoned, and rejects with what it was abandoned with", async () => {
      platform.creations = ["made-then-reset"];
      // The first read shows the machine, its address not there yet; the wait
      // before the second read is abandoned.
      platform.addressOnMake = false;
      const abandon = { next: false };
      platform.show = (_read, held) => {
        abandon.next = true;
        return held;
      };
      const reason = new Error("abandoned by its caller");

      const outcome = await abandonedCreation(abandon, reason);

      expect(platform.sent.map((s) => s.method)).toEqual(["POST", "GET"]);
      expect(platform.destroyed).toEqual([]);
      expect(outcome).toBe(reason);
    });

    it("destroys nothing more once the wait of a destruction is abandoned, and rejects with what it was abandoned with", async () => {
      // A machine of the same name and label already there, failed; the creation
      // makes another, failed too: neither is one to adopt, so both are destroyed.
      const earlier = platform.hold("skrun-run-r1", { skrun_run_id: "r1" }, { state: "failed" });
      platform.creations = ["made-then-reset"];
      platform.stateOnMake = "failed";
      // The first destruction is refused for its rate, and the wait before sending
      // it again is abandoned.
      const abandon = { next: false };
      const deletes: string[] = [];
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deletes.push(new URL(String(input)).pathname.split("/").pop() ?? "");
          if (deletes.length === 1) {
            abandon.next = true;
            return new Response("rate limited", { status: 429 });
          }
        }
        return platform.fetch(input, init);
      }) as typeof fetch;
      const reason = new Error("abandoned by its caller");

      const outcome = await abandonedCreation(abandon, reason, fetchImpl);

      expect(deletes).toEqual([earlier.id]);
      expect(platform.destroyed).toEqual([]);
      expect(outcome).toBe(reason);
    });

    it("counts a 5xx and a network error on one budget: three retries for a read", async () => {
      platform.creations = ["made-then-reset"];
      platform.show = (read) => {
        if (read === 1 || read === 3) throw networkFailure("ECONNRESET");
        return new Response("unavailable", { status: 503 });
      };

      const outcome = await createOn(platform);

      // Cut, 503, cut, 503: the fourth answer ends the read, and the search with it.
      expect(platform.gets()).toHaveLength(4);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/the search by its label failed: .*503 unavailable/);
      expect(platform.posts()).toBe(1);
    });

    it("adopts no machine but its own, when the platform ignores the filter", async () => {
      platform.ignoreFilter = true;
      platform.stateOnMake = "started";
      platform.hold("skrun-run-r2", { skrun_run_id: "r2" });
      platform.hold("skrun-pool-p1", { skrun_pool_id: "p1" });
      platform.hold("skrun-run-other", { skrun_run_id: "r1" });
      platform.creations = ["lost"];

      const outcome = await createOn(platform);

      // None of the three is adopted: the creation is sent once more, and its machine returned.
      expect(outcome).toMatchObject({ id: "m-4", name: "skrun-run-r1" });
      expect(platform.posts()).toBe(2);
      expect(platform.destroyed).toEqual([]);
    });

    it("reads a machine found without a private address again, and adopts it once it shows one", async () => {
      platform.creations = ["made-then-reset"];
      platform.addressOnMake = false;
      platform.show = (read, held) => {
        if (read === 3) held[0].private_ip = "fdaa:0:1::9";
        return held;
      };

      const outcome = await createOn(platform);

      expect(outcome).toMatchObject({ id: "m-1", private_ip: "fdaa:0:1::9" });
      expect(platform.gets()).toHaveLength(3);
    });

    it("destroys a machine that never shows a private address, and fails", async () => {
      platform.creations = ["made-then-reset"];
      platform.addressOnMake = false;

      const outcome = await createOn(platform);

      expect(platform.gets()).toHaveLength(SEARCH_READS);
      expect(platform.destroyed).toEqual(["m-1"]);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/never showed a private address/);
      expect(platform.posts()).toBe(1);
    });

    it("spends one budget of 429s across the reads of its search, not one per read", async () => {
      platform.creations = ["lost"];
      // Every read is refused twice before it is answered.
      platform.show = (read, held) =>
        read % 3 === 0 ? held : new Response("rate limited", { status: 429 });

      const outcome = await createOn(platform);

      // Two reads answered after two refusals each; the fifth refusal, on the third
      // read, is one more than the operation's four.
      expect(platform.gets()).toHaveLength(7);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/the search by its label failed: .*429/);
      expect(platform.posts()).toBe(1);
    });

    it("looks for a creation refused as a duplicate name, and adopts the machine found", async () => {
      const earlier = platform.hold("skrun-run-r1", { skrun_run_id: "r1" });
      platform.creations = [{ status: 409, body: "already_exists" }];

      const outcome = await createOn(platform);

      expect(outcome).toMatchObject({ id: earlier.id });
      expect(platform.posts()).toBe(1);
      expect(platform.gets()).toHaveLength(1);
    });

    it("looks for a creation whose success it could not read, and adopts the machine made", async () => {
      platform.creations = [{ status: 200, body: "<html>proxy</html>", made: true }];

      const outcome = await createOn(platform);

      expect(outcome).toMatchObject({ id: "m-1" });
      expect(platform.posts()).toBe(1);
    });

    it("reports a machine found by its label as adopted, and not sent again", async () => {
      platform.creations = ["made-then-reset"];
      const progress = { resent: false, adopted: false };

      await createOn(platform, undefined, progress);

      expect(progress).toEqual({
        resent: false,
        adopted: true,
        firstSentAt: 0,
        lastSentAt: 0,
      });
    });

    it("reports a creation answered at once as neither sent again nor adopted", async () => {
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(outcome).toMatchObject({ id: "m-1" });
      expect(progress).toEqual({
        resent: false,
        adopted: false,
        firstSentAt: 0,
        lastSentAt: 0,
      });
    });

    it("looks again when the resend is refused as a duplicate name, and adopts the machine found", async () => {
      // The first request made its machine, which shows only after the first search.
      platform.creations = ["made-then-reset", { status: 409, body: "already_exists" }];
      platform.show = (read, held) => (read <= SEARCH_READS ? [] : held);
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(outcome).toMatchObject({ id: "m-1" });
      expect(platform.posts()).toBe(2);
      expect(platform.gets()).toHaveLength(SEARCH_READS + 1);
      expect(progress).toEqual({
        resent: true,
        adopted: true,
        firstSentAt: 0,
        lastSentAt: 5_000,
      });
    });

    it("adopts the machine of a resend whose outcome is unknown again, once its search finds it", async () => {
      platform.creations = ["lost", "made-then-reset"];
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(outcome).toMatchObject({ id: "m-1" });
      expect(platform.posts()).toBe(2);
      expect(platform.gets()).toHaveLength(SEARCH_READS + 1);
      expect(progress).toEqual({
        resent: true,
        adopted: true,
        firstSentAt: 0,
        lastSentAt: 5_000,
      });
    });

    it("never sends a third time: a resend whose outcome is unknown again is looked for, then fails", async () => {
      platform.creations = ["lost", "lost"];
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      expect(platform.posts()).toBe(2);
      expect(platform.gets()).toHaveLength(2 * SEARCH_READS);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", machineId: null } });
      expect(causeOf(outcome)).toMatch(
        /no machine with its label appeared after it was sent again/,
      );
      expect(progress).toEqual({
        resent: true,
        adopted: false,
        firstSentAt: 0,
        lastSentAt: 5_000,
      });
    });

    it("spends one budget of 429s for the whole creation: refusals before and after a resend count together", async () => {
      const refused = { status: 429, body: "rate limited" };
      platform.creations = [refused, refused, "lost", ...Array(10).fill(refused)];
      const progress = { resent: false, adopted: false };

      const outcome = await createOn(platform, undefined, progress);

      // Two refusals, the request lost, the resend; then three more refusals, the
      // last one past the operation's four retries.
      expect(platform.posts()).toBe(6);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(outcome).toMatchObject({ details: { phase: "create", httpStatus: 429 } });
      expect(progress.resent).toBe(true);
    });

    /** The attempts of the 429 refusals logged for one action, in order. */
    function refusalsOf(lines: ReturnType<typeof recordingLogger>["lines"], action: string) {
      return lines
        .filter((l) => l.fields.event === "fly_api_rate_limited" && l.fields.action === action)
        .map((l) => l.fields.attempt);
    }

    it("gives the reads of its search a budget of 429s apart from its requests': four retries each", async () => {
      const refused = { status: 429, body: "rate limited" };
      // The request refused four times, each waited out; the fifth made the machine and lost the answer.
      platform.creations = [refused, refused, refused, refused, "made-then-reset"];
      // The search's reads refused four times too, before one is answered.
      platform.show = (read, held) =>
        read <= FLY_429_MAX_RETRIES ? new Response("rate limited", { status: 429 }) : held;
      const { logger, lines } = recordingLogger();

      const outcome = await createOn(platform, logger);

      expect(outcome).toMatchObject({ id: "m-1" });
      expect(platform.posts()).toBe(FLY_429_MAX_RETRIES + 1);
      expect(platform.gets()).toHaveLength(FLY_429_MAX_RETRIES + 1);
      expect(refusalsOf(lines, "create")).toEqual([1, 2, 3, 4]);
      expect(refusalsOf(lines, "list")).toEqual([1, 2, 3, 4]);
    });

    it("spends one budget of 429s across both its searches, before and after the resend", async () => {
      platform.creations = ["lost", "lost"];
      // Two refusals in the first search, three in the second: five, one past the operation's four.
      const refusedReads = new Set([1, 2, 8, 9, 10]);
      platform.show = (read, held) =>
        refusedReads.has(read) ? new Response("rate limited", { status: 429 }) : held;
      const { logger, lines } = recordingLogger();

      const outcome = await createOn(platform, logger);

      // The first search: two refusals, then its five reads; the resend; the second
      // search ends on its third refusal.
      expect(platform.gets()).toHaveLength(2 + SEARCH_READS + 3);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(causeOf(outcome)).toMatch(/the search by its label failed: .*429/);
      expect(platform.posts()).toBe(2);
      expect(refusalsOf(lines, "list")).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("listByLabel", () => {
    it("asks the platform for one label, and keeps only the machines that carry it", async () => {
      const clock = virtualClock();
      const platform = new RecoveryPlatform(clock);
      platform.ignoreFilter = true;
      const mine = platform.hold("skrun-run-r1", { skrun_run_id: "r1" });
      platform.hold("skrun-run-r2", { skrun_run_id: "r2" });
      platform.hold("skrun-pool-p1", { skrun_pool_id: "r1" });

      const found = await clock.settle(
        recoveringClient(platform, clock).listByLabel("skrun_run_id", "r1"),
      );

      expect(found.map((m) => m.id)).toEqual([mine.id]);
      expect(platform.gets()).toEqual([{ path: LABELLED_LISTING, at: 0 }]);
    });

    it("reads a label again after a 5xx or a 408, three times at most, as after a network error", async () => {
      const clock = virtualClock();
      const platform = new RecoveryPlatform(clock);
      const mine = platform.hold("skrun-run-r1", { skrun_run_id: "r1" });
      const refusals = [502, 408, 503];
      platform.show = (read, held) =>
        read <= refusals.length ? new Response("", { status: refusals[read - 1] }) : held;

      const found = await clock.settle(
        recoveringClient(platform, clock).listByLabel("skrun_run_id", "r1"),
      );

      expect(found.map((m) => m.id)).toEqual([mine.id]);
      expect(platform.gets().map((g) => g.at)).toEqual([0, 250, 750, 1750]);
    });

    it.each([
      ["a listing of the whole app", (api: FlyMachinesApi) => api.list()],
      ["an order on one machine", (api: FlyMachinesApi) => api.destroy("fdmach_abc123")],
    ])("leaves %s failing at once on a 5xx: only a label search reads again", async (_what, call) => {
      fetchSpy.mockResolvedValue(new Response("unavailable", { status: 503 }));
      const waits: number[] = [];
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        sleepImpl: recordingSleep(waits),
      });

      await expect(call(api)).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 503 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });

    it("shares one request between two calls for the same label", async () => {
      const clock = virtualClock();
      const platform = new RecoveryPlatform(clock);
      const api = recoveringClient(platform, clock);

      await clock.settle(
        Promise.all([api.listByLabel("skrun_run_id", "r1"), api.listByLabel("skrun_run_id", "r1")]),
      );

      expect(platform.gets()).toHaveLength(1);
    });

    it("takes six label searches at once and a reconciliation from the listings' bucket: three at once, then one per second", async () => {
      const clock = virtualClock();
      const sent = platformRecording(clock);
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
      });
      const pool = new RunnerPool(api, { size: 1, imageTag: "img", now: clock.now });

      await clock.settle(
        Promise.all([
          ...[1, 2, 3, 4, 5, 6].map((n) => api.listByLabel("skrun_run_id", `r${n}`)),
          pool.reconcile(),
        ]),
      );

      expect(sent.map((s) => s.at)).toEqual([0, 0, 0, 1000, 2000, 3000, 4000]);
    });
  });

  describe("classifyCreateFailure", () => {
    function networkError(code: string): TypeError {
      return new TypeError("fetch failed", {
        cause: Object.assign(new Error(code), { code }),
      });
    }

    it.each([
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
    ])("reads %s as a request that never left", (code) => {
      expect(classifyCreateFailure({ kind: "network", error: networkError(code) })).toBe(
        "never-sent",
      );
    });

    it.each([
      "ECONNRESET",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "EPIPE",
      "ETIMEDOUT",
    ])("reads %s as an outcome unknown", (code) => {
      expect(classifyCreateFailure({ kind: "network", error: networkError(code) })).toBe("unknown");
    });

    it("reads the code of an error that carries no cause", () => {
      const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      expect(classifyCreateFailure({ kind: "network", error: refused })).toBe("never-sent");
      expect(classifyCreateFailure({ kind: "network", error: new Error("?") })).toBe("unknown");
    });

    it("reads every address refusing as never sent, and one that did not as unknown", () => {
      const every = (...codes: string[]) =>
        new TypeError("fetch failed", {
          cause: new AggregateError(
            codes.map((code) => Object.assign(new Error(code), { code })),
            "",
          ),
        });
      expect(
        classifyCreateFailure({ kind: "network", error: every("ECONNREFUSED", "ENOTFOUND") }),
      ).toBe("never-sent");
      expect(
        classifyCreateFailure({ kind: "network", error: every("ECONNREFUSED", "ECONNRESET") }),
      ).toBe("unknown");
      expect(classifyCreateFailure({ kind: "network", error: every() })).toBe("unknown");
    });

    it.each([
      [408, "unknown"],
      [500, "unknown"],
      [502, "unknown"],
      [504, "unknown"],
      [DUPLICATE_NAME_STATUS, "duplicate-name"],
      [429, "rate-limited"],
      [400, "refused"],
      [401, "refused"],
      [404, "refused"],
      [412, "refused"],
      [422, "refused"],
    ] as const)("reads an answer of %i as %s", (status, expected) => {
      expect(classifyCreateFailure({ kind: "status", status })).toBe(expected);
    });

    it("reads a success whose body cannot be read as a machine as an outcome unknown", () => {
      expect(classifyCreateFailure({ kind: "unreadable", status: 200 })).toBe("unknown");
    });

    it("takes the name refused as taken to be the platform's 409", () => {
      expect(DUPLICATE_NAME_STATUS).toBe(409);
    });
  });

  describe("the bounds, exported", () => {
    it("are the platform's documented rate and the client's patience", () => {
      expect({
        FLY_APP_ACTION_BURST,
        FLY_APP_ACTION_RATE_PER_S,
        FLY_429_MAX_RETRIES,
        FLY_429_BACKOFF_MS,
        FLY_RETRY_AFTER_CAP_MS,
        CREATE_DIRECT_RETRY_WAITS_MS,
        SEARCH_READS,
        SEARCH_SPACING_MS,
      }).toEqual({
        FLY_APP_ACTION_BURST: 3,
        FLY_APP_ACTION_RATE_PER_S: 1,
        FLY_429_MAX_RETRIES: 4,
        FLY_429_BACKOFF_MS: [1000, 2000, 4000, 8000],
        FLY_RETRY_AFTER_CAP_MS: 10_000,
        CREATE_DIRECT_RETRY_WAITS_MS: [250, 500, 1000],
        SEARCH_READS: 5,
        SEARCH_SPACING_MS: 1000,
      });
    });

    it("bound a creation among 21 at once, five reads per search, at 141 s", () => {
      // 18 s for a slot, 40 s of patience for the requests and 40 s for the
      // search reads, two searches of five reads — each a second of spacing and
      // three retries counted at a second each —, 3 s of direct retries.
      expect(createWorstCaseMs({ concurrentCreates: 21, searchReads: 5 })).toBe(141_000);
    });

    it("add no wait for a slot while the creations fit in the burst", () => {
      expect(createWorstCaseMs({ concurrentCreates: 1, searchReads: 5 })).toBe(123_000);
      expect(createWorstCaseMs({ concurrentCreates: 3, searchReads: 5 })).toBe(123_000);
      expect(createWorstCaseMs({ concurrentCreates: 4, searchReads: 5 })).toBe(124_000);
    });

    it("count the client's own reads per search when none is given", () => {
      expect(createWorstCaseMs({ concurrentCreates: 21 })).toBe(141_000);
    });

    it("bound every attempt per kind of call — a creation and a suspend longest, a label read and a metadata write shortest", () => {
      expect(FLY_ATTEMPT_TIMEOUT_MS).toEqual({
        create: 60_000,
        start: 30_000,
        suspend: 60_000,
        stop: 30_000,
        destroy: 30_000,
        list: 30_000,
        listByLabel: 15_000,
        metadata: 15_000,
      });
      expect(Object.isFrozen(FLY_ATTEMPT_TIMEOUT_MS)).toBe(true);
    });
  });

  // The bound measured against the client itself: one creation that spends every
  // term — its direct retries, its 429s, both searches and the 429s of their
  // reads — and whose every read is cut three times before it is answered. Each
  // retry takes a slot of its bucket again, so the reads also wait for slots.
  describe("the longest a creation waits, measured against the client", () => {
    type Step = () => Response | Error;
    const cut = () => networkFailure("ECONNRESET");
    const neverLeft = () => networkFailure("ECONNREFUSED");
    const slowDown = () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "10" } });
    const nothing = () => new Response("[]", { status: 200 });

    async function spendEveryTerm(cutRead: Step) {
      const clock = virtualClock();
      // Three requests that never left, four refusals for the rate, then the
      // connection cut once the request left; the resend cut the same way.
      const posts: Step[] = [
        neverLeft,
        neverLeft,
        neverLeft,
        slowDown,
        slowDown,
        slowDown,
        slowDown,
        cut,
        cut,
      ];
      // Every read of both searches cut three times, then answered with no machine;
      // the first four refused for the rate before that.
      const gets: Step[] = Array.from({ length: 2 * SEARCH_READS }, (_, read) => [
        ...(read < FLY_429_MAX_RETRIES ? [slowDown] : []),
        cutRead,
        cutRead,
        cutRead,
        nothing,
      ]).flat();
      const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const step = ((init?.method ?? "GET") === "POST" ? posts : gets).shift();
        if (!step) throw new Error("the script ran out of answers");
        const answer = step();
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch;
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl,
        nowImpl: clock.now,
        sleepImpl: clock.sleep,
        logger: recordingLogger().logger,
      });

      const outcome = await clock.settle(api.create(runMachine("r1")).catch((e: unknown) => e));

      return { elapsed: clock.now(), outcome, unasked: posts.length + gets.length };
    }

    it.each([
      ["cut by the network", cut],
      ["answered 503 by the platform", () => new Response("unavailable", { status: 503 })],
    ])("stays within the bound when every read is %s three times", async (_what, cutRead) => {
      const { elapsed, outcome, unasked } = await spendEveryTerm(cutRead);

      // Every answer scripted was asked for: each term was spent.
      expect(unasked).toBe(0);
      expect(outcome).toBeInstanceOf(MachineSpawnError);
      expect(elapsed).toBeLessThanOrEqual(createWorstCaseMs({ concurrentCreates: 1 }));
    });
  });
});
