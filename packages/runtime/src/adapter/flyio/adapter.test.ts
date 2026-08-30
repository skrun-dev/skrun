import { describe, expect, it, vi } from "vitest";
import { MachineSpawnError } from "../../errors.js";
import type { LLMProvider } from "../../llm/providers/types.js";
import { LLMRouter } from "../../llm/router.js";
import type { Logger } from "../../logger.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { RunEvent, RunnerSpawnedInfo, RunRequest } from "../../types.js";
import { FlyioAdapter, type PresignedStorageAdapter } from "./adapter.js";
import type { FlyMachinesApi, Machine } from "./fly-api.js";
import { RunnerPool } from "./pool.js";

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
        filesystem: "read-only",
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
        sandbox: "strict",
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
  it("VT-7: throws an actionable error that points to streaming, without internal jargon", async () => {
    const { api } = createMockFlyApi("m-oneshot");
    const adapter = new FlyioAdapter(api, createMockStorage(), new LLMRouter(), new ToolRegistry());
    const err = (await adapter.execute(createRunRequest()).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/stream/i);
    expect(err.message).not.toMatch(/skeleton/i);
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

    // SEC-2026-002: the per-run RPC token is injected into the machine env AND
    // sent as a Bearer on the /init RPC (C-3 — initRunner's own fetch path).
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

  it("rejects immediately + still destroys when caller fires abort BEFORE iteration starts", async () => {
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

    // Spawn still runs (run_start emits then spawn races abort). The
    // machine was created → must be destroyed.
    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledWith("m-abort-pre");

    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.code).toBe("ABORTED");
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

function createOkProvider(): LLMProvider {
  return {
    name: "mock",
    call: vi.fn(async () => ({
      content: '{"result":"ok"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    })),
  };
}

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

  it("VT-1: emits runner_spawned (durations only) right after run_start", async () => {
    const adapter = makeAdapter(fetchReturningInit(initWithPhases));
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    expect(events.map((e) => e.type).indexOf("runner_spawned")).toBe(1); // after run_start
    const spawned = events[1];
    if (spawned.type === "runner_spawned") {
      expect(typeof spawned.phases.create_api_ms).toBe("number");
      // Durations only — no operator-internal fields on the wire event.
      expect(Object.keys(spawned)).not.toContain("machineId");
      expect(Object.keys(spawned)).not.toContain("private_ip");
    }
  });

  it("VT-2: derives host_schedule_pull + surfaces vm_boot; callback carries machine/IP", async () => {
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

  it("RT-4: degrades (no throw) when the runner omits phases/boot (older image)", async () => {
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

  it("RT-3: the spawn flow (create -> healthz -> init -> run) is unchanged by the timing", async () => {
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

// ---------------------------------------------------------------------------
// Pre-warm pool acquisition
// ---------------------------------------------------------------------------

/** A pool holding one ready machine, with the platform calls it needs spied. */
function poolHarness(
  over: {
    stale?: boolean;
    startFails?: boolean;
    claimStatus?: number;
    /** Process the machine identified itself as when it was built. `null` = an image too old to say. */
    filledProcessId?: string | null;
    /** Process it reports when assigned. Same value = a genuine wake; different = it cold-booted. */
    claimProcessId?: string | null;
    /** How long the pool has known the machine when the run arrives. */
    knownForMs?: number;
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
      if (over.startFails) throw new Error("could not wake");
    }),
    suspend: vi.fn(async () => {}),
    stop: vi.fn(),
    destroy: vi.fn(async (id: string) => {
      calls.push(`destroy:${id}`);
    }),
    list: vi.fn(),
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
  clock += over.knownForMs ?? 600_000;

  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/healthz")) return new Response("{}", { status: 200 });
    if (url.endsWith("/claim")) {
      calls.push("claim");
      const body =
        over.claimProcessId === null
          ? { ok: true }
          : { ok: true, process_id: over.claimProcessId ?? "proc-paused" };
      return new Response(JSON.stringify(body), { status: over.claimStatus ?? 200 });
    }
    if (url.endsWith("/init")) {
      calls.push("init");
      return new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 });
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

function makeAdapter(flyApi: FlyMachinesApi, fetchImpl: typeof fetch, pool?: RunnerPool) {
  return new ExposedAdapter(
    flyApi,
    createMockStorage(),
    new LLMRouter({}),
    new ToolRegistry(),
    undefined,
    { fetchImpl, pool, runtimeImage: "registry.example/runner:v1" },
  );
}

describe("FlyioAdapter — acquiring a runner from the pool", () => {
  it("wakes a pooled machine and assigns it, without creating one", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());

    expect(spawn.machineId).toBe("pooled-1");
    expect(calls).toEqual(["start:pooled-1", "claim", "init"]);
    expect(calls).not.toContain("create");
    expect(spawn.phases.pool_hit).toBe(true);
  });

  // On a resumed machine these describe when the POOL was filled, not this run.
  it("omits the fill-time phases on a pool-served run", async () => {
    const { flyApi, pool, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(spawn.phases.vm_boot_ms).toBeUndefined();
    expect(spawn.phases.host_schedule_pull_ms).toBeUndefined();
    expect(spawn.phases.module_load_ms).toBeUndefined();
  });

  // VT-9: pool configured but empty -> straight to the create-per-run path.
  it("falls back to creating a machine when the pool is empty", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness();
    pool.takeReady(); // drain it
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(spawn.phases.pool_hit).toBeUndefined();
  });

  // VT-9b: the pool is NOT empty, but its machine will not wake. Distinct from a
  // miss: without this the cold path would silently absorb a fully broken pool.
  it("discards a machine that will not wake, then falls back", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ startFails: true });
    const spawn = await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("create");
    expect(spawn.machineId).toBe("cold-machine");
    expect(pool.get("pooled-1")).toBeUndefined();
  });

  // A refused assignment means someone else already took it, or its rules could
  // not be confirmed. Either way the machine is spent — never retried.
  it("discards a machine that refuses the assignment", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ claimStatus: 409 });
    await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).toContain("create");
  });

  // Checked at the moment of use, not only in the background: a machine built
  // from a superseded image would quietly run superseded code.
  it("discards a stale machine rather than serving from it", async () => {
    const { flyApi, pool, calls, fetchImpl } = poolHarness({ stale: true });
    await makeAdapter(flyApi, fetchImpl, pool).acquire(createRunRequest());
    expect(calls).toContain("destroy:pooled-1");
    expect(calls).not.toContain("claim");
    expect(calls).toContain("create");
  });

  // RT-1: with no pool, nothing about the existing path changes.
  it("takes the create-per-run path unchanged when no pool is configured", async () => {
    const { flyApi, calls, fetchImpl } = poolHarness();
    const spawn = await makeAdapter(flyApi, fetchImpl, undefined).acquire(createRunRequest());
    expect(calls).toEqual(["create", "init"]);
    expect(spawn.phases.pool_hit).toBeUndefined();
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
