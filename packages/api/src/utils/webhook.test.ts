import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// safeFetch (the SSRF guard) is exercised in
// packages/runtime/src/security/safe-fetch.test.ts. Here we mock it and test
// deliverWebhook's ORCHESTRATION: HMAC signing, retry/backoff, and that it calls
// the guarded fetch with a bounded timeout and no redirect-following.
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return { ...actual, safeFetch: vi.fn() };
});

import { safeFetch } from "@skrun-dev/runtime";
import { deliverWebhook } from "./webhook.js";

const safeFetchMock = vi.mocked(safeFetch);

describe("deliverWebhook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls safeFetch with POST + JSON body, a bounded timeout, and no redirects", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 } as never);

    const payload = { run_id: "abc", status: "completed" };
    await deliverWebhook("https://example.com/hook", payload, "test-key");

    expect(safeFetchMock).toHaveBeenCalledOnce();
    const [url, init, opts] = safeFetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
    // SSRF/timeout hardening: bounded per-attempt timeout + no redirect-following
    expect(opts?.timeoutMs).toBeGreaterThan(0);
    expect(opts?.followRedirects).toBe(false);
  });

  it("includes X-Skrun-Signature header with valid HMAC", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 } as never);

    const payload = { run_id: "abc" };
    const signingKey = "my-secret";
    await deliverWebhook("https://example.com/hook", payload, signingKey);

    const [, init] = safeFetchMock.mock.calls[0];
    const signature = (init?.headers as Record<string, string>)["X-Skrun-Signature"];
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);

    const body = JSON.stringify(payload);
    const expected = createHmac("sha256", signingKey).update(body).digest("hex");
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("retries on non-2xx up to 3 times", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 500 } as never);

    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(16000);
    await promise;

    expect(safeFetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("stops retrying on success", async () => {
    safeFetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as never)
      .mockResolvedValueOnce({ ok: true, status: 200 } as never);

    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on network error", async () => {
    safeFetchMock
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as never);

    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when neither signingKey arg nor WEBHOOK_SIGNING_KEY env is set", async () => {
    const previousEnv = process.env.WEBHOOK_SIGNING_KEY;
    delete process.env.WEBHOOK_SIGNING_KEY;

    try {
      await expect(deliverWebhook("https://example.com/hook", { test: true })).rejects.toThrow(
        /WEBHOOK_SIGNING_KEY is not configured/,
      );
      expect(safeFetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousEnv !== undefined) process.env.WEBHOOK_SIGNING_KEY = previousEnv;
    }
  });

  it("uses WEBHOOK_SIGNING_KEY env when no signingKey arg is passed", async () => {
    const previousEnv = process.env.WEBHOOK_SIGNING_KEY;
    process.env.WEBHOOK_SIGNING_KEY = "env-key";
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 } as never);

    try {
      await deliverWebhook("https://example.com/hook", { run_id: "abc" });
      expect(safeFetchMock).toHaveBeenCalledOnce();
      const [, init] = safeFetchMock.mock.calls[0];
      const expected = createHmac("sha256", "env-key")
        .update(JSON.stringify({ run_id: "abc" }))
        .digest("hex");
      expect((init?.headers as Record<string, string>)["X-Skrun-Signature"]).toBe(
        `sha256=${expected}`,
      );
    } finally {
      if (previousEnv !== undefined) process.env.WEBHOOK_SIGNING_KEY = previousEnv;
      else delete process.env.WEBHOOK_SIGNING_KEY;
    }
  });
});
