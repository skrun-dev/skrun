import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverWebhook } from "./webhook.js";

describe("deliverWebhook", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("sends POST with correct Content-Type and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const payload = { run_id: "abc", status: "completed" };
    await deliverWebhook("https://example.com/hook", payload, "test-key");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual(payload);
  });

  it("includes X-Skrun-Signature header with valid HMAC", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const payload = { run_id: "abc" };
    const signingKey = "my-secret";
    await deliverWebhook("https://example.com/hook", payload, signingKey);

    const [, opts] = mockFetch.mock.calls[0];
    const signature = opts.headers["X-Skrun-Signature"];
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);

    // Verify HMAC matches
    const body = JSON.stringify(payload);
    const expected = createHmac("sha256", signingKey).update(body).digest("hex");
    expect(signature).toBe(`sha256=${expected}`);
  });

  it("retries on non-2xx up to 3 times", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    globalThis.fetch = mockFetch;

    // Run delivery in background and advance timers
    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");

    // Advance past all retries: 1s + 4s + 16s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(16000);
    await promise;

    // 1 initial + 3 retries = 4 total
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("stops retrying on success", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const promise = deliverWebhook("https://example.com/hook", { test: true }, "key");
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
