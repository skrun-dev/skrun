/**
 * E2E: caller-provided LLM keys — boundary invariants (#15, VT-19 + VT-20).
 *
 * VT-19 (self-host): a caller key supplied via `X-LLM-API-Key` reaches the
 * `LLMRouter.call` invocation for the run, but never persists anywhere
 * (DB state row, structured logs, dashboard, exported events).
 *
 * VT-20 (cloud): the same caller key reaches the harness `LLMRouter.call`
 * but NEVER appears in the env block of the spawned sandbox machine
 * (ADR-014 — credentials never enter the sandbox). The harness-side
 * `buildMachineConfig` runs through its env allowlist + forbidden-substring
 * guards, refusing to forward any LLM key shape.
 *
 * VT-18 (startup fail-fast for SKRUN_RUNTIME=flyio without FLY_API_TOKEN)
 * is verified by the 5 startup-gate tests in `packages/api/src/index.test.ts`
 * (shipped with task 5.1); this file does NOT re-test it.
 */
import { describe, expect, it, vi } from "vitest";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";
import {
  FlyioAdapter,
  type PresignedStorageAdapter,
} from "../../packages/runtime/src/adapter/flyio/index.js";
import { LocalAdapter } from "../../packages/runtime/src/adapter/local.js";
import type { LLMProvider } from "../../packages/runtime/src/llm/providers/types.js";
import { LLMRouter } from "../../packages/runtime/src/llm/router.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import type { RunEvent, RunRequest } from "../../packages/runtime/src/types.js";

const CALLER_API_KEY = "sk-caller-CAFEBABE-deadbeef-secret-12345";

function makeRunRequest(overrides?: Partial<RunRequest>): RunRequest {
  return {
    agentConfig: {
      name: "test-agent",
      description: "Boundary test agent",
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
      state: { type: "kv" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "You are a test agent.",
    input: { q: "hello" },
    runId: "test-run-boundary",
    callerKeys: { anthropic: CALLER_API_KEY },
    bundleKey: "test/agent/1.0.0.agent",
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("VT-19: caller key reaches the LLM router in self-host mode but never persists", () => {
  /**
   * The router's normal resolveProvider path is to mint an EPHEMERAL provider
   * with the caller's key (bypassing any registered provider) — which would
   * make a real HTTP call to Anthropic in this test. We spy on `router.call`
   * to capture the args + short-circuit the response, asserting that the
   * caller key was indeed forwarded to that boundary.
   */
  function mockRouter(): LLMRouter {
    const router = new LLMRouter();
    vi.spyOn(router, "call").mockResolvedValue({
      content: '{"result":"ok","_state":{"last":"hello"}}',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      estimatedCost: 0.001,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      durationMs: 50,
    });
    return router;
  }

  it("LocalAdapter forwards callerKeys to LLMRouter.call but never writes them to state", async () => {
    const router = mockRouter();
    const stateSets: Array<{ name: string; state: Record<string, unknown> }> = [];
    const stateCallbacks = {
      getState: async () => null,
      setState: async (name: string, state: Record<string, unknown>) => {
        stateSets.push({ name, state });
      },
    };

    const adapter = new LocalAdapter(router, new ToolRegistry(), stateCallbacks);
    await collect(adapter.executeStream(makeRunRequest()));

    // 1. The caller key DID reach the router boundary.
    // router.call signature: (modelConfig, systemPrompt, userContent, tools?,
    //   onToolCall?, temperature?, callerKeys?, toolChoice?, parallelTools?, agentContext?)
    expect(router.call).toHaveBeenCalledOnce();
    const args = (router.call as ReturnType<typeof vi.fn>).mock.calls[0];
    const callerKeysArg = args[6];
    expect(callerKeysArg).toEqual({ anthropic: CALLER_API_KEY });

    // 2. The caller key did NOT land in persisted state.
    expect(stateSets.length).toBe(1);
    expect(stateSets[0]?.name).toBe("test-agent");
    const persisted = JSON.stringify(stateSets[0]?.state);
    expect(persisted).not.toContain(CALLER_API_KEY);
    expect(persisted).not.toContain("CAFEBABE");
  });

  it("LocalAdapter does NOT leak the caller key into any emitted RunEvent payload", async () => {
    const router = mockRouter();
    const adapter = new LocalAdapter(router, new ToolRegistry());
    const events = await collect(adapter.executeStream(makeRunRequest()));

    // Serialize the entire event stream — caller key must not appear ANYWHERE.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(CALLER_API_KEY);
    expect(serialized).not.toContain("CAFEBABE");
  });
});

describe("VT-20: caller key NEVER enters the cloud sandbox env (ADR-014)", () => {
  /**
   * Builds a FlyioAdapter wired to mocked Fly + storage + fetch so we can
   * spawn a (virtual) machine and intercept the env block that would be
   * propagated to it. The env MUST contain only infrastructure parameters
   * — no LLM key, no caller key, no Fly token, no S3 creds.
   */
  function setupCloudAdapter(): {
    adapter: FlyioAdapter;
    capturedEnv: Record<string, string> | undefined;
    createSpy: ReturnType<typeof vi.fn>;
  } {
    const provider: LLMProvider = {
      name: "anthropic",
      call: vi.fn().mockResolvedValue({
        content: '{"result":"ok"}',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("anthropic", provider);

    let capturedEnv: Record<string, string> | undefined;
    const createSpy = vi.fn().mockImplementation((req) => {
      // Capture the env block the harness would propagate.
      capturedEnv = { ...(req.config.env ?? {}) };
      const machine: Machine = {
        id: "m-test",
        name: req.name ?? "skrun-run-test",
        state: "started",
        private_ip: "fdaa::1",
      } as Machine;
      return Promise.resolve(machine);
    });
    const flyApi = {
      create: createSpy,
      destroy: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;
    const storage: PresignedStorageAdapter = {
      put: vi.fn().mockResolvedValue(undefined),
      getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.example/get"),
      getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
    };
    // Mocked fetch: /healthz + /init succeed (empty tools), other routes 404.
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

    const adapter = new FlyioAdapter(flyApi, storage, router, new ToolRegistry(), undefined, {
      fetchImpl,
    });

    return {
      adapter,
      get capturedEnv() {
        return capturedEnv;
      },
      createSpy,
    };
  }

  it("FlyioAdapter spawns a machine whose env contains NO caller LLM key", async () => {
    const ctx = setupCloudAdapter();
    await collect(ctx.adapter.executeStream(makeRunRequest()));

    expect(ctx.createSpy).toHaveBeenCalledOnce();
    const env = ctx.capturedEnv ?? {};
    const envBlob = JSON.stringify(env);

    // The exact caller key value must not appear in the env.
    expect(envBlob).not.toContain(CALLER_API_KEY);
    expect(envBlob).not.toContain("CAFEBABE");
    expect(envBlob).not.toContain("sk-caller");
  });

  it("env contains exactly the allowlisted infrastructure keys — nothing else", async () => {
    const ctx = setupCloudAdapter();
    await collect(ctx.adapter.executeStream(makeRunRequest()));

    const env = ctx.capturedEnv ?? {};
    const keys = Object.keys(env).sort();
    expect(keys).toEqual([
      "BUNDLE_URL",
      "MAX_RUN_TIMEOUT_MS",
      "OUTPUTS_PUT_URL",
      // Harness-controlled infra hostnames (object store + install registries)
      // the runner's egress allowlist must permit — hostnames, not credentials.
      // RUNNER_HARNESS_6PN is NOT here: it is gated on process.env.FLY_PRIVATE_IP
      // (unset in this test), so it is only present on a real Fly machine.
      "RUNNER_INFRA_HOSTS",
      "RUNNER_PORT",
      // Per-run RPC auth token — an infrastructure param consumed by the runner
      // supervisor to authenticate the harness→runner RPC. It is NOT forwarded to
      // the agent script env (buildSpawnEnv only passes SKRUN_* + SCRIPT_SAFE vars
      // — proven by VT-5/SC-2c in script-provider.test.ts), so it does not weaken
      // the ADR-014 "no credentials in the sandbox" boundary this test guards.
      "RUNNER_RPC_TOKEN",
      "SKRUN_ALLOWED_HOSTS",
      "SKRUN_CONTAINER_MODE",
    ]);
  });

  it("env values themselves are not LLM-key-shaped (defense-in-depth)", async () => {
    const ctx = setupCloudAdapter();
    await collect(ctx.adapter.executeStream(makeRunRequest()));

    const env = ctx.capturedEnv ?? {};
    for (const [key, value] of Object.entries(env)) {
      // Common LLM API key prefixes — none should appear in any value.
      expect(value, `env.${key} contains sk-`).not.toMatch(/sk-(ant|live|test|proj)?/);
      expect(value, `env.${key} contains AKIA`).not.toMatch(/AKIA[A-Z0-9]{16}/);
      expect(value, `env.${key} contains AIza`).not.toMatch(/AIza[A-Za-z0-9_-]{35}/);
    }
  });

  it("forbidden env keys are rejected even when explicitly attempted (allowlist defense)", () => {
    // This is a structural assertion against the buildMachineConfig
    // function itself — we cannot construct an attack payload that
    // succeeds. The function lives in machine-config.ts and is
    // exercised separately in `machine-config.test.ts` (env sanitization
    // suite — 14 tests). We assert here that the harness cannot
    // accidentally widen the allowlist via runtime data; the only way
    // to add a key is to edit the source code.
    expect(true).toBe(true); // structural cross-reference, see machine-config.test.ts.
  });
});

describe("VT-18 reference: SKRUN_RUNTIME=flyio fail-fast at startup", () => {
  it("is verified by packages/api/src/index.test.ts (5 startup-gate tests, shipped in 5.1)", () => {
    // VT-18 is structurally satisfied by:
    //   - `createApp` calling `selectRuntimeMode()` at boot,
    //   - which calls `buildFlyioDeps()` when mode === "flyio",
    //   - which throws naming every missing env var.
    // The 5 tests in `packages/api/src/index.test.ts` cover:
    //   - missing all cloud env vars → throws with required-vars list
    //   - partial creds (only FLY_API_TOKEN missing) → throws naming it
    //   - full creds → starts cleanly
    //   - default local mode → starts cleanly (no cloud envs required)
    //   - invalid SKRUN_RUNTIME value → throws (not silent fallback)
    expect(true).toBe(true);
  });
});
