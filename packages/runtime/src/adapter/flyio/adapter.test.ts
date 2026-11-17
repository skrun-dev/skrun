import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSpawnError } from "../../errors.js";
import {
  readOutputLimits,
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
} from "../../files/output-rules.js";
import type {
  HistoryEntry,
  LLMCallRequest,
  LLMCallResponse,
  LLMProvider,
} from "../../llm/providers/types.js";
import { LLMRouter } from "../../llm/router.js";
import type { Logger } from "../../logger.js";
import { ClaimRequestSchema, INIT_STAGES } from "../../runner-contract.js";
import { DEFAULT_MCP_CONNECT_TIMEOUT_MS } from "../../tools/mcp-provider.js";
import { ToolRegistry } from "../../tools/registry.js";
import { INSTALL_REGISTRY_ALLOWLIST } from "../../tools/script-deps-installers.js";
import { SCRIPT_DEPS_INSTALL_TIMEOUT_MS } from "../../tools/script-deps-resolver.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { RunEvent, RunnerSpawnedInfo, RunRequest } from "../../types.js";
import { RUN_TOOL_RESULTS_MAX_BYTES, TOOL_RESULT_NOT_KEPT_MARKER } from "../tool-results-budget.js";
import { acquisitionBudgetMs, seatDeadlineMarginMs } from "./acquisition-budget.js";
import {
  FlyioAdapter,
  type FlyioAdapterOptions,
  INIT_RPC_TIMEOUT_MS,
  type PresignedStorageAdapter,
  type SpawnResult,
} from "./adapter.js";
import { FLY_APP_ACTION_BURST, FlyMachinesApi, type Machine } from "./fly-api.js";
import { STORAGE_HOST_PROBE_KEY } from "./infra-hosts.js";
import {
  MACHINE_LIFETIME_GRACE_MS,
  MAX_TIMER_DELAY_MS,
  machineLifetimeSeconds,
} from "./machine-lifetime.js";
import {
  OUTPUT_BYTES_BUDGET,
  OutputBytesBudget,
  processOutputBytesBudget,
} from "./output-bytes-budget.js";
import { runOutputKey } from "./output-keys.js";
import { OUTPUTS_UPLOAD_BUDGET_MS } from "./outputs-upload.js";
import { RunnerPool } from "./pool.js";
import type { RpcToolProviderOptions } from "./rpc-script-provider.js";

/**
 * The per-request bound of a script tool call, shortened for the cases that
 * must outlast it. `undefined` — every other case — leaves the provider's own
 * default untouched. The adapter builds its script provider itself, so the bound
 * is set where that class is defined rather than through an adapter option no
 * caller needs.
 */
const toolCallBound = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock("./rpc-script-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rpc-script-provider.js")>();
  class BoundedRpcScriptToolProvider extends actual.RpcScriptToolProvider {
    constructor(baseUrl: string, tools: ToolDefinition[], options: RpcToolProviderOptions = {}) {
      super(
        baseUrl,
        tools,
        toolCallBound.ms === undefined ? options : { ...options, timeoutMs: toolCallBound.ms },
      );
    }
  }
  return { ...actual, RpcScriptToolProvider: BoundedRpcScriptToolProvider };
});

function createRunRequest(overrides?: Partial<RunRequest>): RunRequest {
  return {
    agentConfig: {
      name: "test-agent",
      description: "Test agent",
      version: "1.0.0",
      model: { provider: "mock", name: "mock-model" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [],
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: [] },
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
      },
      state: { type: "none" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "You are a test agent.",
    input: { query: "hello" },
    runId: "test-run-id",
    bundleKey: "test/agent/1.0.0.agent",
    ...overrides,
  };
}

function makeMachine(id: string): Machine {
  return {
    id,
    name: `skrun-run-${id}`,
    state: "started",
    private_ip: "fdaa::1",
  } as Machine;
}

function createMockFlyApi(machineId = "machine-123"): {
  api: FlyMachinesApi;
  createSpy: ReturnType<typeof vi.fn>;
  destroySpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn().mockResolvedValue(makeMachine(machineId));
  const destroySpy = vi.fn().mockResolvedValue(undefined);
  const api = {
    create: createSpy,
    destroy: destroySpy,
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(),
  } as unknown as FlyMachinesApi;
  return { api, createSpy, destroySpy };
}

function createMockStorage(): PresignedStorageAdapter {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.example/get?sig=xyz"),
    getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put?sig=xyz"),
  };
}

/**
 * Mock fetch impl: /healthz returns 200, /init returns ok+empty tools.
 * Any other URL returns 404 (test expectations should not reach them).
 */
function createMockFetch(): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/init")) {
      return new Response(JSON.stringify({ ok: true, tools: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * Mock LLM provider that hangs until its abort is detected. Used to
 * simulate a long-running run that the caller aborts mid-flight. Resolves
 * with a stable response when not aborted (so timeout tests can succeed).
 */
function createHangingProvider(): LLMProvider {
  return {
    name: "mock",
    call: vi.fn(
      () =>
        new Promise((resolve) => {
          // Park forever — abort will tear down the surrounding race.
          setTimeout(
            () =>
              resolve({
                content: '{"result":"ok"}',
                usage: { promptTokens: 1, completionTokens: 1 },
              }),
            5_000,
          );
        }),
    ),
  };
}

async function collectEvents(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("FlyioAdapter one-shot execute()", () => {
  it("throws an actionable error that points to streaming, without internal jargon", async () => {
    const { api } = createMockFlyApi("m-oneshot");
    const adapter = new FlyioAdapter(api, createMockStorage(), new LLMRouter(), new ToolRegistry());
    const err = (await adapter.execute(createRunRequest()).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/stream/i);
    expect(err.message).not.toMatch(/skeleton/i);
    // The two clients that work on this runtime, by reading the stream.
    expect(err.message).toContain("skrun run");
    expect(err.message).toContain("client.run()");
  });
});

describe("FlyioAdapter abort handling", () => {
  it("destroys the machine exactly once with reason=aborted when caller fires abort mid-loop", async () => {
    const { api, createSpy, destroySpy } = createMockFlyApi("m-abort-mid");
    const storage = createMockStorage();
    const router = new LLMRouter();
    router.registerProvider("mock", createHangingProvider());
    const tools = new ToolRegistry();
    const fetchImpl = createMockFetch();
    const adapter = new FlyioAdapter(api, storage, router, tools, undefined, { fetchImpl });

    const controller = new AbortController();
    const request = createRunRequest({ abortSignal: controller.signal });

    // Trigger abort 25ms after starting — the agent loop will be blocked
    // on the hanging LLM call at that point.
    setTimeout(() => controller.abort(), 25);

    const events = await collectEvents(adapter.executeStream(request));

    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledWith("m-abort-mid");

    // The per-run RPC token is injected into the machine env AND
    // sent as a Bearer on the /init RPC (initRunner's own fetch path).
    const machineEnv = createSpy.mock.calls[0][0].config.env;
    expect(machineEnv.RUNNER_RPC_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    const initCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith("/init"));
    expect(initCall?.[1].headers.Authorization).toBe(`Bearer ${machineEnv.RUNNER_RPC_TOKEN}`);

    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.code).toBe("ABORTED");
    }
  });

  it("creates nothing when the caller fired its abort before the run began, and ends at once", async () => {
    const { api, createSpy, destroySpy } = createMockFlyApi("m-abort-pre");
    const storage = createMockStorage();
    const router = new LLMRouter();
    router.registerProvider("mock", createHangingProvider());
    const tools = new ToolRegistry();
    const fetchImpl = createMockFetch();
    const adapter = new FlyioAdapter(api, storage, router, tools, undefined, { fetchImpl });

    const controller = new AbortController();
    controller.abort();
    const request = createRunRequest({ abortSignal: controller.signal });

    const events = await collectEvents(adapter.executeStream(request));

    // The acquisition listens to the caller's signal: aborted already, it
    // creates no machine — and so has none to destroy.
    expect(createSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();

    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.code).toBe("MACHINE_SPAWN_FAILED");
    }
  });

  it("does NOT call destroy when spawn itself fails at create phase (no machine to leak)", async () => {
    const createSpy = vi.fn().mockRejectedValue(new Error("Fly API 500"));
    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const api = {
      create: createSpy,
      destroy: destroySpy,
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;
    const storage = createMockStorage();
    const router = new LLMRouter();
    const tools = new ToolRegistry();
    const fetchImpl = createMockFetch();
    const adapter = new FlyioAdapter(api, storage, router, tools, undefined, { fetchImpl });

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).not.toHaveBeenCalled();
    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
  });
});

describe("FlyioAdapter spawn failure diagnostics", () => {
  it("logs the Fly.io API cause + phase + httpStatus when spawn fails at create", async () => {
    // Reproduces the real incident: the runner image tag was deleted from
    // the registry, so Fly's POST /machines returns 400 "manifest unknown".
    // That body lives on the MachineSpawnError cause; this asserts the
    // spawn_failed log surfaces it so the failure is diagnosable from logs.
    const createSpy = vi.fn().mockRejectedValue(
      new MachineSpawnError(
        {
          machineName: "skrun-run-test-run-id",
          machineId: null,
          phase: "create",
          httpStatus: 400,
        },
        new Error(
          "Fly.io API POST /apps/runners/machines: 400 manifest unknown for tag 0.9.0-dev13",
        ),
      ),
    );
    const api = {
      create: createSpy,
      destroy: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;
    const storage = createMockStorage();
    const router = new LLMRouter();
    const tools = new ToolRegistry();
    const fetchImpl = createMockFetch();
    const errorSpy = vi.fn();
    const mockLogger = {
      error: errorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const adapter = new FlyioAdapter(
      api,
      storage,
      router,
      tools,
      undefined,
      { fetchImpl },
      mockLogger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const spawnFailedLog = errorSpy.mock.calls.find(
      (c) => (c[0] as { event?: string } | undefined)?.event === "spawn_failed",
    );
    expect(spawnFailedLog).toBeDefined();
    const logObj = spawnFailedLog?.[0] as {
      cause?: string;
      phase?: string;
      httpStatus?: number | null;
    };
    expect(logObj.cause).toContain("manifest unknown");
    expect(logObj.phase).toBe("create");
    expect(logObj.httpStatus).toBe(400);

    // The caller-facing run_error stays opaque — Fly internals never leak to
    // marketplace consumers; the diagnostic detail is log-only.
    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.message).not.toContain("manifest unknown");
    }
  });
});

// spawn_failed keeps a cause that describes our infrastructure — the platform's
// answer, our own boot probe's status, an /init that got no answer — and drops
// any cause written once the runner has answered: its answer is made of what the
// agent declares. The error itself: its class, code and status, never its message.
describe("FlyioAdapter — the cause a failed spawn keeps", () => {
  const WITNESS = "witness-9b1e";

  function spawnAdapter(api: FlyMachinesApi, fetchImpl: typeof fetch, logger: Logger) {
    return new FlyioAdapter(
      api,
      createMockStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, maxBootTimeMs: 60, bootPollIntervalMs: 5 },
      logger,
    );
  }

  it("keeps the platform's answer when the machine cannot be created", async () => {
    const api = createMockFlyApi("unused").api;
    vi.mocked(api.create).mockRejectedValue(
      new MachineSpawnError(
        { machineName: "skrun-run-test-run-id", machineId: null, phase: "create", httpStatus: 400 },
        new Error("Fly.io API POST /apps/runners/machines: 400 manifest unknown"),
      ),
    );
    const log = recordingLogger();

    await collectEvents(
      spawnAdapter(api, createMockFetch(), log.logger).executeStream(createRunRequest()),
    );

    const line = log.line("spawn_failed");
    expect(JSON.stringify(line)).not.toContain("Failed to spawn");
    expect(line).toMatchObject({
      phase: "create",
      error_name: "MachineSpawnError",
      error_status: "400",
      cause: expect.stringContaining("manifest unknown"),
    });
  });

  it("writes neither the runner's answer nor any cause when its init fails", async () => {
    const { api } = createMockFlyApi("m-init-500");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(`mcp server unreachable: ${WITNESS}`, { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const log = recordingLogger();

    const events = await collectEvents(
      spawnAdapter(api, fetchImpl, log.logger).executeStream(createRunRequest()),
    );

    const line = log.line("spawn_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("cause");
    expect(line).toMatchObject({
      phase: "init-rpc",
      error_name: "MachineSpawnError",
      error_status: "500",
    });
    const last = events[events.length - 1];
    expect(last.type === "run_error" && last.error.code).toBe("MACHINE_SPAWN_FAILED");
  });

  it("writes no cause when the runner's init answer cannot be read", async () => {
    const { api } = createMockFlyApi("m-init-malformed");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: false, detail: WITNESS }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const log = recordingLogger();

    await collectEvents(spawnAdapter(api, fetchImpl, log.logger).executeStream(createRunRequest()));

    const line = log.line("spawn_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("cause");
    expect(line).toMatchObject({ phase: "init-rpc", error_name: "MachineSpawnError" });
  });

  it("keeps the network error when the runner's init cannot be reached", async () => {
    const { api } = createMockFlyApi("m-init-unreachable");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const log = recordingLogger();

    await collectEvents(spawnAdapter(api, fetchImpl, log.logger).executeStream(createRunRequest()));

    const line = log.line("spawn_failed");
    expect(JSON.stringify(line)).not.toContain("Failed to spawn");
    expect(line).not.toHaveProperty("error_status");
    expect(line).toMatchObject({
      phase: "init-rpc",
      httpStatus: null,
      error_name: "MachineSpawnError",
      cause: "fetch failed",
    });
  });

  it("keeps the boot probe's status when the runner never becomes healthy", async () => {
    const { api } = createMockFlyApi("m-unhealthy");
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;
    const log = recordingLogger();

    await collectEvents(spawnAdapter(api, fetchImpl, log.logger).executeStream(createRunRequest()));

    const line = log.line("spawn_failed");
    expect(JSON.stringify(line)).not.toContain("Failed to spawn");
    expect(line).toMatchObject({
      phase: "boot-probe",
      error_name: "MachineSpawnError",
      cause: "/healthz returned HTTP 503",
    });
  });
});

// A run whose machine never got ready is charged nothing: the API learns the
// phase its acquisition stopped at from a callback, and it must have learnt it
// before the run's error is handed out — the consumer ends the run on that
// event, the stream's and the webhook's alike.
describe("FlyioAdapter — a failed start names its phase before its run_error", () => {
  /** A storage that will not sign the bundle's download: the presign phase fails. */
  function unsignedStorage(): PresignedStorageAdapter {
    return {
      put: vi.fn().mockResolvedValue(undefined),
      getPresignedDownloadUrl: vi.fn(async (key: string) => {
        if (key === "test/agent/1.0.0.agent") throw new Error("the store refused to sign");
        return `https://store.example/${key}`;
      }),
      getPresignedUploadUrl: vi.fn().mockResolvedValue("https://store.example/put"),
    };
  }

  /** /healthz answers; /init answers 500, as a runner whose MCP server failed to connect. */
  function initFails(): typeof fetch {
    return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) return new Response("mcp server unreachable", { status: 500 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  const CASES = {
    create: () => {
      const { api } = createMockFlyApi("unused");
      vi.mocked(api.create).mockRejectedValue(
        new MachineSpawnError(
          {
            machineName: "skrun-run-test-run-id",
            machineId: null,
            phase: "create",
            httpStatus: 400,
          },
          new Error("Fly.io API POST /apps/runners/machines: 400 manifest unknown"),
        ),
      );
      return { api, storage: createMockStorage(), fetchImpl: createMockFetch() };
    },
    "boot-probe": () => ({
      api: createMockFlyApi("m-unhealthy").api,
      storage: createMockStorage(),
      fetchImpl: vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    }),
    presign: () => ({
      api: createMockFlyApi("m-unsigned").api,
      storage: unsignedStorage(),
      fetchImpl: createMockFetch(),
    }),
    "init-rpc": () => ({
      api: createMockFlyApi("m-init-500").api,
      storage: createMockStorage(),
      fetchImpl: initFails(),
    }),
  } as const;

  it.each(
    Object.keys(CASES) as Array<keyof typeof CASES>,
  )("%s: the phase is named once, before the run_error is read", async (phase) => {
    const { api, storage, fetchImpl } = CASES[phase]();
    const order: string[] = [];
    const adapter = new FlyioAdapter(
      api,
      storage,
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      {
        fetchImpl,
        maxBootTimeMs: 60,
        bootPollIntervalMs: 5,
        onSpawnFailed: (info) => order.push(`phase:${String(info.phase)}`),
      },
      recordingLogger().logger,
    );

    for await (const event of adapter.executeStream(createRunRequest())) {
      if (event.type === "run_error") order.push(`run_error:${event.error.code}`);
    }

    expect(order).toEqual([`phase:${phase}`, "run_error:MACHINE_SPAWN_FAILED"]);
  });

  // What the caller reads of a failed start — and what its row keeps — is built
  // here, in fixed words: the phase, and a status the platform answered. Never
  // the machine's name or id (operator topology, kept for the logs), nor
  // anything of the runner's answer, its status included.
  const TOLD: Record<keyof typeof CASES, string> = {
    create: 'The run\'s machine could not be started (phase "create", HTTP 400).',
    "boot-probe": 'The run\'s machine could not be started (phase "boot-probe").',
    presign: 'The run\'s machine could not be started (phase "presign").',
    "init-rpc": 'The run\'s machine could not be started (phase "init-rpc").',
  };

  /** The machine the operator's line names: none when it was never made. */
  const MACHINE: Record<keyof typeof CASES, string | null> = {
    create: null,
    "boot-probe": "m-unhealthy",
    presign: "m-unsigned",
    "init-rpc": "m-init-500",
  };

  it.each(
    Object.keys(CASES) as Array<keyof typeof CASES>,
  )("%s: the caller is told the phase in fixed words — no machine's name or id, nothing the runner answered", async (phase) => {
    const { api, storage, fetchImpl } = CASES[phase]();
    const log = recordingLogger();
    const adapter = new FlyioAdapter(
      api,
      storage,
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, maxBootTimeMs: 60, bootPollIntervalMs: 5 },
      log.logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const last = events.at(-1);
    const told = last?.type === "run_error" ? last.error : undefined;
    expect(told).toEqual({ code: "MACHINE_SPAWN_FAILED", message: TOLD[phase] });
    expect(JSON.stringify(events)).not.toMatch(
      /m-unhealthy|m-unsigned|m-init-500|skrun-run-|unreachable|HTTP 500/,
    );
    // The machine goes to the operator's line instead.
    expect(log.line("spawn_failed")).toMatchObject({ phase, machine_id: MACHINE[phase] });
  });

  it("a run whose machine got ready names no phase, whatever ends it after", async () => {
    const { api } = createMockFlyApi("m-ok");
    const onSpawnFailed = vi.fn();
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch(), onSpawnFailed },
      recordingLogger().logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    // The runner answered; the run then fails on its model — no provider here.
    expect(events.map((event) => event.type)).toContain("runner_spawned");
    expect(events.at(-1)?.type).toBe("run_error");
    expect(onSpawnFailed).not.toHaveBeenCalled();
  });
});

function createOkProvider(): LLMProvider {
  return {
    name: "mock",
    call: vi.fn(async () => ({
      content: '{"result":"ok"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    })),
  };
}

// A streamed run's consumer closes the generator at the run's final event,
// without pulling again: what follows that event is the generator's `finally`.
describe("FlyioAdapter — a consumer that closes the run at its final event", () => {
  it("a run its loop ends on a run_error, closed there, destroys its machine once, under the reason run_error", async () => {
    const { api, destroySpy } = createMockFlyApi("m-closed-at-error");
    const router = new LLMRouter();
    // Far over the request's max_cost of 1.0: the loop ends on COST_EXCEEDED.
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async () => ({
        content: '{"result":"ok"}',
        usage: { promptTokens: 1_000_000_000, completionTokens: 1 },
      })),
    });
    const lines: Array<Record<string, unknown>> = [];
    const record = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = {
      info: record,
      warn: record,
      error: record,
      debug: record,
    } as unknown as Logger;
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch() },
      logger,
    );

    let final: RunEvent | undefined;
    for await (const event of adapter.executeStream(createRunRequest())) {
      if (event.type === "run_complete" || event.type === "run_error") {
        final = event;
        break;
      }
    }

    expect(final?.type === "run_error" && final.error.code).toBe("COST_EXCEEDED");
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(
      lines.filter((line) => line.event === "machine_destroy").map((line) => line.reason),
    ).toEqual(["run_error"]);
  });
});

/** Mock fetch: /healthz 200; /init returns the given body. */
function fetchReturningInit(initBody: unknown): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/init")) {
      return new Response(JSON.stringify(initBody), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("FlyioAdapter cold-start telemetry", () => {
  function makeAdapter(
    fetchImpl: typeof fetch,
    onRunnerSpawned?: (info: RunnerSpawnedInfo) => void,
  ): FlyioAdapter {
    const { api } = createMockFlyApi("m-telemetry");
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    return new FlyioAdapter(api, createMockStorage(), router, new ToolRegistry(), undefined, {
      fetchImpl,
      onRunnerSpawned,
    });
  }

  const initWithPhases = {
    ok: true,
    tools: [],
    phases: { bundle_ms: 200, extract_ms: 100, mcp_ms: 0 },
    boot: { vm_boot_ms: 3000, entrypoint_egress_ms: 80 },
  };

  it("emits runner_spawned (its phases, never the machine or its address) right after run_start", async () => {
    const adapter = makeAdapter(fetchReturningInit(initWithPhases));
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    expect(events.map((e) => e.type).indexOf("runner_spawned")).toBe(1); // after run_start
    const spawned = events[1];
    if (spawned.type === "runner_spawned") {
      expect(typeof spawned.phases.create_api_ms).toBe("number");
      // The phases only — no operator-internal fields on the wire event.
      expect(Object.keys(spawned)).not.toContain("machineId");
      expect(Object.keys(spawned)).not.toContain("private_ip");
    }
  });

  it("derives host_schedule_pull + surfaces vm_boot; callback carries machine/IP", async () => {
    let captured: RunnerSpawnedInfo | undefined;
    const adapter = makeAdapter(fetchReturningInit(initWithPhases), (info) => {
      captured = info;
    });
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    const spawned = events.find((e) => e.type === "runner_spawned");
    if (spawned?.type === "runner_spawned") {
      expect(spawned.phases.vm_boot_ms).toBe(3000);
      expect(spawned.phases.entrypoint_egress_ms).toBe(80);
      expect(spawned.phases.init_bundle_ms).toBe(200);
      // Derived (create->healthz - vm_boot, clamped >= 0); present because vm_boot is.
      expect(typeof spawned.phases.host_schedule_pull_ms).toBe("number");
    }
    // The operator-only callback carries machine id + private IP (never the event).
    expect(captured?.machineId).toBe("m-telemetry");
    expect(captured?.privateIp).toBe("fdaa::1");
  });

  it("degrades (no throw) when the runner omits phases/boot (older image)", async () => {
    const adapter = makeAdapter(fetchReturningInit({ ok: true, tools: [] })); // old shape
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    const spawned = events.find((e) => e.type === "runner_spawned");
    expect(spawned).toBeDefined();
    if (spawned?.type === "runner_spawned") {
      expect(typeof spawned.phases.create_api_ms).toBe("number");
      expect(spawned.phases.vm_boot_ms).toBeUndefined();
      expect(spawned.phases.host_schedule_pull_ms).toBeUndefined();
      expect(spawned.phases.init_bundle_ms).toBeUndefined();
    }
  });

  it("carries the dependency install the runner reports, and does without it from an older runner", async () => {
    const spawnedPhases = async (initBody: unknown) => {
      const events = await collectEvents(
        makeAdapter(fetchReturningInit(initBody)).executeStream(createRunRequest()),
      );
      const spawned = events.find((e) => e.type === "runner_spawned");
      return spawned?.type === "runner_spawned" ? spawned.phases : undefined;
    };

    const current = await spawnedPhases({
      ...initWithPhases,
      phases: { ...initWithPhases.phases, deps_ms: 1500 },
    });
    expect(current?.init_deps_ms).toBe(1500);

    // A runner image that predates the install sends the other three phases only.
    const older = await spawnedPhases(initWithPhases);
    expect(older?.init_bundle_ms).toBe(200);
    expect(older?.init_deps_ms).toBeUndefined();
  });

  it("the spawn flow (create -> healthz -> init -> run) is unchanged by the timing", async () => {
    const { api, createSpy } = createMockFlyApi("m-rt3");
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: createMockFetch(),
      },
    );
    const types = (await collectEvents(adapter.executeStream(createRunRequest()))).map(
      (e) => e.type,
    );
    // Spawn succeeded (machine created once, runner_spawned emitted after run_start)
    // — the create->healthz->init flow is intact; the timing wrappers didn't alter it.
    expect(createSpy).toHaveBeenCalledOnce();
    expect(types[0]).toBe("run_start");
    expect(types).toContain("runner_spawned");
  });
});

describe("FlyioAdapter — the image a cold runner was created with", () => {
  /** Runs one cold spawn whose create response carries `imageRef`; returns the spawn_ready log. */
  async function spawnReadyLog(imageRef: Machine["image_ref"]): Promise<Record<string, unknown>> {
    const machine = { ...makeMachine("m-image"), image_ref: imageRef } as Machine;
    const api = {
      create: vi.fn().mockResolvedValue(machine),
      destroy: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;
    const infoSpy = vi.fn();
    const logger = {
      error: vi.fn(),
      info: infoSpy,
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch() },
      logger,
    );
    await collectEvents(adapter.executeStream(createRunRequest()));
    const call = infoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string } | undefined)?.event === "spawn_ready",
    );
    expect(call).toBeDefined();
    return call?.[0] as Record<string, unknown>;
  }

  it("logs the image the platform reports, digest included, on spawn_ready", async () => {
    const log = await spawnReadyLog({
      registry: "registry.fly.io",
      repository: "runners-app",
      tag: "runner-1.2.3",
      digest: "sha256:0123abcd",
    });
    expect(log.image).toBe("registry.fly.io/runners-app:runner-1.2.3@sha256:0123abcd");
  });

  it("logs no image when the platform reports none — never a made-up one", async () => {
    const log = await spawnReadyLog(undefined);
    expect(log.image).toBeUndefined();
    expect(log.machine_id).toBe("m-image");
  });
});

// ---------------------------------------------------------------------------
// Pre-warm pool acquisition
// ---------------------------------------------------------------------------

/** A pool holding one ready machine, with the platform calls it needs spied. */
function poolHarness(
  over: {
    stale?: boolean;
    startFails?: boolean;
    /** What the wake throws, when it fails with a given error rather than a plain one. */
    startError?: unknown;
    claimStatus?: number;
    /** Process the machine identified itself as when it was built. `null` = an image too old to say. */
    filledProcessId?: string | null;
    /** Process it reports when assigned. Same value = a genuine wake; different = it cold-booted. */
    claimProcessId?: string | null;
    /** How long the pool has known the machine when the run arrives. */
    knownForMs?: number;
    /** The in-VM phases the runner reports from /init. Absent = none reported. */
    initPhases?: Record<string, number>;
    /** What /claim answers, as text. Absent = a JSON body that names the process. */
    claimBody?: string;
    /** What /init answers on the pooled machine only. Absent = the ok body; "cut" = no answer at all. */
    pooledInit?: { status: number; body: string } | "cut";
    /** What /init answers on the machine created for the run. Absent = the ok body. */
    coldInit?: { status: number; body: string };
    /** What /healthz answers on the pooled machine only, by status. Absent = 200. */
    pooledHealthz?: number;
    /**
     * A second ready machine, `pooled-2` at `fdaa::a`, offered after `pooled-1`.
     * What it does differently from the options above, which it otherwise
     * follows: its wake, its answer to the assignment, its `/init`.
     */
    second?: {
      startFails?: boolean;
      claimStatus?: number;
      init?: { status: number; body: string };
    };
  } = {},
) {
  const calls: string[] = [];
  const flyApi = {
    create: vi.fn(async () => {
      calls.push("create");
      return makeMachine("cold-machine");
    }),
    start: vi.fn(async (id: string) => {
      calls.push(`start:${id}`);
      if (id === "pooled-2" && over.second?.startFails !== undefined) {
        if (over.second.startFails) throw new Error("could not wake");
        return;
      }
      if (over.startError !== undefined) throw over.startError;
      if (over.startFails) throw new Error("could not wake");
    }),
    suspend: vi.fn(async () => {}),
    stop: vi.fn(),
    destroy: vi.fn(async (id: string) => {
      calls.push(`destroy:${id}`);
    }),
    list: vi.fn(),
    // Not in `calls`: written in the background, in an order of its own.
    setMetadata: vi.fn(async () => {}),
  } as unknown as FlyMachinesApi;

  // The clock advances between the fill and the run, because that gap is exactly
  // what tells a resumed machine from one that quietly cold-booted.
  let clock = 1_000_000;
  const pool = new RunnerPool(flyApi, {
    size: 1,
    imageTag: over.stale ? "registry.example/runner:OLD" : "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
    now: () => clock,
  });
  pool.register({
    machineId: "pooled-1",
    privateIp: "fdaa::9",
    claimToken: "c".repeat(64),
    imageTag: "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
    processId: over.filledProcessId === null ? undefined : (over.filledProcessId ?? "proc-paused"),
  });
  pool.markReady("pooled-1");
  if (over.second) {
    pool.register({
      machineId: "pooled-2",
      privateIp: "fdaa::a",
      claimToken: "d".repeat(64),
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
      processId: "proc-paused",
    });
    pool.markReady("pooled-2");
  }
  clock += over.knownForMs ?? 600_000;

  const onSecond = (url: string) => url.includes("[fdaa::a]");
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/healthz")) {
      if (over.pooledHealthz !== undefined && url.includes("[fdaa::9]")) {
        return new Response("{}", { status: over.pooledHealthz });
      }
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/claim")) {
      calls.push("claim");
      const body =
        over.claimProcessId === null
          ? { ok: true }
          : { ok: true, process_id: over.claimProcessId ?? "proc-paused" };
      const status =
        onSecond(url) && over.second?.claimStatus !== undefined
          ? over.second.claimStatus
          : (over.claimStatus ?? 200);
      return new Response(over.claimBody ?? JSON.stringify(body), { status });
    }
    if (url.endsWith("/init")) {
      calls.push("init");
      if (over.pooledInit && url.includes("[fdaa::9]")) {
        if (over.pooledInit === "cut") throw new TypeError("fetch failed");
        return new Response(over.pooledInit.body, { status: over.pooledInit.status });
      }
      if (over.coldInit && url.includes("[fdaa::1]")) {
        return new Response(over.coldInit.body, { status: over.coldInit.status });
      }
      if (over.second?.init && onSecond(url)) {
        return new Response(over.second.init.body, { status: over.second.init.status });
      }
      const body = over.initPhases
        ? { ok: true, tools: [], phases: over.initPhases }
        : { ok: true, tools: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { flyApi, pool, calls, fetchImpl };
}

class ExposedAdapter extends FlyioAdapter {
  acquire(request: RunRequest) {
    return this.acquireRunner(request);
  }
}

function makeAdapter(
  flyApi: FlyMachinesApi,
  fetchImpl: typeof fetch,
  pool?: RunnerPool,
  extra: {
    logger?: Logger;
    storage?: PresignedStorageAdapter;
    /** Short boot bounds, for a case whose machine never answers its health check. */
    boot?: { maxBootTimeMs: number; bootPollIntervalMs: number };
    /** The hold of the run's seat the API hands over. Absent = the adapter derives its own. */
    seatHoldMs?: number;
  } = {},
) {
  return new ExposedAdapter(
    flyApi,
    extra.storage ?? createMockStorage(),
    new LLMRouter({}),
    new ToolRegistry(),
    undefined,
    {
      fetchImpl,
      pool,
      runtimeImage: "registry.example/runner:v1",
      ...extra.boot,
      ...(extra.seatHoldMs !== undefined && { seatHoldMs: extra.seatHoldMs }),
    },
    extra.logger,
  );
}

/** A logger that keeps every line it is given, whatever the level, and the level it came at. */
function recordingLogger() {
  const lines: Record<string, unknown>[] = [];
  const levels: string[] = [];
  const keep = (level: string) =>
    vi.fn((fields: unknown) => {
      if (typeof fields !== "object" || fields === null) return;
      lines.push(fields as Record<string, unknown>);
      levels.push(level);
    });
  const logger = {
    error: keep("error"),
    warn: keep("warn"),
    info: keep("info"),
    debug: keep("debug"),
  } as unknown as Logger;
  const first = (event: string) => lines.findIndex((fields) => fields.event === event);
  return {
    logger,
    line: (event: string) => lines.find((fields) => fields.event === event),
    /** The level of an event's first line; `undefined` when none was written. */
    levelOf: (event: string): string | undefined => levels[first(event)],
    /** Every line's event, in the order they were written. */
    events: () => lines.map((fields) => fields.event),
  };
}

describe("FlyioAdapter — acquiring a runner from the pool", () => {
  it("wakes a pooled machine and assigns it, without creating one", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("pooled-1");
    expect(calls).toEqual(["start:pooled-1", "claim", "init"]);
    expect(calls).not.toContain("create");
    expect(spawn.phases.pool_hit).toBe(true);
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  // On a resumed machine these describe when the POOL was filled, not this run.
  it("omits the fill-time phases on a pool-served run", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.vm_boot_ms).toBeUndefined();
    expect(spawn.phases.host_schedule_pull_ms).toBeUndefined();
    expect(spawn.phases.module_load_ms).toBeUndefined();
  });

  // The install happens at /init, after the assignment — this run's, not the fill's.
  it("carries the dependency install on a pool-served run", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      initPhases: { bundle_ms: 40, extract_ms: 10, deps_ms: 2200, mcp_ms: 0 },
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.pool_hit).toBe(true);
    expect(spawn.phases.init_deps_ms).toBe(2200);
  });

  // A pool configured but empty: straight to the create-per-run path.
  it("falls back to creating a machine when the pool is empty", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    pool.takeReady(); // drain it
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  // The pool is NOT empty, but its machine will not wake. Distinct from a
  // miss: without this the cold path would silently absorb a fully broken pool.
  // Its claim failed before the run's handoff began: not taken.
  it("discards a machine that will not wake, then falls back", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ startFails: true });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(pool.get("pooled-1")).toBeUndefined();
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  // Woken, but its runner never answers its health check: its claim failed
  // before the run's handoff began, so it is not taken either.
  it("discards a machine whose health check fails, then falls back — not counted as taken", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ pooledHealthz: 503 });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, {
      boot: { maxBootTimeMs: 60, bootPollIntervalMs: 5 },
    }).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).not.toContain("claim");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  // A refused assignment means someone else already took it, or its rules could
  // not be confirmed. Either way the machine is spent — never retried. The run's
  // handoff had begun: the machine was taken for the run, and its phases say so.
  it("discards a machine that refuses the assignment", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ claimStatus: 409 });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("create");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("counts a machine whose /init fails as taken, then falls back", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      pooledInit: { status: 500, body: "bundle fetch failed" },
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  // One pooled machine per run once its handoff began: the machine that refused
  // its assignment is the run's last, and the next one is left for another run.
  it("stops at the first machine lost after the run's handoff began — a refused assignment — and falls back, the next ready machine untouched", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      claimStatus: 409,
      second: { claimStatus: 200, init: { status: 500, body: "bundle fetch failed" } },
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).not.toContain("start:pooled-2");
    expect(calls).not.toContain("destroy:pooled-2");
    expect(pool.get("pooled-2")?.state).toBe("ready");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  // Machine by machine: the one that would not wake is not counted, the one
  // that refused its assignment is.
  it("counts a refused assignment and not a failed wake before it", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      startFails: true,
      second: { startFails: false, claimStatus: 409 },
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("destroy:pooled-2");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("a refused assignment sends the run to a machine of its own, a second pooled machine ready or not: never served from the pool after a machine lost", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      claimStatus: 409,
      second: { claimStatus: 200 },
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(pool.get("pooled-2")?.state).toBe("ready");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  // Checked at the moment of use, not only in the background: a machine built
  // from a superseded image would quietly run superseded code. Discarded before
  // any claim, it was not taken for the run.
  it("discards a stale machine rather than serving from it", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ stale: true });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).not.toContain("claim");
    expect(calls).toContain("create");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  // With no pool, nothing about the existing path changes.
  it("takes the create-per-run path unchanged when no pool is configured", async () => {
    const { flyApi, calls, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, undefined).acquire(createRunRequest());
    expect(calls).toEqual(["create", "init"]);
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });
});

// A run hands its agent to one pooled machine at most. A claim that fails before
// anything of the run reached its machine — a wake, a health check — moves on to
// the next ready machine. Once the run's handoff began — its assignment, then its
// /init — the loop stops there: a failure that any other machine would meet
// again (what the runner's step says, judged by the contract) fails the run,
// with no machine created; anything else sends the run to a machine of its own.
describe("FlyioAdapter — a run hands its agent to one pooled machine at most", () => {
  type InitAnswer = { status: number; body: string } | "cut";

  /**
   * Three ready machines, `pooled-1` to `pooled-3`, at `fdaa::1:1` to `fdaa::1:3`,
   * offered in that order. What one does differently, by its id: a wake that
   * fails, a health check that answers a status, a status to the assignment, an
   * /init answer — or a connection cut before any answer. Every other step
   * succeeds.
   */
  function threeReady(
    over: {
      wakeFails?: string[];
      healthz?: Record<string, number>;
      claim?: Record<string, number>;
      init?: Record<string, InitAnswer>;
    } = {},
  ) {
    const calls: string[] = [];
    const flyApi = {
      create: vi.fn(async () => {
        calls.push("create");
        return makeMachine("cold-machine");
      }),
      start: vi.fn(async (id: string) => {
        calls.push(`start:${id}`);
        if (over.wakeFails?.includes(id)) throw new Error("could not wake");
      }),
      suspend: vi.fn(async () => {}),
      stop: vi.fn(),
      destroy: vi.fn(async (id: string) => {
        calls.push(`destroy:${id}`);
      }),
      list: vi.fn(),
      setMetadata: vi.fn(async () => {}),
    } as unknown as FlyMachinesApi;

    const pool = new RunnerPool(flyApi, {
      size: 3,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
    });
    const ids = ["pooled-1", "pooled-2", "pooled-3"];
    ids.forEach((machineId, i) => {
      pool.register({
        machineId,
        privateIp: `fdaa::1:${i + 1}`,
        claimToken: "c".repeat(64),
        imageTag: "registry.example/runner:v1",
        harness6pn: "fdaa:0:1::2",
        processId: "proc-paused",
      });
      pool.markReady(machineId);
    });
    // The pooled machine a runner URL points at, or the machine created for the run.
    const machineOf = (url: string) => {
      const at = /\[fdaa::1:(\d)\]/.exec(url);
      return at ? `pooled-${at[1]}` : "cold";
    };

    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      const id = machineOf(url);
      if (url.endsWith("/healthz")) {
        return new Response("{}", { status: over.healthz?.[id] ?? 200 });
      }
      if (url.endsWith("/claim")) {
        calls.push(`claim:${id}`);
        return new Response(JSON.stringify({ ok: true, process_id: "proc-paused" }), {
          status: over.claim?.[id] ?? 200,
        });
      }
      if (url.endsWith("/init")) {
        calls.push(`init:${id}`);
        const answer = over.init?.[id];
        if (answer === "cut") throw new TypeError("fetch failed");
        if (answer) return new Response(answer.body, { status: answer.status });
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    return { flyApi, pool, calls, fetchImpl };
  }

  /** The adapter, and the handoffs its acquisition counted — the run's phases tell them only on a run that gets a machine. */
  function counted(flyApi: FlyMachinesApi, fetchImpl: typeof fetch, pool: RunnerPool) {
    const adapter = makeAdapter(flyApi, fetchImpl, pool);
    const tryPooled = vi.spyOn(
      adapter as unknown as { tryPooledRunner: (...args: unknown[]) => Promise<unknown> },
      "tryPooledRunner",
    );
    const handoffs = () => (tryPooled.mock.calls[0]?.[3] as { failed: number }).failed;
    return { adapter, handoffs };
  }

  const failedInit = (body: Record<string, unknown>) => ({
    status: 500,
    body: JSON.stringify({ error: "init failed", message: "witness-runner-text", ...body }),
  });

  it.each([
    ["a bundle downloaded whole whose checksum differs", { stage: "bundle-checksum" }],
    ["a bundle downloaded whole that does not extract", { stage: "bundle-extract" }],
    [
      "an MCP server that refuses the connection with 401",
      { stage: "mcp-connect", mcp: { http_status: 401 } },
    ],
    [
      "an MCP server that has nothing at its address (404)",
      { stage: "mcp-connect", mcp: { http_status: 404 } },
    ],
    [
      "an MCP server that answers its handshake with a JSON-RPC error",
      { stage: "mcp-connect", mcp: { rpc_code: -32602 } },
    ],
  ])("an /init that fails on %s fails the run: one pooled machine consumed, two left ready, no machine created", async (_what, body) => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({
      init: { "pooled-1": failedInit(body) },
    });
    const { adapter, handoffs } = counted(flyApi, fetchImpl, pool);

    const err = await adapter.acquire(createRunRequest()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MachineSpawnError);
    expect((err as MachineSpawnError).details).toMatchObject({
      phase: "init-rpc",
      // Discarded already: nothing is left for the run's end to destroy.
      machineId: null,
    });
    expect(calls).not.toContain("create");
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:pooled-1"]);
    expect(calls).not.toContain("start:pooled-2");
    expect(pool.stats().ready).toBe(2);
    expect(handoffs()).toBe(1);
  });

  it.each([
    ["the bundle's download got no answer", { stage: "bundle-network" }],
    ["the bundle's download was refused", { stage: "bundle-status" }],
    ["the bundle's body was cut", { stage: "bundle-incomplete" }],
    ["the machine's disk was full", { stage: "disk-full" }],
    ["an MCP server could not be reached", { stage: "mcp-connect" }],
    [
      "an MCP server refused the connection with 403",
      { stage: "mcp-connect", mcp: { http_status: 403 } },
    ],
    [
      "an MCP server refused the connection with 503",
      { stage: "mcp-connect", mcp: { http_status: 503 } },
    ],
    ["anything else", { stage: "other" }],
  ])("an /init that fails because %s sends the run to a machine of its own: one pooled machine consumed, two left ready, one creation", async (_what, body) => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({
      init: { "pooled-1": failedInit(body) },
    });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:pooled-1"]);
    expect(calls).not.toContain("start:pooled-2");
    expect(pool.stats().ready).toBe(2);
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("an /init that gets no answer — its connection cut — sends the run to a machine of its own: one pooled machine consumed, one creation", async () => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({ init: { "pooled-1": "cut" } });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(calls).not.toContain("start:pooled-2");
    expect(pool.stats().ready).toBe(2);
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it.each([
    409, 500,
  ])("an assignment refused with %i sends the run to a machine of its own: one pooled machine consumed, one creation", async (status) => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({ claim: { "pooled-1": status } });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls).not.toContain("init:pooled-1");
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(calls).not.toContain("start:pooled-2");
    expect(pool.stats().ready).toBe(2);
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it.each([
    [
      "an older runner's, without a step",
      { error: "init failed", message: "bundle checksum mismatch" },
    ],
    [
      "a newer runner's, with a step this side does not know",
      { error: "init failed", message: "x", stage: "bundle-signature" },
    ],
  ])("a failed /init whose body is %s may not be the run's: the run goes to a machine of its own", async (_what, body) => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({
      init: { "pooled-1": { status: 500, body: JSON.stringify(body) } },
    });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(pool.stats().ready).toBe(2);
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("a failed /init whose body is not JSON — cut, or not the runner's — may not be the run's: the run goes to a machine of its own", async () => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({
      init: { "pooled-1": { status: 500, body: '{"error":"init failed","stage":"bundle-chec' } },
    });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("a wake that fails on the first machine moves on to the next, which serves the run: no machine taken for it, none created", async () => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({ wakeFails: ["pooled-1"] });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("pooled-2");
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).not.toContain("create");
    expect(pool.stats().ready).toBe(1);
    expect(spawn.phases.pool_hit).toBe(true);
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  it("a health check that fails on the first machine moves on to the next, which serves the run", async () => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({ healthz: { "pooled-1": 503 } });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, {
      boot: { maxBootTimeMs: 60, bootPollIntervalMs: 5 },
    }).acquire(createRunRequest());

    expect(spawn.machineId).toBe("pooled-2");
    expect(calls).not.toContain("claim:pooled-1");
    expect(calls).not.toContain("create");
    expect(spawn.phases.pool_hit).toBe(true);
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  it("a run whose /init fails for its own fault ends on a run_error, the pooled machine destroyed once and no machine created", async () => {
    const { flyApi, pool, calls, fetchImpl } = threeReady({
      init: { "pooled-1": failedInit({ stage: "bundle-checksum" }) },
    });
    const log = recordingLogger();
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      flyApi,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl, pool, runtimeImage: "registry.example/runner:v1" },
      log.logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
    if (last?.type === "run_error") {
      expect(last.error.code).toBe("MACHINE_SPAWN_FAILED");
      expect(last.error.message).not.toContain("witness-runner-text");
      expect(last.error.message).not.toContain("pooled-1");
    }
    expect(events.map((e) => e.type)).not.toContain("runner_spawned");
    expect(calls).not.toContain("create");
    expect(calls.filter((c) => c.startsWith("destroy:"))).toEqual(["destroy:pooled-1"]);
    expect(JSON.stringify(log.line("spawn_failed"))).not.toContain("witness-runner-text");
    expect(log.line("spawn_failed")).toMatchObject({ phase: "init-rpc" });
  });
});

// The caller of a run whose /init failed reads the step the runner named, in
// the harness's fixed words — never the runner's text, which can quote what the
// agent declares, and never the machine. Cold and from the pool alike.
describe("FlyioAdapter — a failed /init is told to its caller by its step, in fixed words", () => {
  const WITNESS = "witness-7c1e https://mcp.example/secret-path";

  const failedInitBody = (stage: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: "init failed", message: `${WITNESS} failed`, stage, ...extra });

  async function runErrorOf(adapter: FlyioAdapter) {
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
    return last?.type === "run_error" ? last.error : undefined;
  }

  function quietRouter() {
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    return router;
  }

  it.each([
    ...INIT_STAGES,
  ])("a cold run whose /init fails at step %s: the step in fixed words, nothing of the runner's, no machine", async (stage) => {
    const { api } = createMockFlyApi("m-init-failed");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) return new Response(failedInitBody(stage), { status: 500 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const log = recordingLogger();
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      quietRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, runtimeImage: "registry.example/runner:v1" },
      log.logger,
    );

    const error = await runErrorOf(adapter);

    expect(error?.code).toBe("MACHINE_SPAWN_FAILED");
    expect(error?.message).toMatch(
      new RegExp(
        `^The run's machine could not be started \\(phase "init-rpc", step "${stage}"\\): .+\\.$`,
      ),
    );
    expect(error?.message).not.toContain("witness-7c1e");
    expect(error?.message).not.toContain("mcp.example");
    expect(error?.message).not.toMatch(/m-init-failed|skrun-run-/);
    expect(log.line("spawn_failed")).toMatchObject({ phase: "init-rpc", stage });
    expect(JSON.stringify(log.line("spawn_failed"))).not.toContain("witness-7c1e");
  });

  it.each([
    ["bundle-checksum", {}],
    ["bundle-extract", {}],
    ["mcp-connect", { mcp: { http_status: 401 } }],
  ] as const)("a run whose pooled machine's /init fails for its own fault at step %s: the step in fixed words, nothing of the runner's, no machine", async (stage, extra) => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      pooledInit: { status: 500, body: failedInitBody(stage, extra) },
    });
    const adapter = new FlyioAdapter(
      flyApi,
      createMockStorage(),
      quietRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, pool, runtimeImage: "registry.example/runner:v1" },
    );

    const error = await runErrorOf(adapter);

    expect(error?.message).toMatch(
      new RegExp(
        `^The run's machine could not be started \\(phase "init-rpc", step "${stage}"\\): .+\\.$`,
      ),
    );
    expect(error?.message).not.toContain("witness-7c1e");
    expect(error?.message).not.toContain("pooled-1");
  });

  it("a cold run whose runner answers a failed /init without a step — an older one — is told the phase alone", async () => {
    const { api } = createMockFlyApi("m-init-failed");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ error: "init failed", message: WITNESS }), {
          status: 500,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      quietRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, runtimeImage: "registry.example/runner:v1" },
    );

    const error = await runErrorOf(adapter);

    expect(error?.message).toBe('The run\'s machine could not be started (phase "init-rpc").');
  });
});

// A run the server did not entitle to a pooled machine goes straight to the
// cold path, past a pool that has one ready. It is counted as a skip, never as
// a miss: a pool passed over on purpose is not a pool that failed to serve.
// A pooled machine may sleep long between its fill, which opens its
// infrastructure hosts, and its run; at /init its runner reports whether they
// still resolve within the addresses it opened. The pool counts what the answer
// says — a moved address, or nothing to say — successful or failed, and each
// moved address is a warn line under a stable name: the counter is read without
// the logs, the line outlives a restart. No rule moves for it, and a machine
// created for its run is not counted.
describe("FlyioAdapter — what a pooled machine measured of its infrastructure hosts is counted", () => {
  const answered = (extra: Record<string, unknown>) => ({
    status: 200,
    body: JSON.stringify({ ok: true, tools: [], ...extra }),
  });
  const refused = (extra: Record<string, unknown>) => ({
    status: 500,
    body: JSON.stringify({
      error: "init failed",
      message: "witness-runner-text",
      stage: "bundle-network",
      ...extra,
    }),
  });
  const counted = (pool: RunnerPool) => ({
    changed: pool.stats().infraHostsChanged,
    unmeasured: pool.stats().infraHostsUnmeasured,
  });

  /** A logger that keeps each line with its level. */
  function levelled() {
    const lines: { level: string; fields: Record<string, unknown> }[] = [];
    const at = (level: string) =>
      vi.fn((fields: unknown) => {
        if (typeof fields === "object" && fields !== null)
          lines.push({ level, fields: fields as Record<string, unknown> });
      });
    const logger = {
      error: at("error"),
      warn: at("warn"),
      info: at("info"),
      debug: at("debug"),
    } as unknown as Logger;
    return { logger, of: (event: string) => lines.filter((l) => l.fields.event === event) };
  }

  it("counts a moved address the answer of a served run's /init reports, and logs it at warn under a stable name", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      pooledInit: answered({ infra_hosts: "changed" }),
    });
    const log = levelled();
    const request = createRunRequest();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      request,
    );

    expect(spawn.machineId).toBe("pooled-1");
    expect(spawn.phases.pool_hit).toBe(true);
    expect(counted(pool)).toEqual({ changed: 1, unmeasured: 0 });
    expect(log.of("pool_infra_hosts_changed")).toEqual([
      {
        level: "warn",
        fields: {
          event: "pool_infra_hosts_changed",
          run_id: request.runId,
          machine_id: "pooled-1",
          phase: "ready",
        },
      },
    ]);
  });

  it.each([
    ["unmeasured", { infra_hosts: "unmeasured" }],
    ["absent — a runner too old to measure", {}],
    ["a word this side does not know", { infra_hosts: "a-word-of-a-newer-runner" }],
  ])("counts '%s' in a served run's answer as nothing to say, without a line", async (_what, extra) => {
    const { flyApi, pool, fetchImpl } = poolHarness({ pooledInit: answered(extra) });
    const log = levelled();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      createRunRequest(),
    );

    expect(spawn.machineId).toBe("pooled-1");
    expect(counted(pool)).toEqual({ changed: 0, unmeasured: 1 });
    expect(log.of("pool_infra_hosts_changed")).toEqual([]);
  });

  it("counts nothing when the addresses did not move", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      pooledInit: answered({ infra_hosts: "unchanged" }),
    });
    const log = levelled();
    await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(createRunRequest());

    expect(counted(pool)).toEqual({ changed: 0, unmeasured: 0 });
    expect(log.of("pool_infra_hosts_changed")).toEqual([]);
  });

  it("counts the moved address a failed /init's body reports, and logs it; the run then takes a machine of its own", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      pooledInit: refused({ infra_hosts: "changed" }),
    });
    const log = levelled();
    const request = createRunRequest();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      request,
    );

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls).toContain("create");
    expect(counted(pool)).toEqual({ changed: 1, unmeasured: 0 });
    expect(log.of("pool_infra_hosts_changed")).toEqual([
      {
        level: "warn",
        fields: {
          event: "pool_infra_hosts_changed",
          run_id: request.runId,
          machine_id: "pooled-1",
          phase: "init-rpc",
        },
      },
    ]);
  });

  it("counts a failed /init's body without the measurement as nothing to say", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({ pooledInit: refused({}) });
    await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(counted(pool)).toEqual({ changed: 0, unmeasured: 1 });
  });

  it("counts the measurement of an /init that failed for the run's own fault", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      pooledInit: refused({ stage: "bundle-checksum", infra_hosts: "changed" }),
    });
    const adapter = makeAdapter(flyApi, fetchImpl, pool);

    await expect(adapter.acquire(createRunRequest())).rejects.toBeInstanceOf(MachineSpawnError);
    expect(calls).not.toContain("create");
    expect(counted(pool)).toEqual({ changed: 1, unmeasured: 0 });
  });

  it("counts nothing for a pooled /init that got no answer", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({ pooledInit: "cut" });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("cold-machine");
    expect(counted(pool)).toEqual({ changed: 0, unmeasured: 0 });
  });

  it("counts nothing on a machine created for its run, whatever its answer says", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      coldInit: answered({ infra_hosts: "changed" }),
    });
    pool.takeReady(); // drain it: the run creates its own machine
    const log = levelled();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      createRunRequest(),
    );

    expect(spawn.machineId).toBe("cold-machine");
    expect(counted(pool)).toEqual({ changed: 0, unmeasured: 0 });
    expect(log.of("pool_infra_hosts_changed")).toEqual([]);
  });
});

describe("FlyioAdapter — a run not entitled to the pool takes the cold path", () => {
  it("leaves a pool with a ready machine alone — no counter read, no machine taken, no refill asked — and creates its own", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    const takeReady = vi.spyOn(pool, "takeReady");
    const stats = vi.spyOn(pool, "stats");
    const requestTopUp = vi.spyOn(pool, "requestTopUp");

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(
      createRunRequest({ poolEligible: false }),
    );

    expect(takeReady).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(requestTopUp).not.toHaveBeenCalled();
    expect(calls).toEqual(["create", "init"]);
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  it("counts a skip, not a miss — and the ready machine stays ready for the next run that may take it", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();

    await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest({ poolEligible: false }));

    expect(pool.stats()).toMatchObject({ ready: 1, claimed: 0, hits: 0, misses: 0, skipped: 1 });
    expect(pool.get("pooled-1")?.state).toBe("ready");
  });

  it.each([
    ["a run entitled to it", { poolEligible: true }],
    ["a request that does not say", {}],
  ] as const)("%s is served from the pool as before, no skip counted", async (_label, over) => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest(over));

    expect(spawn.machineId).toBe("pooled-1");
    expect(calls).not.toContain("create");
    expect(pool.stats()).toMatchObject({ hits: 1, misses: 0, skipped: 0 });
  });

  it("with a pool configured at zero, a run not entitled to it takes the cold path and nothing is counted", async () => {
    const { flyApi, calls, fetchImpl } = poolHarness();
    const off = new RunnerPool(flyApi, { size: 0, imageTag: "registry.example/runner:v1" });

    const spawn = await makeAdapter(flyApi, fetchImpl, off).acquire(
      createRunRequest({ poolEligible: false }),
    );

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls).toEqual(["create", "init"]);
    expect(off.stats()).toMatchObject({ hits: 0, misses: 0, skipped: 0 });
  });
});

// A machine that served a run leaves the pool's inventory before the run asks
// for its destruction, whether that destruction succeeds or not: it is then the
// reconciliation's to judge, like any machine this process does not hold. Kept
// through a slow destruction, it would be counted as vanished — the platform no
// longer lists it, and this process never forgot it — on every run the pool
// serves. A destruction that fails is counted, on the pool's counter.
describe("FlyioAdapter — a run's machine leaves the pool's inventory before it is destroyed", () => {
  /** The pool's own clock. */
  const poolNow = (pool: RunnerPool) => (pool as unknown as { now: () => number }).now();

  it("forgets a pooled machine before asking for its destruction, counts a destruction that fails, and the next reconciliation judges the machine as one it does not hold", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    let heldWhenDestroyed: unknown = "not asked";
    vi.mocked(flyApi.destroy).mockImplementation(async (id: string) => {
      heldWhenDestroyed = pool.get(id) ?? null;
      throw new Error("the platform refused the destruction");
    });

    await collectEvents(makeAdapter(flyApi, fetchImpl, pool).executeStream(createRunRequest()));

    expect(vi.mocked(flyApi.destroy).mock.calls.map(([id]) => id)).toEqual(["pooled-1"]);
    expect(heldWhenDestroyed).toBeNull();
    expect(pool.get("pooled-1")).toBeUndefined();
    expect(pool.stats()).toMatchObject({ destroyFailures: 1, claimed: 0, draining: 0 });

    // Still listed, started and untouched past the window of a started machine:
    // judged on what the platform says, as a machine nobody holds — destroyed.
    vi.mocked(flyApi.destroy).mockImplementation(async () => {});
    const untouched = new Date(poolNow(pool) - 30 * 60_000).toISOString();
    const reconciled = await pool.reconcile({
      machines: [
        {
          ...makeMachine("pooled-1"),
          name: "skrun-pool-abc",
          state: "started",
          created_at: untouched,
          updated_at: untouched,
        },
      ],
      sentAt: poolNow(pool),
    });
    expect(reconciled).toEqual({ destroyed: 1, forgotten: 0 });
    expect(pool.stats()).toMatchObject({ orphansDestroyed: 1, vanished: 0 });
  });

  it("counts no machine as vanished while a slow destruction is under way and the reconciliations no longer list it", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    let asked: () => void = () => {};
    const destroyAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let finish: () => void = () => {};
    const destroyed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(flyApi.destroy).mockImplementation(async () => {
      asked();
      await destroyed;
    });

    const run = collectEvents(
      makeAdapter(flyApi, fetchImpl, pool).executeStream(createRunRequest()),
    );
    await destroyAsked;
    // Two listings sent while the DELETE is in flight, neither returning the machine.
    for (const _ of [1, 2]) await pool.reconcile({ machines: [], sentAt: poolNow(pool) });
    finish();
    await run;

    expect(pool.stats()).toMatchObject({ vanished: 0, destroyFailures: 0 });
    expect(pool.get("pooled-1")).toBeUndefined();
  });

  // Marked draining and forgotten at the next instruction, the state would never
  // be read: the run's end forgets the machine, as the server's stop does.
  it("forgets a pooled machine at its run's end without marking it draining first", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const markDraining = vi.spyOn(pool, "markDraining");
    const forget = vi.spyOn(pool, "forget");

    await collectEvents(makeAdapter(flyApi, fetchImpl, pool).executeStream(createRunRequest()));

    expect(forget).toHaveBeenCalledWith("pooled-1");
    expect(markDraining).not.toHaveBeenCalled();
    expect(pool.get("pooled-1")).toBeUndefined();
  });

  // The pool is off, at size 0, or has nothing ready: the run's machine is its
  // own, and a destruction of it that fails is counted all the same.
  it("counts a cold machine's failed destruction on the pool too", async () => {
    const { flyApi, fetchImpl } = poolHarness();
    const off = new RunnerPool(flyApi, { size: 0, imageTag: "registry.example/runner:v1" });
    vi.mocked(flyApi.destroy).mockRejectedValue(new Error("the platform refused the destruction"));

    await collectEvents(makeAdapter(flyApi, fetchImpl, off).executeStream(createRunRequest()));

    expect(vi.mocked(flyApi.destroy).mock.calls.map(([id]) => id)).toEqual(["cold-machine"]);
    expect(off.stats().destroyFailures).toBe(1);
  });
});

// A log line says an error's class and code, never its message: a message can
// quote a file name the agent chose, a request, or the body of an answer. What
// the caller is told, the run_error, does not change.
describe("FlyioAdapter — a failure is logged by the error's class, never its message", () => {
  const WITNESS = "witness-4d2f";

  it("logs a failed run by the error's class, and still tells the caller its message", async () => {
    const { api } = createMockFlyApi("m-run-failed");
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async () => {
        throw new Error(`the model refused ${WITNESS}`);
      }),
    });
    const log = recordingLogger();
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch() },
      log.logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const line = log.line("run_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ run_id: "test-run-id", error_name: "Error" });
    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") expect(last.error.message).toContain(WITNESS);
  });

  it("logs a failed claim of a pooled machine by the error's class, at the step the claim had reached", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const storage = createMockStorage();
    vi.mocked(storage.getPresignedDownloadUrl).mockRejectedValueOnce(
      new Error(`no such object ${WITNESS}`),
    );
    const log = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, {
      logger: log.logger,
      storage,
    }).acquire(createRunRequest());

    const line = log.line("pool_claim_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({
      machine_id: "pooled-1",
      phase: "pool-claim",
      error_name: "Error",
    });
    // The signing of the run's URLs is part of its handoff: the machine counts as taken.
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("writes neither the runner's answer nor any cause when a pooled machine refuses the assignment", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      claimStatus: 500,
      claimBody: `egress setup failed: ${WITNESS}`,
    });
    const log = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      createRunRequest(),
    );

    const line = log.line("pool_claim_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("cause");
    expect(line).toMatchObject({
      machine_id: "pooled-1",
      phase: "pool-claim",
      error_name: "MachineSpawnError",
      error_code: "MACHINE_SPAWN_FAILED",
    });
    expect(log.line("machine_destroy")).toMatchObject({
      machine_id: "pooled-1",
      reason: "pool_discard_pool-claim",
    });
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  // The platform's own answer is the one cause a failed claim keeps: it
  // describes our infrastructure, not a run. Shaped as the API client raises
  // it, one level down under a synthetic message.
  it("names the platform's status and answer when a pooled machine will not wake", async () => {
    const platformError = new MachineSpawnError(
      { machineName: "pooled-1", machineId: "pooled-1", phase: "boot-probe", httpStatus: 404 },
      new Error("Fly.io API POST /apps/runners/machines/pooled-1/start: 404 witness-fly-body"),
    );
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ startError: platformError });
    const log = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      createRunRequest(),
    );

    const line = log.line("pool_claim_failed");
    expect(line).toMatchObject({
      machine_id: "pooled-1",
      phase: "pool-resume",
      error_name: "MachineSpawnError",
      error_status: "404",
      cause: expect.stringContaining("witness-fly-body"),
    });
    expect(String(line?.cause)).not.toContain("Failed to spawn");
    expect(log.line("machine_destroy")).toMatchObject({ reason: "pool_discard_pool-resume" });
    // The run falls back to the cold path, as before — the machine that would
    // not wake not counted as taken for it.
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
  });

  it("writes neither the runner's answer nor any cause when a woken machine fails its init", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      pooledInit: { status: 500, body: `bundle fetch failed: ${WITNESS}` },
    });
    const log = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger: log.logger }).acquire(
      createRunRequest(),
    );

    const line = log.line("pool_claim_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("cause");
    expect(line).toMatchObject({
      machine_id: "pooled-1",
      phase: "init-rpc",
      error_name: "MachineSpawnError",
      error_status: "500",
    });
    expect(spawn.phases.pool_handoffs_failed).toBe(1);
  });

  it("logs a failed destroy by the error's class", async () => {
    const { api, destroySpy } = createMockFlyApi("m-destroy");
    destroySpy.mockRejectedValue(
      new Error(`Fly.io API DELETE /machines/m-destroy: 500 ${WITNESS}`),
    );
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const log = recordingLogger();
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch() },
      log.logger,
    );

    await collectEvents(adapter.executeStream(createRunRequest()));

    const line = log.line("machine_destroy_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ machine_id: "m-destroy", error_name: "Error" });
  });
});

describe("FlyioAdapter — telling a real resume from a silent cold boot", () => {
  // The platform treats the resume as an attempt, not a guarantee, and the two are
  // indistinguishable from outside — so the machine says which process answered.
  //
  // These tests used to drive the classification with an uptime that grew with
  // wall-clock time. They passed, and the code was wrong: a paused machine's clock
  // is frozen along with the rest of it, so uptime never tracks elapsed time and
  // every genuine wake was being reported as a cold boot in production. The test
  // encoded the same false premise as the code, which is exactly why it could not
  // catch it. Identity has no premise to get wrong.
  it("reports a resume when the same process answers", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      filledProcessId: "proc-A",
      claimProcessId: "proc-A",
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.pool_resumed_from_snapshot).toBe(true);
  });

  // A pool whose machines all cold-boot still "works" while delivering a fraction
  // of the benefit — a median over both would hide it entirely.
  it("reports a cold boot when a different process answers", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({
      filledProcessId: "proc-A",
      claimProcessId: "proc-B-after-a-cold-boot",
    });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.pool_resumed_from_snapshot).toBe(false);
  });

  it("degrades to unknown when the assignment does not report a process", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({ claimProcessId: null });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.pool_resumed_from_snapshot).toBeUndefined();
    expect(spawn.phases.pool_hit).toBe(true);
  });

  // The other half: a machine built by an image that could not identify itself.
  // Answering "unknown" beats answering "cold boot" in the field whose only job is
  // to raise an alarm — a stuck alarm cannot fire when something is really wrong.
  it("degrades to unknown when the machine was built without one", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness({ filledProcessId: null });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.pool_resumed_from_snapshot).toBeUndefined();
    expect(spawn.phases.pool_hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The bundle checksum reaching the runner
// ---------------------------------------------------------------------------

/** The parsed body of the single `/init` POST the harness made. */
function initBody(fetchImpl: typeof fetch): Record<string, unknown> {
  const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) =>
    String(c[0]).endsWith("/init"),
  );
  return JSON.parse(String((call?.[1] as { body?: unknown })?.body));
}

describe("FlyioAdapter — the bundle checksum reaches the runner", () => {
  const checksum = "a".repeat(64);

  // There are two ways a runner is obtained, and each builds its own `/init`
  // body. A checksum on one of them only is a check that does not apply to the
  // other, which is the point of asserting both rather than one.
  it("puts it in the init body when the machine is created for this run", async () => {
    const { flyApi, calls, fetchImpl } = poolHarness();
    await makeAdapter(flyApi, fetchImpl).acquire(createRunRequest({ bundleSha256: checksum }));

    expect(calls).toContain("create");
    expect(initBody(fetchImpl).bundleSha256).toBe(checksum);
  });

  it("puts it in the init body when the machine comes from the pool", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    await makeAdapter(flyApi, fetchImpl, pool).acquire(
      createRunRequest({ bundleSha256: checksum }),
    );

    expect(calls).toContain("claim");
    expect(calls).not.toContain("create");
    expect(initBody(fetchImpl).bundleSha256).toBe(checksum);
  });

  // A bundle published before checksums were kept has none. The field is simply
  // absent from the body, and the runner treats that as "extract, and say so".
  it("leaves the field out when the bundle has no checksum on record", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(initBody(fetchImpl)).not.toHaveProperty("bundleSha256");
  });
});

// The runner's egress rules are set at boot, before any run value reaches it:
// the hosts of its own infrastructure — the install registries, the object store
// it fetches the bundle from — travel in the machine's environment.
describe("FlyioAdapter — the hosts a cold runner may reach for its infrastructure", () => {
  it("are the install registries and the object store's host", async () => {
    const { api, createSpy } = createMockFlyApi("m-hosts");
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: createMockFetch(),
      },
    );

    await collectEvents(adapter.executeStream(createRunRequest()));

    const env = createSpy.mock.calls[0][0].config.env;
    expect(env.RUNNER_INFRA_HOSTS).toBe([...INSTALL_REGISTRY_ALLOWLIST, "r2.example"].join(","));
  });
});

// A machine nobody destroys — its process died, slept or lost its database —
// is judged by the lifetime it carries: the hold of its run's seat plus a
// grace, in whole seconds. One value with the seat's: the API hands the adapter
// the hold its admission wrote, never a copy; an adapter handed none derives it
// the way the seat's is — the run's timeout capped at the longest timer, plus
// the margin of the platform's burst on this adapter's boot budget.
describe("FlyioAdapter — the lifetime a run's machine is created with", () => {
  function requestWithTimeout(timeout: string): RunRequest {
    const request = createRunRequest();
    return {
      ...request,
      agentConfig: {
        ...request.agentConfig,
        environment: { ...request.agentConfig.environment, timeout },
      },
    };
  }

  /** The lifetime the machine of one cold run carries, as written into its environment. */
  async function lifetimeWritten(
    options: FlyioAdapterOptions,
    timeout: string,
  ): Promise<string | undefined> {
    const { api, createSpy } = createMockFlyApi("m-lifetime");
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: createMockFetch(),
        ...options,
      },
    );
    await collectEvents(adapter.executeStream(requestWithTimeout(timeout)));
    expect(createSpy).toHaveBeenCalledOnce();
    return createSpy.mock.calls[0][0].config.env.RUNNER_LIFETIME_S;
  }

  it("is the hold of its run's seat it is handed, plus the grace, in seconds", async () => {
    // A run of 900 s, its seat held 900 s and a margin of 50 s.
    const seatHoldMs = 900_000 + 50_000;
    const written = await lifetimeWritten({ seatHoldMs }, "900s");
    expect(written).toBe(String(machineLifetimeSeconds({ seatHoldMs })));
    // The same figures written out, as a reading aid: 950 + 300.
    expect(written).toBe("1250");
  });

  it("handed no hold, is the run's timeout plus the margin of the platform's burst, plus the grace", async () => {
    const seatHoldMs = 900_000 + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST });
    expect(await lifetimeWritten({}, "900s")).toBe(
      String(Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000)),
    );
  });

  it("handed no hold, follows the boot budget the adapter is given", async () => {
    const seatHoldMs =
      900_000 +
      seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST, maxBootTimeMs: 30_000 });
    expect(await lifetimeWritten({ maxBootTimeMs: 30_000 }, "900s")).toBe(
      String(Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000)),
    );
  });

  // Nothing bounds the timeout an agent writes. Counted raw, its machine's
  // lifetime would be a number no clock inside the machine can reach — or none at all.
  it("handed no hold, caps a timeout no timer can hold as the seat's: a finite number of seconds", async () => {
    const seatHoldMs =
      MAX_TIMER_DELAY_MS + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST });
    const written = await lifetimeWritten({}, "9999999999999s");
    expect(written).toBe(String(Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000)));
    expect(written).toMatch(/^[0-9]{1,10}$/);
  });
});

// A pooled machine waits for its run with no lifetime: it learns one at its
// assignment, in the body of /claim, counted from there — the hold of its run's
// seat plus the grace, as a machine created for the run carries from its creation.
describe("FlyioAdapter — the lifetime a pooled machine learns at its assignment", () => {
  function requestWithTimeout(timeout: string): RunRequest {
    const request = createRunRequest();
    return {
      ...request,
      agentConfig: {
        ...request.agentConfig,
        environment: { ...request.agentConfig.environment, timeout },
      },
    };
  }

  /** The body of /claim, for one run served from the pool. */
  async function claimBody(seatHoldMs: number | undefined, timeout: string): Promise<unknown> {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { seatHoldMs }).acquire(
      requestWithTimeout(timeout),
    );
    expect(spawn.machineId).toBe("pooled-1");
    const claims = vi
      .mocked(fetchImpl)
      .mock.calls.filter(([input]) => String(input).endsWith("/claim"));
    expect(claims).toHaveLength(1);
    return JSON.parse(String(claims[0]?.[1]?.body));
  }

  async function lifetimeClaimed(seatHoldMs: number | undefined, timeout: string) {
    return ((await claimBody(seatHoldMs, timeout)) as { lifetimeS?: unknown }).lifetimeS;
  }

  it("is the hold of its run's seat it is handed, plus the grace, in seconds", async () => {
    // A run of 900 s, its seat held 900 s and a margin of 50 s.
    const seatHoldMs = 900_000 + 50_000;
    const claimed = await lifetimeClaimed(seatHoldMs, "900s");
    expect(claimed).toBe(machineLifetimeSeconds({ seatHoldMs }));
    // The same figures written out, as a reading aid: 950 + 300.
    expect(claimed).toBe(1250);
  });

  it("handed no hold, is the run's timeout plus the margin of the platform's burst, plus the grace", async () => {
    const seatHoldMs = 900_000 + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST });
    expect(await lifetimeClaimed(undefined, "900s")).toBe(
      Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000),
    );
  });

  it("handed no hold, caps a timeout no timer can hold as the seat's: ten digits at most", async () => {
    const seatHoldMs =
      MAX_TIMER_DELAY_MS + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST });
    const claimed = await lifetimeClaimed(undefined, "9999999999999s");
    expect(claimed).toBe(Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000));
    expect(String(claimed)).toMatch(/^[0-9]{1,10}$/);
  });

  // The runner reads the body against the contract both sides share: the
  // lifetime the adapter sends must be one that contract keeps.
  it("is sent in a body the runner's contract reads, the lifetime kept", async () => {
    const body = await claimBody(950_000, "900s");
    const parsed = ClaimRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.lifetimeS).toBe(1250);
  });
});

// Once its runner has answered its assignment, a pooled machine is labelled
// with its run and the end of its life, in its metadata: whoever lists the app
// can then judge it on its run, where its name says only that it is a pooled
// one. In the background — the run never waits for it, and a failed write is a
// line, never a failed assignment.
describe("FlyioAdapter — an assigned pooled machine carries its run and the end of its life", () => {
  /** The pool harness's runner, its answer to /claim held until the test lets it go. */
  function holdingClaim(fetchImpl: typeof fetch) {
    let sent = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, 2_000);
      release = () => {
        clearTimeout(guard);
        resolve();
      };
    });
    const held = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/claim")) {
        sent = true;
        await gate;
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    return { fetchImpl: held, release, sent: () => sent };
  }

  /** Let the work in flight run out. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("writes its run and the end of its life once /claim has answered — never before", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const claim = holdingClaim(fetchImpl);
    // A run of 900 s, its seat held 900 s and a margin of 50 s: a lifetime of 1250 s.
    const acquiring = makeAdapter(flyApi, claim.fetchImpl, pool, { seatHoldMs: 950_000 }).acquire(
      createRunRequest(),
    );

    await vi.waitFor(() => expect(claim.sent()).toBe(true));
    await settle();
    // The assignment is in flight: nothing of the run is on the machine yet.
    expect(flyApi.setMetadata).not.toHaveBeenCalled();

    const answeredFrom = Date.now();
    claim.release();
    const spawn = await acquiring;
    await vi.waitFor(() => expect(flyApi.setMetadata).toHaveBeenCalledTimes(2));
    const answeredBy = Date.now();

    expect(spawn.machineId).toBe("pooled-1");
    const writes = vi.mocked(flyApi.setMetadata).mock.calls;
    expect(writes.map(([machineId, key]) => [machineId, key])).toEqual([
      ["pooled-1", "skrun_run_id"],
      ["pooled-1", "skrun_lifetime_end"],
    ]);
    expect(writes[0]?.[2]).toBe("test-run-id");
    // An instant, in ISO 8601 and UTC: its assignment plus its lifetime.
    const written = String(writes[1]?.[2]);
    const end = Date.parse(written);
    expect(written).toBe(new Date(end).toISOString());
    expect(end - 1250 * 1000).toBeGreaterThanOrEqual(answeredFrom);
    expect(end - 1250 * 1000).toBeLessThanOrEqual(answeredBy);
  });

  it("is never waited for by the run: a write that does not answer leaves the run going", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    let answerWrites = () => {};
    const writes = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, 2_000);
      answerWrites = () => {
        clearTimeout(guard);
        resolve();
      };
    });
    vi.mocked(flyApi.setMetadata).mockImplementation(() => writes);

    const first = await Promise.race([
      makeAdapter(flyApi, fetchImpl, pool)
        .acquire(createRunRequest())
        .then((spawn) => spawn.machineId),
      writes.then(() => "the writes ended first"),
    ]);
    answerWrites();

    expect(first).toBe("pooled-1");
    expect(calls).toContain("init");
    expect(flyApi.setMetadata).toHaveBeenCalledTimes(2);
  });

  it("logs a write that fails, by the error's class — the assignment and /init unchanged, the other key still written", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    vi.mocked(flyApi.setMetadata).mockImplementation(async (_id: string, key: string) => {
      if (key === "skrun_run_id") {
        throw new MachineSpawnError(
          { machineName: "pooled-1", machineId: "pooled-1", phase: "boot-probe", httpStatus: 404 },
          new Error("witness-platform-text machine not found"),
        );
      }
    });
    const { logger, line } = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger }).acquire(
      createRunRequest(),
    );
    await vi.waitFor(() => expect(line("pool_metadata_write_failed")).toBeDefined());

    expect(spawn.machineId).toBe("pooled-1");
    expect(spawn.phases.pool_hit).toBe(true);
    expect(spawn.phases).not.toHaveProperty("pool_handoffs_failed");
    expect(calls).toEqual(["start:pooled-1", "claim", "init"]);
    expect(flyApi.setMetadata).toHaveBeenCalledTimes(2);
    expect(line("pool_metadata_write_failed")).toMatchObject({
      run_id: "test-run-id",
      machine_id: "pooled-1",
      key: "skrun_run_id",
      error_name: "MachineSpawnError",
    });
    expect(JSON.stringify(line("pool_metadata_write_failed"))).not.toContain(
      "witness-platform-text",
    );
  });

  // A write races the machine's destruction: a fast failure of its /init, or a
  // run that ends at once, destroys the machine while the end of its life is
  // still being written, and the platform then fails the write. Not a label
  // the machine lacks: the machine is gone, and this server took it away.
  /**
   * The write of the end of a machine's life, held until that machine's
   * destruction is asked, then failed as the platform fails a write on a
   * machine it destroys: once the destruction has answered (`answered`), or
   * while it is still under way (`under-way`). Its run's label is written.
   */
  function failingOnceDestroyed(
    flyApi: FlyMachinesApi,
    calls: string[],
    machineId: string,
    when: "answered" | "under-way",
  ) {
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    let asked = () => {};
    const destroyAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let failed = () => {};
    const writeFailed = new Promise<void>((resolve) => {
      failed = resolve;
    });
    vi.mocked(flyApi.destroy).mockImplementation(async (id: string) => {
      calls.push(`destroy:${id}`);
      if (id !== machineId) return;
      asked();
      if (when === "answered") return;
      // Under way: the destruction answers a turn after the write has failed.
      await writeFailed;
      await turn();
    });
    vi.mocked(flyApi.setMetadata).mockImplementation(async (_id: string, key: string) => {
      if (key !== "skrun_lifetime_end") return;
      await destroyAsked;
      // Answered: a turn, for the destruction's answer to land first.
      if (when === "answered") await turn();
      failed();
      throw new MachineSpawnError(
        { machineName: machineId, machineId, phase: "boot-probe", httpStatus: 500 },
        new Error("witness-platform-text machine is being destroyed"),
      );
    });
    return { writeFailed };
  }

  /** The adapter's record of the label writes in flight. */
  const writesInFlight = (adapter: FlyioAdapter) =>
    (adapter as unknown as { labelling: Map<string, unknown> }).labelling;

  it("logs no labelling failure for a write that fails on a machine it discarded — its /init failed, the machine destroyed before the write's answer", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({
      pooledInit: { status: 500, body: "bundle fetch failed" },
    });
    const { writeFailed } = failingOnceDestroyed(flyApi, calls, "pooled-1", "answered");
    const { logger, line, levelOf, events } = recordingLogger();
    const adapter = makeAdapter(flyApi, fetchImpl, pool, { logger });

    const spawn = await adapter.acquire(createRunRequest());
    await writeFailed;
    await settle();

    expect(spawn.machineId).toBe("cold-machine");
    expect(line("pool_metadata_write_failed")).toBeUndefined();
    expect(line("pool_claim_failed")).toMatchObject({ machine_id: "pooled-1", phase: "init-rpc" });
    expect(line("machine_destroy")).toMatchObject({
      machine_id: "pooled-1",
      reason: "pool_discard_init-rpc",
    });
    // The write failed once the machine was destroyed: one debug line, by the
    // error's class, never its text.
    expect(events().indexOf("machine_destroy")).toBeLessThan(
      events().indexOf("pool_metadata_write_moot"),
    );
    expect(levelOf("pool_metadata_write_moot")).toBe("debug");
    expect(line("pool_metadata_write_moot")).toMatchObject({
      run_id: "test-run-id",
      machine_id: "pooled-1",
      key: "skrun_lifetime_end",
      error_name: "MachineSpawnError",
    });
    expect(JSON.stringify(line("pool_metadata_write_moot"))).not.toContain("witness-platform-text");
    // Nothing kept of the machine once its writes settled.
    expect(writesInFlight(adapter).size).toBe(0);
  });

  it("logs no labelling failure for a write that fails while its run's end destroys the machine", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    const { writeFailed } = failingOnceDestroyed(flyApi, calls, "pooled-1", "under-way");
    const { logger, line, levelOf, events } = recordingLogger();
    const adapter = makeAdapter(flyApi, fetchImpl, pool, { logger });

    await collectEvents(adapter.executeStream(createRunRequest()));
    await writeFailed;
    await settle();

    expect(calls).toContain("destroy:pooled-1");
    expect(line("pool_metadata_write_failed")).toBeUndefined();
    // Failed while the destruction was under way: before its answer.
    expect(events().indexOf("pool_metadata_write_moot")).toBeLessThan(
      events().indexOf("machine_destroy"),
    );
    expect(levelOf("pool_metadata_write_moot")).toBe("debug");
    expect(line("pool_metadata_write_moot")).toMatchObject({
      machine_id: "pooled-1",
      key: "skrun_lifetime_end",
    });
    expect(writesInFlight(adapter).size).toBe(0);
  });

  it("still logs a write that fails on a machine serving its run, the machine destroyed afterwards at the run's end", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    vi.mocked(flyApi.setMetadata).mockImplementation(async (_id: string, key: string) => {
      if (key !== "skrun_lifetime_end") return;
      throw new MachineSpawnError(
        { machineName: "pooled-1", machineId: "pooled-1", phase: "boot-probe", httpStatus: 500 },
        new Error("witness-platform-text internal error"),
      );
    });
    const { logger, line, levelOf, events } = recordingLogger();
    const adapter = makeAdapter(flyApi, fetchImpl, pool, { logger });

    await collectEvents(adapter.executeStream(createRunRequest()));
    await settle();

    expect(calls).toContain("destroy:pooled-1");
    expect(events().indexOf("pool_metadata_write_failed")).toBeLessThan(
      events().indexOf("machine_destroy"),
    );
    expect(levelOf("pool_metadata_write_failed")).toBe("warn");
    expect(line("pool_metadata_write_failed")).toMatchObject({
      run_id: "test-run-id",
      machine_id: "pooled-1",
      key: "skrun_lifetime_end",
      error_name: "MachineSpawnError",
    });
    expect(line("pool_metadata_write_moot")).toBeUndefined();
  });

  it("writes nothing on a machine whose assignment was refused", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ claimStatus: 409 });

    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    await settle();

    expect(spawn.machineId).toBe("cold-machine");
    expect(calls).toContain("destroy:pooled-1");
    expect(flyApi.setMetadata).not.toHaveBeenCalled();
  });
});

describe("FlyioAdapter — the stream beats while a runner is acquired", () => {
  /** The heartbeat cadence of these cases, reduced from its default. */
  const BEAT_MS = 20;

  /**
   * An acquisition three beats long. It still makes its runner — create, boot
   * probe, init, on the mocked API — after the wait: no machine is ready ahead.
   */
  class SlowAcquireAdapter extends FlyioAdapter {
    protected override async acquireRunner(request: RunRequest): Promise<SpawnResult> {
      await new Promise((resolve) => setTimeout(resolve, BEAT_MS * 3 + 5));
      return super.acquireRunner(request);
    }
  }

  function makeSlowAdapter(api: FlyMachinesApi): FlyioAdapter {
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    return new SlowAcquireAdapter(api, createMockStorage(), router, new ToolRegistry(), undefined, {
      fetchImpl: createMockFetch(),
      heartbeatIntervalMs: BEAT_MS,
    });
  }

  const label = (e: RunEvent): string =>
    e.type === "run_heartbeat" ? `${e.type}:${e.stage}` : e.type;

  it("emits acquiring_runner heartbeats between run_start and runner_spawned", async () => {
    const { api, createSpy } = createMockFlyApi("m-slow-acquire");

    const events = (
      await collectEvents(makeSlowAdapter(api).executeStream(createRunRequest()))
    ).map(label);

    expect(events[0]).toBe("run_start");
    const spawned = events.indexOf("runner_spawned");
    expect(spawned).toBeGreaterThan(0);
    const between = events.slice(1, spawned);
    expect(between).toContain("run_heartbeat:acquiring_runner");
    // Nothing else fills that gap: every event there is an acquisition beat.
    expect(new Set(between)).toEqual(new Set(["run_heartbeat:acquiring_runner"]));
    // The runner was made during the stream, after the beats started.
    expect(createSpy).toHaveBeenCalledOnce();
  });

  it("still ends a failed acquisition with its run_error, after the beats", async () => {
    const createSpy = vi.fn().mockRejectedValue(new Error("Fly API 500"));
    const api = {
      create: createSpy,
      destroy: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;

    const events = await collectEvents(makeSlowAdapter(api).executeStream(createRunRequest()));

    const labels = events.map(label);
    expect(labels[0]).toBe("run_start");
    expect(labels).toContain("run_heartbeat:acquiring_runner");
    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
    if (last?.type === "run_error") expect(last.error.code).toBe("MACHINE_SPAWN_FAILED");
    expect(labels).not.toContain("runner_spawned");
  });
});

describe("FlyioAdapter — a long install never meets the tool-call bound", () => {
  /** The per-request bound of a tool call in these cases, shortened from its default. */
  const TOOL_CALL_MS = 60;
  /** An install three times that long. */
  const INSTALL_MS = TOOL_CALL_MS * 3;
  /** The heartbeat cadence, reduced so the install spans several beats. */
  const BEAT_MS = 20;

  beforeEach(() => {
    toolCallBound.ms = TOOL_CALL_MS;
  });
  afterEach(() => {
    toolCallBound.ms = undefined;
  });

  const buildTool: ToolDefinition = {
    name: "build",
    description: "uses a declared dependency",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  };

  /** A model that asks for the script tool once, then answers. */
  function askingForTheToolOnce(): LLMProvider {
    let iteration = 0;
    return {
      name: "mock",
      call: vi.fn(async () => {
        iteration++;
        if (iteration === 1) {
          return {
            content: "",
            toolCalls: [{ name: "build", args: {}, id: "call-1" }],
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return { content: '{"result":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
  }

  /** Resolves after `ms`, or rejects the way fetch does when the request is aborted. */
  function waitUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }

  /**
   * A runner whose dependency install takes `installMs`, spent either while it
   * initialises (`at: "init"`) or on its first tool call (`at: "first-call"`,
   * the lazy shape). Everything else answers at once.
   */
  function runnerInstalling(installMs: number, at: "init" | "first-call"): typeof fetch {
    let installed = false;
    return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        if (at === "init") {
          await waitUnlessAborted(installMs);
          installed = true;
        }
        const phases = {
          bundle_ms: 1,
          extract_ms: 1,
          deps_ms: at === "init" ? installMs : 0,
          mcp_ms: 0,
        };
        return new Response(JSON.stringify({ ok: true, tools: [buildTool], phases }), {
          status: 200,
        });
      }
      if (url.endsWith("/tool")) {
        if (!installed) {
          await waitUnlessAborted(installMs, init?.signal);
          installed = true;
        }
        return new Response(JSON.stringify({ content: "built", isError: false }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  function runWith(fetchImpl: typeof fetch): Promise<RunEvent[]> {
    const { api } = createMockFlyApi("m-install");
    const router = new LLMRouter();
    router.registerProvider("mock", askingForTheToolOnce());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl,
        heartbeatIntervalMs: BEAT_MS,
      },
    );
    const request = createRunRequest();
    request.agentConfig.tools = [
      { name: "build", description: buildTool.description, input_schema: buildTool.parameters },
    ];
    return collectEvents(adapter.executeStream(request));
  }

  const label = (e: RunEvent): string =>
    e.type === "run_heartbeat" ? `${e.type}:${e.stage}` : e.type;

  it("installed while the runner initialises, the first tool call succeeds under the acquisition heartbeat", async () => {
    const events = await runWith(runnerInstalling(INSTALL_MS, "init"));
    const labels = events.map(label);

    // The first and only tool call succeeded, and nothing anywhere ran out of time.
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toEqual([
      expect.objectContaining({ tool: "build", result: "built", is_error: false }),
    ]);
    expect(JSON.stringify(events)).not.toContain("exceeded");
    expect(labels.at(-1)).toBe("run_complete");

    // The install was covered by the acquisition beat, before the runner was ready.
    const spawned = labels.indexOf("runner_spawned");
    expect(labels.slice(0, spawned)).toContain("run_heartbeat:acquiring_runner");
    const ready = events[spawned];
    if (ready?.type === "runner_spawned") expect(ready.phases.init_deps_ms).toBe(INSTALL_MS);
  });

  it("installed on the first tool call instead, the same install runs out of the call's time", async () => {
    // The shape the install at /init avoids — and the proof that the shortened
    // bound is in force in this file, without which the case above would pass
    // for the wrong reason.
    const events = await runWith(runnerInstalling(INSTALL_MS, "first-call"));
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toEqual([
      expect.objectContaining({
        tool: "build",
        is_error: true,
        result: `RPC failed: tool "build" exceeded ${TOOL_CALL_MS}ms timeout`,
      }),
    ]);
  });
});

describe("FlyioAdapter — the wait for /init is bounded, and named when it runs out", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A fetch whose /init takes `initMs` to answer — forever when null — and
   * stops when aborted, as the platform's does. `onInit` sees each /init's signal.
   */
  function fetchWithInit(
    initMs: number | null,
    onInit?: (signal: AbortSignal | null | undefined) => void,
  ): typeof fetch {
    return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        onInit?.(init?.signal);
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
          if (initMs !== null) {
            setTimeout(
              () => resolve(new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 })),
              initMs,
            );
          }
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  function makeAdapter(fetchImpl: typeof fetch, api: FlyMachinesApi) {
    const errorSpy = vi.fn();
    const logger = {
      error: errorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl },
      logger,
    );
    return { adapter, errorSpy };
  }

  it("ends a /init still unanswered at INIT_RPC_TIMEOUT_MS, 300 s, as a spawn failure at init-rpc, on a simulated clock", async () => {
    // No real process runs here, so the clock can be a simulated one: the case
    // holds the bound the adapter puts on /init without waiting for it.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const { api, destroySpy } = createMockFlyApi("m-init-silent");
    let initSignal: AbortSignal | null | undefined;
    let asked: () => void = () => {};
    const initAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { adapter, errorSpy } = makeAdapter(
      fetchWithInit(null, (signal) => {
        initSignal = signal;
        asked();
      }),
      api,
    );

    const collecting = collectEvents(adapter.executeStream(createRunRequest()));
    await initAsked;

    await vi.advanceTimersByTimeAsync(INIT_RPC_TIMEOUT_MS - 1);
    expect(initSignal?.aborted, "/init, given up before its bound").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(initSignal?.aborted, "/init, still awaited at its bound").toBe(true);

    const events = await collecting;
    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
    if (last?.type === "run_error") expect(last.error.code).toBe("MACHINE_SPAWN_FAILED");
    const spawnFailed = errorSpy.mock.calls.find(
      (c) => (c[0] as { event?: string } | undefined)?.event === "spawn_failed",
    )?.[0] as { phase?: string; httpStatus?: number | null; cause?: string } | undefined;
    // No answer was read: the cause is the wait our code names, and it is kept.
    expect(spawnFailed).toMatchObject({
      phase: "init-rpc",
      httpStatus: null,
      error_name: "MachineSpawnError",
      cause: "/init did not answer within 300 s: timed out",
    });
    // The machine, still installing, is not left behind.
    expect(destroySpy).toHaveBeenCalledWith("m-init-silent");
  });

  it("lets a /init that answers within the bound through", async () => {
    const { api } = createMockFlyApi("m-init-answers");
    const { adapter, errorSpy } = makeAdapter(fetchWithInit(30), api);

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    // The runner was made ready: its /init answered, and no spawn failed.
    expect(events.map((e) => e.type)).toContain("runner_spawned");
    const spawnFailed = errorSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string } | undefined)?.event === "spawn_failed",
    );
    expect(spawnFailed).toEqual([]);
  });

  it("leaves /init the time of an install stopped at its limit, then of an MCP connection", () => {
    // The install's limit is derived from the other two: raising one of the
    // three alone would turn a named install failure back into a timed-out /init.
    expect(SCRIPT_DEPS_INSTALL_TIMEOUT_MS + DEFAULT_MCP_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(
      INIT_RPC_TIMEOUT_MS,
    );
  });
});

describe("FlyioAdapter — the state is written once the output files are uploaded", () => {
  /**
   * A stateful run on a runner whose `/outputs/collect` answers `collectStatus`.
   * Each step that matters is noted in `order`: the outputs request, the state
   * write.
   */
  async function statefulRun(collectStatus: number, failWrite = false) {
    const order: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        order.push("outputs");
        return collectStatus === 200
          ? new Response(JSON.stringify({ files: [] }), { status: 200 })
          : new Response("runner failed", { status: collectStatus });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { api, destroySpy } = createMockFlyApi("m-state");
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async () => ({
        content: '{"result":"ok","_state":{"step":1}}',
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    });
    const state = {
      getState: vi.fn(async () => null),
      setState: vi.fn(async (_name: string, s: Record<string, unknown>) => {
        order.push("setState");
        if (failWrite) throw new Error("database unreachable");
        writes.push(s);
      }),
    };
    const adapter = new FlyioAdapter(api, createMockStorage(), router, new ToolRegistry(), state, {
      fetchImpl,
    });
    const request = createRunRequest();
    request.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };
    const events = await collectEvents(adapter.executeStream(request));
    return { events, writes, order, destroySpy };
  }

  it("a run whose outputs are uploaded writes its state once, after the upload", async () => {
    const { events, writes, order, destroySpy } = await statefulRun(200);

    expect(events.at(-1)?.type).toBe("run_complete");
    expect(writes).toEqual([{ step: 1 }]);
    expect(order).toEqual(["outputs", "setState"]);
    expect(destroySpy).toHaveBeenCalledOnce();
  });

  it("a run whose outputs upload fails ends on run_error and writes no state", async () => {
    const { events, writes, order, destroySpy } = await statefulRun(500);

    const last = events.at(-1);
    expect(last?.type === "run_error" && last.error.code).toBe("EXECUTION_FAILED");
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
    expect(writes).toEqual([]);
    expect(order).toEqual(["outputs"]);
    expect(destroySpy).toHaveBeenCalledOnce();
  });

  it("a state write that fails after the upload ends the run on run_error, and the machine is destroyed", async () => {
    const { events, order, destroySpy } = await statefulRun(200, true);

    const last = events.at(-1);
    expect(last?.type === "run_error" && last.error).toEqual({
      code: "EXECUTION_FAILED",
      message: "database unreachable",
    });
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
    expect(order).toEqual(["outputs", "setState"]);
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledWith("m-state");
  });
});

describe("FlyioAdapter — what a failed outputs upload does to the run, and what its time budget does", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const OUTPUT_KEY = runOutputKey("test-run-id", "report.txt");
  const UPLOAD_ERROR_MESSAGE = "The run's output files could not be stored.";

  /**
   * A stateful run whose runner lists one output file, `report.txt`, on a store
   * that writes and signs as `store` says. The store signs the run's own `/init`
   * URLs as usual: only the output file's link goes through `presignOutput`.
   * `runner.collect`, when given, answers the file list instead.
   */
  function uploadRun(
    store: {
      put: PresignedStorageAdapter["put"];
      presignOutput?: () => Promise<string>;
      delete?: PresignedStorageAdapter["delete"];
    },
    runner: { collect?: () => Response; logger?: Logger } = {},
  ) {
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect") && runner.collect) return runner.collect();
      if (url.endsWith("/outputs/collect")) {
        return new Response(
          JSON.stringify({ files: [{ path: "report.txt", size: 3, mimeType: "text/plain" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/outputs/file")) return new Response("abc", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const storage: PresignedStorageAdapter = {
      put: store.put,
      getPresignedDownloadUrl: vi.fn(async (key: string) =>
        key === OUTPUT_KEY && store.presignOutput
          ? store.presignOutput()
          : `https://r2.example/get/${key}`,
      ),
      getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put?sig=xyz"),
      ...(store.delete ? { delete: store.delete } : {}),
    };
    const { api, destroySpy } = createMockFlyApi("m-upload");
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async () => ({
        content: '{"result":"ok","_state":{"step":1}}',
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    });
    const state = {
      getState: vi.fn(async () => null),
      setState: vi.fn(async (_name: string, s: Record<string, unknown>) => {
        writes.push(s);
      }),
    };
    const adapter = new FlyioAdapter(
      api,
      storage,
      router,
      new ToolRegistry(),
      state,
      { fetchImpl },
      runner.logger,
    );
    const request = createRunRequest();
    request.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };
    return { events: collectEvents(adapter.executeStream(request)), writes, destroySpy };
  }

  /** An error of the given class name, its message quoting the key — as a storage client's can. */
  const storeError = (name: string) =>
    Object.assign(new Error(`PUT ${OUTPUT_KEY}: 503 Slow Down`), { name });

  it.each([
    [
      "a write that fails with TimeoutError",
      { put: async () => Promise.reject(storeError("TimeoutError")) },
    ],
    [
      "a write that fails with AbortError",
      { put: async () => Promise.reject(storeError("AbortError")) },
    ],
    ["a write that fails with Error", { put: async () => Promise.reject(storeError("Error")) }],
    [
      "a link that cannot be signed",
      {
        put: async () => {},
        presignOutput: async () => Promise.reject(new Error(`cannot sign ${OUTPUT_KEY}`)),
      },
    ],
  ])("ends the run on EXECUTION_FAILED, never ABORTED nor TIMEOUT, with a constant message, on %s before the budget runs out; the machine destroyed", async (_what, store) => {
    const { events, writes, destroySpy } = uploadRun(store);

    const all = await events;
    const last = all.at(-1);
    expect(last?.type === "run_error" && last.error).toEqual({
      code: "EXECUTION_FAILED",
      message: UPLOAD_ERROR_MESSAGE,
    });
    expect(JSON.stringify(last)).not.toContain("report.txt");
    expect(all.some((e) => e.type === "run_complete")).toBe(false);
    expect(writes).toEqual([]);
    expect(destroySpy).toHaveBeenCalledWith("m-upload");
  });

  /** An error as a storage client throws one: its own class, a message that quotes the key. */
  const accessDenied = () =>
    Object.assign(new Error(`Access Denied for ${OUTPUT_KEY}`), { name: "AccessDenied" });

  it.each([
    [
      "a file list answered with an error status",
      { put: async () => {} },
      () => new Response("collect failed under /mnt/session/outputs/report.txt", { status: 500 }),
      { error_code: "outputs_list", cause_name: "RunnerStatusError" },
    ],
    [
      "a file list not in its shape",
      { put: async () => {} },
      () => new Response(JSON.stringify({ files: [{ path: "report.txt" }] }), { status: 200 }),
      { error_code: "outputs_list", cause_name: "Error" },
    ],
    [
      "a write the store refuses",
      { put: async () => Promise.reject(accessDenied()) },
      undefined,
      { error_code: "outputs_put", cause_name: "AccessDenied" },
    ],
    [
      "a link that cannot be signed",
      {
        put: async () => {},
        presignOutput: async () => Promise.reject(new TypeError(`cannot sign ${OUTPUT_KEY}`)),
      },
      undefined,
      { error_code: "outputs_presign", cause_name: "TypeError" },
    ],
  ])("logs the failed run on %s by the step that failed and the class of its cause, never a message", async (_what, store, collect, expected) => {
    const log = recordingLogger();
    const { events } = uploadRun(store, { collect, logger: log.logger });

    await events;

    const line = log.line("run_failed");
    expect(line).toMatchObject({
      run_id: "test-run-id",
      error_name: "OutputsUploadError",
      ...expected,
    });
    expect(JSON.stringify(line)).not.toContain("report.txt");
  });

  it("tells a file list refused with a 400 from one not in its shape, by the class of the cause on the failed run's line", async () => {
    // A 400 is what a runner answers to limits past its own bounds — an image
    // older than the server, once the server's bounds are raised.
    const failedLine = async (collect: () => Response) => {
      const log = recordingLogger();
      await uploadRun({ put: async () => {} }, { collect, logger: log.logger }).events;
      return log.line("run_failed");
    };

    const refused = await failedLine(
      () => new Response("max_size_bytes out of range for report.txt", { status: 400 }),
    );
    const misshapen = await failedLine(() => new Response(JSON.stringify({ ok: true })));

    expect(refused?.error_code).toBe("outputs_list");
    expect(misshapen?.error_code).toBe("outputs_list");
    expect(refused?.cause_name).not.toBe(misshapen?.cause_name);
    expect(refused?.cause_name).toBe("RunnerStatusError");
    expect(JSON.stringify(refused)).not.toContain("report.txt");
  });

  it.each([
    "AbortError",
    "TimeoutError",
  ])("lets the run succeed — its output, its state — when its budget runs out during a write that then fails with %s; the cut object erased", async (name) => {
    // No real process runs here: the budget is held on a simulated clock.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const objects = new Map<string, Buffer>();
    let interrupted = false;
    let writeAsked: () => void = () => {};
    const writing = new Promise<void>((resolve) => {
      writeAsked = resolve;
    });
    const { events, writes, destroySpy } = uploadRun({
      // The store holds the whole object, then its answer is slow: it waits
      // until it is told to stop — or, never told, ends by itself well past the budget.
      put: (key, data, opts) => {
        objects.set(key, data);
        writeAsked();
        return new Promise<void>((resolve, reject) => {
          const guard = setTimeout(resolve, 10 * OUTPUTS_UPLOAD_BUDGET_MS);
          opts?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(guard);
              interrupted = true;
              reject(Object.assign(new Error("Request aborted"), { name }));
            },
            { once: true },
          );
        });
      },
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    });

    await writing;
    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS);
    expect(interrupted, "the write was cut by the budget").toBe(true);

    const all = await events;
    const last = all.at(-1);
    expect(last?.type).toBe("run_complete");
    if (last?.type === "run_complete") {
      expect(last.output).toEqual({ result: "ok" });
      expect(last.files).toEqual([]);
    }
    expect(writes).toEqual([{ step: 1 }]);
    expect([...objects.keys()]).toEqual([]);
    expect(destroySpy).toHaveBeenCalledWith("m-upload");
  });
});

// The caller learns how many of a run's output files were left out, and why:
// the run's end counts them by reason. Counts only — a file's name is the
// agent's, and never leaves in the event.
describe("FlyioAdapter — the run's end counts the output files it left out, by reason, and names none", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const LIMITS = readOutputLimits(process.env);

  interface Listing {
    /** What the runner lists, in its order. */
    files: Array<{ path: string; size: number }>;
    /** What the runner says it left out of its list itself. */
    runnerExcluded?: { name_refused: number; too_large: number; over_count: number };
    /** The status a file's pull is answered with; otherwise 200, with as many bytes as listed. */
    pullStatus?: Record<string, number>;
    /** The store's write; otherwise one that stores at once. */
    put?: PresignedStorageAdapter["put"];
  }

  function runListing(listing: Listing) {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/init") {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.pathname === "/outputs/collect") {
        return new Response(
          JSON.stringify({
            files: listing.files.map((file) => ({ ...file, mimeType: "text/plain" })),
            ...(listing.runnerExcluded && { excluded: listing.runnerExcluded }),
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/outputs/file") {
        const path = url.searchParams.get("path") ?? "";
        const status = listing.pullStatus?.[path];
        if (status !== undefined) return new Response("refused", { status });
        const size = listing.files.find((file) => file.path === path)?.size ?? 0;
        return new Response("x".repeat(size), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const storage: PresignedStorageAdapter = {
      put: listing.put ?? vi.fn().mockResolvedValue(undefined),
      getPresignedDownloadUrl: vi.fn(async (key: string) => `https://r2.example/get/${key}`),
      getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put?sig=xyz"),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      createMockFlyApi("m-left-out").api,
      storage,
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl },
    );
    return collectEvents(adapter.executeStream(createRunRequest()));
  }

  /** The run's terminal event, which must be its `run_complete`. */
  async function runComplete(events: Promise<RunEvent[]>) {
    const last = (await events).at(-1);
    if (last?.type !== "run_complete") throw new Error(`the run ended on ${last?.type}`);
    return last;
  }

  /** The event as the caller reads it, the stored files' names aside. */
  const withoutStoredFiles = (event: Record<string, unknown>) =>
    JSON.stringify({ ...event, files: undefined });

  const small = (path: string) => ({ path, size: 3 });

  it.each([
    [
      "a file past the size limit",
      {
        listing: { files: [{ path: "big.bin", size: LIMITS.max_size_bytes + 1 }, small("ok.txt")] },
        stored: ["ok.txt"],
        excluded: { too_large: 1 },
        names: ["big.bin"],
      },
    ],
    [
      "a name the output name rule refuses",
      {
        listing: { files: [small("a/../escape.txt"), small("ok.txt")] },
        stored: ["ok.txt"],
        excluded: { name_refused: 1 },
        names: ["escape.txt"],
      },
    ],
    [
      "a file past the count",
      {
        listing: {
          files: Array.from({ length: LIMITS.max_count + 1 }, (_, i) =>
            small(`f-${String(i).padStart(5, "0")}.txt`),
          ),
        },
        stored: Array.from(
          { length: LIMITS.max_count },
          (_, i) => `f-${String(i).padStart(5, "0")}.txt`,
        ),
        excluded: { over_count: 1 },
        names: [`f-${String(LIMITS.max_count).padStart(5, "0")}.txt`],
      },
    ],
    [
      "a file whose pull fails",
      {
        listing: { files: [small("gone.txt"), small("ok.txt")], pullStatus: { "gone.txt": 500 } },
        stored: ["ok.txt"],
        excluded: { pull_failed: 1 },
        names: ["gone.txt"],
      },
    ],
    [
      "what the runner left out of its list, added to what the upload leaves out",
      {
        listing: {
          files: [{ path: "big.bin", size: LIMITS.max_size_bytes + 1 }, small("ok.txt")],
          runnerExcluded: { name_refused: 1, too_large: 2, over_count: 3 },
        },
        stored: ["ok.txt"],
        excluded: { name_refused: 1, too_large: 3, over_count: 3 },
        names: ["big.bin"],
      },
    ],
  ])("counts %s", async (_reason, { listing, stored, excluded, names }) => {
    const event = await runComplete(runListing(listing));

    expect(event.files.map((file) => file.name)).toEqual(stored);
    expect(event.files_excluded).toEqual(excluded);
    for (const name of names) expect(withoutStoredFiles({ ...event })).not.toContain(name);
  });

  it("counts the files the upload's time budget left out: the one under way and those after it", async () => {
    // No real process runs here: the budget is held on a simulated clock.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    let writeAsked: () => void = () => {};
    const writing = new Promise<void>((resolve) => {
      writeAsked = resolve;
    });
    const events = runListing({
      files: [small("slow.txt"), small("next.txt")],
      // The store holds its answer until it is told to stop — or, never told,
      // ends by itself well past the budget.
      put: (_key, _data, opts) => {
        writeAsked();
        return new Promise<void>((resolve, reject) => {
          const guard = setTimeout(resolve, 10 * OUTPUTS_UPLOAD_BUDGET_MS);
          opts?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(guard);
              reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        });
      },
    });

    await writing;
    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS);
    const event = await runComplete(events);

    expect(event.files).toEqual([]);
    expect(event.files_excluded).toEqual({ upload_budget: 2 });
    expect(withoutStoredFiles({ ...event })).not.toContain("slow.txt");
  });

  it("counts nothing when every file is kept: an empty object, never absent", async () => {
    const event = await runComplete(runListing({ files: [small("a.txt"), small("b.txt")] }));

    expect(event.files.map((file) => file.name)).toEqual(["a.txt", "b.txt"]);
    expect(event.files_excluded).toEqual({});
  });

  it("counts nothing when the runner lists no file", async () => {
    const event = await runComplete(runListing({ files: [] }));

    expect(event.files).toEqual([]);
    expect(event.files_excluded).toEqual({});
  });
});

// An adapter is built for each run: a budget of its own would bound one run, not
// the process. Each upload reserves the size limit on the budget it is handed —
// the one the API's dependencies carry, or the process's.
describe("FlyioAdapter — one output bytes budget per process, shared by every adapter", () => {
  const LIMIT_BYTES = readOutputLimits(process.env).max_size_bytes;

  /**
   * A run whose runner lists one output file and serves it once `release` is
   * called — or, never released, five seconds later, so that a case that fails
   * leaves nothing waiting. `pulled` settles when the file's pull is asked for.
   */
  function runHeldAtItsPull(options: FlyioAdapterOptions) {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 5_000).unref();
    });
    let markPulled: () => void = () => {};
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve;
    });
    let pulls = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        return new Response(
          JSON.stringify({ files: [{ path: "report.txt", size: 3, mimeType: "text/plain" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/outputs/file")) {
        pulls++;
        markPulled();
        await released;
        return new Response("abc", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      createMockFlyApi("m-held").api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { ...options, fetchImpl },
    );
    return {
      events: collectEvents(adapter.executeStream(createRunRequest())),
      release,
      pulled,
      pulls: () => pulls,
    };
  }

  it("two adapters built on the same dependencies reserve on the one budget those carry: room for one file's limit lets one pull at a time", async () => {
    const deps = { outputsBudget: new OutputBytesBudget(LIMIT_BYTES) };
    const first = runHeldAtItsPull({ outputsBudget: deps.outputsBudget });
    await first.pulled;
    const second = runHeldAtItsPull({ outputsBudget: deps.outputsBudget });

    // The second upload waits for room: the first holds the whole budget.
    await vi.waitFor(() => expect(deps.outputsBudget.waiting).toBe(1));
    expect(second.pulls()).toBe(0);
    expect(deps.outputsBudget.inUse).toBe(LIMIT_BYTES);

    first.release();
    await second.pulled;
    second.release();
    const [a, b] = await Promise.all([first.events, second.events]);
    expect(a.at(-1)?.type).toBe("run_complete");
    expect(b.at(-1)?.type).toBe("run_complete");
    expect(deps.outputsBudget.inUse).toBe(0);
  });

  it("two adapters built without the option reserve on the process's budget", async () => {
    const shared = processOutputBytesBudget();
    const before = shared.inUse;
    const first = runHeldAtItsPull({});
    const second = runHeldAtItsPull({});

    await Promise.all([first.pulled, second.pulled]);
    expect(shared.inUse).toBe(before + 2 * LIMIT_BYTES);

    first.release();
    second.release();
    await Promise.all([first.events, second.events]);
    expect(shared.inUse).toBe(before);
  });

  it("is one instance for the whole process", () => {
    expect(processOutputBytesBudget()).toBe(processOutputBytesBudget());
    expect(processOutputBytesBudget().capacity).toBe(OUTPUT_BYTES_BUDGET);
  });
});

// A creation sent a second time — its first outcome unknown, and nothing found
// by its label — may have crossed a first request still in flight: two machines
// of one name and one label. Only the label finds the second, so the run that
// had to send its creation twice destroys every machine of its label.
describe("FlyioAdapter — a run whose creation was sent twice", () => {
  const RUN_NAME = "skrun-run-test-run-id";

  function labelledMachine(id: string, name = RUN_NAME, ip = "fdaa::1"): Machine {
    return { id, name, state: "started", private_ip: ip } as Machine;
  }

  /**
   * A platform client whose creation reports how it went — `resent` as the case
   * says — and whose label search returns what the case holds under the run's
   * label.
   */
  function clientReporting(options: {
    resent: boolean;
    createFails?: boolean;
    labelled: Machine[];
  }) {
    const create = vi.fn(async (_request: unknown, progress?: { resent: boolean }) => {
      if (progress) progress.resent = options.resent;
      if (options.createFails) {
        throw new MachineSpawnError(
          { machineName: RUN_NAME, machineId: null, phase: "create", httpStatus: null },
          new Error("the outcome of the creation is unknown"),
        );
      }
      return labelledMachine("m-run");
    });
    const listByLabel = vi.fn(async () => options.labelled);
    const destroy = vi.fn(async () => undefined);
    const api = {
      create,
      listByLabel,
      destroy,
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;
    return { api, create, listByLabel, destroy };
  }

  /** A runner that boots, initialises and has no outputs — or never answers its probe. */
  function runnerFetch(healthy = true): typeof fetch {
    return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: healthy }), { status: healthy ? 200 : 503 });
      }
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  async function run(api: FlyMachinesApi, fetchImpl: typeof fetch) {
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const lines: Array<Record<string, unknown>> = [];
    const record = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = {
      info: record,
      warn: record,
      error: record,
      debug: record,
    } as unknown as Logger;
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl, maxBootTimeMs: 50, bootPollIntervalMs: 5 },
      logger,
    );
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    const destroyed = lines
      .filter((l) => l.event === "machine_destroy")
      .map((l) => [l.machine_id, l.reason]);
    return { events, destroyed };
  }

  it("destroys every machine of its label at the end of the run, the second as a duplicate", async () => {
    const { api, listByLabel } = clientReporting({
      resent: true,
      labelled: [
        labelledMachine("m-run"),
        labelledMachine("m-dup", RUN_NAME, "fdaa::2"),
        // Its label, but another name: not this run's creation.
        labelledMachine("m-foreign", "skrun-run-someone-else", "fdaa::3"),
      ],
    });

    const { events, destroyed } = await run(api, runnerFetch());

    expect(events.at(-1)?.type).toBe("run_complete");
    expect(listByLabel).toHaveBeenCalledWith("skrun_run_id", "test-run-id");
    expect(destroyed).toEqual([
      ["m-run", "run_complete"],
      ["m-dup", "duplicate_after_resend"],
    ]);
  });

  it("destroys them when its start fails after the creation, the machine it had once only", async () => {
    const { api } = clientReporting({
      resent: true,
      labelled: [labelledMachine("m-run"), labelledMachine("m-dup", RUN_NAME, "fdaa::2")],
    });

    const { events, destroyed } = await run(api, runnerFetch(false));

    expect(events.at(-1)?.type).toBe("run_error");
    expect(destroyed).toEqual([
      ["m-run", "spawn_failed_boot-probe"],
      ["m-dup", "duplicate_after_resend"],
    ]);
  });

  it("destroys them when the creation itself fails after it was sent twice", async () => {
    const { api } = clientReporting({
      resent: true,
      createFails: true,
      labelled: [labelledMachine("m-late", RUN_NAME, "fdaa::4")],
    });

    const { events, destroyed } = await run(api, runnerFetch());

    expect(events.at(-1)?.type).toBe("run_error");
    expect(destroyed).toEqual([["m-late", "duplicate_after_resend"]]);
  });

  it("skips a machine of its label already going away", async () => {
    const { api } = clientReporting({
      resent: true,
      labelled: [
        labelledMachine("m-run"),
        { ...labelledMachine("m-gone", RUN_NAME, "fdaa::5"), state: "destroying" } as Machine,
      ],
    });

    const { destroyed } = await run(api, runnerFetch());

    expect(destroyed).toEqual([["m-run", "run_complete"]]);
  });

  it("searches nothing more when its creation was sent once", async () => {
    const { api, listByLabel } = clientReporting({
      resent: false,
      labelled: [labelledMachine("m-run"), labelledMachine("m-dup", RUN_NAME, "fdaa::2")],
    });

    const { events, destroyed } = await run(api, runnerFetch());

    expect(events.at(-1)?.type).toBe("run_complete");
    expect(listByLabel).not.toHaveBeenCalled();
    expect(destroyed).toEqual([["m-run", "run_complete"]]);
  });

  it("ends the run as it would have when the search for its duplicates fails", async () => {
    const { api, listByLabel } = clientReporting({ resent: true, labelled: [] });
    listByLabel.mockRejectedValue(new Error("listing refused"));

    const { events, destroyed } = await run(api, runnerFetch());

    expect(events.at(-1)?.type).toBe("run_complete");
    expect(destroyed).toEqual([["m-run", "run_complete"]]);
  });
});

// A cold run's /init URLs are signed once its machine answers — as the pool's
// are once its machine wakes — never before the machine is created: the
// creation may wait for its slot, for a refusal, for a search, and a URL signed
// before all that could expire before /init reads it.
describe("FlyioAdapter — a cold run's /init URLs are signed once its machine answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SECOND = 1000;

  interface Signed {
    key: string;
    expiresIn: number;
    at: number;
  }

  /** A store that records each URL it signs, and when. */
  function recordingStorage(signed: Signed[], failKey?: string): PresignedStorageAdapter {
    const sign = async (key: string, expiresIn: number) => {
      signed.push({ key, expiresIn, at: Date.now() });
      if (key === failKey) throw new Error("the store refused to sign");
      return `https://store.example/${key}?sig=1`;
    };
    return {
      put: vi.fn(async () => undefined),
      getPresignedDownloadUrl: vi.fn(sign),
      getPresignedUploadUrl: vi.fn(sign),
    };
  }

  it("signs them after the last boot probe, for their whole lifetime from there, and keeps them out of the machine", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const start = Date.now();
    // The creation waits 60 s — its slot, a refusal — before the platform answers.
    const { api, createSpy } = createMockFlyApi("m-late");
    createSpy.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60 * SECOND));
      return makeMachine("m-late");
    });
    // The machine then takes 80 s to answer its boot probe.
    const probes: number[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        probes.push(Date.now());
        const up = Date.now() - start >= 140 * SECOND;
        return new Response(JSON.stringify({ ok: up }), { status: up ? 200 : 503 });
      }
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const signed: Signed[] = [];
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      recordingStorage(signed),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl,
        heartbeatIntervalMs: 600 * SECOND,
      },
    );

    let settled = false;
    const collecting = collectEvents(adapter.executeStream(createRunRequest())).finally(() => {
      settled = true;
    });
    for (let step = 0; step < 1000 && !settled; step++) {
      await vi.advanceTimersByTimeAsync(SECOND / 2);
    }
    const events = await collecting;

    expect(events.at(-1)?.type).toBe("run_complete");
    const lastProbe = probes.at(-1) ?? Number.NaN;
    expect(lastProbe - start).toBeGreaterThanOrEqual(140 * SECOND);
    // The bundle's URL and the outputs' URL: signed after the last probe, for
    // the boot budget plus its margin, 120 s, counted from there.
    const runUrls = signed.filter((s) => s.key !== STORAGE_HOST_PROBE_KEY);
    expect(runUrls.map((s) => s.key).sort()).toEqual(
      ["_runs/test-run-id/outputs.tar.gz", "test/agent/1.0.0.agent"].sort(),
    );
    for (const url of runUrls) {
      expect(url.at).toBeGreaterThanOrEqual(lastProbe);
      expect(url.expiresIn).toBe(120);
    }
    // The machine's environment holds neither URL, and still the store's host.
    const env = createSpy.mock.calls[0][0].config.env;
    expect(env).not.toHaveProperty("BUNDLE_URL");
    expect(env).not.toHaveProperty("OUTPUTS_PUT_URL");
    expect(env.RUNNER_INFRA_HOSTS.split(",")).toContain("store.example");
  });

  it("destroys the machine it created when the store will not sign its /init URLs", async () => {
    const { api, createSpy, destroySpy } = createMockFlyApi("m-unsigned");
    const signed: Signed[] = [];
    const { logger, line } = recordingLogger();
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      recordingStorage(signed, "test/agent/1.0.0.agent"),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: createMockFetch() },
      logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    expect(createSpy).toHaveBeenCalledOnce();
    const last = events.at(-1);
    expect(last?.type === "run_error" && last.error.code).toBe("MACHINE_SPAWN_FAILED");
    expect(destroySpy).toHaveBeenCalledWith("m-unsigned");
    expect(line("spawn_failed")).toMatchObject({
      phase: "presign",
      error_name: "MachineSpawnError",
      cause: "the store refused to sign",
    });
    expect(line("machine_destroy")).toMatchObject({
      machine_id: "m-unsigned",
      reason: "spawn_failed_presign",
    });
  });

  // Before the creation, the store signs a probe URL to show its host. Its
  // failure can quote the store's endpoint: the caller is told the phase, in the
  // fixed words of a failed start; the store's own words stay in the log.
  it("fails at presign, before any creation, when the store will not sign the probe of its host: the caller is told the phase, never the store's words", async () => {
    const { api, createSpy, destroySpy } = createMockFlyApi("m-never");
    const storeSaid = "Custom endpoint `witness-store.internal.example://9000` was not a valid URI";
    const storage: PresignedStorageAdapter = {
      put: vi.fn(async () => undefined),
      getPresignedDownloadUrl: vi.fn(async () => {
        throw new Error(storeSaid);
      }),
      getPresignedUploadUrl: vi.fn(async () => "https://store.example/y"),
    };
    const spawnFailed: unknown[] = [];
    const { logger, line } = recordingLogger();
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      storage,
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: createMockFetch(),
        onSpawnFailed: (failure) => {
          spawnFailed.push(failure);
        },
      },
      logger,
    );

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    expect(createSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "run_error",
      error: {
        code: "MACHINE_SPAWN_FAILED",
        message: `The run's machine could not be started (phase "presign").`,
      },
    });
    expect(JSON.stringify(events)).not.toContain("witness-store");
    expect(spawnFailed).toEqual([{ phase: "presign" }]);
    expect(line("spawn_failed")).toMatchObject({
      phase: "presign",
      error_name: "MachineSpawnError",
      machine_id: null,
      cause: storeSaid,
    });
  });
});

// ---------------------------------------------------------------------------
// The runner's answers to /claim, /healthz and /init: a redirect is never
// followed, and each answer is read within its bounds, in bytes and in time.
// The machine also runs the agent's code, which can answer in the runner's
// place: whatever comes back is untrusted.
// ---------------------------------------------------------------------------

interface LoopbackServer {
  url: string;
  port: number;
  /** The path of every request it received, in order. */
  hits: string[];
  close(): Promise<void>;
}

/**
 * A server on the loopback address, in this process. A client that stops
 * reading resets its socket: the expected end of such an answer, never a
 * failure of the test.
 */
async function serveLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.on("error", () => {});
    handler(req, res);
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        // Stop accepting first, then end every connection: the order Node documents.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Valid JSON of exactly `size` bytes: the fields given, and a padding field. */
function paddedJson(fields: Record<string, unknown>, size: number): string {
  const head = JSON.stringify({ ...fields, pad: "" });
  return `${head.slice(0, -2)}${"a".repeat(size - head.length)}"}`;
}

/**
 * A body in memory that counts what its reader took: one chunk per read, none
 * read ahead, so `delivered` is exactly what was read. It ends by itself.
 */
function countedBody(text: string, chunk = 1024) {
  const bytes = Buffer.from(text);
  const state = { delivered: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.delivered >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, state.delivered + chunk);
        controller.enqueue(new Uint8Array(bytes.subarray(state.delivered, end)));
        state.delivered = end;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/**
 * A body that sends `head` at once, then one byte a second, until it is
 * cancelled — or, at the latest, after 600 s, so it always ends by itself.
 */
function drippingBody(head: string) {
  const state = { cancelled: false };
  let headSent = false;
  let ticks = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!headSent) {
          headSent = true;
          controller.enqueue(new Uint8Array(Buffer.from(head)));
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!state.cancelled) {
              ticks += 1;
              if (ticks > 600) controller.close();
              else controller.enqueue(new Uint8Array([0x61]));
            }
            resolve();
          }, 1_000);
        });
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** An answer that never comes: it fails when its request is aborted, as the platform's fetch does. */
function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
  });
}

type RunnerRoute = (init: RequestInit | undefined, nth: number) => Response | Promise<Response>;

/**
 * A fake runner, by path. Records each request's signal, and resolves
 * `asked(path, n)` once that path has been requested `n` times.
 */
function fakeRunner(routes: Record<string, RunnerRoute>) {
  const signals: Record<string, Array<AbortSignal | null | undefined>> = {};
  const waiters: Array<{ path: string; n: number; resolve: () => void }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
    const seen = signals[path] ?? [];
    signals[path] = seen;
    seen.push(init?.signal);
    for (const waiter of waiters) {
      if (waiter.path === path && seen.length >= waiter.n) waiter.resolve();
    }
    const route = routes[path];
    return route ? route(init, seen.length) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const asked = (path: string, n = 1) =>
    new Promise<void>((resolve) => {
      if ((signals[path]?.length ?? 0) >= n) resolve();
      else waiters.push({ path, n, resolve });
    });
  return { fetchImpl, signals, asked };
}

const okInit = () =>
  new Response(JSON.stringify({ ok: true, tools: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** A platform client whose cold machine sits at `privateIp`, and a pool with one ready machine at `pooledIp`. */
function platformWithPool(privateIp: string, pooledIp: string) {
  const calls: string[] = [];
  const flyApi = {
    create: vi.fn(async () => {
      calls.push("create");
      return {
        id: "cold-machine",
        name: "skrun-run-test-run-id",
        state: "started",
        private_ip: privateIp,
      };
    }),
    start: vi.fn(async (id: string) => {
      calls.push(`start:${id}`);
    }),
    suspend: vi.fn(async () => {}),
    stop: vi.fn(),
    destroy: vi.fn(async (id: string) => {
      calls.push(`destroy:${id}`);
    }),
    list: vi.fn(),
    listByLabel: vi.fn(async () => []),
    setMetadata: vi.fn(async () => {}),
  } as unknown as FlyMachinesApi;
  const pool = new RunnerPool(flyApi, {
    size: 1,
    imageTag: "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
  });
  pool.register({
    machineId: "pooled-1",
    privateIp: pooledIp,
    claimToken: "c".repeat(64),
    imageTag: "registry.example/runner:v1",
    harness6pn: "fdaa:0:1::2",
    processId: "proc-paused",
  });
  pool.markReady("pooled-1");
  return { flyApi, pool, calls };
}

describe("FlyioAdapter — a redirect from the runner is never followed", () => {
  const servers: LoopbackServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  /** An address that answers anything it is asked, as an internal service would. */
  async function internalTarget() {
    const target = await serveLoopback((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, process_id: "proc-paused", tools: [] }));
    });
    servers.push(target);
    return target;
  }

  /** The runner, on the loopback address: `redirects` names the one path it answers with a 302. */
  async function runnerOn(redirects: string, target: LoopbackServer) {
    const server = await serveLoopback((req, res) => {
      if (req.url === redirects) {
        res.writeHead(302, { Location: `${target.url}/internal` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url === "/init" ? JSON.stringify({ ok: true, tools: [] }) : "{}");
    });
    servers.push(server);
    return server;
  }

  /**
   * The boot budget is wide by default: a probe that must succeed gets all the
   * room a loaded machine may need. The case where every probe fails narrows it.
   */
  function adapterOn(
    port: number,
    flyApi: FlyMachinesApi,
    pool: RunnerPool | undefined,
    logger: Logger,
    maxBootTimeMs = 10_000,
  ) {
    // No fetch given: the adapter's own, on the loopback address.
    return new ExposedAdapter(
      flyApi,
      createMockStorage(),
      new LLMRouter({}),
      new ToolRegistry(),
      undefined,
      {
        pool,
        runnerPort: port,
        maxBootTimeMs,
        bootPollIntervalMs: 20,
        runtimeImage: "registry.example/runner:v1",
      },
      logger,
    );
  }

  it("discards a pooled machine whose /claim redirects, and falls back to creating one", async () => {
    const target = await internalTarget();
    const server = await runnerOn("/claim", target);
    const { flyApi, pool, calls } = platformWithPool("127.0.0.1", "127.0.0.1");
    const { logger, line } = recordingLogger();

    const spawn = await adapterOn(server.port, flyApi, pool, logger).acquire(createRunRequest());

    expect(target.hits).toEqual([]);
    expect(line("pool_claim_failed")).toMatchObject({
      machine_id: "pooled-1",
      phase: "pool-claim",
      error_name: "MachineSpawnError",
    });
    expect(calls).toContain("destroy:pooled-1");
    expect(spawn.machineId).toBe("cold-machine");
  });

  it("fails a cold start at its boot probe when /healthz redirects", async () => {
    const target = await internalTarget();
    const server = await runnerOn("/healthz", target);
    const { flyApi, calls } = platformWithPool("127.0.0.1", "127.0.0.1");
    const { logger, line } = recordingLogger();

    await collectEvents(
      adapterOn(server.port, flyApi, undefined, logger, 400).executeStream(createRunRequest()),
    );

    expect(target.hits).toEqual([]);
    expect(line("spawn_failed")).toMatchObject({
      phase: "boot-probe",
      error_name: "MachineSpawnError",
      cause: "/healthz answered with a redirect, which is never followed",
    });
    expect(calls).toContain("destroy:cold-machine");
  });

  it("fails a cold start at init when /init redirects", async () => {
    const target = await internalTarget();
    const server = await runnerOn("/init", target);
    const { flyApi, calls } = platformWithPool("127.0.0.1", "127.0.0.1");
    const { logger, line } = recordingLogger();

    await collectEvents(
      adapterOn(server.port, flyApi, undefined, logger).executeStream(createRunRequest()),
    );

    expect(target.hits).toEqual([]);
    expect(line("spawn_failed")).toMatchObject({
      phase: "init-rpc",
      httpStatus: null,
      error_name: "MachineSpawnError",
      cause: "/init answered with a redirect, which is never followed",
    });
    expect(calls).toContain("destroy:cold-machine");
  });
});

describe("FlyioAdapter — the runner's answers are read up to their bounds, and no further", () => {
  const KIB = 1024;
  const MIB = 1024 * KIB;

  function coldAdapter(api: FlyMachinesApi, fetchImpl: typeof fetch, logger: Logger) {
    return new FlyioAdapter(
      api,
      createMockStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl },
      logger,
    );
  }

  it("fails a cold start at init when /init answers more than 1 MiB, past which it reads nothing", async () => {
    const body = countedBody(paddedJson({ ok: true, tools: [] }, MIB + 2 * KIB));
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/init": () => new Response(body.stream, { status: 200 }),
    });
    const { api, destroySpy } = createMockFlyApi("m-init-large");
    const { logger, line } = recordingLogger();

    await collectEvents(coldAdapter(api, fetchImpl, logger).executeStream(createRunRequest()));

    expect(body.state.delivered).toBeLessThanOrEqual(MIB + KIB);
    expect(body.state.cancelled).toBe(true);
    expect(line("spawn_failed")).toMatchObject({
      phase: "init-rpc",
      httpStatus: 200,
      error_name: "MachineSpawnError",
    });
    // An answer was read: its cause is not kept.
    expect(line("spawn_failed")).not.toHaveProperty("cause");
    expect(destroySpy).toHaveBeenCalledWith("m-init-large");
  });

  it("reads 4 KiB of a 1 MiB error answer from /init", async () => {
    const body = countedBody("e".repeat(MIB));
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/init": () => new Response(body.stream, { status: 500 }),
    });
    const { api } = createMockFlyApi("m-init-error");
    const { logger, line } = recordingLogger();

    await collectEvents(coldAdapter(api, fetchImpl, logger).executeStream(createRunRequest()));

    expect(body.state.delivered).toBeLessThanOrEqual(4 * KIB + KIB);
    expect(body.state.cancelled).toBe(true);
    expect(line("spawn_failed")).toMatchObject({ phase: "init-rpc", httpStatus: 500 });
  });

  it("discards a pooled machine whose /claim answers more than 64 KiB, past which it reads nothing", async () => {
    const body = countedBody(paddedJson({ ok: true, process_id: "proc-paused" }, MIB));
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/claim": () => new Response(body.stream, { status: 200 }),
      "/init": okInit,
    });
    const { flyApi, pool, calls } = platformWithPool("fdaa::1", "fdaa::9");
    const { logger, line } = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger }).acquire(
      createRunRequest(),
    );

    expect(body.state.delivered).toBeLessThanOrEqual(64 * KIB + KIB);
    expect(body.state.cancelled).toBe(true);
    expect(line("pool_claim_failed")).toMatchObject({
      machine_id: "pooled-1",
      phase: "pool-claim",
    });
    expect(calls).toContain("destroy:pooled-1");
    expect(spawn.machineId).toBe("cold-machine");
  });

  it("keeps a pooled machine whose /claim answer is cut while it is read, as one that cannot say its process", async () => {
    let sent = false;
    // The head of the answer, then the connection cut: a failure of the read
    // that is neither past the bound nor past the deadline.
    const cut = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) {
            controller.error(new TypeError("terminated"));
            return;
          }
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"ok":true,"process_id":"proc-'));
        },
      },
      { highWaterMark: 0 },
    );
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/claim": () => new Response(cut, { status: 200 }),
      "/init": okInit,
    });
    const { flyApi, pool, calls } = platformWithPool("fdaa::1", "fdaa::9");
    const { logger, line } = recordingLogger();

    const spawn = await makeAdapter(flyApi, fetchImpl, pool, { logger }).acquire(
      createRunRequest(),
    );

    expect(spawn.machineId).toBe("pooled-1");
    expect(calls).not.toContain("destroy:pooled-1");
    expect(line("pool_claim_failed")).toBeUndefined();
  });

  it("reads 4 KiB of a 1 MiB error answer from /claim", async () => {
    const body = countedBody("e".repeat(MIB));
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/claim": () => new Response(body.stream, { status: 500 }),
      "/init": okInit,
    });
    const { flyApi, pool } = platformWithPool("fdaa::1", "fdaa::9");
    const { logger, line } = recordingLogger();

    await makeAdapter(flyApi, fetchImpl, pool, { logger }).acquire(createRunRequest());

    expect(body.state.delivered).toBeLessThanOrEqual(4 * KIB + KIB);
    expect(body.state.cancelled).toBe(true);
    expect(line("pool_claim_failed")).toMatchObject({ phase: "pool-claim", error_status: "500" });
  });

  it("reads nothing of a cold /healthz answer: its status is the whole probe", async () => {
    const body = countedBody(paddedJson({ ok: true }, MIB));
    const { fetchImpl } = fakeRunner({
      "/healthz": () => new Response(body.stream, { status: 200 }),
      "/init": okInit,
    });
    const { api } = createMockFlyApi("m-probe");

    const spawn = await makeAdapter(api, fetchImpl, undefined).acquire(createRunRequest());

    expect(spawn.machineId).toBe("m-probe");
    expect(body.state.delivered).toBe(0);
    expect(body.state.cancelled).toBe(true);
  });
});

describe("FlyioAdapter — each answer of the runner is waited for within its bound, on a simulated clock", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance to one millisecond before `ms` and read `check`, then to `ms` and read it again. */
  async function across(ms: number, check: () => boolean): Promise<[boolean, boolean]> {
    await vi.advanceTimersByTimeAsync(ms - 1);
    const before = check();
    await vi.advanceTimersByTimeAsync(1);
    return [before, check()];
  }

  it("gives up on a /claim whose headers have not come at 30 s, and falls back", async () => {
    const runner = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/claim": (init) => neverAnswers(init),
      "/init": okInit,
    });
    const { flyApi, pool, calls } = platformWithPool("fdaa::1", "fdaa::9");

    const acquiring = makeAdapter(flyApi, runner.fetchImpl, pool).acquire(createRunRequest());
    await runner.asked("/claim");

    expect(await across(30_000, () => runner.signals["/claim"]?.[0]?.aborted === true)).toEqual([
      false,
      true,
    ]);
    const spawn = await acquiring;
    expect(calls).toContain("destroy:pooled-1");
    expect(spawn.machineId).toBe("cold-machine");
  });

  it.each([
    ["/claim", 200, 10_000],
    ["/claim", 500, 10_000],
    ["/init", 200, 30_000],
    ["/init", 500, 30_000],
  ] as const)("cuts a %s answer (HTTP %i) that drips past %i ms", async (path, status, bound) => {
    const body = drippingBody('{"ok":true,"tools":[],"pad":"');
    const pooled = path === "/claim";
    const runner = fakeRunner({
      "/healthz": () => new Response("{}", { status: 200 }),
      "/claim": () => (pooled ? new Response(body.stream, { status }) : okInit()),
      "/init": () => (pooled ? okInit() : new Response(body.stream, { status })),
    });
    const { flyApi, pool } = platformWithPool("fdaa::1", "fdaa::9");

    const acquiring = makeAdapter(flyApi, runner.fetchImpl, pooled ? pool : undefined)
      .acquire(createRunRequest())
      .then(
        (spawn) => spawn.machineId,
        (err: unknown) => (err instanceof MachineSpawnError ? err.details.phase : "other"),
      );
    await runner.asked(path);

    expect(await across(bound, () => body.state.cancelled)).toEqual([false, true]);
    // The claim is dropped, and the run falls back to a machine of its own; the
    // cold start fails at init.
    expect(await acquiring).toBe(pooled ? "cold-machine" : "init-rpc");
  });

  it("gives up on a cold /healthz probe at 5 s, and probes again", async () => {
    const runner = fakeRunner({
      "/healthz": (init, nth) =>
        nth === 1 ? neverAnswers(init) : new Response("{}", { status: 200 }),
      "/init": okInit,
    });
    const { api } = createMockFlyApi("m-slow-probe");

    const acquiring = makeAdapter(api, runner.fetchImpl, undefined).acquire(createRunRequest());
    await runner.asked("/healthz");

    expect(await across(5_000, () => runner.signals["/healthz"]?.[0]?.aborted === true)).toEqual([
      false,
      true,
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect((await acquiring).machineId).toBe("m-slow-probe");
  });

  it("fails at its boot probe once the budget is spent, naming the last probe's wait", async () => {
    const runner = fakeRunner({ "/healthz": (init) => neverAnswers(init) });
    const { api } = createMockFlyApi("m-silent-probe");
    const adapter = new ExposedAdapter(
      api,
      createMockStorage(),
      new LLMRouter({}),
      new ToolRegistry(),
      undefined,
      { fetchImpl: runner.fetchImpl, maxBootTimeMs: 7_000, bootPollIntervalMs: 500 },
    );

    const acquiring = adapter.acquire(createRunRequest()).then(
      () => undefined,
      (err: unknown) => err,
    );
    await runner.asked("/healthz");
    await vi.advanceTimersByTimeAsync(5_500);
    // The first probe was given up at 5 s, the second sent after the 500 ms pause:
    // the budget is checked between probes, and each keeps its own bound.
    expect(runner.signals["/healthz"]?.length).toBe(2);
    expect(await across(5_000, () => runner.signals["/healthz"]?.[1]?.aborted === true)).toEqual([
      false,
      true,
    ]);
    await vi.advanceTimersByTimeAsync(500);

    const error = await acquiring;
    expect(error).toBeInstanceOf(MachineSpawnError);
    expect((error as MachineSpawnError).details.phase).toBe("boot-probe");
    expect(((error as MachineSpawnError).cause as Error).message).toBe(
      "/healthz did not answer within 5 s: timed out",
    );
    expect(runner.signals["/healthz"]).toHaveLength(2);
  });
});

// One budget bounds the whole acquisition — the pool's claims and the cold path
// together —, and the caller's signal ends it as the budget does: every call of
// the acquisition is handed both, and the run ends where the acquisition stood.
describe("FlyioAdapter — one acquisition budget, and the caller's signal, end the acquisition", () => {
  const BUDGET_MS = 20_000;
  const BUDGET_MESSAGE =
    "The machine for this run was not ready within its acquisition budget (20s).";

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the work in flight run out; the simulated clock does not move. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const quiet = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  /** A request that answers only by failing, once its signal aborts — as Node's fetch does. */
  function hang(init?: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }

  /**
   * The platform, behind the real client: a creation answers its machine, or
   * hangs; a start of a pooled machine answers, or hangs; a destroy answers.
   * Every request is kept, with the signal it was sent with. `createBoundMs`
   * sets the bound of each creation attempt in the client, its own default
   * otherwise.
   */
  function platform(over: { create?: "hang"; start?: "hang"; createBoundMs?: number } = {}) {
    const sent: Array<{ method: string; path: string; signal?: AbortSignal | null }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, signal: init?.signal });
      if (method === "POST" && url.pathname.endsWith("/machines")) {
        if (over.create === "hang") return hang(init);
        return new Response(
          JSON.stringify({
            id: "m-cold",
            name: "skrun-run-test-run-id",
            state: "started",
            private_ip: "fdaa::7",
          }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.pathname.endsWith("/start")) {
        if (over.start === "hang") return hang(init);
        return new Response("", { status: 200 });
      }
      if (method === "DELETE") return new Response("", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const api = new FlyMachinesApi("token", "app", {
      fetchImpl,
      logger: quiet,
      ...(over.createBoundMs === undefined
        ? {}
        : { attemptTimeoutsMs: { create: over.createBoundMs } }),
    });
    const of = (method: string, suffix: string) =>
      sent.filter((s) => s.method === method && s.path.endsWith(suffix));
    return { api, sent, of };
  }

  /** The runner: its probe answers 200, a status, or hangs; its /init answers, or hangs. */
  function runner(over: { healthz?: "hang" | number; init?: "hang" } = {}) {
    const signals: Record<string, Array<AbortSignal | null | undefined>> = {};
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      signals[path] ??= [];
      signals[path].push(init?.signal);
      if (path === "/healthz") {
        if (over.healthz === "hang") return hang(init);
        return new Response("{}", {
          status: typeof over.healthz === "number" ? over.healthz : 200,
        });
      }
      if (path === "/claim") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (path === "/init") {
        if (over.init === "hang") return hang(init);
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, signals };
  }

  function adapterOn(
    api: FlyMachinesApi,
    runnerFetch: typeof fetch,
    extra: Partial<FlyioAdapterOptions> = {},
  ) {
    const { logger, line } = recordingLogger();
    const router = new LLMRouter();
    router.registerProvider("mock", createOkProvider());
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: runnerFetch,
        runtimeImage: "registry.example/runner:v1",
        acquisitionBudgetMs: BUDGET_MS,
        ...extra,
      },
      logger,
    );
    return { adapter, line };
  }

  /** The run's stream, read to its end in the background; `onEvent` sees each event as it arrives. */
  function drive(
    adapter: FlyioAdapter,
    request: RunRequest = createRunRequest(),
    onEvent: (event: RunEvent) => void = () => {},
  ) {
    const events: RunEvent[] = [];
    let ended = false;
    const done = (async () => {
      for await (const event of adapter.executeStream(request)) {
        events.push(event);
        onEvent(event);
      }
      ended = true;
    })();
    const runError = () => {
      const last = events[events.length - 1];
      return last?.type === "run_error" ? last.error : undefined;
    };
    return { events, done, ended: () => ended, runError };
  }

  /** A pool of three ready machines, built for the adapter's image. */
  function poolOfThree(api: FlyMachinesApi): RunnerPool {
    const pool = new RunnerPool(api, {
      size: 3,
      imageTag: "registry.example/runner:v1",
      harness6pn: "fdaa:0:1::2",
    });
    for (const machineId of ["pooled-1", "pooled-2", "pooled-3"]) {
      pool.register({
        machineId,
        privateIp: "fdaa::9",
        claimToken: "c".repeat(64),
        imageTag: "registry.example/runner:v1",
        harness6pn: "fdaa:0:1::2",
      });
      pool.markReady(machineId);
    }
    return pool;
  }

  it("a pool whose every claim hangs ends at the budget, not once per machine: one machine tried and discarded, no cold path", async () => {
    const fly = platform({ start: "hang" });
    const pool = poolOfThree(fly.api);
    const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, { pool });
    const run = drive(adapter);

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(run.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()).toEqual({ code: "MACHINE_SPAWN_FAILED", message: BUDGET_MESSAGE });
    expect(line("spawn_failed")).toMatchObject({ phase: "pool-resume" });
    // One wake was asked, and cut by the budget; that machine is discarded, the
    // other two are left in the pool, and no machine is created.
    expect(fly.of("POST", "/start")).toHaveLength(1);
    expect(fly.of("POST", "/start")[0]?.signal?.aborted).toBe(true);
    expect(fly.of("DELETE", "/pooled-1")).toHaveLength(1);
    expect(fly.of("POST", "/machines")).toEqual([]);
    expect(pool.stats().ready).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a creation of the real client that hangs ends at the budget, its request cut, at phase create", async () => {
    const fly = platform({ create: "hang" });
    const cleanups: Array<Promise<void>> = [];
    const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, {
      onBackgroundCleanup: (cleanup) => {
        cleanups.push(cleanup);
      },
    });
    const run = drive(adapter);

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(run.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()).toEqual({ code: "MACHINE_SPAWN_FAILED", message: BUDGET_MESSAGE });
    expect(line("spawn_failed")).toMatchObject({ phase: "create", cause: BUDGET_MESSAGE });
    expect(fly.of("POST", "/machines")).toHaveLength(1);
    expect(fly.of("POST", "/machines")[0]?.signal?.aborted).toBe(true);
    expect(fly.of("DELETE", "")).toEqual([]);
    // What that creation may have made is looked for in the background; once
    // that is over, nothing is left armed.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(cleanups);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a boot probe that hangs ends at the budget, not at the boot budget, at phase boot-probe — the machine destroyed", async () => {
    const fly = platform();
    const probe = runner({ healthz: "hang" });
    const { adapter, line } = adapterOn(fly.api, probe.fetchImpl, { maxBootTimeMs: 600_000 });
    const run = drive(adapter);

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(run.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()).toEqual({ code: "MACHINE_SPAWN_FAILED", message: BUDGET_MESSAGE });
    expect(line("spawn_failed")).toMatchObject({ phase: "boot-probe", cause: BUDGET_MESSAGE });
    expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
    // The probe in flight was cut by the budget, not left to its own bound.
    expect(probe.signals["/healthz"]?.at(-1)?.aborted).toBe(true);
    expect(probe.signals["/init"]).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without the option, the budget is the platform's burst on the adapter's boot budget", async () => {
    const budgetMs = acquisitionBudgetMs({
      concurrentCreates: FLY_APP_ACTION_BURST,
      maxBootTimeMs: 1_000_000,
    });
    // A creation that never answers before the budget: each attempt's own bound
    // is set past it, so the budget is what ends the acquisition.
    const fly = platform({ create: "hang", createBoundMs: budgetMs + 1 });
    const cleanups: Array<Promise<void>> = [];
    const { adapter } = adapterOn(fly.api, runner().fetchImpl, {
      acquisitionBudgetMs: undefined,
      maxBootTimeMs: 1_000_000,
      onBackgroundCleanup: (cleanup) => {
        cleanups.push(cleanup);
      },
    });
    const run = drive(adapter);

    await vi.advanceTimersByTimeAsync(budgetMs - 1);
    expect(run.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()).toEqual({
      code: "MACHINE_SPAWN_FAILED",
      message: `The machine for this run was not ready within its acquisition budget (${budgetMs / 1000}s).`,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(cleanups);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller who hangs up while /init is awaited ends the acquisition at once — the machine destroyed", async () => {
    const fly = platform();
    const calls = runner({ init: "hang" });
    const { adapter, line } = adapterOn(fly.api, calls.fetchImpl);
    const controller = new AbortController();
    const run = drive(adapter, createRunRequest({ abortSignal: controller.signal }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.signals["/init"]).toHaveLength(1);
    controller.abort();
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()?.code).toBe("MACHINE_SPAWN_FAILED");
    expect(run.runError()?.message).not.toBe(BUDGET_MESSAGE);
    expect(line("spawn_failed")).toMatchObject({ phase: "init-rpc" });
    expect(calls.signals["/init"]?.[0]?.aborted).toBe(true);
    expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller who hangs up while the boot probe loops ends it at once: no probe after, the machine destroyed", async () => {
    const fly = platform();
    const probe = runner({ healthz: 503 });
    const { adapter, line } = adapterOn(fly.api, probe.fetchImpl, { maxBootTimeMs: 600_000 });
    const controller = new AbortController();
    const run = drive(adapter, createRunRequest({ abortSignal: controller.signal }));

    // A few probes, each answered 503, each followed by the pause between two.
    await vi.advanceTimersByTimeAsync(2_250);
    const probesBefore = probe.signals["/healthz"]?.length ?? 0;
    expect(probesBefore).toBeGreaterThan(1);
    controller.abort();
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()?.code).toBe("MACHINE_SPAWN_FAILED");
    expect(line("spawn_failed")).toMatchObject({ phase: "boot-probe" });
    expect(probe.signals["/healthz"]).toHaveLength(probesBefore);
    expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller who hangs up while a pooled machine is claimed ends there: the machine discarded, no other tried, no cold path", async () => {
    const fly = platform({ start: "hang" });
    const pool = poolOfThree(fly.api);
    const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, { pool });
    const controller = new AbortController();
    const run = drive(adapter, createRunRequest({ abortSignal: controller.signal }));

    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(line("spawn_failed")).toMatchObject({ phase: "pool-resume" });
    expect(fly.of("POST", "/start")).toHaveLength(1);
    expect(fly.of("DELETE", "/pooled-1")).toHaveLength(1);
    expect(fly.of("POST", "/machines")).toEqual([]);
    expect(pool.stats().ready).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller who hung up before the run began takes no pooled machine: none woken, none discarded, no creation", async () => {
    const fly = platform();
    const pool = poolOfThree(fly.api);
    const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, { pool });
    const run = drive(adapter, createRunRequest({ abortSignal: AbortSignal.abort() }));

    await flush();
    expect(run.ended()).toBe(true);
    await run.done;

    expect(run.runError()?.code).toBe("MACHINE_SPAWN_FAILED");
    expect(line("spawn_failed")).toMatchObject({ phase: "create" });
    expect(fly.sent).toEqual([]);
    expect(pool.stats().ready).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an acquisition that succeeds leaves no timer of its budget armed", async () => {
    const fly = platform();
    const { adapter } = adapterOn(fly.api, runner().fetchImpl);
    const spawn = await (
      adapter as unknown as { acquireRunner(r: RunRequest): Promise<SpawnResult> }
    ).acquireRunner(createRunRequest());

    expect(spawn.machineId).toBe("m-cold");
    expect(vi.getTimerCount()).toBe(0);
  });

  // A pooled machine's phases reach the caller only when the acquisition is
  // abandoned there — a claim that fails otherwise falls back to the cold path.
  // Abandoned at any phase, from the pool or cold, the caller is told that
  // phase in fixed words: no machine's name, no id.
  it.each([
    ["pool", "pool-resume", "start"],
    ["pool", "boot-probe", "healthz"],
    ["pool", "pool-claim", "claim"],
    ["pool", "init-rpc", "init"],
    ["cold", "create", "machines"],
    ["cold", "boot-probe", "healthz"],
    ["cold", "init-rpc", "init"],
  ] as const)("%s: a caller who hangs up at %s is told that phase, no machine named", async (path, phase, stuck) => {
    const fly = platform({
      ...(stuck === "start" && { start: "hang" }),
      ...(stuck === "machines" && { create: "hang" }),
    });
    const pool = path === "pool" ? poolOfThree(fly.api) : undefined;
    const runnerFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const at = new URL(String(input)).pathname;
      if (at === `/${stuck}`) return hang(init);
      if (at === "/healthz") return new Response("{}", { status: 200 });
      if (at === "/claim") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (at === "/init") {
        return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const cleanups: Array<Promise<void>> = [];
    const { adapter, line } = adapterOn(fly.api, runnerFetch, {
      pool,
      onBackgroundCleanup: (cleanup) => {
        cleanups.push(cleanup);
      },
    });
    const controller = new AbortController();
    const run = drive(adapter, createRunRequest({ abortSignal: controller.signal }));

    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await flush();
    await run.done;
    // A creation cut in flight is looked for in the background: let it end.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(cleanups);

    expect(line("spawn_failed")).toMatchObject({ phase });
    expect(run.runError()).toEqual({
      code: "MACHINE_SPAWN_FAILED",
      message: `The run's machine could not be started (phase "${phase}").`,
    });
    expect(JSON.stringify(run.events)).not.toMatch(/pooled-|m-cold|skrun-pool-|skrun-run-/);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A creation abandoned once its request left may have made a machine the
  // platform has not answered for: the client sends nothing more for it, and
  // the adapter looks for it by its label — after the run's error is out, in
  // the background, within a bound.
  describe("a creation abandoned mid-flight is looked for by its label, in the background", () => {
    const RUN_MACHINE = "skrun-run-test-run-id";

    /**
     * The platform makes the machine a creation asks for, then never answers the
     * run's own creation — until its request's signal aborts; other creations are
     * answered. A labelled listing shows the machines of the label from
     * `listedFrom` ms after they were made — or hangs, or is refused.
     */
    function creatingPlatform(over: { listedFrom?: number; read?: "hang" | number } = {}) {
      const held: Array<Machine & { madeAt: number }> = [];
      const sent: Array<{ method: string; path: string; at: number; signal?: AbortSignal | null }> =
        [];
      // Times are read from the case's start: the simulated clock starts at the real date.
      const origin = Date.now();
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        sent.push({ method, path: url.pathname, at: Date.now() - origin, signal: init?.signal });
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as {
            name: string;
            config: Machine["config"];
          };
          const machine = {
            id: `m-${held.length + 1}`,
            name: body.name,
            state: "started" as const,
            private_ip: "fdaa::3",
            config: body.config,
            madeAt: Date.now(),
          };
          held.push(machine);
          if (body.name === RUN_MACHINE) return hang(init);
          return new Response(JSON.stringify(machine), { status: 200 });
        }
        if (method === "DELETE") {
          const id = url.pathname.split("/").pop();
          const at = held.findIndex((m) => m.id === id);
          if (at >= 0) held.splice(at, 1);
          return new Response("", { status: 200 });
        }
        if (over.read === "hang") return hang(init);
        if (typeof over.read === "number") return new Response("refused", { status: over.read });
        const runId = url.searchParams.get("metadata.skrun_run_id");
        const listed = held.filter(
          (m) =>
            m.config?.metadata?.skrun_run_id === runId &&
            Date.now() - m.madeAt >= (over.listedFrom ?? 0),
        );
        return new Response(JSON.stringify(listed), { status: 200 });
      }) as typeof fetch;
      const api = new FlyMachinesApi("token", "app", { fetchImpl, logger: quiet });
      const at = (method: string) => sent.filter((s) => s.method === method).map((s) => s.at);
      return { api, sent, held, at };
    }

    /** An adapter whose background clean-ups are handed to the case. */
    function cleanedAdapter(api: FlyMachinesApi, extra: Partial<FlyioAdapterOptions> = {}) {
      const cleanups: Array<Promise<void>> = [];
      const built = adapterOn(api, runner().fetchImpl, {
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
        ...extra,
      });
      return { ...built, cleanups };
    }

    it("a creation the budget abandons is found once the run's error is out — the error not waiting for it — and destroyed", async () => {
      const fly = creatingPlatform({ listedFrom: BUDGET_MS + 1_500 });
      const { adapter, line, cleanups } = cleanedAdapter(fly.api);
      const sentWhenTold: number[] = [];
      const run = drive(adapter, createRunRequest(), (event) => {
        if (event.type === "run_error") sentWhenTold.push(fly.sent.length);
      });

      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await flush();
      // The run's error, and the end of its stream, are out at the budget: the
      // clean-up has not read anything yet.
      expect(run.ended()).toBe(true);
      expect(run.runError()).toEqual({ code: "MACHINE_SPAWN_FAILED", message: BUDGET_MESSAGE });
      expect(sentWhenTold).toEqual([1]);
      expect(cleanups).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await cleanups[0];

      // Nothing was sent for the abandoned creation itself: its one request was
      // cut. After it, the clean-up's reads a second apart — five, the first one
      // already ten seconds after the request left — and one destruction.
      expect(fly.sent[0]?.signal?.aborted).toBe(true);
      expect(fly.at("POST")).toEqual([0]);
      expect(fly.at("GET")).toEqual([21_000, 22_000, 23_000, 24_000, 25_000]);
      expect(fly.at("DELETE")).toEqual([22_000]);
      expect(fly.held).toEqual([]);
      expect(line("abandoned_create_cleanup")).toEqual({
        event: "abandoned_create_cleanup",
        run_id: "test-run-id",
        found: 1,
        destroyed: 1,
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reads on until a read leaves ten seconds after the request: a machine listed seven seconds late is still found", async () => {
      const fly = creatingPlatform({ listedFrom: 7_000 });
      const { adapter, line, cleanups } = cleanedAdapter(fly.api, { acquisitionBudgetMs: 1_000 });
      const run = drive(adapter);

      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(run.ended()).toBe(true);
      await vi.advanceTimersByTimeAsync(12_000);
      await cleanups[0];

      // Five reads, from 2 to 6 s, cannot see it; the reads go on until one
      // leaves at 10 s, and the one at 7 s finds it.
      expect(fly.at("GET")).toEqual([
        2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000,
      ]);
      expect(fly.at("DELETE")).toEqual([7_000]);
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 1, destroyed: 1 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a creation abandoned during its resend: the reads go on until one leaves ten seconds after the last request, and find the machine it made", async () => {
      // The first request is answered 503: its outcome unknown, it made nothing.
      // The client's own search reads five times, finds nothing, and sends the
      // creation again at 5 s — that request makes the machine, listed seven
      // seconds later, and hangs. The budget cuts it half a second after it left.
      const held: Array<Machine & { madeAt: number }> = [];
      const sent: Array<{ method: string; at: number }> = [];
      const origin = Date.now();
      let posts = 0;
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        sent.push({ method, at: Date.now() - origin });
        if (method === "POST") {
          posts++;
          if (posts === 1) return new Response("upstream", { status: 503 });
          const body = JSON.parse(String(init?.body)) as {
            name: string;
            config: Machine["config"];
          };
          held.push({
            id: `m-${posts}`,
            name: body.name,
            state: "started",
            private_ip: "fdaa::3",
            config: body.config,
            madeAt: Date.now(),
          });
          return hang(init);
        }
        if (method === "DELETE") {
          const id = url.pathname.split("/").pop();
          const at = held.findIndex((m) => m.id === id);
          if (at >= 0) held.splice(at, 1);
          return new Response("", { status: 200 });
        }
        const runId = url.searchParams.get("metadata.skrun_run_id");
        const listed = held.filter(
          (m) => m.config?.metadata?.skrun_run_id === runId && Date.now() - m.madeAt >= 7_000,
        );
        return new Response(JSON.stringify(listed), { status: 200 });
      }) as typeof fetch;
      const api = new FlyMachinesApi("token", "app", { fetchImpl, logger: quiet });
      const { adapter, line, cleanups } = cleanedAdapter(api, { acquisitionBudgetMs: 5_500 });
      const run = drive(adapter);

      await vi.advanceTimersByTimeAsync(5_500);
      await flush();
      expect(run.ended()).toBe(true);
      expect(sent.filter((s) => s.method === "POST").map((s) => s.at)).toEqual([0, 5_000]);
      await vi.advanceTimersByTimeAsync(15_000);
      await cleanups[0];

      // The client's five reads (1-5 s), then the clean-up's: from 6.5 s, until
      // one leaves at 15 s or after — the one at 12.5 s finds the machine.
      expect(sent.filter((s) => s.method === "GET").map((s) => s.at)).toEqual([
        1_000, 2_000, 3_000, 4_000, 5_000, 6_500, 7_500, 8_500, 9_500, 10_500, 11_500, 12_500,
        13_500, 14_500, 15_500,
      ]);
      expect(held).toEqual([]);
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 1, destroyed: 1 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a creation abandoned before its request left looks for nothing: one line, no read", async () => {
      const fly = creatingPlatform();
      // Three creations take the platform's burst: the run's waits a second for its slot.
      await Promise.all(
        ["a", "b", "c"].map((id) =>
          fly.api.create({ name: `skrun-run-${id}`, config: { image: "img" } }),
        ),
      );
      const { adapter, line, cleanups } = cleanedAdapter(fly.api, { acquisitionBudgetMs: 500 });
      const run = drive(adapter);

      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(run.ended()).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(fly.sent.filter((s) => s.method === "POST")).toHaveLength(3);
      expect(fly.at("GET")).toEqual([]);
      expect(cleanups).toEqual([]);
      expect(line("abandoned_create_cleanup")).toEqual({
        event: "abandoned_create_cleanup",
        run_id: "test-run-id",
        found: 0,
        destroyed: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a read that hangs is cut at ten seconds and never sent again: the clean-up ends within its bound", async () => {
      const fly = creatingPlatform({ read: "hang" });
      const { adapter, line, cleanups } = cleanedAdapter(fly.api, { acquisitionBudgetMs: 1_000 });
      drive(adapter);
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      let over = false;
      void cleanups[0]?.then(() => {
        over = true;
      });

      // Five reads, each cut ten seconds after it left, a second apart: the second
      // already left ten seconds after the request.
      await vi.advanceTimersByTimeAsync(55_000);
      await flush();
      expect(over).toBe(true);
      expect(fly.at("GET")).toEqual([2_000, 13_000, 24_000, 35_000, 46_000]);
      expect(fly.sent.filter((s) => s.method === "GET").every((s) => s.signal?.aborted)).toBe(true);
      expect(line("abandoned_create_read_cut")).toMatchObject({ run_id: "test-run-id" });
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 0, destroyed: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a read the platform refuses ends the clean-up on a line of its own, never an unhandled rejection", async () => {
      const fly = creatingPlatform({ read: 400 });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // No one is handed the clean-up: it must not need anyone to catch it.
        const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, {
          acquisitionBudgetMs: 1_000,
        });
        drive(adapter);
        await vi.advanceTimersByTimeAsync(3_000);
        await flush();

        expect(fly.at("GET")).toEqual([2_000]);
        expect(unhandled).toEqual([]);
        expect(line("abandoned_create_cleanup_failed")).toMatchObject({
          event: "abandoned_create_cleanup_failed",
          run_id: "test-run-id",
          error_name: "MachineSpawnError",
        });
        expect(JSON.stringify(line("abandoned_create_cleanup_failed"))).not.toContain("refused");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("a creation dated on a clock ahead of the adapter's is read fifteen times at most: the search ends whatever the clock says", async () => {
      const reads: number[] = [];
      const origin = Date.now();
      const flyApi = {
        listByLabel: async () => {
          reads.push(Date.now() - origin);
          return [];
        },
      } as unknown as FlyMachinesApi;
      const { adapter, line } = adapterOn(flyApi, runner().fetchImpl);

      // Its last request dated an hour ahead: no read ever leaves ten seconds after it.
      let over = false;
      void (
        adapter as unknown as {
          cleanUpAbandonedCreation(runId: string, lastSentAt: number): Promise<void> | undefined;
        }
      )
        .cleanUpAbandonedCreation("test-run-id", origin + 3_600_000)
        ?.then(() => {
          over = true;
        });
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();

      // Five reads at least, and ten more — one for each of the ten seconds the
      // search reads past a creation's last request —: fifteen, a second apart.
      expect(over).toBe(true);
      expect(reads).toHaveLength(15);
      expect(reads.at(-1)).toBe(15_000);
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 0, destroyed: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["refused", "refuse"],
      ["cut at its bound", "hang"],
    ] as const)("a machine it finds whose destruction is %s is counted among the pool's failed destructions", async (_what, how) => {
      const found = { id: "m-found", name: RUN_MACHINE, state: "started" } as Machine;
      const flyApi = {
        listByLabel: async () => [found],
        destroy: (_id: string, options?: { signal?: AbortSignal }) =>
          how === "refuse"
            ? Promise.reject(new Error("platform refused"))
            : new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                  once: true,
                });
              }),
      } as unknown as FlyMachinesApi;
      const pool = new RunnerPool(flyApi, { size: 0, imageTag: "registry.example/runner:v1" });
      const { adapter, line } = adapterOn(flyApi, runner().fetchImpl, { pool });

      const cleanup = (
        adapter as unknown as {
          cleanUpAbandonedCreation(runId: string, lastSentAt: number): Promise<void> | undefined;
        }
      ).cleanUpAbandonedCreation("test-run-id", Date.now());
      await vi.advanceTimersByTimeAsync(60_000);
      await cleanup;

      expect(pool.stats().destroyFailures).toBe(1);
      expect(
        line(how === "refuse" ? "machine_destroy_failed" : "abandoned_create_destroy_cut"),
      ).toMatchObject({ machine_id: "m-found" });
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 1, destroyed: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a creation whose consumer closes the run on a heartbeat is cut at once, then found by its label in the background and destroyed", async () => {
      const fly = creatingPlatform({ listedFrom: 1_500 });
      const { adapter, line, cleanups } = cleanedAdapter(fly.api, { heartbeatIntervalMs: 1_000 });
      const run = adapter.executeStream(createRunRequest());
      expect((await run.next()).value).toMatchObject({ type: "run_start" });
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await beat).value).toMatchObject({
        type: "run_heartbeat",
        stage: "acquiring_runner",
      });

      await run.return(undefined);
      await flush();

      // The creation in flight was cut by the close, not left to the budget.
      expect(fly.sent[0]?.signal?.aborted).toBe(true);
      expect(cleanups).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(12_000);
      await cleanups[0];
      expect(fly.at("DELETE")).toHaveLength(1);
      expect(fly.held).toEqual([]);
      expect(line("abandoned_create_cleanup")).toMatchObject({ found: 1, destroyed: 1 });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // A consumer may close the run's stream — return() on its generator — at any
  // event it reads before the loop: a heartbeat of the acquisition, or
  // runner_spawned. And a step between the acquisition and the loop may throw.
  // Whichever way the run ends there, no machine is left behind: one already in
  // the run's hands is destroyed by the stream's end, one still being acquired
  // is let go — the acquisition cut at once — and destroyed in the background.
  describe("a run that ends before its loop leaves no machine behind", () => {
    const HEARTBEAT_MS = 1_000;

    /** A gate: a promise, and the function that opens it. */
    function gate(): { opened: Promise<void>; open: () => void } {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    }

    it("closed on a heartbeat while /init is awaited: the acquisition is cut at once, and its machine destroyed in the background", async () => {
      const fly = platform();
      const calls = runner({ init: "hang" });
      const cleanups: Array<Promise<void>> = [];
      const { adapter, line } = adapterOn(fly.api, calls.fetchImpl, {
        heartbeatIntervalMs: HEARTBEAT_MS,
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      });
      const run = adapter.executeStream(createRunRequest());
      expect((await run.next()).value).toMatchObject({ type: "run_start" });
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await beat).value).toMatchObject({
        type: "run_heartbeat",
        stage: "acquiring_runner",
      });
      expect(calls.signals["/init"]).toHaveLength(1);

      await run.return(undefined);
      await flush();

      expect(calls.signals["/init"]?.[0]?.aborted).toBe(true);
      expect(cleanups).toHaveLength(1);
      await cleanups[0];
      expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
      expect(line("machine_destroy")).toMatchObject({
        machine_id: "m-cold",
        reason: "consumer_closed",
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("closed on a heartbeat once its pooled machine is ready, before it pulled again: the machine leaves the pool's inventory, then is destroyed in the background", async () => {
      const fly = platform();
      const pool = poolOfThree(fly.api);
      const initAnswered = gate();
      const runnerFetch = (async (input: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(input)).pathname;
        if (path === "/healthz") return new Response("{}", { status: 200 });
        if (path === "/claim") return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (path === "/init") {
          await initAnswered.opened;
          return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const heldWhenDestroyed: unknown[] = [];
      vi.spyOn(fly.api, "destroy").mockImplementation(async (id: string) => {
        heldWhenDestroyed.push(pool.get(id) ?? null);
      });
      const cleanups: Array<Promise<void>> = [];
      const { adapter } = adapterOn(fly.api, runnerFetch, {
        pool,
        heartbeatIntervalMs: HEARTBEAT_MS,
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      });
      const run = adapter.executeStream(createRunRequest());
      await run.next();
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await beat).value).toMatchObject({ type: "run_heartbeat" });
      // The machine answers its /init while the consumer holds the heartbeat.
      initAnswered.open();
      await flush();
      expect(pool.stats()).toMatchObject({ claimed: 1, hits: 1 });

      await run.return(undefined);
      await flush();
      await Promise.all(cleanups);

      expect(vi.mocked(fly.api.destroy).mock.calls.map(([id]) => id)).toEqual(["pooled-1"]);
      expect(heldWhenDestroyed).toEqual([null]);
      expect(pool.stats()).toMatchObject({ ready: 2, claimed: 0, draining: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    // A consumer may throw into the stream — throw() on its generator — instead
    // of closing it. Its error is not the acquisition's: the run ends as one its
    // consumer closed, and the error goes back to that consumer.
    it("thrown into on a heartbeat while /init is awaited: the consumer's error comes back, no run_error, the acquisition cut at once, its machine destroyed in the background", async () => {
      const fly = platform();
      const calls = runner({ init: "hang" });
      const cleanups: Array<Promise<void>> = [];
      const spawnFailed: unknown[] = [];
      const { adapter, line } = adapterOn(fly.api, calls.fetchImpl, {
        heartbeatIntervalMs: HEARTBEAT_MS,
        onSpawnFailed: (failure) => {
          spawnFailed.push(failure);
        },
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      });
      const run = adapter.executeStream(createRunRequest());
      expect((await run.next()).value).toMatchObject({ type: "run_start" });
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await beat).value).toMatchObject({
        type: "run_heartbeat",
        stage: "acquiring_runner",
      });
      expect(calls.signals["/init"]).toHaveLength(1);

      const consumerError = new Error("the consumer gave up");
      const after = await run.throw(consumerError).then(
        (result) => result,
        (err: unknown) => err,
      );
      await flush();

      expect(after).toBe(consumerError);
      expect(calls.signals["/init"]?.[0]?.aborted).toBe(true);
      expect(spawnFailed).toEqual([]);
      expect(line("spawn_failed")).toBeUndefined();
      expect(cleanups).toHaveLength(1);
      await cleanups[0];
      expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
      expect(line("machine_destroy")).toMatchObject({
        machine_id: "m-cold",
        reason: "consumer_closed",
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("thrown into on a heartbeat once its pooled machine is ready: the consumer's error comes back, and the machine leaves the pool's inventory, then is destroyed in the background", async () => {
      const fly = platform();
      const pool = poolOfThree(fly.api);
      const initAnswered = gate();
      const runnerFetch = (async (input: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(input)).pathname;
        if (path === "/healthz") return new Response("{}", { status: 200 });
        if (path === "/claim") return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (path === "/init") {
          await initAnswered.opened;
          return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const destroyed: string[] = [];
      vi.spyOn(fly.api, "destroy").mockImplementation(async (id: string) => {
        destroyed.push(id);
      });
      const cleanups: Array<Promise<void>> = [];
      const { adapter, line } = adapterOn(fly.api, runnerFetch, {
        pool,
        heartbeatIntervalMs: HEARTBEAT_MS,
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      });
      const run = adapter.executeStream(createRunRequest());
      await run.next();
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await beat).value).toMatchObject({ type: "run_heartbeat" });
      // The machine answers its /init while the consumer holds the heartbeat.
      initAnswered.open();
      await flush();
      expect(pool.stats()).toMatchObject({ claimed: 1, hits: 1 });

      const consumerError = new Error("the consumer gave up");
      const after = await run.throw(consumerError).then(
        (result) => result,
        (err: unknown) => err,
      );
      await flush();
      await Promise.all(cleanups);

      expect(after).toBe(consumerError);
      expect(line("spawn_failed")).toBeUndefined();
      expect(destroyed).toEqual(["pooled-1"]);
      expect(pool.stats()).toMatchObject({ ready: 2, claimed: 0, draining: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("thrown into on a heartbeat after its acquisition failed: the consumer's error comes back, not the acquisition's, and the machine it made is destroyed in the background", async () => {
      const fly = platform();
      const initRefused = gate();
      const runnerFetch = (async (input: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(input)).pathname;
        if (path === "/healthz") return new Response("{}", { status: 200 });
        if (path === "/init") {
          await initRefused.opened;
          return new Response("refused", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const cleanups: Array<Promise<void>> = [];
      const { adapter, line } = adapterOn(fly.api, runnerFetch, {
        heartbeatIntervalMs: HEARTBEAT_MS,
        onBackgroundCleanup: (cleanup) => {
          cleanups.push(cleanup);
        },
      });
      const run = adapter.executeStream(createRunRequest());
      await run.next();
      const beat = run.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await beat).value).toMatchObject({ type: "run_heartbeat" });
      // The runner refuses its /init while the consumer holds the heartbeat.
      initRefused.open();
      await flush();

      const consumerError = new Error("the consumer gave up");
      const after = await run.throw(consumerError).then(
        (result) => result,
        (err: unknown) => err,
      );
      await flush();
      await Promise.all(cleanups);

      expect(after).toBe(consumerError);
      expect(line("spawn_failed")).toBeUndefined();
      expect(line("acquisition_closed")).toMatchObject({ ready: false, phase: "init-rpc" });
      expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
      expect(line("machine_destroy")).toMatchObject({
        machine_id: "m-cold",
        reason: "consumer_closed",
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("closed at runner_spawned: its machine destroyed once, by the stream's end", async () => {
      const fly = platform();
      const { adapter, line } = adapterOn(fly.api, runner().fetchImpl);
      const run = adapter.executeStream(createRunRequest());
      await run.next();
      const spawned = run.next();
      await flush();
      expect((await spawned).value).toMatchObject({ type: "runner_spawned" });

      await run.return(undefined);

      expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
      expect(line("machine_destroy")).toMatchObject({
        machine_id: "m-cold",
        reason: "consumer_closed",
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["a tool provider that will not register", "provider"],
      ["a telemetry sink that throws", "telemetry"],
    ] as const)("%s after runner_spawned: the stream throws it, and its machine is destroyed once", async (_what, thrower) => {
      const boom = new Error("witness-thrown-before-the-loop");
      const addProvider = vi.spyOn(ToolRegistry.prototype, "addProvider");
      if (thrower === "provider") addProvider.mockRejectedValueOnce(boom);
      try {
        const fly = platform();
        const { adapter, line } = adapterOn(fly.api, runner().fetchImpl, {
          ...(thrower === "telemetry" && {
            onRunnerSpawned: () => {
              throw boom;
            },
          }),
        });
        const events: RunEvent[] = [];
        const ended = (async () => {
          for await (const event of adapter.executeStream(createRunRequest())) events.push(event);
        })().then(
          () => "ended",
          (err: unknown) => err,
        );
        await flush();

        expect(await ended).toBe(boom);
        expect(events.map((event) => event.type)).toEqual(["run_start", "runner_spawned"]);
        expect(fly.of("DELETE", "/m-cold")).toHaveLength(1);
        expect(line("machine_destroy")).toMatchObject({
          machine_id: "m-cold",
          reason: "run_failed",
        });
      } finally {
        addProvider.mockRestore();
      }
    });
  });
});

describe("FlyioAdapter — a run keeps at most 8 MiB of tool results", () => {
  const MIB = 1024 * 1024;
  const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");

  const bigTool: ToolDefinition = {
    name: "big",
    description: "answers 1 MiB",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  };

  /** A runner whose script tool answers 1 MiB, cut to its answer as the runner cuts it. */
  function runnerAnsweringBig(): typeof fetch {
    return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/init")) {
        return new Response(JSON.stringify({ ok: true, tools: [bigTool] }), { status: 200 });
      }
      if (url.endsWith("/tool")) {
        const answer = truncateToolResult({ content: "f".repeat(MIB), isError: false });
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      if (url.endsWith("/outputs/collect")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("a model that asks for 1 MiB results at every turn: past 8 MiB each result is replaced by the marker, and the run completes", async () => {
    const histories: HistoryEntry[][] = [];
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
        histories.push(request.history ?? []);
        const turn = histories.length;
        if (turn > 4) {
          return {
            content: '{"result":"done"}',
            assistantTurn: { provider: "mock", content: { answers: true } },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          content: "",
          toolCalls: [0, 1, 2].map((i) => ({ name: "big", args: {}, id: `call-${turn}-${i}` })),
          assistantTurn: { provider: "mock", content: { asks: turn } },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const { api } = createMockFlyApi("m-tool-results");
    const adapter = new FlyioAdapter(
      api,
      createMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      {
        fetchImpl: runnerAnsweringBig(),
      },
    );
    const request = createRunRequest();
    request.agentConfig.tools = [
      { name: "big", description: bigTool.description, input_schema: bigTool.parameters },
    ];

    const events = await collectEvents(adapter.executeStream(request));

    const results = events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []));
    expect(results).toHaveLength(12);
    // The runner's cut passes unchanged: eight of its answers fit the run's bound.
    const kept = results.slice(0, 8);
    const runnerCut = truncateToolResult({ content: "f".repeat(MIB), isError: false }).content;
    expect(kept).toEqual(Array(8).fill(runnerCut));
    expect(runnerCut.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(bytesOf(runnerCut)).toBeLessThan(TOOL_RESPONSE_MAX_BYTES);
    expect(results.slice(8)).toEqual(Array(4).fill(TOOL_RESULT_NOT_KEPT_MARKER));
    // What the model read last: the same twelve, the results kept within the bound.
    const last = (histories.at(-1) ?? []).flatMap((entry) =>
      entry.kind === "tool_results" ? entry.results.map((r) => r.result) : [],
    );
    expect(last).toEqual(results);
    expect(kept.reduce((sum, r) => sum + bytesOf(r), 0)).toBeLessThanOrEqual(
      RUN_TOOL_RESULTS_MAX_BYTES,
    );
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "done" } });
  });
});
