import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { createGuardedFetch } from "../security/safe-fetch.js";
import type { LLMCallResponse, LLMProvider } from "./providers/types.js";
import { LLMRouter } from "./router.js";

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
      { name: "foo", version: "1.0.0", environmentId: "prod" },
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
      expect(String(warn?.error)).toContain("[REDACTED]");
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
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ allowPrivateHosts: false });

    vi.mocked(createGuardedFetch).mockClear();
    await withEnvAsync({ SKRUN_ALLOW_LOCAL_MODEL_HOSTS: "true" }, async () => {
      await callWith(
        { ...ANTHROPIC, base_url: "http://localhost:9/v1" },
        { callerKeys: { anthropic: "sk-ant-caller" } },
      );
    });
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ allowPrivateHosts: true });
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
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ allowPrivateHosts: true });
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
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ allowPrivateHosts: false });
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

  it("RT-10: providers without a base_url keep the SDK's own transport", async () => {
    const r = new LLMRouter();
    r.registerProvider("anthropic", createMockProvider("anthropic"));
    await r.call(ANTHROPIC as never, "sys", "user");
    // No agent-declared endpoint means no guarded transport, so OpenAI/Mistral/
    // Grok/Groq at their fixed endpoints are untouched by this change.
    expect(vi.mocked(createGuardedFetch)).not.toHaveBeenCalled();
  });
});
