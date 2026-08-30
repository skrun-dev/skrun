/**
 * E2E: adapter parity (#15 VT-1 + VT-14).
 *
 * Given the same deterministic agent + input, LocalAdapter and FlyioAdapter
 * must produce equivalent `run_complete.output`. This is the structural
 * guarantee SC-1 names: a self-host operator switching to cloud should
 * see byte-equivalent agent behaviour (modulo timestamps, machine ids,
 * presigned URL hosts — every other field stable).
 *
 * Both adapters delegate to the shared `runAgentLoop` helper, so the
 * common path is exercised; the test guards against future drift if
 * either adapter starts pre/post-processing the loop output differently.
 *
 * Live-cloud parity (real Fly.io + R2 round-trip) is covered separately
 * by Phase 10.1 cloud E2E — gated on FLY_API_TOKEN.
 */
import { describe, expect, it, vi } from "vitest";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";
import {
  FlyioAdapter,
  type PresignedStorageAdapter,
} from "../../packages/runtime/src/adapter/flyio/index.js";
import { LocalAdapter } from "../../packages/runtime/src/adapter/local.js";
import { LLMRouter } from "../../packages/runtime/src/llm/router.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import type { RunCompleteEvent, RunEvent, RunRequest } from "../../packages/runtime/src/types.js";

const DETERMINISTIC_OUTPUT = '{"result":"42","reason":"deterministic-test"}';

function makeRunRequest(runId: string, overrides?: Partial<RunRequest>): RunRequest {
  return {
    agentConfig: {
      name: "parity-agent",
      description: "Adapter parity test agent",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-3-5-sonnet" },
      inputs: [],
      outputs: [
        { name: "result", type: "string", description: "result" },
        { name: "reason", type: "string", description: "reason" },
      ],
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
    skillContent: "You are a deterministic parity test agent.",
    input: { question: "what is the meaning of life?" },
    runId,
    agent_version: "1.0.0",
    bundleKey: "dev/parity-agent/1.0.0.agent",
    ...overrides,
  };
}

function mockRouter(): LLMRouter {
  const router = new LLMRouter();
  vi.spyOn(router, "call").mockResolvedValue({
    content: DETERMINISTIC_OUTPUT,
    usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    estimatedCost: 0.005,
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    durationMs: 250,
  });
  return router;
}

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Build a FlyioAdapter with every external dependency mocked so the agent
 * loop runs end-to-end without touching real Fly.io / R2 / network.
 */
function makeMockedFlyioAdapter(router: LLMRouter): FlyioAdapter {
  const flyApi = {
    create: vi.fn().mockImplementation(
      (req): Promise<Machine> =>
        Promise.resolve({
          id: "m-parity",
          name: req.name ?? "skrun-run-parity",
          state: "started",
          private_ip: "fdaa::1",
        } as Machine),
    ),
    destroy: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(),
  } as unknown as FlyMachinesApi;

  const storage: PresignedStorageAdapter = {
    put: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.example/get?sig=xyz"),
    getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put?sig=xyz"),
  };

  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
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

  return new FlyioAdapter(flyApi, storage, router, new ToolRegistry(), undefined, {
    fetchImpl,
  });
}

/** Strip volatile fields so two `run_complete` events can be compared. */
function normalizeRunComplete(e: RunCompleteEvent): Omit<
  RunCompleteEvent,
  "timestamp" | "duration_ms"
> & {
  duration_ms: "<normalized>";
} {
  return {
    type: e.type,
    run_id: e.run_id,
    timestamp: "<normalized>" as unknown as never,
    output: e.output,
    usage: e.usage,
    cost: e.cost,
    duration_ms: "<normalized>",
    files: e.files,
  };
}

describe("VT-1 / VT-14: LocalAdapter and FlyioAdapter produce parity outputs", () => {
  it("both adapters yield run_complete with the same `output` for a deterministic agent", async () => {
    // LocalAdapter run.
    const localRouter = mockRouter();
    const local = new LocalAdapter(localRouter, new ToolRegistry());
    const localEvents = await collect(local.executeStream(makeRunRequest("run-local")));
    const localComplete = localEvents.find((e) => e.type === "run_complete") as
      | RunCompleteEvent
      | undefined;
    expect(localComplete).toBeDefined();

    // FlyioAdapter run (fully mocked external deps).
    const cloudRouter = mockRouter();
    const cloud = makeMockedFlyioAdapter(cloudRouter);
    const cloudEvents = await collect(cloud.executeStream(makeRunRequest("run-cloud")));
    const cloudComplete = cloudEvents.find((e) => e.type === "run_complete") as
      | RunCompleteEvent
      | undefined;
    expect(cloudComplete).toBeDefined();

    // Parity on the structural output — what the agent actually returned.
    expect(cloudComplete?.output).toEqual(localComplete?.output);
    expect(cloudComplete?.output).toEqual({
      result: "42",
      reason: "deterministic-test",
    });
  });

  it("both adapters yield equivalent usage / cost numbers (same provider response)", async () => {
    const local = new LocalAdapter(mockRouter(), new ToolRegistry());
    const cloud = makeMockedFlyioAdapter(mockRouter());

    const [localEvents, cloudEvents] = await Promise.all([
      collect(local.executeStream(makeRunRequest("run-local"))),
      collect(cloud.executeStream(makeRunRequest("run-cloud"))),
    ]);

    const localComplete = localEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;
    const cloudComplete = cloudEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;

    expect(cloudComplete.usage).toEqual(localComplete.usage);
    expect(cloudComplete.cost).toEqual(localComplete.cost);
  });

  it("both adapters yield run_start as the first event with the same agent + version", async () => {
    const local = new LocalAdapter(mockRouter(), new ToolRegistry());
    const cloud = makeMockedFlyioAdapter(mockRouter());

    const [localEvents, cloudEvents] = await Promise.all([
      collect(local.executeStream(makeRunRequest("run-local"))),
      collect(cloud.executeStream(makeRunRequest("run-cloud"))),
    ]);

    expect(localEvents[0]?.type).toBe("run_start");
    expect(cloudEvents[0]?.type).toBe("run_start");
    if (localEvents[0]?.type === "run_start" && cloudEvents[0]?.type === "run_start") {
      expect(cloudEvents[0].agent).toBe(localEvents[0].agent);
      expect(cloudEvents[0].agent_version).toBe(localEvents[0].agent_version);
    }
  });

  it("both adapters yield exactly one llm_complete event with matching provider + model", async () => {
    const local = new LocalAdapter(mockRouter(), new ToolRegistry());
    const cloud = makeMockedFlyioAdapter(mockRouter());

    const [localEvents, cloudEvents] = await Promise.all([
      collect(local.executeStream(makeRunRequest("run-local"))),
      collect(cloud.executeStream(makeRunRequest("run-cloud"))),
    ]);

    const localLlm = localEvents.filter((e) => e.type === "llm_complete");
    const cloudLlm = cloudEvents.filter((e) => e.type === "llm_complete");
    expect(localLlm).toHaveLength(1);
    expect(cloudLlm).toHaveLength(1);
    if (localLlm[0]?.type === "llm_complete" && cloudLlm[0]?.type === "llm_complete") {
      expect(cloudLlm[0].provider).toBe(localLlm[0].provider);
      expect(cloudLlm[0].model).toBe(localLlm[0].model);
      expect(cloudLlm[0].tokens).toBe(localLlm[0].tokens);
    }
  });

  it("normalized run_complete payloads match across adapters (modulo run_id, timestamp, duration)", async () => {
    const local = new LocalAdapter(mockRouter(), new ToolRegistry());
    const cloud = makeMockedFlyioAdapter(mockRouter());

    const [localEvents, cloudEvents] = await Promise.all([
      collect(local.executeStream(makeRunRequest("run-X"))),
      collect(cloud.executeStream(makeRunRequest("run-X"))),
    ]);

    const localComplete = localEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;
    const cloudComplete = cloudEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;

    expect(normalizeRunComplete(cloudComplete)).toEqual(normalizeRunComplete(localComplete));
  });

  it("cloud-mode parity holds even when the cloud adapter has no outputs to upload", async () => {
    // Defensive: with files: [], the FlyioAdapter still calls
    // /outputs/collect and the runAgentLoop yields the run_complete via
    // the file-augmentation path. Asserting both adapters land at the
    // same empty files state.
    const local = new LocalAdapter(mockRouter(), new ToolRegistry());
    const cloud = makeMockedFlyioAdapter(mockRouter());

    const [localEvents, cloudEvents] = await Promise.all([
      collect(local.executeStream(makeRunRequest("run-L"))),
      collect(cloud.executeStream(makeRunRequest("run-C"))),
    ]);

    const localComplete = localEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;
    const cloudComplete = cloudEvents.find((e) => e.type === "run_complete") as RunCompleteEvent;

    expect(localComplete.files).toEqual([]);
    expect(cloudComplete.files).toEqual([]);
  });
});
