/**
 * E2E: Fly.io sandbox machine lifecycle (#15 VT-13 + VT-21).
 *
 * VT-13 (no-leak): 100 sequential FlyioAdapter runs against a mocked
 * FlyMachinesApi → every machine ever created MUST also be destroyed.
 * Asserted via mock state: createCount === destroyCount, no live
 * machineIds remaining at the end.
 *
 * VT-21 (parallel isolation): 5 concurrent runs each get a DISTINCT
 * machineId; all 5 destroy calls fire. Catches accidental machine reuse
 * (e.g. caching the FlyioAdapter ctor between requests with mutable
 * spawn state) + classic concurrency bugs (e.g. shared machineId
 * variable closed-over by a Promise.all loop).
 *
 * Both VTs use mocked FlyMachinesApi. Real Fly.io no-leak validation
 * lands in 10.1 cloud E2E.
 */
import { describe, expect, it, vi } from "vitest";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";
import {
  FlyioAdapter,
  type PresignedStorageAdapter,
} from "../../packages/runtime/src/adapter/flyio/index.js";
import { LLMRouter } from "../../packages/runtime/src/llm/router.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import type { RunEvent, RunRequest } from "../../packages/runtime/src/types.js";

function makeRunRequest(runId: string): RunRequest {
  return {
    agentConfig: {
      name: "lifecycle-agent",
      description: "Lifecycle test agent",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-3-5-sonnet" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [],
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: ["api.anthropic.com"] },
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
    skillContent: "lifecycle test",
    input: { i: 0 },
    runId,
    bundleKey: "dev/lifecycle-agent/1.0.0.agent",
  };
}

/**
 * Mock Fly tracks every machine that's ever been created + every destroy
 * call. Exposes a `liveMachines()` snapshot for end-of-test assertions.
 */
function makeMockFly(): {
  api: FlyMachinesApi;
  liveMachines: () => string[];
  createdCount: () => number;
  destroyedCount: () => number;
  createdIds: () => string[];
} {
  const created = new Set<string>();
  const createdOrder: string[] = [];
  const destroyed = new Set<string>();
  let nextId = 1;

  const api = {
    create: vi.fn().mockImplementation(async (req: { name?: string }) => {
      const id = `m-${nextId++}`;
      created.add(id);
      createdOrder.push(id);
      const m: Machine = {
        id,
        name: req.name ?? `skrun-run-${id}`,
        state: "started",
        private_ip: "fdaa::1",
      } as Machine;
      return m;
    }),
    destroy: vi.fn().mockImplementation(async (machineId: string) => {
      destroyed.add(machineId);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(),
  } as unknown as FlyMachinesApi;

  return {
    api,
    liveMachines: () => [...created].filter((id) => !destroyed.has(id)),
    createdCount: () => created.size,
    destroyedCount: () => destroyed.size,
    createdIds: () => [...createdOrder],
  };
}

function makeMockStorage(): PresignedStorageAdapter {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.example/get"),
    getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
  };
}

function makeMockFetch(): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

function makeMockRouter(): LLMRouter {
  const router = new LLMRouter();
  vi.spyOn(router, "call").mockResolvedValue({
    content: '{"result":"ok"}',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    estimatedCost: 0,
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    durationMs: 1,
  });
  return router;
}

async function drain(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("VT-13: 100 sequential runs leave 0 machines alive", () => {
  it("createCount === destroyCount + no live machines remaining (no-leak)", async () => {
    const fly = makeMockFly();
    const adapter = new FlyioAdapter(
      fly.api,
      makeMockStorage(),
      makeMockRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl: makeMockFetch() },
    );

    const RUN_COUNT = 100;
    for (let i = 0; i < RUN_COUNT; i++) {
      await drain(adapter.executeStream(makeRunRequest(`run-seq-${i}`)));
    }

    expect(fly.createdCount()).toBe(RUN_COUNT);
    expect(fly.destroyedCount()).toBe(RUN_COUNT);
    expect(fly.liveMachines()).toEqual([]);

    // Each run got a distinct machineId (no recycling).
    const ids = fly.createdIds();
    expect(new Set(ids).size).toBe(RUN_COUNT);
  });

  it("createCount === destroyCount even when a fraction of runs throw mid-loop", async () => {
    const fly = makeMockFly();
    let callCount = 0;
    // Mocked router that throws on every 10th call — simulates LLM
    // provider failures. The adapter must still destroy each spawned
    // machine in the finally block.
    const router = new LLMRouter();
    vi.spyOn(router, "call").mockImplementation(async () => {
      callCount += 1;
      if (callCount % 10 === 0) throw new Error("simulated LLM failure");
      return {
        content: '{"result":"ok"}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCost: 0,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        durationMs: 1,
      };
    });
    const adapter = new FlyioAdapter(
      fly.api,
      makeMockStorage(),
      router,
      new ToolRegistry(),
      undefined,
      { fetchImpl: makeMockFetch() },
    );

    const RUN_COUNT = 100;
    for (let i = 0; i < RUN_COUNT; i++) {
      await drain(adapter.executeStream(makeRunRequest(`run-mixed-${i}`)));
    }

    // Some runs ended with run_error, but ALL machines spawned must be
    // destroyed.
    expect(fly.createdCount()).toBe(RUN_COUNT);
    expect(fly.destroyedCount()).toBe(RUN_COUNT);
    expect(fly.liveMachines()).toEqual([]);
  });
});

describe("VT-21: parallel runs spawn distinct machines, all destroyed", () => {
  it("5 concurrent runs → 5 distinct machineIds + 5 destroys", async () => {
    const fly = makeMockFly();
    const adapter = new FlyioAdapter(
      fly.api,
      makeMockStorage(),
      makeMockRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl: makeMockFetch() },
    );

    const RUN_COUNT = 5;
    const promises = Array.from({ length: RUN_COUNT }, (_, i) =>
      drain(adapter.executeStream(makeRunRequest(`run-par-${i}`))),
    );
    await Promise.all(promises);

    expect(fly.createdCount()).toBe(RUN_COUNT);
    expect(fly.destroyedCount()).toBe(RUN_COUNT);
    expect(fly.liveMachines()).toEqual([]);

    // All 5 machineIds distinct.
    const ids = fly.createdIds();
    expect(new Set(ids).size).toBe(RUN_COUNT);
  });

  it("destroy calls match createIds exactly (no machine destroyed twice, no orphan)", async () => {
    const fly = makeMockFly();
    const adapter = new FlyioAdapter(
      fly.api,
      makeMockStorage(),
      makeMockRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl: makeMockFetch() },
    );

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => drain(adapter.executeStream(makeRunRequest(`run-${i}`)))),
    );

    // Inspect every destroy call — set of ids destroyed must equal set
    // of ids created.
    const destroyCalls = (fly.api.destroy as ReturnType<typeof vi.fn>).mock.calls;
    const destroyedIds = destroyCalls.map((args) => args[0] as string);
    expect(new Set(destroyedIds)).toEqual(new Set(fly.createdIds()));
    // No double-destroy.
    expect(destroyedIds.length).toBe(new Set(destroyedIds).size);
  });
});
