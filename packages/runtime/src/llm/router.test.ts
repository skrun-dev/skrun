import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { createGuardedFetch } from "../security/safe-fetch.js";
import { estimateCost } from "./cost.js";
import { LLMCapabilityError } from "./errors.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import type {
  ConversationHistory,
  LLMCallRequest,
  LLMCallResponse,
  LLMProvider,
  NativeTurn,
  ToolCallRequest,
} from "./providers/types.js";
import {
  LLMRouter,
  MODEL_RESPONSE_MAX_BYTES,
  readPrimaryFailoverMs,
  resolveKeySource,
} from "./router.js";

// SEC-001 (audit/006): spy on the real `createGuardedFetch` rather than replace
// it, so behaviour is untouched but the WIRING is assertable — that the router
// passes the guard at all, and passes `allowPrivateHosts` tracking the operator
// opt-in. A bare `createGuardedFetch()` would block the documented
// Ollama-on-localhost case at connect; that is the bug this spy exists to catch.
vi.mock("../security/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/safe-fetch.js")>();
  return { ...actual, createGuardedFetch: vi.fn(actual.createGuardedFetch) };
});

function createMockProvider(name: string, response?: Partial<LLMCallResponse>): LLMProvider {
  return {
    name,
    call: vi.fn().mockResolvedValue({
      content: response?.content ?? `Response from ${name}`,
      toolCalls: response?.toolCalls,
      usage: response?.usage ?? { promptTokens: 100, completionTokens: 50 },
    }),
  };
}

function createFailingProvider(name: string): LLMProvider {
  return {
    name,
    call: vi.fn().mockRejectedValue(new Error(`${name} failed`)),
  };
}

function createHangingProvider(name: string): LLMProvider {
  return {
    name,
    // Resolves only after a very long delay — with fake timers we never advance
    // that far, so it stays pending like a real hang, without leaking a
    // never-resolving promise.
    call: vi.fn(
      () =>
        new Promise<LLMCallResponse>((resolve) => {
          setTimeout(() => {
            resolve({
              content: `slow ${name}`,
              usage: { promptTokens: 1, completionTokens: 1 },
            });
          }, 10 * 60_000);
        }),
    ),
  };
}

describe("LLMRouter", () => {
  let router: LLMRouter;

  beforeEach(() => {
    router = new LLMRouter();
  });

  it("should route to the correct provider", async () => {
    const mock = createMockProvider("anthropic");
    router.registerProvider("anthropic", mock);

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "system",
      "user message",
    );

    expect(result.content).toBe("Response from anthropic");
    expect(result.provider).toBe("anthropic");
    expect(mock.call).toHaveBeenCalledOnce();
  });

  it("should fallback on primary failure", async () => {
    router.registerProvider("anthropic", createFailingProvider("anthropic"));
    router.registerProvider("openai", createMockProvider("openai"));

    const result = await router.call(
      {
        provider: "anthropic",
        name: "claude-sonnet-4-20250514",
        fallback: { provider: "openai", name: "gpt-4o" },
      },
      "system",
      "user",
    );

    expect(result.content).toBe("Response from openai");
    expect(result.provider).toBe("openai");
  });

  it("VT-4: fails over to the fallback fast when the primary hangs, before its full timeout", async () => {
    vi.useFakeTimers();
    try {
      router.registerProvider("anthropic", createHangingProvider("anthropic"));
      router.registerProvider("openai", createMockProvider("openai"));

      const callPromise = router.call(
        {
          provider: "anthropic",
          name: "claude-sonnet-4-20250514",
          fallback: { provider: "openai", name: "gpt-4o" },
        },
        "system",
        "user",
      );

      // Advance past the 45s failover timeout while the primary is still hanging
      // (its own resolution is 10 min away) → the race rejects → fallback runs.
      await vi.advanceTimersByTimeAsync(46_000);
      const result = await callPromise;

      expect(result.provider).toBe("openai");
      expect(result.content).toBe("Response from openai");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RT-2: an immediate primary rejection still falls over (no failover-timer wait)", async () => {
    // Real timers: if the race wrongly waited for the 45s timer, this would time out.
    router.registerProvider("anthropic", createFailingProvider("anthropic"));
    router.registerProvider("openai", createMockProvider("openai"));

    const result = await router.call(
      {
        provider: "anthropic",
        name: "claude-sonnet-4-20250514",
        fallback: { provider: "openai", name: "gpt-4o" },
      },
      "system",
      "user",
    );

    expect(result.provider).toBe("openai");
    expect(result.content).toBe("Response from openai");
  });

  it("should throw if primary fails and no fallback", async () => {
    router.registerProvider("anthropic", createFailingProvider("anthropic"));

    await expect(
      router.call({ provider: "anthropic", name: "model" }, "sys", "user"),
    ).rejects.toThrow("anthropic failed");
  });

  it("should throw if provider not registered", async () => {
    await expect(
      router.call({ provider: "anthropic", name: "model" }, "sys", "user"),
    ).rejects.toThrow('No API key available for provider "anthropic"');
  });

  it("should track token usage", async () => {
    router.registerProvider("anthropic", createMockProvider("anthropic"));

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "sys",
      "user",
    );

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);
  });

  // The router threads the run's cache key to the Mistral adapter, which
  // passes it on as prompt_cache_key, and surfaces the cache reads it returns,
  // billed at Mistral's cached-read rate.
  it("router hands Mistral the run's cache key and surfaces its cache reads", async () => {
    const mistralMock: LLMProvider = {
      name: "mistral",
      call: vi.fn().mockResolvedValue({
        content: "Mistral response",
        assistantTurn: { provider: "mistral", content: { role: "assistant", content: "ok" } },
        usage: { promptTokens: 500, completionTokens: 100, cacheReadTokens: 1024 },
      } satisfies LLMCallResponse),
    };
    router.registerProvider("mistral", mistralMock);

    const result = await router.call(
      { provider: "mistral", name: "mistral-large-2512" },
      "system",
      "user message",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { name: "foo", version: "1.0.0", environmentId: "prod" },
    );

    const callArgs = (mistralMock.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.cacheKey).toMatch(/^[0-9a-f]{64}$/); // hex digest
    expect(result.usage.cacheReadTokens).toBe(1024);
    expect(result.usage.cacheWriteTokens).toBeUndefined();
    expect(result.estimatedCost).toBe(estimateCost("mistral-large-2512", 500, 100, 1024));
    // The cached part bills below the full input rate.
    expect(result.estimatedCost).toBeLessThan(estimateCost("mistral-large-2512", 1524, 100));
  });

  // VT-10 (router accumulation) — provider returns cache fields → router
  // surfaces them on aggregated result + applies cached rate to estimateCost.
  it("router accumulates cacheReadTokens + cacheWriteTokens across iteration", async () => {
    const cachingMock: LLMProvider = {
      name: "anthropic",
      call: vi.fn().mockResolvedValue({
        content: "ok",
        usage: {
          promptTokens: 500, // post-cache residual (Anthropic native shape)
          completionTokens: 200,
          cacheReadTokens: 8000,
          cacheWriteTokens: 2000,
        },
      } satisfies LLMCallResponse),
    };
    router.registerProvider("anthropic", cachingMock);

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-6" },
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { name: "foo", version: "1.0.0", environmentId: "prod" },
    );

    expect(result.usage.cacheReadTokens).toBe(8000);
    expect(result.usage.cacheWriteTokens).toBe(2000);
    // estimateCost should reflect the cached rate, not the full input rate
    // for the cached portion. claude-sonnet-4-6: input=$3, cached_read=$0.30,
    // cached_write_5m=$3.75, output=$15.
    // Expected: (500×3 + 8000×0.30 + 2000×3.75 + 200×15) / 1M = (1500+2400+7500+3000)/1M = 0.0144
    expect(result.estimatedCost).toBeCloseTo(0.0144, 6);
  });

  // No agentContext → no cacheKey computed → adapters get cacheKey=undefined.
  it("no agentContext → cacheKey is undefined (dev-mode raw call)", async () => {
    const mock = createMockProvider("anthropic");
    router.registerProvider("anthropic", mock);

    await router.call({ provider: "anthropic", name: "claude-sonnet-4-6" }, "sys", "user");

    const callArgs = (mock.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.cacheKey).toBeUndefined();
  });

  // RT-3 (#68 prompt-caching) — pre-#68 mock provider returning ONLY
  // { promptTokens, completionTokens } (no cache fields) flows through the
  // router untouched. Existing consumers reading these two fields keep
  // working. New optional cache fields are absent / undefined on the
  // accumulated result. Locks in back-compat for anyone with a custom
  // LLMProvider implementation that hasn't been updated to populate cache
  // fields.
  it("RT-3: pre-#68 provider (no cache fields) still works through router", async () => {
    const legacyProvider: LLMProvider = {
      name: "legacy-mock",
      // Explicit shape — no cacheReadTokens / cacheWriteTokens. Mirrors what a
      // 3rd-party provider implementation would return before #68.
      call: vi.fn().mockResolvedValue({
        content: "Legacy response",
        usage: { promptTokens: 200, completionTokens: 75 },
      } satisfies LLMCallResponse),
    };
    router.registerProvider("anthropic", legacyProvider);

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "sys",
      "user",
    );

    // Pre-#68 fields are correctly populated.
    expect(result.usage.promptTokens).toBe(200);
    expect(result.usage.completionTokens).toBe(75);
    expect(result.usage.totalTokens).toBe(275);
    // New cache fields are absent / undefined when provider doesn't report them.
    // Consumer code reading only the legacy 3 fields ignores these cleanly.
    expect(result.usage.cacheReadTokens).toBeUndefined();
    expect(result.usage.cacheWriteTokens).toBeUndefined();
  });

  it("should estimate cost", async () => {
    router.registerProvider("anthropic", createMockProvider("anthropic"));

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "sys",
      "user",
    );

    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it("should measure duration", async () => {
    router.registerProvider("anthropic", createMockProvider("anthropic"));

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "sys",
      "user",
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should execute tool calling loop", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: "anthropic",
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ name: "search", args: { q: "test" }, id: "t1" }],
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        return {
          content: "Final answer after tool use",
          usage: { promptTokens: 150, completionTokens: 50 },
        };
      }),
    };

    router.registerProvider("anthropic", provider);

    const onToolCall = vi.fn().mockResolvedValue({
      name: "search",
      result: "search results here",
      id: "t1",
    });

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      "sys",
      "user",
      [{ name: "search", description: "Search", parameters: {} }],
      onToolCall,
    );

    expect(result.content).toBe("Final answer after tool use");
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(provider.call).toHaveBeenCalledTimes(2);
    expect(result.usage.totalTokens).toBe(320); // 100+150 + 20+50
  });

  describe("caller-provided keys", () => {
    it("should use caller key instead of server key", async () => {
      const serverProvider = createMockProvider("anthropic", { content: "server response" });
      router.registerProvider("anthropic", serverProvider);

      const callerKeys = { anthropic: "sk-ant-caller-key" };

      // The call will fail because the caller key is fake, but the server provider must NOT be called
      try {
        await router.call(
          { provider: "anthropic", name: "claude-sonnet-4-20250514" },
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          callerKeys,
        );
      } catch {
        // Expected: real API call fails with fake key
      }

      expect(serverProvider.call).not.toHaveBeenCalled();
    });

    it("should fall back to server key when caller key not provided for that provider", async () => {
      const serverProvider = createMockProvider("anthropic");
      router.registerProvider("anthropic", serverProvider);

      const callerKeys = { openai: "sk-caller-openai" };

      const result = await router.call(
        { provider: "anthropic", name: "claude-sonnet-4-20250514" },
        "sys",
        "user",
        undefined,
        undefined,
        undefined,
        callerKeys,
      );

      expect(result.content).toBe("Response from anthropic");
      expect(serverProvider.call).toHaveBeenCalledOnce();
    });

    it("should use caller key for primary and server key for fallback", async () => {
      const serverFallback = createMockProvider("openai");
      router.registerProvider("openai", serverFallback);

      const callerKeys = { anthropic: "sk-ant-fake" };

      const result = await router.call(
        {
          provider: "anthropic",
          name: "claude-sonnet-4-20250514",
          fallback: { provider: "openai", name: "gpt-4o" },
        },
        "sys",
        "user",
        undefined,
        undefined,
        undefined,
        callerKeys,
      );

      expect(result.content).toBe("Response from openai");
      expect(result.provider).toBe("openai");
      expect(serverFallback.call).toHaveBeenCalledOnce();
    });

    it("should throw when no key available from any source", async () => {
      await expect(
        router.call(
          { provider: "mistral", name: "mistral-large" },
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          { anthropic: "sk-ant-key" },
        ),
      ).rejects.toThrow('No API key available for provider "mistral"');
    });

    it("should work with no callerKeys (backward compatibility)", async () => {
      router.registerProvider("anthropic", createMockProvider("anthropic"));

      const result = await router.call(
        { provider: "anthropic", name: "claude-sonnet-4-20250514" },
        "sys",
        "user",
      );

      expect(result.content).toBe("Response from anthropic");
    });

    it("VT-13: uses the creator key over the server key (creator > server)", async () => {
      const serverProvider = createMockProvider("anthropic");
      router.registerProvider("anthropic", serverProvider);
      try {
        await router.call(
          { provider: "anthropic", name: "claude-sonnet-4-20250514" },
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          undefined, // callerKeys
          undefined,
          undefined,
          undefined, // toolChoice, parallelTools, agentContext
          { anthropic: "sk-ant-creator-fake" }, // creatorKeys
        );
      } catch {
        // The creator key resolves to an ephemeral real provider that fails on
        // the fake key — expected. The point is the SERVER mock was bypassed.
      }
      expect(serverProvider.call).not.toHaveBeenCalled();
    });

    it("VT-13: uses the creator key for the primary and the server key for the fallback", async () => {
      const serverFallback = createMockProvider("openai");
      router.registerProvider("openai", serverFallback);

      const result = await router.call(
        {
          provider: "anthropic",
          name: "claude-sonnet-4-20250514",
          fallback: { provider: "openai", name: "gpt-4o" },
        },
        "sys",
        "user",
        undefined,
        undefined,
        undefined,
        undefined, // callerKeys
        undefined,
        undefined,
        undefined,
        { anthropic: "sk-ant-creator-fake" }, // creatorKeys → primary (ephemeral, fails)
      );

      // Primary used the creator key (ephemeral, failed) → fell back to the
      // openai server mock. Proves creatorKeys is threaded into call().
      expect(result.provider).toBe("openai");
      expect(serverFallback.call).toHaveBeenCalledOnce();
    });

    it("VT-32: a creator key is used WITH a custom base_url (base_url orthogonal)", async () => {
      // base_url + a creator key → the creator tier is picked and the key is used
      // with the custom endpoint (an ephemeral OpenAI-compatible provider that
      // fails against the fake endpoint). The server-registered mock is bypassed
      // — base_url must NOT make the creator key fall through to the server tier.
      const serverProvider = createMockProvider("anthropic");
      router.registerProvider("anthropic", serverProvider);
      try {
        await router.call(
          {
            provider: "anthropic",
            name: "claude-sonnet-4-20250514",
            base_url: "https://llm.internal.example/v1",
          },
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { anthropic: "sk-ant-creator-fake" },
        );
      } catch {
        // ephemeral provider call to the fake base_url fails — expected.
      }
      expect(serverProvider.call).not.toHaveBeenCalled();
    });

    it("VT-30: redacts an active key value from the fallback warn log (B-1)", async () => {
      const logged: Array<Record<string, unknown>> = [];
      const logger = {
        warn: (obj: Record<string, unknown>) => logged.push(obj),
        info: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
      } as unknown as Logger;
      const r = new LLMRouter(logger);
      // Primary (server mock) throws an error echoing the creator key; the
      // openai fallback (server mock) succeeds, so the primary_failed warn fires.
      r.registerProvider("anthropic", {
        name: "anthropic",
        call: vi.fn().mockRejectedValue(new Error("401 Incorrect API key: sk-creator-LEAK")),
      });
      r.registerProvider("openai", createMockProvider("openai"));

      await r.call(
        {
          provider: "anthropic",
          name: "claude-sonnet-4-20250514",
          fallback: { provider: "openai", name: "gpt-4o" },
        },
        "sys",
        "user",
        undefined,
        undefined,
        undefined,
        undefined, // callerKeys
        undefined,
        undefined,
        undefined,
        { google: "sk-creator-LEAK" }, // creatorKeys → the active secret
      );

      const warn = logged.find((l) => l.event === "primary_failed");
      expect(warn).toBeDefined();
      expect(JSON.stringify(warn)).not.toContain("sk-creator-LEAK");
      // The line carries the error's class, never its message: nothing to redact.
      expect(warn).not.toHaveProperty("error");
      expect(warn).toMatchObject({ error_name: "Error" });
    });
  });

  describe("xAI provider auto-registration (#58)", () => {
    function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
      const original = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      try {
        return fn();
      } finally {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    }

    it("VT-27: auto-registers xai provider when XAI_API_KEY is set", () => {
      withEnv("XAI_API_KEY", "xai-test-key", () => {
        const r = new LLMRouter();
        const providers = (r as unknown as { providers: Map<string, LLMProvider> }).providers;
        expect(providers.has("xai")).toBe(true);
        expect(providers.get("xai")?.name).toBe("xai");
      });
    });

    it("does NOT register xai when XAI_API_KEY is unset", () => {
      withEnv("XAI_API_KEY", undefined, () => {
        const r = new LLMRouter();
        const providers = (r as unknown as { providers: Map<string, LLMProvider> }).providers;
        expect(providers.has("xai")).toBe(false);
      });
    });
  });
});

// A provider's error message can quote the request it refused, or a key; its
// class, code and HTTP status say enough to tell a rate limit from a refused key.
describe("LLMRouter — a failed primary is logged by the error's class, code and status", () => {
  it("logs the provider error's class and status, never its message, and still falls over", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const keep = (obj: Record<string, unknown>) => {
      logged.push(obj);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", {
      name: "anthropic",
      call: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("quota exceeded for witness-58d1"), { status: 429 }),
        ),
    });
    r.registerProvider("openai", createMockProvider("openai"));

    const result = await r.call(
      {
        provider: "anthropic",
        name: "claude-sonnet-4-20250514",
        fallback: { provider: "openai", name: "gpt-4o" },
      },
      "system",
      "user",
    );

    const line = logged.find((l) => l.event === "primary_failed");
    expect(JSON.stringify(line)).not.toContain("witness-58d1");
    expect(line).not.toHaveProperty("error");
    expect(line).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      error_name: "Error",
      error_status: "429",
    });
    expect(result.provider).toBe("openai");
  });
});

describe("model.base_url guard (SEC-001, audit/006)", () => {
  const HOSTILE = "https://attacker.example/v1";
  const ANTHROPIC = { provider: "anthropic" as const, name: "claude-sonnet-4-20250514" };

  /** Async-capable env swap — the file's other `withEnv` is sync and scoped elsewhere. */
  async function withEnvAsync(
    vars: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const originals = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of originals) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /** Drive a call through the router and return the error it surfaced, if any. */
  async function callWith(
    modelConfig: Record<string, unknown>,
    opts: { callerKeys?: Record<string, string>; creatorKeys?: Record<string, string> } = {},
  ): Promise<Error | null> {
    const r = new LLMRouter();
    try {
      await r.call(
        modelConfig as never,
        "sys",
        "user",
        undefined,
        undefined,
        undefined,
        opts.callerKeys,
        undefined,
        undefined,
        undefined,
        opts.creatorKeys,
      );
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  /**
   * A transport that answers instantly — no DNS, no socket.
   *
   * The two tests marked below assert the WIRING (that the router built a
   * guarded fetch, and with which flag) on a call that is allowed to proceed to
   * HOSTILE. On the real transport they perform a live lookup of
   * `attacker.example`: a reserved TLD, so it always fails — but how FAST it
   * fails belongs to the runner's DNS, not to us. VT-6 timed out at 5003ms on CI
   * Node 22 while passing locally and on the previous commit.
   *
   * The guard's own behaviour is NOT stubbed away: VT-4 keeps the real transport
   * (localhost must not be blocked under the opt-in — the bug this spy exists to
   * catch), and security/safe-fetch.test.ts covers the guard directly.
   */
  function instantTransport(): ReturnType<typeof createGuardedFetch> {
    return (async () => new Response("{}", { status: 401 })) as unknown as ReturnType<
      typeof createGuardedFetch
    >;
  }

  /**
   * What the router hands the guard for an agent-declared endpoint: the
   * address opt-in, and the bounds every response of that endpoint is held to
   * — its body, and the retry headers taken off. No deadline when the call
   * passes none.
   */
  const guardOf = (allowPrivateHosts: boolean) => ({
    allowPrivateHosts,
    maxResponseBytes: MODEL_RESPONSE_MAX_BYTES,
    deadline: undefined,
    stripRetryHeaders: true,
  });

  beforeEach(() => {
    vi.mocked(createGuardedFetch).mockClear();
  });

  it("VT-1: refuses a non-http(s) scheme before any provider is built", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "sk-ant-server" }, async () => {
      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://evil.example/x"]) {
        const e = await callWith({ ...ANTHROPIC, base_url: url });
        expect(e?.message).toMatch(/must use http or https/);
      }
    });
    // No provider was constructed for any of them.
    expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
  });

  it("VT-2: refuses a private/reserved LITERAL host by default, naming the opt-in", async () => {
    await withEnvAsync(
      { SKRUN_ALLOW_LOCAL_MODEL_HOSTS: undefined, ANTHROPIC_API_KEY: "sk-ant-server" },
      async () => {
        const e = await callWith({
          ...ANTHROPIC,
          base_url: "http://169.254.169.254/latest/meta-data",
        });
        expect(e?.message).toMatch(/private or reserved address/);
        expect(e?.message).toMatch(/SKRUN_ALLOW_LOCAL_MODEL_HOSTS/);
      },
    );
    // This is the case the connect-time guard CANNOT see: undici skips
    // `connect.lookup` for an IP literal. Measured in the Q-6 spike.
    expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
  });

  it("VT-3: the same hostile base_url is refused on ALL THREE key tiers", async () => {
    const hostile = { ...ANTHROPIC, base_url: "http://127.0.0.1:9/v1" };
    await withEnvAsync(
      { SKRUN_ALLOW_LOCAL_MODEL_HOSTS: undefined, ANTHROPIC_API_KEY: "sk-ant-server" },
      async () => {
        const caller = await callWith(hostile, { callerKeys: { anthropic: "sk-ant-caller" } });
        const creator = await callWith(hostile, { creatorKeys: { anthropic: "sk-ant-creator" } });
        const server = await callWith(hostile);
        for (const e of [caller, creator, server]) {
          expect(e?.message).toMatch(/private or reserved address/);
        }
      },
    );
    // Proves the guard runs BEFORE tier selection: no tier reached a provider.
    expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
  });

  it("VT-3b: the router passes the guard, with allowPrivateHosts tracking the opt-in", async () => {
    // The guard's BEHAVIOUR (a public host resolving private is refused at
    // connect) is already covered in security/safe-fetch.test.ts via its
    // `resolver` seam. What only this file can assert is the WIRING.
    vi.mocked(createGuardedFetch).mockReturnValueOnce(instantTransport());
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: undefined }, async () => {
      await callWith(
        { ...ANTHROPIC, base_url: HOSTILE },
        { callerKeys: { anthropic: "sk-ant-caller" } },
      );
    });
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith(guardOf(false));

    vi.mocked(createGuardedFetch).mockClear();
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: "true" }, async () => {
      await callWith(
        { ...ANTHROPIC, base_url: "http://localhost:9/v1" },
        { callerKeys: { anthropic: "sk-ant-caller" } },
      );
    });
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith(guardOf(true));
  });

  it("VT-4: with the opt-in, the documented Ollama endpoint gets past validation", async () => {
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: "true" }, async () => {
      const e = await callWith(
        { ...ANTHROPIC, base_url: "http://localhost:11434/v1" },
        { callerKeys: { anthropic: "sk-ant-caller" } },
      );
      // Nothing is listening, so the CALL fails — but not on validation, which
      // is the whole claim. docs/agent-yaml.md:39 stays runnable.
      expect(e?.message ?? "").not.toMatch(/private or reserved address|must use http or https/);
    });
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith(guardOf(true));
  });

  it("VT-5: the server tier refuses its own key to an agent-declared endpoint", async () => {
    await withEnvAsync(
      { SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: undefined, ANTHROPIC_API_KEY: "sk-ant-server" },
      async () => {
        const e = await callWith({ ...ANTHROPIC, base_url: HOSTILE });
        expect(e?.message).toMatch(/does not send its own key to an agent-declared/);
        // The refusal names all three ways forward, not just "no".
        expect(e?.message).toMatch(/creator key/);
        expect(e?.message).toMatch(/X-LLM-API-Key/);
        expect(e?.message).toMatch(/SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL/);
      },
    );
  });

  it("VT-6: with the operator opt-in, the server tier does pair its key with it", async () => {
    vi.mocked(createGuardedFetch).mockReturnValueOnce(instantTransport());
    await withEnvAsync(
      { SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: "true", ANTHROPIC_API_KEY: "sk-ant-server" },
      async () => {
        const e = await callWith({ ...ANTHROPIC, base_url: HOSTILE });
        expect(e?.message ?? "").not.toMatch(/does not send its own key/);
      },
    );
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith(guardOf(false));
  });

  it("RT-9: the fallback model carries no base_url (safe by omission, now pinned)", async () => {
    // FallbackModelSchema has no base_url field and router.ts passes `undefined`
    // at that position for the fallback call. Nothing enforced that, so a future
    // "make it consistent" refactor could thread modelConfig.base_url into the
    // fallback and silently reopen SEC-001 for the fallback's provider.
    const fallbackProvider = createMockProvider("openai");
    const r = new LLMRouter();
    r.registerProvider("openai", fallbackProvider);
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: undefined }, async () => {
      try {
        await r.call(
          {
            ...ANTHROPIC,
            base_url: HOSTILE,
            fallback: { provider: "openai", name: "gpt-5.2" },
          } as never,
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          { anthropic: "sk-ant-caller" },
        );
      } catch {
        // the primary fails against the fake endpoint — expected
      }
    });
    // The fallback ran on the SERVER-REGISTERED provider, i.e. no base_url was
    // threaded into it. Exactly one guarded fetch was built: the primary's.
    expect(fallbackProvider.call).toHaveBeenCalledOnce();
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledOnce();
  });

  it("the run's deadline reaches the guard of the agent's endpoint, for every request of the attempt", async () => {
    vi.mocked(createGuardedFetch).mockReturnValueOnce(instantTransport());
    const deadline = Date.now() + 120_000;
    const r = new LLMRouter();
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: undefined }, async () => {
      await r
        .call(
          { ...ANTHROPIC, base_url: HOSTILE } as never,
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          { anthropic: "sk-ant-caller" },
          undefined,
          undefined,
          undefined,
          undefined,
          { deadline },
        )
        .catch(() => undefined);
    });
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ ...guardOf(false), deadline });
  });

  it("RT-10: providers without a base_url keep the SDK's own transport", async () => {
    const r = new LLMRouter();
    r.registerProvider("anthropic", createMockProvider("anthropic"));
    await r.call(ANTHROPIC as never, "sys", "user");
    // No agent-declared endpoint means no guarded transport, so OpenAI/Mistral/
    // Grok/Groq at their fixed endpoints are untouched by this change.
    expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
  });
});

describe("tool-loop spend ceiling (#116)", () => {
  const MODEL = { provider: "anthropic" as const, name: "claude-sonnet-4-20250514" };
  const TOOLS = [{ name: "search", description: "Search", parameters: {} }];
  const PROMPT_TOKENS = 1_000;
  const COMPLETION_TOKENS = 200;
  /**
   * Mirrors `MAX_TOOL_ITERATIONS` in router.ts — the only bound the loop had
   * before it started reading the ceiling from inside itself. The assertions
   * below are what tell "stopped in the loop" apart from "stopped after it":
   * both end on the same cost error, only the provider-call count differs.
   */
  const MAX_TOOL_ITERATIONS = 10;

  /** A provider that asks for a tool on EVERY iteration, so only a bound can stop the loop. */
  function alwaysAsksForATool() {
    const call = vi.fn().mockResolvedValue({
      content: "",
      toolCalls: [{ name: "search", args: { q: "x" }, id: "t1" }],
      usage: { promptTokens: PROMPT_TOKENS, completionTokens: COMPLETION_TOKENS },
    });
    const provider: LLMProvider = { name: "anthropic", call };
    return { provider, call };
  }

  it("VT-12 (#116): the loop stops on the ceiling, well short of the iteration bound", async () => {
    const r = new LLMRouter();
    const { provider, call } = alwaysAsksForATool();
    r.registerProvider("anthropic", provider);
    const onToolCall = vi.fn().mockResolvedValue({ name: "search", result: "ok", id: "t1" });

    // The ceiling sits between the 2nd and the 3rd iteration's cumulative
    // spend, derived from the price table rather than hardcoded: a repricing
    // moves the scenario instead of silently invalidating it.
    const perIteration = estimateCost(MODEL.name, PROMPT_TOKENS, COMPLETION_TOKENS);
    const maxCost = perIteration * 2.5;

    const result = await r.call(
      MODEL,
      "sys",
      "user",
      TOOLS,
      onToolCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost },
    );

    expect(result.costExceeded).toBe(true);
    // The load-bearing assertion: the loop stopped inside itself. Reading the
    // ceiling only on the way out would leave this at the iteration bound.
    expect(call.mock.calls.length).toBeLessThan(MAX_TOOL_ITERATIONS);
    expect(call).toHaveBeenCalledTimes(3);
    // And it stopped before dispatching the tools of the iteration that tipped over.
    expect(onToolCall).toHaveBeenCalledTimes(2);
    // The returned cost is the one the ceiling was compared against.
    expect(result.estimatedCost).toBeGreaterThan(maxCost);
  });

  it("RT-9 (#116): with no ceiling the loop is bounded only by its iteration count", async () => {
    const r = new LLMRouter();
    const { provider, call } = alwaysAsksForATool();
    r.registerProvider("anthropic", provider);
    const onToolCall = vi.fn().mockResolvedValue({ name: "search", result: "ok", id: "t1" });

    const result = await r.call(MODEL, "sys", "user", TOOLS, onToolCall);

    expect(result.costExceeded).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(result.content).toMatch(/Max tool iterations reached/);
  });

  it("a ceiling that is never reached leaves the loop and the response untouched", async () => {
    const r = new LLMRouter();
    const { provider, call } = alwaysAsksForATool();
    r.registerProvider("anthropic", provider);
    const onToolCall = vi.fn().mockResolvedValue({ name: "search", result: "ok", id: "t1" });

    const result = await r.call(
      MODEL,
      "sys",
      "user",
      TOOLS,
      onToolCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: 1_000 },
    );

    expect(result.costExceeded).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
  });
});

describe("the key decision — one function, read by the router and before a run", () => {
  const NONE = { serverHasProvider: false, serverKeyWithBaseUrlAllowed: false };
  const BASE_URL = "https://models.example/v1";

  describe("resolveKeySource, one case per tier and per refusal", () => {
    it("caller: the request's key for this provider wins over every other tier", () => {
      expect(
        resolveKeySource("google", {
          callerKeys: { google: "k-caller" },
          creatorKeys: { google: "k-creator" },
          serverHasProvider: true,
          serverKeyWithBaseUrlAllowed: true,
        }),
      ).toEqual({ tier: "caller" });
    });

    it("creator: an attached key wins over the server's", () => {
      expect(
        resolveKeySource("google", {
          callerKeys: { openai: "k-other-provider" },
          creatorKeys: { google: "k-creator" },
          serverHasProvider: true,
          serverKeyWithBaseUrlAllowed: false,
        }),
      ).toEqual({ tier: "creator" });
    });

    it("server: the server registered the provider, and no base_url is declared", () => {
      expect(resolveKeySource("google", { ...NONE, serverHasProvider: true })).toEqual({
        tier: "server",
      });
    });

    it("server-base-url: a declared base_url takes the server tier only under the opt-in", () => {
      expect(
        resolveKeySource("google", {
          baseUrl: BASE_URL,
          serverHasProvider: false,
          serverKeyWithBaseUrlAllowed: true,
        }),
      ).toEqual({ tier: "server-base-url" });
    });

    it("refused, no-key: no tier has a key, a key for another provider included", () => {
      expect(resolveKeySource("google", { ...NONE, callerKeys: { openai: "k" } })).toEqual({
        refused: "no-key",
      });
    });

    it("refused, base-url-needs-own-key: a declared base_url never takes the server's key by default", () => {
      expect(
        resolveKeySource("google", { baseUrl: BASE_URL, ...NONE, serverHasProvider: true }),
      ).toEqual({ refused: "base-url-needs-own-key" });
    });

    it("a declared base_url is orthogonal to the caller and creator tiers", () => {
      expect(
        resolveKeySource("google", { ...NONE, baseUrl: BASE_URL, callerKeys: { google: "k" } }),
      ).toEqual({ tier: "caller" });
      expect(
        resolveKeySource("google", { ...NONE, baseUrl: BASE_URL, creatorKeys: { google: "k" } }),
      ).toEqual({ tier: "creator" });
    });

    // meta has no endpoint of its own: only an agent-declared base_url serves it.
    const META_REFUSED = { refused: "meta-needs-base-url" };

    it("refused, meta-needs-base-url: meta without a base_url is served by no key — the caller's, the creator's nor the server's", () => {
      const EVERY_TIER = { serverHasProvider: true, serverKeyWithBaseUrlAllowed: true };
      expect({
        caller: resolveKeySource("meta", { ...EVERY_TIER, callerKeys: { meta: "k-caller" } }),
        creator: resolveKeySource("meta", { ...EVERY_TIER, creatorKeys: { meta: "k-creator" } }),
        server: resolveKeySource("meta", EVERY_TIER),
      }).toEqual({ caller: META_REFUSED, creator: META_REFUSED, server: META_REFUSED });
    });

    it("meta with a base_url goes through the tiers as any provider does", () => {
      expect({
        caller: resolveKeySource("meta", {
          ...NONE,
          baseUrl: BASE_URL,
          callerKeys: { meta: "k-caller" },
        }),
        creator: resolveKeySource("meta", {
          ...NONE,
          baseUrl: BASE_URL,
          creatorKeys: { meta: "k-creator" },
        }),
        serverBaseUrl: resolveKeySource("meta", {
          baseUrl: BASE_URL,
          serverHasProvider: false,
          serverKeyWithBaseUrlAllowed: true,
        }),
        none: resolveKeySource("meta", { ...NONE, baseUrl: BASE_URL }),
      }).toEqual({
        caller: { tier: "caller" },
        creator: { tier: "creator" },
        serverBaseUrl: { tier: "server-base-url" },
        none: { refused: "base-url-needs-own-key" },
      });
    });
  });

  describe("LLMRouter.checkKeyResolvable", () => {
    async function withEnv(
      vars: Record<string, string | undefined>,
      fn: () => Promise<void> | void,
    ): Promise<void> {
      const originals = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        await fn();
      } finally {
        for (const [k, v] of originals) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    beforeEach(() => {
      vi.mocked(createGuardedFetch).mockClear();
    });

    it("reads the server's registered providers and the operator's opt-in", async () => {
      await withEnv(
        { GOOGLE_API_KEY: undefined, SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: undefined },
        () => {
          const r = new LLMRouter();
          expect(r.checkKeyResolvable("google")).toEqual({ refused: "no-key" });
          expect(r.checkKeyResolvable("google", undefined, BASE_URL)).toEqual({
            refused: "base-url-needs-own-key",
          });
          r.registerProvider("google", createMockProvider("google"));
          expect(r.checkKeyResolvable("google")).toEqual({ tier: "server" });
        },
      );
      await withEnv({ SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: "true" }, () => {
        expect(new LLMRouter().checkKeyResolvable("google", undefined, BASE_URL)).toEqual({
          tier: "server-base-url",
        });
      });
    });

    it("builds no provider and leaves base_url validation to the router's first call", () => {
      const r = new LLMRouter();
      expect(
        r.checkKeyResolvable("anthropic", { anthropic: "k" }, "file:///etc/passwd", undefined),
      ).toEqual({ tier: "caller" });
      expect(
        r.checkKeyResolvable("anthropic", undefined, BASE_URL, { anthropic: "k-creator" }),
      ).toEqual({ tier: "creator" });
      expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
    });

    it("checkModelKeys reads the primary with its base_url and the fallback without, as call() does", async () => {
      await withEnv(
        {
          GOOGLE_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: undefined,
        },
        () => {
          const r = new LLMRouter();
          const model = {
            provider: "google" as const,
            name: "gemini-2.5-flash",
            base_url: BASE_URL,
            fallback: { provider: "openai" as const, name: "gpt-4o-mini" },
          };
          expect(r.checkModelKeys(model)).toEqual({
            primary: { refused: "base-url-needs-own-key" },
            fallback: { refused: "no-key" },
            servable: false,
          });
          // The fallback is never sent to the agent's endpoint: a server key serves it.
          r.registerProvider("openai", createMockProvider("openai"));
          expect(r.checkModelKeys(model)).toEqual({
            primary: { refused: "base-url-needs-own-key" },
            fallback: { tier: "server" },
            servable: true,
          });
          expect(r.checkModelKeys({ provider: "google", name: "g" }, { google: "k" })).toEqual({
            primary: { tier: "caller" },
            servable: true,
          });
        },
      );
    });

    it("a primary with no key at any tier fails at its first call, and the fallback serves the run", async () => {
      await withEnv({ GOOGLE_API_KEY: undefined }, async () => {
        const r = new LLMRouter();
        const fallback = createMockProvider("openai");
        r.registerProvider("openai", fallback);
        const model = {
          provider: "google" as const,
          name: "gemini-2.5-flash",
          fallback: { provider: "openai" as const, name: "gpt-4o" },
        };

        expect(r.checkModelKeys(model).servable).toBe(true);
        const result = await r.call(model, "s", "u");

        expect(result.provider).toBe("openai");
        expect(fallback.call).toHaveBeenCalledOnce();
      });
    });

    it("refuses exactly where the router's call refuses, with the router's own messages", async () => {
      await withEnv(
        { GOOGLE_API_KEY: undefined, SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL: undefined },
        async () => {
          const r = new LLMRouter();
          const cases: Array<{ baseUrl?: string; message: RegExp }> = [
            { message: /No API key available for provider "google"/ },
            { baseUrl: BASE_URL, message: /does not send its own key to an agent-declared/ },
          ];
          for (const { baseUrl, message } of cases) {
            expect("refused" in r.checkKeyResolvable("google", undefined, baseUrl)).toBe(true);
            await expect(
              r.call({ provider: "google", name: "gemini-2.5-flash", base_url: baseUrl }, "s", "u"),
            ).rejects.toThrow(message);
          }
        },
      );
    });

    it("meta without a base_url: refused before any tier is read, and the router's call refuses it too, whatever key is given", async () => {
      const r = new LLMRouter();
      const keys = { meta: "k-meta" };
      expect({
        none: r.checkKeyResolvable("meta"),
        caller: r.checkKeyResolvable("meta", keys),
        creator: r.checkKeyResolvable("meta", undefined, undefined, keys),
      }).toEqual({
        none: { refused: "meta-needs-base-url" },
        caller: { refused: "meta-needs-base-url" },
        creator: { refused: "meta-needs-base-url" },
      });
      const model = { provider: "meta" as const, name: "llama-local" };
      for (const [callerKeys, creatorKeys] of [
        [undefined, undefined],
        [keys, undefined],
        [undefined, keys],
      ] as const) {
        await expect(
          r.call(
            model,
            "s",
            "u",
            undefined,
            undefined,
            undefined,
            callerKeys,
            undefined,
            undefined,
            undefined,
            creatorKeys,
          ),
        ).rejects.toThrow('Unknown provider: "meta"');
      }
    });

    it("checkModelKeys: meta without a base_url is served by no key, as the primary or as a fallback", async () => {
      await withEnv({ GOOGLE_API_KEY: undefined }, () => {
        const r = new LLMRouter();
        const keys = { meta: "k-meta" };
        const META = { provider: "meta" as const, name: "llama-local" };
        expect({
          primary: r.checkModelKeys(META, keys, keys),
          primaryAndFallback: r.checkModelKeys({ ...META, fallback: META }, keys, keys),
          // A meta fallback refuses nothing of a run its primary serves.
          fallbackOnly: r.checkModelKeys(
            { provider: "google", name: "gemini-2.5-flash", fallback: META },
            { google: "k-google", ...keys },
          ),
        }).toEqual({
          primary: { primary: { refused: "meta-needs-base-url" }, servable: false },
          primaryAndFallback: {
            primary: { refused: "meta-needs-base-url" },
            fallback: { refused: "meta-needs-base-url" },
            servable: false,
          },
          fallbackOnly: {
            primary: { tier: "caller" },
            fallback: { refused: "meta-needs-base-url" },
            servable: true,
          },
        });
      });
    });

    it("a meta primary with no base_url, a key for it given by the caller and the creator: the call turns to the fallback, which serves it", async () => {
      await withEnv({ OPENAI_API_KEY: undefined }, async () => {
        const r = new LLMRouter();
        const fallback = createMockProvider("openai");
        r.registerProvider("openai", fallback);
        const keys = { meta: "k-meta" };
        const model = {
          provider: "meta" as const,
          name: "llama-local",
          fallback: { provider: "openai" as const, name: "gpt-4o" },
        };

        expect(r.checkModelKeys(model, keys, keys).servable).toBe(true);
        const result = await r.call(
          model,
          "s",
          "u",
          undefined,
          undefined,
          undefined,
          keys,
          undefined,
          undefined,
          undefined,
          keys,
        );

        expect(result.provider).toBe("openai");
        expect(fallback.call).toHaveBeenCalledOnce();
      });
    });
  });
});

describe("the tool loop keeps the conversation", () => {
  const PRIMARY = { provider: "anthropic" as const, name: "claude-sonnet-4-6" };
  const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: {} }];
  const INPUT = "Find two values.";
  const INPUT_PARTS = [{ kind: "text" as const, text: INPUT }];
  const AGENT = { name: "agent", version: "1.0.0", environmentId: "env" };

  type Step = Partial<LLMCallResponse> | Error | "hang" | "hang-then-fail";

  /**
   * A provider that answers from a script, returns each answer as its own
   * native turn, and keeps every request as it was when sent (a clone: the
   * router appending a turn afterwards must not show in an earlier capture).
   */
  function scripted(name: string, steps: Step[]) {
    const requests: LLMCallRequest[] = [];
    let index = 0;
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(structuredClone(request));
      const step = steps[index++];
      if (step === undefined) throw new Error(`${name}: called more often than scripted`);
      if (step instanceof Error) throw step;
      if (step === "hang") {
        return new Promise<LLMCallResponse>((resolve) => {
          setTimeout(
            () =>
              resolve({
                content: "too late",
                assistantTurn: { provider: name, content: "too late" },
                usage: { promptTokens: 1, completionTokens: 1 },
              }),
            10 * 60_000,
          );
        });
      }
      if (step === "hang-then-fail") {
        return new Promise<LLMCallResponse>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`${name}: no answer before its own timeout`)),
            10 * 60_000,
          );
        });
      }
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls,
        assistantTurn: step.assistantTurn ?? { provider: name, content: { answer: index } },
        usage: step.usage ?? { promptTokens: 100, completionTokens: 20 },
      };
    });
    const provider: LLMProvider = { name, call };
    return { provider, requests, call };
  }

  const turn = (provider: string, label: string): NativeTurn => ({
    provider,
    content: [{ type: "witness", label }],
  });
  const asksFor = (id: string, q: string, nativeTurn: NativeTurn): Partial<LLMCallResponse> => ({
    toolCalls: [{ name: "lookup", args: { q }, id }],
    assistantTurn: nativeTurn,
  });
  const answer = vi.fn(async (call: ToolCallRequest) => ({
    name: call.name,
    result: `value of ${String(call.args.q)}`,
    id: call.id,
  }));

  beforeEach(() => {
    answer.mockClear();
  });

  it("each request carries every earlier turn as returned with its results, and the response returns the whole conversation", async () => {
    const t1 = turn("anthropic", "first");
    const t2 = turn("anthropic", "second");
    const t3 = turn("anthropic", "final");
    const { provider, requests } = scripted("anthropic", [
      asksFor("call-1", "a", t1),
      asksFor("call-2", "b", t2),
      { content: "done", assistantTurn: t3 },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    const result = await r.call(PRIMARY, "sys", INPUT, TOOLS, answer);

    const r1 = {
      kind: "tool_results",
      results: [{ name: "lookup", result: "value of a", id: "call-1" }],
    };
    const r2 = {
      kind: "tool_results",
      results: [{ name: "lookup", result: "value of b", id: "call-2" }],
    };
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.userContent).toEqual(INPUT_PARTS);
    expect(requests[0].history).toEqual([]);
    expect(requests[1].history).toEqual([{ kind: "assistant", turn: t1 }, r1]);
    expect(requests[2].history).toEqual([
      { kind: "assistant", turn: t1 },
      r1,
      { kind: "assistant", turn: t2 },
      r2,
    ]);
    expect(result.content).toBe("done");
    expect(result.history).toEqual({
      provider: "anthropic",
      model: PRIMARY.name,
      input: INPUT_PARTS,
      entries: [
        { kind: "assistant", turn: t1 },
        r1,
        { kind: "assistant", turn: t2 },
        r2,
        { kind: "assistant", turn: t3 },
      ],
    });
  });

  it("a result returned without an id carries the id of the call it answers", async () => {
    const { provider, requests } = scripted("anthropic", [
      asksFor("call-1", "a", turn("anthropic", "first")),
      { content: "done" },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);
    const withoutId = vi.fn(async (call: ToolCallRequest) => ({ name: call.name, result: "ok" }));

    await r.call(PRIMARY, "sys", INPUT, TOOLS, withoutId);

    expect(requests[1].history?.[1]).toEqual({
      kind: "tool_results",
      results: [{ name: "lookup", result: "ok", id: "call-1" }],
    });
  });

  it("the tool-choice directive goes with the first turn only, and every turn shares the run's cache key", async () => {
    const { provider, requests } = scripted("anthropic", [
      asksFor("call-1", "a", turn("anthropic", "first")),
      asksFor("call-2", "b", turn("anthropic", "second")),
      { content: "done" },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    await r.call(
      PRIMARY,
      "sys",
      INPUT,
      TOOLS,
      answer,
      undefined,
      undefined,
      { mode: "specific", tool: "lookup" },
      undefined,
      AGENT,
    );

    expect(requests.map((q) => q.toolChoice)).toEqual([
      { mode: "specific", tool: "lookup" },
      { mode: "auto" },
      { mode: "auto" },
    ]);
    const keys = new Set(requests.map((q) => q.cacheKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f]+$/);
  });

  it("usage over three turns is the sum of each turn's, nothing counted twice as the conversation grows", async () => {
    const { provider } = scripted("anthropic", [
      {
        ...asksFor("call-1", "a", turn("anthropic", "first")),
        usage: { promptTokens: 1_000, completionTokens: 50, cacheWriteTokens: 400 },
      },
      {
        ...asksFor("call-2", "b", turn("anthropic", "second")),
        usage: { promptTokens: 300, completionTokens: 60, cacheReadTokens: 900 },
      },
      {
        content: "done",
        usage: { promptTokens: 200, completionTokens: 70, cacheReadTokens: 1_100 },
      },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    const result = await r.call(PRIMARY, "sys", INPUT, TOOLS, answer);

    expect(result.usage).toEqual({
      promptTokens: 1_500,
      completionTokens: 180,
      totalTokens: 1_680,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 400,
    });
    expect(result.estimatedCost).toBe(estimateCost(PRIMARY.name, 1_500, 180, 2_000, 400));
  });

  it("a ceiling passed at the second turn stops the loop there, flagged, the conversation ending on the last results: the turn whose calls never ran is left out", async () => {
    const usage = { promptTokens: 1_000, completionTokens: 200 };
    const t1 = turn("anthropic", "first");
    const t2 = turn("anthropic", "second");
    const { provider, call } = scripted("anthropic", [
      { ...asksFor("call-1", "a", t1), usage },
      { ...asksFor("call-2", "b", t2), usage },
      { ...asksFor("call-3", "c", turn("anthropic", "third")), usage },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);
    const perTurn = estimateCost(PRIMARY.name, usage.promptTokens, usage.completionTokens);

    const result = await r.call(
      PRIMARY,
      "sys",
      INPUT,
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: perTurn * 1.5 },
    );

    expect(result.costExceeded).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(result.history?.entries).toEqual([
      { kind: "assistant", turn: t1 },
      { kind: "tool_results", results: [{ name: "lookup", result: "value of a", id: "call-1" }] },
    ]);
    expect(result.history?.entries).not.toContainEqual({ kind: "assistant", turn: t2 });
  });

  it("a ceiling passed on a turn that calls nothing keeps that turn: it has nothing left unanswered", async () => {
    const usage = { promptTokens: 1_000, completionTokens: 200 };
    const t1 = turn("anthropic", "first");
    const t2 = turn("anthropic", "final");
    const { provider } = scripted("anthropic", [
      { ...asksFor("call-1", "a", t1), usage },
      { content: "done", assistantTurn: t2, usage },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);
    const perTurn = estimateCost(PRIMARY.name, usage.promptTokens, usage.completionTokens);

    const result = await r.call(
      PRIMARY,
      "sys",
      INPUT,
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: perTurn * 1.5 },
    );

    expect(result.costExceeded).toBe(true);
    expect(result.history?.entries.at(-1)).toEqual({ kind: "assistant", turn: t2 });
  });

  it("calls with no handler to run them are left out of the conversation, the text that came with them still returned", async () => {
    const t1 = turn("anthropic", "asks with no one to answer");
    const { provider } = scripted("anthropic", [
      { content: "partial text", ...asksFor("call-1", "a", t1) },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    const result = await r.call(PRIMARY, "sys", INPUT, TOOLS);

    expect(result.content).toBe("partial text");
    expect(result.history?.entries).toEqual([]);
  });

  it("the iteration bound ends the conversation on the last tool results", async () => {
    const steps = Array.from({ length: 10 }, (_, i) =>
      asksFor(`call-${i}`, `q${i}`, turn("anthropic", `turn-${i}`)),
    );
    const { provider, call } = scripted("anthropic", steps);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    const result = await r.call(PRIMARY, "sys", INPUT, TOOLS, answer);

    expect(call).toHaveBeenCalledTimes(10);
    expect(result.content).toMatch(/Max tool iterations reached/);
    expect(result.history?.entries).toHaveLength(20);
    expect(result.history?.entries.at(-1)?.kind).toBe("tool_results");
  });

  it("a primary that fails after a tool turn fails the call: the fallback is never called, so no tool runs twice", async () => {
    const primary = scripted("anthropic", [
      asksFor("call-1", "a", turn("anthropic", "primary-first")),
      new Error("anthropic failed"),
    ]);
    const fallback = scripted("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    await expect(
      r.call(
        { ...PRIMARY, fallback: { provider: "openai", name: "gpt-4o" } },
        "sys",
        INPUT,
        TOOLS,
        answer,
      ),
    ).rejects.toThrow("anthropic failed");

    expect(primary.requests).toHaveLength(2);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(fallback.requests).toHaveLength(0);
  });

  it("a primary that goes unanswered after a tool turn is waited on — no failover timer once a tool has run — and its own failure fails the call, the fallback never called", async () => {
    vi.useFakeTimers();
    try {
      const primary = scripted("anthropic", [
        asksFor("call-1", "a", turn("anthropic", "primary-first")),
        "hang-then-fail",
      ]);
      const fallback = scripted("openai", [{ content: "from the fallback" }]);
      const r = new LLMRouter();
      r.registerProvider("anthropic", primary.provider);
      r.registerProvider("openai", fallback.provider);

      const outcome = r
        .call(
          { ...PRIMARY, fallback: { provider: "openai", name: "gpt-4o" } },
          "sys",
          INPUT,
          TOOLS,
          answer,
        )
        .then(
          (value) => value,
          (err: unknown) => err,
        );
      // Past the failover delay of a call of the model: nothing hands over.
      await vi.advanceTimersByTimeAsync(46_000);
      expect(fallback.requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(await outcome).toMatchObject({
        message: "anthropic: no answer before its own timeout",
      });
      expect(primary.requests).toHaveLength(2);
      expect(answer).toHaveBeenCalledTimes(1);
      expect(fallback.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("continuing a conversation a previous call returned", () => {
    const priorTurn = turn("anthropic", "prior-final");
    const prior: ConversationHistory = {
      provider: "anthropic",
      model: PRIMARY.name,
      input: INPUT_PARTS,
      entries: [{ kind: "assistant", turn: priorTurn }],
    };
    const FOLLOW_UP = "Now answer in JSON.";

    it("the same provider and model get it back, the new message appended, and return it extended", async () => {
      const nextTurn = turn("anthropic", "follow-up");
      const { provider, requests } = scripted("anthropic", [
        { content: "{}", assistantTurn: nextTurn },
      ]);
      const r = new LLMRouter();
      r.registerProvider("anthropic", provider);

      const result = await r.call(
        PRIMARY,
        "sys",
        FOLLOW_UP,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { history: prior },
      );

      const followUp = { kind: "user", parts: [{ kind: "text", text: FOLLOW_UP }] };
      expect(requests[0].userContent).toEqual(INPUT_PARTS);
      expect(requests[0].history).toEqual([{ kind: "assistant", turn: priorTurn }, followUp]);
      expect(result.history).toEqual({
        provider: "anthropic",
        model: PRIMARY.name,
        input: INPUT_PARTS,
        entries: [
          { kind: "assistant", turn: priorTurn },
          followUp,
          { kind: "assistant", turn: nextTurn },
        ],
      });
      // The caller's conversation is not modified.
      expect(prior.entries).toHaveLength(1);
    });

    it("another model of the same provider ignores it and starts from the new message alone", async () => {
      const { provider, requests } = scripted("anthropic", [{ content: "{}" }]);
      const r = new LLMRouter();
      r.registerProvider("anthropic", provider);

      await r.call(
        { provider: "anthropic", name: "claude-haiku-4-5" },
        "sys",
        FOLLOW_UP,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { history: prior },
      );

      expect(requests[0].userContent).toEqual([{ kind: "text", text: FOLLOW_UP }]);
      expect(requests[0].history).toEqual([]);
    });

    it("another provider ignores it and starts from the new message alone", async () => {
      const { provider, requests } = scripted("openai", [{ content: "{}" }]);
      const r = new LLMRouter();
      r.registerProvider("openai", provider);

      await r.call(
        { provider: "openai", name: PRIMARY.name },
        "sys",
        FOLLOW_UP,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { history: prior },
      );

      expect(requests[0].userContent).toEqual([{ kind: "text", text: FOLLOW_UP }]);
      expect(requests[0].history).toEqual([]);
    });

    it("a conversation the fallback produced goes to the fallback's attempt only, never to the primary's", async () => {
      const fromFallback: ConversationHistory = {
        provider: "openai",
        model: "gpt-4o",
        input: INPUT_PARTS,
        entries: [{ kind: "assistant", turn: turn("openai", "fallback-final") }],
      };
      const primary = scripted("anthropic", [new Error("anthropic failed")]);
      const fallback = scripted("openai", [{ content: "{}" }]);
      const r = new LLMRouter();
      r.registerProvider("anthropic", primary.provider);
      r.registerProvider("openai", fallback.provider);

      await r.call(
        { ...PRIMARY, fallback: { provider: "openai", name: "gpt-4o" } },
        "sys",
        FOLLOW_UP,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { history: fromFallback },
      );

      expect(primary.requests[0].userContent).toEqual([{ kind: "text", text: FOLLOW_UP }]);
      expect(primary.requests[0].history).toEqual([]);
      expect(fallback.requests[0].userContent).toEqual(INPUT_PARTS);
      expect(fallback.requests[0].history).toEqual([
        ...fromFallback.entries,
        { kind: "user", parts: [{ kind: "text", text: FOLLOW_UP }] },
      ]);
    });

    describe("a declared base_url: the same provider's name over another API, so the conversation also keeps its destination", () => {
      // The primary at the agent's endpoint, its fallback the same provider and
      // model at the provider's own API: both adapters carry the name
      // "anthropic", and their turns two different shapes.
      const ENDPOINT = "https://llm.example.test/v1";
      const AT_ENDPOINT = {
        ...PRIMARY,
        base_url: ENDPOINT,
        fallback: { provider: "anthropic" as const, name: PRIMARY.name },
      };
      const KEYS = { anthropic: "sk-ant-caller" };
      const followUp = { kind: "user", parts: [{ kind: "text", text: FOLLOW_UP }] };
      const endpointTurn: NativeTurn = {
        provider: "anthropic",
        content: { role: "assistant", content: "at the endpoint" },
      };
      const nativeTurn: NativeTurn = {
        provider: "anthropic",
        content: [{ type: "text", text: "at the provider's own API" }],
      };

      type Script = Array<Partial<LLMCallResponse> | Error>;

      /**
       * The two adapters the router builds for a caller key — the
       * OpenAI-compatible one for the endpoint, the native one for the
       * fallback — each answering from its script and keeping every request
       * as it was sent.
       */
      function adapters(endpoint: Script, native: Script) {
        const seen: Record<"endpoint" | "native", LLMCallRequest[]> = { endpoint: [], native: [] };
        const play =
          (side: "endpoint" | "native", script: Script) =>
          async (request: LLMCallRequest): Promise<LLMCallResponse> => {
            seen[side].push(structuredClone(request));
            const step = script.shift();
            if (step === undefined) throw new Error(`${side}: called more often than scripted`);
            if (step instanceof Error) throw step;
            return {
              content: step.content ?? "",
              assistantTurn: step.assistantTurn ?? { provider: "anthropic", content: [] },
              usage: { promptTokens: 10, completionTokens: 2 },
            };
          };
        const spies = [
          vi
            .spyOn(OpenAICompatibleProvider.prototype, "call")
            .mockImplementation(play("endpoint", endpoint)),
          vi.spyOn(AnthropicProvider.prototype, "call").mockImplementation(play("native", native)),
        ];
        return {
          seen,
          restore: () => {
            for (const spy of spies) spy.mockRestore();
          },
        };
      }

      const callAtEndpoint = (r: LLMRouter, message: string, history?: ConversationHistory) =>
        r.call(
          AT_ENDPOINT,
          "sys",
          message,
          undefined,
          undefined,
          undefined,
          KEYS,
          undefined,
          undefined,
          undefined,
          undefined,
          history && { history },
        );

      it("a conversation held at the agent's endpoint goes back there, never to the fallback at the provider's own API", async () => {
        const { seen, restore } = adapters(
          [{ content: "{", assistantTurn: endpointTurn }, new Error("the endpoint failed")],
          [{ content: "{}" }],
        );
        try {
          const r = new LLMRouter();
          const first = await callAtEndpoint(r, INPUT);
          await callAtEndpoint(r, FOLLOW_UP, first.history);

          expect(seen.endpoint).toHaveLength(2);
          expect(seen.endpoint[1].userContent).toEqual(INPUT_PARTS);
          expect(seen.endpoint[1].history).toEqual([
            { kind: "assistant", turn: endpointTurn },
            followUp,
          ]);
          expect(seen.native).toHaveLength(1);
          expect(seen.native[0].userContent).toEqual([{ kind: "text", text: FOLLOW_UP }]);
          expect(seen.native[0].history).toEqual([]);
        } finally {
          restore();
        }
      });

      it("a conversation held at the provider's own API goes back there, never to the primary at the agent's endpoint", async () => {
        const { seen, restore } = adapters(
          [new Error("the endpoint failed"), new Error("the endpoint failed again")],
          [{ content: "{", assistantTurn: nativeTurn }, { content: "{}" }],
        );
        try {
          const r = new LLMRouter();
          const first = await callAtEndpoint(r, INPUT);
          await callAtEndpoint(r, FOLLOW_UP, first.history);

          expect(seen.endpoint).toHaveLength(2);
          expect(seen.endpoint[1].userContent).toEqual([{ kind: "text", text: FOLLOW_UP }]);
          expect(seen.endpoint[1].history).toEqual([]);
          expect(seen.native).toHaveLength(2);
          expect(seen.native[1].userContent).toEqual(INPUT_PARTS);
          expect(seen.native[1].history).toEqual([
            { kind: "assistant", turn: nativeTurn },
            followUp,
          ]);
        } finally {
          restore();
        }
      });
    });

    it("the capability check reads the conversation's input as well as the new message, before any provider call", async () => {
      const withAudio: ConversationHistory = {
        ...prior,
        input: [{ kind: "audio", media_type: "audio/wav", bytes: new Uint8Array([1, 2, 3]) }],
      };
      const { provider, call } = scripted("anthropic", [{ content: "{}" }]);
      const r = new LLMRouter();
      r.registerProvider("anthropic", provider);

      await expect(
        r.call(
          PRIMARY,
          "sys",
          FOLLOW_UP,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { history: withAudio },
        ),
      ).rejects.toBeInstanceOf(LLMCapabilityError);
      expect(call).not.toHaveBeenCalled();
    });
  });

  it("the capability check still refuses, at the first call, a part the model cannot read", async () => {
    const { provider, call } = scripted("anthropic", [{ content: "{}" }]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    await expect(
      r.call(PRIMARY, "sys", [
        { kind: "text", text: INPUT },
        { kind: "audio", media_type: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
      ]),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("a temperature the model refuses is not sent, and the degradation is logged", () => {
  /**
   * A router whose log lines are kept — each with its message, which tells
   * the two reasons apart —, with one provider per name that records each
   * request — and fails it, for a name in `failing`.
   */
  function routerWith(names: string[], failing: string[] = []) {
    const logged: Array<Record<string, unknown>> = [];
    const keep = (obj: Record<string, unknown>, msg?: string) => {
      logged.push({ ...obj, msg });
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    const r = new LLMRouter(logger);
    const requests: Record<string, LLMCallRequest[]> = {};
    for (const name of names) {
      requests[name] = [];
      r.registerProvider(name, {
        name,
        call: vi.fn(async (request: LLMCallRequest) => {
          requests[name]?.push(structuredClone(request));
          if (failing.includes(name)) throw new Error(`${name} failed`);
          return {
            content: "ok",
            assistantTurn: { provider: name, content: [] },
            usage: { promptTokens: 10, completionTokens: 2 },
          };
        }),
      });
    }
    const gaps = () => logged.filter((l) => l.event === "provider_gap");
    return { r, requests, gaps };
  }

  it("a model the matrix marks as refusing one gets none, and one provider_gap line names it", async () => {
    const { r, requests, gaps } = routerWith(["anthropic"]);

    await r.call(
      { provider: "anthropic", name: "claude-opus-4-7-20260416", temperature: 0.3 },
      "sys",
      "hi",
    );

    expect(requests.anthropic?.[0]?.temperature).toBeUndefined();
    expect(gaps()).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-7-20260416",
        gap: "temperature_not_supported",
        msg: expect.stringContaining("does not accept a temperature"),
      }),
    ]);
  });

  it.each([
    ["a model that accepts one", "anthropic", "claude-sonnet-4-6"],
    [
      "a model the matrix does not know, of a provider that gets it as declared",
      "mistral",
      "mistral-unlisted-9",
    ],
  ] as const)("%s gets it, as declared, and nothing is logged", async (_case, provider, name) => {
    const { r, requests, gaps } = routerWith([provider]);

    await r.call({ provider, name, temperature: 0.3 }, "sys", "hi");

    expect(requests[provider]?.[0]?.temperature).toBe(0.3);
    expect(gaps()).toEqual([]);
  });

  it.each([
    ["anthropic", "claude-unlisted-9"],
    ["google", "gemini-9.9-flash"],
    ["openai", "gpt-9-unlisted"],
  ] as const)("an unlisted %s model gets none, and one provider_gap line names it", async (provider, name) => {
    const { r, requests, gaps } = routerWith([provider]);

    await r.call({ provider, name, temperature: 0.3 }, "sys", "hi");

    expect(requests[provider]?.[0]?.temperature).toBeUndefined();
    expect(gaps()).toEqual([
      expect.objectContaining({
        provider,
        model: name,
        gap: "temperature_not_supported",
        msg: expect.stringContaining("is not in the capability matrix"),
      }),
    ]);
  });

  it.each([
    ["anthropic", "llama3.1:8b"],
    ["google", "gemma3:4b"],
    ["openai", "qwen3:8b"],
  ] as const)("an unlisted model behind a declared base_url gets it as declared under %s, and nothing is logged", async (provider, name) => {
    const seen: LLMCallRequest[] = [];
    const spy = vi
      .spyOn(OpenAICompatibleProvider.prototype, "call")
      .mockImplementation(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
        seen.push(structuredClone(request));
        return {
          content: "ok",
          assistantTurn: { provider, content: { role: "assistant", content: "ok" } },
          usage: { promptTokens: 10, completionTokens: 2 },
        };
      });
    try {
      const { r, gaps } = routerWith([]);

      await r.call(
        { provider, name, base_url: "https://llm.example.test/v1", temperature: 0.3 },
        "sys",
        "hi",
        undefined,
        undefined,
        undefined,
        { [provider]: "caller-key" },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]?.temperature).toBe(0.3);
      expect(gaps()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("each attempt is judged by its own model: a fallback that accepts one gets it after a primary that refuses it", async () => {
    const { r, requests, gaps } = routerWith(["openai", "google"], ["openai"]);

    await r.call(
      {
        provider: "openai",
        name: "gpt-5",
        temperature: 0.3,
        fallback: { provider: "google", name: "gemini-2.5-flash" },
      },
      "sys",
      "hi",
    );

    expect(requests.openai?.[0]?.temperature).toBeUndefined();
    expect(requests.google?.[0]?.temperature).toBe(0.3);
    expect(gaps()).toEqual([expect.objectContaining({ provider: "openai", model: "gpt-5" })]);
  });
});

describe("LLMRouter — one answer of the model asks for at most 128 tool calls", () => {
  const MODEL = { provider: "anthropic" as const, name: "claude-sonnet-4-6" };
  const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: {} }];

  /** `count` calls of the one tool, each with its own id, all prefixed by `label`. */
  const toolCalls = (count: number, label: string): ToolCallRequest[] =>
    Array.from({ length: count }, (_, i) => ({
      name: "lookup",
      args: { q: `${label}-${i}` },
      id: `${label}-${i}`,
    }));

  /**
   * A provider that answers from a script, each answer with its own turn and
   * usage, and keeps every request as it was when sent.
   */
  function scripted(name: string, steps: Array<Partial<LLMCallResponse>>) {
    const requests: LLMCallRequest[] = [];
    let index = 0;
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(structuredClone(request));
      const step = steps[index++];
      if (step === undefined) throw new Error(`${name}: called more often than scripted`);
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls,
        assistantTurn: { provider: name, content: [{ type: "witness", label: `turn-${index}` }] },
        usage: step.usage ?? { promptTokens: 100, completionTokens: 20 },
      };
    });
    const provider: LLMProvider = { name, call };
    return { provider, call, requests };
  }

  /** A logger that keeps the fields of every line. */
  function capturingLogger() {
    const logged: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      logged.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, logged };
  }

  const answer = vi.fn(async (call: ToolCallRequest) => ({
    name: call.name,
    result: "ok",
    id: call.id,
  }));

  beforeEach(() => {
    answer.mockClear();
  });

  it("an answer asking for 129 tool calls runs none of them and stops the call by name, every turn's usage kept — the 128 of the turn before all ran", async () => {
    const { logger, logged } = capturingLogger();
    const { provider, call } = scripted("anthropic", [
      { toolCalls: toolCalls(128, "first"), usage: { promptTokens: 100, completionTokens: 20 } },
      {
        content: "text that came with the calls",
        toolCalls: toolCalls(129, "second"),
        usage: { promptTokens: 300, completionTokens: 40 },
      },
      { content: "an answer the router never asks for" },
    ]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", provider);

    const result = await r.call(MODEL, "sys", "user", TOOLS, answer);

    // None of the 129 ran; the 128 of the turn before did, each once.
    expect(answer).toHaveBeenCalledTimes(128);
    expect(answer.mock.calls.map(([c]) => c.id)).toEqual(toolCalls(128, "first").map((c) => c.id));
    // The model was not asked again after the refused answer.
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.stopped).toEqual({
      code: "TOO_MANY_TOOL_CALLS",
      message:
        "The model asked for 129 tool calls in one turn; a turn may ask for at most 128. None of them was run.",
    });
    expect(result.content).toBe("");
    // Both turns were billed: the refused one is counted.
    expect(result.usage).toEqual({ promptTokens: 400, completionTokens: 60, totalTokens: 460 });
    expect(result.estimatedCost).toBe(estimateCost(MODEL.name, 400, 60));
    expect(result.provider).toBe("anthropic");
    // The conversation stays one a provider accepts: the refused turn, whose
    // calls got no result, is left out.
    expect(result.history?.entries.map((entry) => entry.kind)).toEqual([
      "assistant",
      "tool_results",
    ]);
    // One line: counts and the bound, never a content.
    expect(logged.filter((line) => line.event === "model_bound_refused")).toEqual([
      {
        event: "model_bound_refused",
        provider: "anthropic",
        model: MODEL.name,
        code: "TOO_MANY_TOOL_CALLS",
        limit: 128,
        calls: 129,
      },
    ]);
  });

  it("128 tool calls in one answer, exactly the bound, all run, and the call ends as usual", async () => {
    const { logger, logged } = capturingLogger();
    const { provider, call } = scripted("anthropic", [
      { toolCalls: toolCalls(128, "only") },
      { content: "done" },
    ]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", provider);

    const result = await r.call(MODEL, "sys", "user", TOOLS, answer);

    expect(answer).toHaveBeenCalledTimes(128);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("done");
    expect(result).not.toHaveProperty("stopped");
    expect(logged.some((line) => line.event === "model_bound_refused")).toBe(false);
  });

  it("129 tool calls in the primary's first answer, no tool run yet: the fallback takes over from the input, the primary's turn left behind and its billed tokens counted, each at its model's price", async () => {
    const { logger, logged } = capturingLogger();
    const primary = scripted("anthropic", [
      { toolCalls: toolCalls(129, "primary"), usage: { promptTokens: 700, completionTokens: 90 } },
    ]);
    const fallback = scripted("openai", [
      { content: "from the fallback", usage: { promptTokens: 30, completionTokens: 7 } },
    ]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
    );

    expect(result.provider).toBe("openai");
    expect(result.content).toBe("from the fallback");
    expect(result).not.toHaveProperty("stopped");
    expect(answer).not.toHaveBeenCalled();
    expect(primary.call).toHaveBeenCalledTimes(1);
    // The fallback sees no turn of the primary: it starts from the input.
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.requests[0]?.userContent).toEqual([{ kind: "text", text: "user" }]);
    expect(fallback.requests[0]?.history).toEqual([]);
    // The refused answer was billed: its tokens are the run's too, priced at the
    // primary's model, the fallback's at its own.
    expect(result.usage).toEqual({ promptTokens: 730, completionTokens: 97, totalTokens: 827 });
    expect(result.estimatedCost).toBe(
      estimateCost(MODEL.name, 700, 90) + estimateCost("gpt-4o", 30, 7),
    );
    // The refusal, then the hand-over, named by the stop's code.
    expect(
      logged
        .filter((line) => line.event === "model_bound_refused" || line.event === "primary_failed")
        .map((line) => [line.event, line.code ?? line.stop]),
    ).toEqual([
      ["model_bound_refused", "TOO_MANY_TOOL_CALLS"],
      ["primary_failed", "TOO_MANY_TOOL_CALLS"],
    ]);
  });

  it("129 tool calls in the primary's third answer, after its tools ran: the call stops there, the fallback never called", async () => {
    const primary = scripted("anthropic", [
      { toolCalls: toolCalls(1, "first") },
      { toolCalls: toolCalls(1, "second") },
      { toolCalls: toolCalls(129, "third") },
    ]);
    const fallback = scripted("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
    );

    expect(fallback.call).not.toHaveBeenCalled();
    expect(result.provider).toBe("anthropic");
    expect(result.stopped?.code).toBe("TOO_MANY_TOOL_CALLS");
    expect(result.content).toBe("");
    expect(answer).toHaveBeenCalledTimes(2);
    // The three turns of the primary, each 100 + 20.
    expect(result.usage).toEqual({ promptTokens: 300, completionTokens: 60, totalTokens: 360 });
  });

  it("129 tool calls with no handler to run them stop the call all the same", async () => {
    const { provider } = scripted("anthropic", [
      { content: '{"result":"ok"}', toolCalls: toolCalls(129, "unhandled") },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    // No tools and no handler: the loop could only return the text.
    const result = await r.call(MODEL, "sys", "user");

    expect(result.stopped?.code).toBe("TOO_MANY_TOOL_CALLS");
    expect(result.content).toBe("");
  });

  // An answer over both bounds: the call bound is read first, so it is the
  // one the call stops on — and the one the fallback may take over from.
  const HEAVY_USAGE = { promptTokens: 10_000, completionTokens: 2_000 };
  const HEAVY_COST = estimateCost(
    MODEL.name,
    HEAVY_USAGE.promptTokens,
    HEAVY_USAGE.completionTokens,
  );

  it("an answer over both the call bound and the spend ceiling stops on the call bound, none of its calls run", async () => {
    // The scenario holds only if this answer alone passes the ceiling.
    expect(HEAVY_COST).toBeGreaterThan(0);
    const { provider, call } = scripted("anthropic", [
      { toolCalls: toolCalls(129, "both"), usage: HEAVY_USAGE },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", provider);

    const result = await r.call(
      MODEL,
      "sys",
      "user",
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: HEAVY_COST / 2 },
    );

    expect(result.stopped?.code).toBe("TOO_MANY_TOOL_CALLS");
    expect(result).not.toHaveProperty("costExceeded");
    expect(result.content).toBe("");
    expect(answer).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("the same answer as the primary's first, a fallback declared: the refused answer alone spent more than the whole max_cost — the fallback is never called, and the call stops on the call bound, as without a fallback, the refused answer's usage and cost counted", async () => {
    const { logger, logged } = capturingLogger();
    const primary = scripted("anthropic", [
      { toolCalls: toolCalls(129, "both"), usage: HEAVY_USAGE },
    ]);
    const fallback = scripted("openai", [
      {
        content: "from the fallback",
        toolCalls: toolCalls(1, "fallback"),
        usage: { promptTokens: 30, completionTokens: 7 },
      },
      { content: "the fallback's answer after its tool" },
    ]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: HEAVY_COST / 2 },
    );

    // Nothing is left of the ceiling for the fallback: no call of it is billed.
    expect(fallback.call).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    // The call stops on the bound, read before the cost, as a primary without
    // a fallback does — with the refused answer's usage and cost.
    expect(result.provider).toBe("anthropic");
    expect(result.content).toBe("");
    expect(result.stopped?.code).toBe("TOO_MANY_TOOL_CALLS");
    expect(result).not.toHaveProperty("costExceeded");
    expect(result.usage).toEqual({
      promptTokens: HEAVY_USAGE.promptTokens,
      completionTokens: HEAVY_USAGE.completionTokens,
      totalTokens: HEAVY_USAGE.promptTokens + HEAVY_USAGE.completionTokens,
    });
    expect(result.estimatedCost).toBe(HEAVY_COST);
    // The primary's line says the fallback does not take over, and why.
    expect(
      logged
        .filter((line) => line.event === "primary_failed")
        .map((line) => [line.stop, line.fallback]),
    ).toEqual([["TOO_MANY_TOOL_CALLS", false]]);
  });

  it("a max_cost the primary's refused answer nearly used up: the fallback is handed what is left of it, and stops on it sooner — after its first answer, none of its tools run", async () => {
    const primaryUsage = { promptTokens: 700, completionTokens: 90 };
    const fallbackUsage = { promptTokens: 30, completionTokens: 7 };
    const primaryCost = estimateCost(
      MODEL.name,
      primaryUsage.promptTokens,
      primaryUsage.completionTokens,
    );
    const fallbackCost = estimateCost(
      "gpt-4o",
      fallbackUsage.promptTokens,
      fallbackUsage.completionTokens,
    );
    // A ceiling the fallback's first answer alone stays under, which the two
    // answers together pass.
    const maxCost = primaryCost + fallbackCost / 2;
    expect(fallbackCost).toBeLessThan(maxCost);
    const primary = scripted("anthropic", [
      { toolCalls: toolCalls(129, "primary"), usage: primaryUsage },
    ]);
    const fallback = scripted("openai", [
      { toolCalls: toolCalls(1, "fallback"), usage: fallbackUsage },
      { content: "the fallback's answer after its tool", usage: fallbackUsage },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost },
    );

    expect(result.provider).toBe("openai");
    expect(result.costExceeded).toBe(true);
    expect(fallback.call).toHaveBeenCalledTimes(1);
    expect(answer).not.toHaveBeenCalled();
    expect(result.estimatedCost).toBe(primaryCost + fallbackCost);
    expect(result.estimatedCost).toBeGreaterThan(maxCost);
  });

  it("a max_cost the primary's refused answer spent exactly: not past it, as the caller reads it — the fallback is called, with nothing left", async () => {
    const primaryUsage = { promptTokens: 700, completionTokens: 90 };
    const primaryCost = estimateCost(
      MODEL.name,
      primaryUsage.promptTokens,
      primaryUsage.completionTokens,
    );
    const primary = scripted("anthropic", [
      { toolCalls: toolCalls(129, "primary"), usage: primaryUsage },
    ]);
    const fallback = scripted("openai", [
      { content: "from the fallback", usage: { promptTokens: 30, completionTokens: 7 } },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: primaryCost },
    );

    expect(fallback.call).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("openai");
    expect(result).not.toHaveProperty("stopped");
    expect(result.costExceeded).toBe(true);
  });

  it("the cache tokens of a primary the fallback replaced are counted with the fallback's", async () => {
    const primary = scripted("anthropic", [
      {
        toolCalls: toolCalls(129, "primary"),
        usage: {
          promptTokens: 700,
          completionTokens: 90,
          cacheReadTokens: 50,
          cacheWriteTokens: 20,
        },
      },
    ]);
    const fallback = scripted("openai", [
      {
        content: "from the fallback",
        usage: { promptTokens: 30, completionTokens: 7, cacheReadTokens: 5 },
      },
    ]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(
      { ...MODEL, fallback: { provider: "openai", name: "gpt-4o" } },
      "sys",
      "user",
      TOOLS,
      answer,
    );

    expect(result.provider).toBe("openai");
    expect(result.usage).toEqual({
      promptTokens: 730,
      completionTokens: 97,
      totalTokens: 827,
      cacheReadTokens: 55,
      cacheWriteTokens: 20,
    });
    expect(result.estimatedCost).toBe(
      estimateCost(MODEL.name, 700, 90, 50, 20) + estimateCost("gpt-4o", 30, 7, 5),
    );
  });
});

// Each answer of the model is counted as the conversation keeps it — its turn
// exactly as the provider returned it, as JSON, in bytes of UTF-8 — and what a
// run keeps of them is held to 4 MiB. The turns below have the shape of an
// OpenAI-compatible endpoint's (the one a model.base_url answers in): its
// text, its reasoning, its tool calls with their arguments as the model wrote
// them. Each case builds them to an exact weight.
describe("LLMRouter — the answers of the model a run keeps weigh at most 4 MiB", () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  const BUDGET_MESSAGE =
    "The model's answers in this run weigh more than 4 MiB (4194304 bytes), the most a run keeps of them — each answer counted as the conversation keeps it, as the provider returned it: its text, its reasoning and its tool calls.";
  const MODEL = { provider: "openai" as const, name: "gpt-4o" };
  const WITH_FALLBACK = {
    ...MODEL,
    fallback: { provider: "anthropic" as const, name: "claude-sonnet-4-6" },
  };
  const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: {} }];

  /** What an answer weighs: its turn as the provider returned it, as JSON, in bytes of UTF-8. */
  const weight = (turn: NativeTurn): number => Buffer.byteLength(JSON.stringify(turn));

  /** A turn in the shape of an OpenAI-compatible endpoint's. */
  const turnOf = (provider: string, message: Record<string, unknown>): NativeTurn => ({
    provider,
    content: { role: "assistant", content: null, ...message },
  });

  /**
   * `bytes` bytes of UTF-8 text: "é" (two bytes) and "😀" (four) when `wide`,
   * as many as fit, then plain letters; plain letters only otherwise.
   */
  function textOf(bytes: number, wide = false): string {
    if (!wide) return "a".repeat(bytes);
    const pairs = Math.floor(bytes / 6);
    return "é😀".repeat(pairs) + "a".repeat(bytes - pairs * 6);
  }

  type Carrier = "text" | "wide text" | "reasoning" | "raw arguments";

  /**
   * An answer asking for one call of `lookup`, its turn weighing exactly
   * `bytes`, the weight carried where `carrier` says. Raw arguments are not
   * valid JSON: the call reaches the router with its arguments parsed to `{}`,
   * and the turn keeps them as the model wrote them.
   */
  function askingAnswer(
    id: string,
    bytes: number,
    carrier: Carrier,
  ): Partial<LLMCallResponse> & {
    turn: NativeTurn;
  } {
    const call = (args: string) => [
      { id, type: "function", function: { name: "lookup", arguments: args } },
    ];
    const build = (fill: string): NativeTurn => {
      switch (carrier) {
        case "text":
        case "wide text":
          return turnOf("openai", { content: fill, tool_calls: call('{"q":"x"}') });
        case "reasoning":
          return turnOf("openai", { reasoning_content: fill, tool_calls: call('{"q":"x"}') });
        case "raw arguments":
          return turnOf("openai", { tool_calls: call(`{"q": "${fill}`) });
      }
    };
    const fill = textOf(bytes - weight(build("")), carrier === "wide text");
    const turn = build(fill);
    expect(weight(turn)).toBe(bytes);
    return {
      turn,
      content: carrier === "text" || carrier === "wide text" ? fill : "",
      toolCalls: [{ name: "lookup", args: carrier === "raw arguments" ? {} : { q: "x" }, id }],
    };
  }

  /** A final answer, its turn weighing exactly `bytes`, its text a valid output followed by padding. */
  function finalAnswer(
    provider: string,
    bytes: number,
  ): Partial<LLMCallResponse> & {
    turn: NativeTurn;
  } {
    const head = '{"result":"done"}';
    const build = (pad: string) => turnOf(provider, { content: head + pad });
    const turn = build(textOf(bytes - weight(build(""))));
    expect(weight(turn)).toBe(bytes);
    return { turn, content: (turn.content as { content: string }).content };
  }

  /** A provider that answers from a script, each answer with the turn the step gives. */
  function scripted(name: string, steps: Array<Partial<LLMCallResponse> & { turn: NativeTurn }>) {
    let index = 0;
    const call = vi.fn(async (): Promise<LLMCallResponse> => {
      const step = steps[index++];
      if (step === undefined) throw new Error(`${name}: called more often than scripted`);
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls,
        assistantTurn: step.turn,
        usage: step.usage ?? { promptTokens: 100, completionTokens: 20 },
      };
    });
    const provider: LLMProvider = { name, call };
    return { provider, call };
  }

  /** A logger that keeps the fields of every line. */
  function capturingLogger() {
    const logged: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      logged.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, logged };
  }

  const answer = vi.fn(async (call: ToolCallRequest) => ({
    name: call.name,
    result: "ok",
    id: call.id,
  }));

  beforeEach(() => {
    answer.mockClear();
  });

  /** The options bag of `call()`, the twelfth argument. */
  const withOptions = (
    router: LLMRouter,
    model: Parameters<LLMRouter["call"]>[0],
    opts: Parameters<LLMRouter["call"]>[11],
  ) =>
    router.call(
      model,
      "sys",
      "user",
      TOOLS,
      answer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts,
    );

  // Three answers: two asking for a tool, carrying the weight, then a small
  // final one. Their sum is the case's; the third answer is the one that
  // reaches it.
  const FINAL_BYTES = 128;
  const threeAnswers = (total: number, carrier: Carrier) => {
    const first = Math.floor((total - FINAL_BYTES) / 2);
    return [
      askingAnswer("call-1", first, carrier),
      askingAnswer("call-2", total - FINAL_BYTES - first, carrier),
      finalAnswer("openai", FINAL_BYTES),
    ];
  };

  const CARRIERS: Array<[string, Carrier]> = [
    ["their text", "text"],
    ["their text, in characters of two and four bytes", "wide text"],
    ["their reasoning (reasoning_content)", "reasoning"],
    ["a tool call's arguments as the model wrote them, not valid JSON", "raw arguments"],
  ];

  it.each(
    CARRIERS,
  )("three answers weighing 4 MiB + 1 byte in all, by %s: the call stops at the third on MODEL_OUTPUT_BUDGET_EXCEEDED, the two tools before it run", async (_what, carrier) => {
    const { logger, logged } = capturingLogger();
    const { provider, call } = scripted("openai", threeAnswers(FOUR_MIB + 1, carrier));
    const r = new LLMRouter(logger);
    r.registerProvider("openai", provider);
    const budget = { usedBytes: 0 };

    const result = await withOptions(r, MODEL, { outputBudget: budget });

    expect(result.stopped).toEqual({
      code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
      message: BUDGET_MESSAGE,
    });
    expect(result.content).toBe("");
    expect(call).toHaveBeenCalledTimes(3);
    expect(answer).toHaveBeenCalledTimes(2);
    // The three answers were billed: each is counted.
    expect(result.usage).toEqual({ promptTokens: 300, completionTokens: 60, totalTokens: 360 });
    // The budget the call was handed keeps what the call returned.
    expect(budget.usedBytes).toBe(FOUR_MIB + 1);
    // One line: the bound and the count, never a content.
    expect(logged.filter((line) => line.event === "model_bound_refused")).toEqual([
      {
        event: "model_bound_refused",
        provider: "openai",
        model: MODEL.name,
        code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
        limit: FOUR_MIB,
        kept_bytes: FOUR_MIB + 1,
      },
    ]);
  });

  it.each([
    ["4 MiB − 1 byte", FOUR_MIB - 1],
    ["4 MiB exactly, the bound", FOUR_MIB],
  ])("three answers weighing %s in all: the call ends as usual, every answer counted", async (_what, total) => {
    const { logger, logged } = capturingLogger();
    const { provider, call } = scripted("openai", threeAnswers(total, "text"));
    const r = new LLMRouter(logger);
    r.registerProvider("openai", provider);
    const budget = { usedBytes: 0 };

    const result = await withOptions(r, MODEL, { outputBudget: budget });

    expect(result).not.toHaveProperty("stopped");
    expect(result.content.startsWith('{"result":"done"}')).toBe(true);
    expect(call).toHaveBeenCalledTimes(3);
    expect(answer).toHaveBeenCalledTimes(2);
    expect(budget.usedBytes).toBe(total);
    expect(logged.some((line) => line.event === "model_bound_refused")).toBe(false);
  });

  it("a budget an earlier call of the run used: the next call stops as soon as its answers and those pass 4 MiB", async () => {
    const earlier = 3 * 1024 * 1024;
    const asking = askingAnswer("call-1", 1024 * 1024 - 100, "text");
    const { provider, call } = scripted("openai", [asking, finalAnswer("openai", 101)]);
    const r = new LLMRouter();
    r.registerProvider("openai", provider);
    const budget = { usedBytes: earlier };

    const result = await withOptions(r, MODEL, { outputBudget: budget });

    // The first answer leaves 100 bytes; the final one weighs 101.
    expect(result.stopped?.code).toBe("MODEL_OUTPUT_BUDGET_EXCEEDED");
    expect(call).toHaveBeenCalledTimes(2);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(budget.usedBytes).toBe(FOUR_MIB + 1);
  });

  it("a primary refused at its first answer for 129 tool calls: the fallback starts with the whole budget, the refused answer not counted", async () => {
    const calls = Array.from({ length: 129 }, (_, i) => ({
      name: "lookup",
      args: {},
      id: `call-${i}`,
    }));
    // The primary's refused answer weighs 3 MiB; the fallback's, 3 MiB too:
    // counted together they would pass the bound.
    const primary = scripted("openai", [
      { ...askingAnswer("call-0", 3 * 1024 * 1024, "text"), toolCalls: calls },
    ]);
    const fallbackAnswer = finalAnswer("anthropic", 3 * 1024 * 1024);
    const fallback = scripted("anthropic", [fallbackAnswer]);
    const r = new LLMRouter();
    r.registerProvider("openai", primary.provider);
    r.registerProvider("anthropic", fallback.provider);
    const budget = { usedBytes: 0 };

    const result = await withOptions(r, WITH_FALLBACK, { outputBudget: budget });

    expect(result.provider).toBe("anthropic");
    expect(result).not.toHaveProperty("stopped");
    expect(result.content).toBe(fallbackAnswer.content);
    expect(answer).not.toHaveBeenCalled();
    // Only the answer that was kept is counted.
    expect(budget.usedBytes).toBe(3 * 1024 * 1024);
  });

  it("the budget passed at the primary's first answer, a fallback declared: the call stops there, the fallback never called — the answer comes from the model itself", async () => {
    const primary = scripted("openai", [finalAnswer("openai", 2 * 1024 * 1024)]);
    const fallback = scripted("anthropic", [finalAnswer("anthropic", 100)]);
    const r = new LLMRouter();
    r.registerProvider("openai", primary.provider);
    r.registerProvider("anthropic", fallback.provider);

    // What an earlier call of the run kept: 3 MiB.
    const result = await withOptions(r, WITH_FALLBACK, {
      outputBudget: { usedBytes: 3 * 1024 * 1024 },
    });

    expect(result.stopped).toEqual({
      code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
      message: BUDGET_MESSAGE,
    });
    expect(result.provider).toBe("openai");
    expect(fallback.call).not.toHaveBeenCalled();
  });

  it("an answer over both the call bound and the budget, the primary's first: the call bound is read first, and the fallback takes over", async () => {
    const calls = Array.from({ length: 129 }, (_, i) => ({
      name: "lookup",
      args: {},
      id: `call-${i}`,
    }));
    const primary = scripted("openai", [
      { ...askingAnswer("call-0", FOUR_MIB + 1, "text"), toolCalls: calls },
    ]);
    const fallback = scripted("anthropic", [finalAnswer("anthropic", 100)]);
    const r = new LLMRouter();
    r.registerProvider("openai", primary.provider);
    r.registerProvider("anthropic", fallback.provider);

    const result = await withOptions(r, WITH_FALLBACK, { outputBudget: { usedBytes: 0 } });

    expect(result.provider).toBe("anthropic");
    expect(result).not.toHaveProperty("stopped");
    expect(fallback.call).toHaveBeenCalledTimes(1);
  });

  it("an answer over both the budget and the spend ceiling stops on the budget, its call not run", async () => {
    const heavy = { promptTokens: 10_000, completionTokens: 2_000 };
    const heavyCost = estimateCost(MODEL.name, heavy.promptTokens, heavy.completionTokens);
    // The scenario holds only if this answer alone passes the ceiling.
    expect(heavyCost).toBeGreaterThan(0);
    const { provider } = scripted("openai", [
      { ...askingAnswer("call-1", FOUR_MIB + 1, "text"), usage: heavy },
    ]);
    const r = new LLMRouter();
    r.registerProvider("openai", provider);

    const result = await withOptions(r, MODEL, { maxCost: heavyCost / 2 });

    expect(result.stopped?.code).toBe("MODEL_OUTPUT_BUDGET_EXCEEDED");
    expect(result).not.toHaveProperty("costExceeded");
    expect(answer).not.toHaveBeenCalled();
  });

  it("a call handed no budget counts its own answers from zero", async () => {
    const { provider } = scripted("openai", threeAnswers(FOUR_MIB + 1, "text"));
    const r = new LLMRouter();
    r.registerProvider("openai", provider);

    const result = await r.call(MODEL, "sys", "user", TOOLS, answer);

    expect(result.stopped?.code).toBe("MODEL_OUTPUT_BUDGET_EXCEEDED");
    expect(answer).toHaveBeenCalledTimes(2);
  });
});

// An endpoint the agent declares in `model.base_url` answers what it likes. A
// local server stands for it, behind the real guard and the real OpenAI SDK:
// each case scripts its answers, one per request, and counts the requests. The
// endpoint's path carries a word no message may repeat. Real time throughout:
// the SDK's waits between retries are its own timers.
describe("LLMRouter — what a model.base_url may answer: the size of a response, its retries", () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  const TOO_LARGE_MESSAGE =
    "The response of the model endpoint the agent declares (model.base_url) is larger than 4 MiB (4194304 bytes), the most one response may weigh. It was not read further.";
  const BODY_REFUSAL =
    "The response body is larger than 4 MiB (4194304 bytes), the most this request may read. It was not read further.";
  const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: {} }];
  const CASE = { timeout: 15_000 };

  type Answer = (req: IncomingMessage, res: ServerResponse) => void;
  let script: Answer[] = [];
  let requests = 0;
  let server: Server;
  let port = 0;

  /** An answer of the endpoint: a status, a JSON body, headers. */
  const reply =
    (status: number, body: string | Buffer, headers: Record<string, string> = {}): Answer =>
    (_req, res) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    };
  /** A chat completion carrying `message`, with a usage of its own. */
  const completion = (
    message: Record<string, unknown>,
    usage = { prompt_tokens: 100, completion_tokens: 20 },
  ): string =>
    JSON.stringify({
      id: "completion",
      object: "chat.completion",
      created: 0,
      model: "endpoint-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: null, ...message },
        },
      ],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
  const askForATool = (id: string): Answer =>
    reply(
      200,
      completion({
        tool_calls: [
          { id, type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      }),
    );
  /** A well-formed completion one byte past the bound once its text is in. */
  const oversized: Answer = reply(200, completion({ content: "a".repeat(FOUR_MIB) }));
  const errorBody = JSON.stringify({ error: { message: "slow down", type: "rate_limit" } });

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.on("error", () => undefined);
      req.resume();
      req.on("end", () => {
        const answer = script[requests] ?? script[script.length - 1];
        requests += 1;
        answer?.(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    script = [];
    requests = 0;
    vi.stubEnv("SKRUN_ALLOW_LOCAL_MODEL_HOSTS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const endpoint = () => ({
    provider: "openai" as const,
    name: "endpoint-model",
    base_url: `http://127.0.0.1:${port}/v1/secret-path`,
  });
  const CALLER_KEYS = { openai: "sk-caller" };

  /** What a promise settles on within `ms`: its value, its error, or "still pending". */
  async function within(ms: number, pending: Promise<unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve("still pending"), ms);
    });
    try {
      return await Promise.race([
        pending.then(
          (value) => value,
          (err: unknown) => err,
        ),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A logger that keeps the fields of every line. */
  function capturingLogger() {
    const logged: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      logged.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, logged };
  }

  it(
    "a response past 4 MiB at the third request stops the call by name: one request for that turn, the usage of the two turns made, nothing of the address",
    CASE,
    async () => {
      script = [askForATool("call-1"), askForATool("call-2"), oversized];
      const { logger, logged } = capturingLogger();
      const onToolCall = vi.fn(async (call: ToolCallRequest) => ({
        name: call.name,
        result: "ok",
        id: call.id,
      }));
      const r = new LLMRouter(logger);

      const outcome = await within(
        10_000,
        r.call(endpoint(), "sys", "user", TOOLS, onToolCall, undefined, CALLER_KEYS),
      );

      expect(outcome).toMatchObject({
        stopped: { code: "MODEL_RESPONSE_TOO_LARGE", message: TOO_LARGE_MESSAGE },
        content: "",
        usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
      });
      // Three requests in all: one per turn, the refused one asked for once.
      expect(requests).toBe(3);
      expect(onToolCall).toHaveBeenCalledTimes(2);
      const { message } = (outcome as { stopped: { message: string } }).stopped;
      for (const part of ["secret-path", "127.0.0.1", `:${port}`]) {
        expect(message).not.toContain(part);
      }
      expect(logged.filter((line) => line.event === "model_bound_refused")).toEqual([
        {
          event: "model_bound_refused",
          provider: "openai",
          model: "endpoint-model",
          code: "MODEL_RESPONSE_TOO_LARGE",
          limit: FOUR_MIB,
        },
      ]);
    },
  );

  it(
    "the same response as the primary's first, a fallback declared: the fallback takes over, the endpoint asked once",
    CASE,
    async () => {
      script = [oversized];
      const { logger, logged } = capturingLogger();
      const fallback = createMockProvider("anthropic", { content: "from the fallback" });
      const r = new LLMRouter(logger);
      r.registerProvider("anthropic", fallback);

      const outcome = await within(
        10_000,
        r.call(
          { ...endpoint(), fallback: { provider: "anthropic", name: "claude-sonnet-4-6" } },
          "sys",
          "user",
          undefined,
          undefined,
          undefined,
          CALLER_KEYS,
        ),
      );

      expect(outcome).toMatchObject({ provider: "anthropic", content: "from the fallback" });
      expect(outcome).not.toHaveProperty("stopped");
      expect(requests).toBe(1);
      expect(fallback.call).toHaveBeenCalledOnce();
      expect(
        logged
          .filter((line) => line.event === "model_bound_refused" || line.event === "primary_failed")
          .map((line) => [line.event, line.code ?? line.stop]),
      ).toEqual([
        ["model_bound_refused", "MODEL_RESPONSE_TOO_LARGE"],
        ["primary_failed", "MODEL_RESPONSE_TOO_LARGE"],
      ]);
    },
  );

  it(
    "an error response past 4 MiB is the endpoint's error, asked for once: read up to the bound, its message the body's refusal",
    CASE,
    async () => {
      script = [reply(400, Buffer.alloc(10 * 1024 * 1024, 0x61))];
      const r = new LLMRouter();

      const outcome = await within(
        10_000,
        r.call(endpoint(), "sys", "user", undefined, undefined, undefined, CALLER_KEYS),
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ status: 400 });
      expect((outcome as Error).message).toContain(BODY_REFUSAL);
      expect(requests).toBe(1);
    },
  );

  it.each([
    ["a 429 asking for an hour's wait (retry-after: 3600)", { "retry-after": "3600" }],
    ["a 429 asking for no retry (x-should-retry: false)", { "x-should-retry": "false" }],
  ])(
    "%s is retried on the SDK's own rules: three requests, within 2 s",
    CASE,
    async (_what, headers) => {
      script = [reply(429, errorBody, headers)];
      const r = new LLMRouter();
      const startedAt = Date.now();

      const outcome = await within(
        4_000,
        r.call(endpoint(), "sys", "user", undefined, undefined, undefined, CALLER_KEYS),
      );

      expect(outcome).toMatchObject({ status: 429 });
      expect(requests).toBe(3);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000);
    },
  );

  it("a 400 asking to be retried (x-should-retry: true) is asked for once", CASE, async () => {
    script = [reply(400, errorBody, { "x-should-retry": "true" })];
    const r = new LLMRouter();

    const outcome = await within(
      4_000,
      r.call(endpoint(), "sys", "user", undefined, undefined, undefined, CALLER_KEYS),
    );

    expect(outcome).toMatchObject({ status: 400 });
    expect(requests).toBe(1);
  });

  // What the conversation keeps of an answer, through the real adapter: not
  // the text the router reads, but the turn — its reasoning, and each call's
  // arguments in the model's own string, parsed or not.
  const ANSWER_WEIGHT = 1.5 * 1024 * 1024;
  it.each([
    [
      "a reasoning_content",
      (id: string) => ({
        reasoning_content: "r".repeat(ANSWER_WEIGHT),
        tool_calls: [
          { id, type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      }),
    ],
    [
      "a tool call's arguments as the model wrote them, not valid JSON",
      (id: string) => ({
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: "lookup", arguments: `{"q": "${"x".repeat(ANSWER_WEIGHT)}` },
          },
        ],
      }),
    ],
  ])(
    "three answers of 1.5 MiB each, carried by %s: the call stops at the third on MODEL_OUTPUT_BUDGET_EXCEEDED, the two tools before it run",
    CASE,
    async (_what, message) => {
      script = ["call-1", "call-2", "call-3"].map((id) => reply(200, completion(message(id))));
      const onToolCall = vi.fn(async (call: ToolCallRequest) => ({
        name: call.name,
        result: "ok",
        id: call.id,
      }));
      const r = new LLMRouter();

      const outcome = await within(
        10_000,
        r.call(endpoint(), "sys", "user", TOOLS, onToolCall, undefined, CALLER_KEYS),
      );

      expect(outcome).toMatchObject({
        stopped: { code: "MODEL_OUTPUT_BUDGET_EXCEEDED" },
        content: "",
      });
      expect(requests).toBe(3);
      expect(onToolCall).toHaveBeenCalledTimes(2);
    },
  );
});

// The fallback takes over only while no tool of the primary has run: once one
// has, the fallback would run the tools again from the input. The failover
// delay covers each call of the primary's model while no tool has run, never
// its whole run; an attempt abandoned on it dispatches nothing more.
describe("LLMRouter — the fallback takes over only before a tool of the primary ran", () => {
  const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: {} }];
  const MODEL = {
    provider: "anthropic" as const,
    name: "claude-sonnet-4-6",
    fallback: { provider: "openai" as const, name: "gpt-4o" },
  };

  interface Answer {
    /** Answers this many ms after it is called — a timer, which the clock drives. */
    after?: number;
    /** Asks for this many calls of `lookup`. */
    calls?: number;
    content?: string;
    fails?: Error;
  }

  /** A provider that answers from a script. */
  function timed(name: string, script: Answer[]) {
    let index = 0;
    const call = vi.fn(async (_request: LLMCallRequest): Promise<LLMCallResponse> => {
      const at = index++;
      const step = script[at];
      if (step === undefined) throw new Error(`${name}: called more often than scripted`);
      if (step.after) await new Promise((resolve) => setTimeout(resolve, step.after));
      if (step.fails) throw step.fails;
      return {
        content: step.content ?? "",
        toolCalls: step.calls
          ? Array.from({ length: step.calls }, (_, i) => ({
              name: "lookup",
              args: { q: `${name}-${at}-${i}` },
              id: `${name}-${at}-${i}`,
            }))
          : undefined,
        assistantTurn: { provider: name, content: { turn: at } },
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    });
    const provider: LLMProvider = { name, call };
    return { provider, call };
  }

  const lookup = vi.fn(async (call: ToolCallRequest) => ({
    name: call.name,
    result: "ok",
    id: call.id,
  }));

  /** A logger that keeps every line it is given. */
  function keeping() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (obj: Record<string, unknown>) => {
      lines.push(obj);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, lines };
  }

  /** What a promise settles on: its value, or the error it rejects with. */
  const settled = (pending: Promise<unknown>): Promise<unknown> =>
    pending.then(
      (value) => value,
      (err: unknown) => err,
    );

  beforeEach(() => {
    lookup.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a primary slower than the failover delay over its whole run, each call of its model under it, a tool at every turn: never handed over, and nothing runs once the call returned", async () => {
    vi.useFakeTimers();
    const primary = timed("anthropic", [
      { after: 120, calls: 1 },
      { after: 120, calls: 1 },
      { after: 120, calls: 1 },
      { after: 120, calls: 1 },
      { after: 120, content: "from the primary" },
    ]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter(undefined, { primaryFailoverMs: 300 });
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const outcome = settled(r.call(MODEL, "sys", "user", TOOLS, lookup));
    await vi.advanceTimersByTimeAsync(2_000);

    // Neither handed over nor cut: the primary's own answer.
    expect(await outcome).toMatchObject({ provider: "anthropic", content: "from the primary" });
    expect(fallback.call).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(primary.call).toHaveBeenCalledTimes(5);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("a primary abandoned on its failover delay whose call answers at last, asking for tools: none of them runs, the fallback holds the run, and one primary_abandoned line says so", async () => {
    vi.useFakeTimers();
    const { logger, lines } = keeping();
    const primary = timed("anthropic", [{ after: 1_000, calls: 3 }]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter(logger, { primaryFailoverMs: 300 });
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const pending = r.call(MODEL, "sys", "user", TOOLS, lookup);
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result.provider).toBe("openai");
    expect(result.content).toBe("from the fallback");

    // The primary's call answers now, asking for three tools.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.event === "primary_abandoned")).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        failover_ms: 300,
      }),
    ]);
  });

  it("a primary that fails at its third call, its tools having run: the call fails on its error, the fallback never called, and primary_failed says the fallback does not take over", async () => {
    const { logger, lines } = keeping();
    const primary = timed("anthropic", [
      { calls: 1 },
      { calls: 1 },
      { fails: new Error("anthropic failed at its third call") },
    ]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    await expect(r.call(MODEL, "sys", "user", TOOLS, lookup)).rejects.toThrow(
      "anthropic failed at its third call",
    );

    expect(fallback.call).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lines.filter((line) => line.event === "primary_failed")).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tools_served: 2,
        fallback: false,
      }),
    ]);
  });

  it("a primary that fails at its first call, no tool run yet: the fallback takes over, and primary_failed says so", async () => {
    const { logger, lines } = keeping();
    const primary = timed("anthropic", [{ fails: new Error("anthropic failed at once") }]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter(logger);
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const result = await r.call(MODEL, "sys", "user", TOOLS, lookup);

    expect(result.provider).toBe("openai");
    expect(result.content).toBe("from the fallback");
    expect(lines.filter((line) => line.event === "primary_failed")).toEqual([
      expect.objectContaining({ tools_served: 0, fallback: true }),
    ]);
  });

  it("a primary whose tool answered with an error, then whose next call fails: the call fails, the fallback never called — a tool that answered an error has run all the same", async () => {
    const primary = timed("anthropic", [
      { calls: 1 },
      { fails: new Error("anthropic failed after a tool error") },
    ]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);
    const failing = vi.fn(async (call: ToolCallRequest) => ({
      name: call.name,
      result: "[TOOL_FAILED] the lookup failed",
      id: call.id,
    }));

    await expect(r.call(MODEL, "sys", "user", TOOLS, failing)).rejects.toThrow(
      "anthropic failed after a tool error",
    );

    expect(failing).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
  });

  it("a primary whose tool loop throws right after a tool was handed over: the call fails on that error, the fallback never called", async () => {
    const primary = timed("anthropic", [{ calls: 1 }]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter();
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);
    const throwing = vi.fn(async (_call: ToolCallRequest): Promise<never> => {
      throw new Error("the tool's transport broke");
    });

    await expect(r.call(MODEL, "sys", "user", TOOLS, throwing)).rejects.toThrow(
      "the tool's transport broke",
    );

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
  });

  it("a model without a fallback: a call slower than the failover delay is waited on, never cut", async () => {
    vi.useFakeTimers();
    const primary = timed("anthropic", [{ after: 1_000, content: "slow but sure" }]);
    const r = new LLMRouter(undefined, { primaryFailoverMs: 300 });
    r.registerProvider("anthropic", primary.provider);

    const outcome = settled(
      r.call({ provider: "anthropic", name: "claude-sonnet-4-6" }, "sys", "user", TOOLS, lookup),
    );
    await vi.advanceTimersByTimeAsync(1_500);

    expect(await outcome).toMatchObject({ provider: "anthropic", content: "slow but sure" });
  });

  it("no timer of the router is left once a call with a fallback has returned — a primary that answered under the delay, then one that failed at once", async () => {
    vi.useFakeTimers();
    const primary = timed("anthropic", [
      { after: 100, calls: 1 },
      { after: 100, content: "from the primary" },
    ]);
    const fallback = timed("openai", [{ content: "from the fallback" }]);
    const r = new LLMRouter(undefined, { primaryFailoverMs: 300 });
    r.registerProvider("anthropic", primary.provider);
    r.registerProvider("openai", fallback.provider);

    const answered = settled(r.call(MODEL, "sys", "user", TOOLS, lookup));
    // Returned at 200 ms; a failover timer left armed would still be pending.
    await vi.advanceTimersByTimeAsync(250);
    expect(await answered).toMatchObject({ provider: "anthropic", content: "from the primary" });
    expect(vi.getTimerCount()).toBe(0);

    const failing = timed("anthropic", [{ fails: new Error("anthropic failed at once") }]);
    r.registerProvider("anthropic", failing.provider);
    const handedOver = settled(r.call(MODEL, "sys", "user", TOOLS, lookup));
    await vi.advanceTimersByTimeAsync(0);
    expect(await handedOver).toMatchObject({ provider: "openai", content: "from the fallback" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// SKRUN_PRIMARY_FAILOVER_MS is read once, strictly, by the process that builds
// the run route's router — at its start, which a malformed value refuses. The
// router itself never reads the environment: built without a delay, it waits
// the default.
describe("the failover delay: SKRUN_PRIMARY_FAILOVER_MS read strictly, a router built with its delay", () => {
  const MODEL = {
    provider: "anthropic" as const,
    name: "claude-sonnet-4-6",
    fallback: { provider: "openai" as const, name: "gpt-4o" },
  };
  const refusal = (raw: string) =>
    `SKRUN_PRIMARY_FAILOVER_MS must be a whole number of milliseconds from 1 to 2147483647 (got "${raw}"). Unset it to use the 45000 ms default.`;

  /** A primary whose first call is never answered, and a fallback that answers at once. */
  function register(r: Pick<LLMRouter, "registerProvider">) {
    const fallback = createMockProvider("openai");
    r.registerProvider("anthropic", {
      name: "anthropic",
      call: vi.fn(() => new Promise<LLMCallResponse>(() => {})),
    });
    r.registerProvider("openai", fallback);
    return fallback;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    "-5",
    "0",
    "abc",
    "",
    " 1.5",
    "1e3",
    "0x10",
    "2147483648",
  ])("the value %j is refused, naming the variable", (raw) => {
    expect(() => readPrimaryFailoverMs({ SKRUN_PRIMARY_FAILOVER_MS: raw })).toThrow(refusal(raw));
  });

  it("unset, the 45000 ms default; a whole number of ms is read, spaces around it set aside, up to what a timer holds", () => {
    expect(readPrimaryFailoverMs({})).toBe(45_000);
    expect(readPrimaryFailoverMs({ SKRUN_PRIMARY_FAILOVER_MS: "1000" })).toBe(1_000);
    expect(readPrimaryFailoverMs({ SKRUN_PRIMARY_FAILOVER_MS: " 1000 " })).toBe(1_000);
    expect(readPrimaryFailoverMs({ SKRUN_PRIMARY_FAILOVER_MS: "1" })).toBe(1);
    expect(readPrimaryFailoverMs({ SKRUN_PRIMARY_FAILOVER_MS: "2147483647" })).toBe(2_147_483_647);
  });

  it("reads the process environment when given none", () => {
    vi.stubEnv("SKRUN_PRIMARY_FAILOVER_MS", "2500");
    expect(readPrimaryFailoverMs()).toBe(2_500);
  });

  it("a router built with a delay of 1000 ms hands an unanswered first call to the fallback at 1 s", async () => {
    vi.useFakeTimers();
    const r = new LLMRouter(undefined, { primaryFailoverMs: 1_000 });
    const fallback = register(r);

    const pending = r.call(MODEL, "sys", "user");
    await vi.advanceTimersByTimeAsync(999);
    expect(fallback.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ provider: "openai" });
  });

  it("a router built without a delay waits 45 s, whatever SKRUN_PRIMARY_FAILOVER_MS says when its module loads: the router never reads the environment", async () => {
    vi.stubEnv("SKRUN_PRIMARY_FAILOVER_MS", "1000");
    vi.resetModules();
    const { LLMRouter: LoadedNow } = await import("./router.js");
    vi.useFakeTimers();
    const r = new LoadedNow();
    const fallback = register(r);

    const pending = r.call(MODEL, "sys", "user");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fallback.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(43_500);
    expect(await pending).toMatchObject({ provider: "openai" });
  });
});
