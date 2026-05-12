import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMCallResponse, LLMProvider } from "./providers/types.js";
import { LLMRouter } from "./router.js";

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

  // VT-12 (#68 prompt-caching) — Mistral provider invoked at runtime emits
  // a structured `cache_skipped` debug log. The log is observable in test
  // output but not asserted programmatically (peer-review N2: log message
  // text is brittle; the BEHAVIOR is the test). Here we verify the router
  // correctly threads through to the Mistral factory's skipCaching path:
  // no cache primitives leaked, no accumulated cache fields surfaced.
  it("VT-12: router invokes Mistral provider — no cache primitives, no cache fields surfaced", async () => {
    const mistralMock: LLMProvider = {
      name: "mistral",
      // Mock the OpenAICompatibleProvider behavior with skipCaching=true:
      // even if upstream returned cached_tokens, the adapter ignores them.
      call: vi.fn().mockResolvedValue({
        content: "Mistral response",
        usage: { promptTokens: 500, completionTokens: 100 },
        // Notably no cacheReadTokens / cacheWriteTokens — Mistral skipCaching path.
      } satisfies LLMCallResponse),
    };
    router.registerProvider("mistral", mistralMock);

    const result = await router.call(
      { provider: "mistral", name: "mistral-large-3" },
      "system",
      "user message",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // agentContext IS provided — proves cacheKey is computed but Mistral
      // adapter's skipCaching path correctly suppresses it.
      { name: "acme/foo", version: "1.0.0", environmentId: "prod" },
    );

    // Provider received cacheKey (proves router threading works).
    const callArgs = (mistralMock.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.cacheKey).toBeDefined();
    expect(callArgs.cacheKey).toMatch(/^[0-9a-f]{64}$/); // hex digest

    // Router result has no cache fields (Mistral adapter would have skipped them
    // — the mock here returns no cache fields, simulating that behavior).
    expect(result.usage.cacheReadTokens).toBeUndefined();
    expect(result.usage.cacheWriteTokens).toBeUndefined();
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
      { name: "acme/foo", version: "1.0.0", environmentId: "prod" },
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
