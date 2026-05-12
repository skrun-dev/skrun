import { afterEach, describe, expect, it, vi } from "vitest";
import { SkrunClient } from "./client.js";
import { SkrunApiError, SkrunFileUploadError } from "./errors.js";

const BASE_URL = "http://localhost:4000";
const TOKEN = "test-token";

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function mockFetchError(errorBody: { code: string; message: string }, status: number) {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: errorBody }), { status, statusText: "Error" }),
    );
}

describe("SkrunClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- Constructor ---

  it("throws on invalid baseUrl", () => {
    expect(() => new SkrunClient({ baseUrl: "not-a-url", token: TOKEN })).toThrow(
      "Invalid baseUrl",
    );
  });

  it("accepts valid baseUrl", () => {
    expect(() => new SkrunClient({ baseUrl: BASE_URL, token: TOKEN })).not.toThrow();
  });

  // --- Binary input upload (Tasks 7.1+7.2+7.3) ---

  it("VT-24: run() with Blob input auto-uploads via /api/files and substitutes file_id", async () => {
    const fetchMock = vi.fn();
    // First call: POST /api/files → returns {file_id, ...}
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          file_id: "fil_uploaded_xyz",
          size: 4,
          media_type: "image/jpeg",
          purpose: "input",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201 },
      ),
    );
    // Second call: POST /run → returns the run result
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ run_id: "run_1", status: "completed", output: {} }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock;

    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/jpeg" });
    await client.run("dev/agent", { photo: blob, question: "what?" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call hits /api/files
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall[0]).toBe(`${BASE_URL}/api/files`);
    expect((firstCall[1] as RequestInit).method).toBe("POST");

    // Second call hits /run with file_id substitution
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall[0]).toBe(`${BASE_URL}/api/agents/dev/agent/run`);
    const sentBody = JSON.parse((secondCall[1] as RequestInit).body as string);
    expect(sentBody.input).toEqual({
      photo: { type: "file", source: "id", file_id: "fil_uploaded_xyz" },
      question: "what?",
    });
  });

  it("RT-8: text-only input does not call /api/files", async () => {
    const fetchMock = mockFetchJson({ run_id: "r", status: "completed", output: {} });
    globalThis.fetch = fetchMock;

    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await client.run("dev/agent", { question: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(`${BASE_URL}/api/agents/dev/agent/run`);
  });

  it("auto-uploads array of Blobs and substitutes each with file_id ref", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          file_id: "fil_a",
          size: 1,
          media_type: "image/jpeg",
          purpose: "input",
          expires_at: "2026-04-30T00:00:00Z",
        }),
        { status: 201 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          file_id: "fil_b",
          size: 1,
          media_type: "image/jpeg",
          purpose: "input",
          expires_at: "2026-04-30T00:00:00Z",
        }),
        { status: 201 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ run_id: "r", status: "completed", output: {} }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock;

    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await client.run("dev/agent", {
      receipts: [
        new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
        new Blob([new Uint8Array([2])], { type: "image/jpeg" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const runBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(runBody.input.receipts).toEqual([
      { type: "file", source: "id", file_id: "fil_a" },
      { type: "file", source: "id", file_id: "fil_b" },
    ]);
  });

  it("throws SkrunFileUploadError when /api/files returns an error", async () => {
    globalThis.fetch = mockFetchError({ code: "FILE_TOO_LARGE", message: "too big" }, 413);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const blob = new Blob([new Uint8Array(10)], { type: "image/jpeg" });
    await expect(client.run("dev/agent", { photo: blob })).rejects.toBeInstanceOf(
      SkrunFileUploadError,
    );
  });

  it("supports Uint8Array input (Node-friendly path)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          file_id: "fil_buf",
          size: 4,
          media_type: "application/octet-stream",
          purpose: "input",
          expires_at: "2026-04-30T00:00:00Z",
        }),
        { status: 201 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ run_id: "r", status: "completed", output: {} }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock;

    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    await client.run("dev/agent", { document: bytes });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const runBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(runBody.input.document).toEqual({
      type: "file",
      source: "id",
      file_id: "fil_buf",
    });
  });

  // --- run() ---

  it("run() sends correct URL, headers, and body", async () => {
    const mockResult = { run_id: "abc", status: "completed", output: { score: 95 } };
    globalThis.fetch = mockFetchJson(mockResult);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.run("dev/code-review", { code: "x" });

    expect(result.run_id).toBe("abc");
    expect(result.output).toEqual({ score: 95 });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/code-review/run`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ input: { code: "x" } });
  });

  it("run() with agent object format", async () => {
    globalThis.fetch = mockFetchJson({ run_id: "abc", status: "completed" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run({ namespace: "dev", name: "my-agent" }, { query: "hi" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/my-agent/run`);
  });

  it("run() with llmKeys option sends X-LLM-API-Key header", async () => {
    globalThis.fetch = mockFetchJson({ run_id: "abc", status: "completed" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run("dev/agent", {}, { llmKeys: { google: "AIza..." } });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-LLM-API-Key"]).toBe(JSON.stringify({ google: "AIza..." }));
  });

  // --- stream() ---

  it("stream() sends Accept: text/event-stream header", async () => {
    const sseText = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      'event: run_complete\ndata: {"type":"run_complete","run_id":"x","timestamp":"t","output":{},"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"cost":{"estimated":0},"duration_ms":0}',
    ].join("\n\n");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(sseText, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const events = [];
    for await (const event of client.stream("dev/agent", {})) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("run_start");
    expect(events[1].type).toBe("run_complete");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Accept).toBe("text/event-stream");
  });

  // --- runAsync() ---

  it("runAsync() sends webhook_url and returns run_id", async () => {
    globalThis.fetch = mockFetchJson({ run_id: "async-123" }, 202);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.runAsync("dev/agent", { code: "x" }, "https://hook.example.com");

    expect(result.run_id).toBe("async-123");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.webhook_url).toBe("https://hook.example.com");
  });

  // --- Registry methods ---

  it("push() sends octet-stream with version query param", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", namespace: "dev", latest_version: "1.0.0" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.push("dev/agent", Buffer.from("bundle"), "1.0.0");

    expect(result.latest_version).toBe("1.0.0");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("push?version=1.0.0");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("push() with message sends X-Skrun-Version-Notes header (percent-encoded)", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", namespace: "dev", latest_version: "1.0.0" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.push("dev/agent", Buffer.from("bundle"), "1.0.0", {
      message: "🚀 Amélioration",
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Skrun-Version-Notes"]).toBe(encodeURIComponent("🚀 Amélioration"));
  });

  it("push() without message omits the header", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", namespace: "dev", latest_version: "1.0.0" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.push("dev/agent", Buffer.from("bundle"), "1.0.0");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Skrun-Version-Notes"]).toBeUndefined();
  });

  it("push() with empty message omits the header", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", namespace: "dev", latest_version: "1.0.0" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.push("dev/agent", Buffer.from("bundle"), "1.0.0", { message: "" });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Skrun-Version-Notes"]).toBeUndefined();
  });

  it("push() with message > 500 chars throws before network call", async () => {
    globalThis.fetch = mockFetchJson({});
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(
      client.push("dev/agent", Buffer.from("bundle"), "1.0.0", { message: "a".repeat(501) }),
    ).rejects.toThrow(/too long/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("push() with null byte in message throws before network call", async () => {
    globalThis.fetch = mockFetchJson({});
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(
      client.push("dev/agent", Buffer.from("bundle"), "1.0.0", { message: "hello\x00" }),
    ).rejects.toThrow(/null bytes/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("pull() returns Buffer", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("bundle-content"), { status: 200 }));
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const buf = await client.pull("dev/agent");

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe("bundle-content");
  });

  it("pull() with version includes version in path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from(""), { status: 200 }));
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.pull("dev/agent", "2.0.0");

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/pull/2.0.0");
  });

  it("list() returns paginated response", async () => {
    const mockList = { agents: [{ name: "a" }], total: 1, page: 1, limit: 20 };
    globalThis.fetch = mockFetchJson(mockList);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.list({ page: 2, limit: 10 });

    expect(result.agents).toHaveLength(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("page=2");
    expect(url).toContain("limit=10");
  });

  it("getAgent() returns metadata", async () => {
    const meta = { name: "agent", namespace: "dev", verified: true, latest_version: "1.0.0" };
    globalThis.fetch = mockFetchJson(meta);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.getAgent("dev/agent");

    expect(result.verified).toBe(true);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/agent`);
  });

  it("getVersions() returns string array", async () => {
    globalThis.fetch = mockFetchJson({ versions: ["1.0.0", "1.1.0"] });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const versions = await client.getVersions("dev/agent");

    expect(versions).toEqual(["1.0.0", "1.1.0"]);
  });

  it("verify() sends PATCH with verified flag", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", verified: true });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.verify("dev/agent", true);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/verify");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ verified: true });
  });

  // --- Error handling ---

  it("HTTP error throws SkrunApiError", async () => {
    globalThis.fetch = mockFetchError({ code: "NOT_FOUND", message: "Agent not found" }, 404);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    try {
      await client.run("dev/nonexistent", {});
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).code).toBe("NOT_FOUND");
      expect((e as SkrunApiError).status).toBe(404);
    }
  });

  it("invalid agent format throws Error", async () => {
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await expect(client.run("no-slash", {})).rejects.toThrow("Agent must be 'namespace/name'");
  });

  it("network error throws SkrunApiError with NETWORK_ERROR", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.run("dev/agent", {})).rejects.toThrow(SkrunApiError);
    try {
      await client.run("dev/agent", {});
    } catch (e) {
      expect((e as SkrunApiError).code).toBe("NETWORK_ERROR");
    }
  });

  // --- Version pinning ---

  it("run({ version }) sends version in body", async () => {
    globalThis.fetch = mockFetchJson({
      run_id: "abc",
      status: "completed",
      agent_version: "1.2.0",
      output: {},
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run("dev/agent", { x: 1 }, { version: "1.2.0" });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ input: { x: 1 }, version: "1.2.0" });
  });

  it("stream({ version }) sends version in body", async () => {
    // Minimal SSE response: one run_start event then stream ends cleanly.
    const sseBody = `event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"dev/agent","agent_version":"1.0.0"}\n\n`;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    // Consume the generator (ignore parse errors — we assert on the fetch body).
    try {
      for await (const _evt of client.stream("dev/agent", { x: 1 }, { version: "1.0.0" })) {
        // drain
      }
    } catch {
      // SSE parser may throw on end-of-stream; we only care about the request body.
    }

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ input: { x: 1 }, version: "1.0.0" });
  });

  it("runAsync(..., { version }) sends both webhook_url and version", async () => {
    globalThis.fetch = mockFetchJson({ run_id: "abc", agent_version: "1.0.0" }, 202);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.runAsync("dev/agent", { x: 1 }, "https://example.com/hook", { version: "1.0.0" });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      input: { x: 1 },
      version: "1.0.0",
      webhook_url: "https://example.com/hook",
    });
  });

  it("run() without version option does NOT include version in body", async () => {
    globalThis.fetch = mockFetchJson({
      run_id: "abc",
      status: "completed",
      agent_version: "1.2.0",
      output: {},
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run("dev/agent", { x: 1 });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ input: { x: 1 } });
    expect(JSON.parse(init.body).version).toBeUndefined();
  });

  // --- Zero dependencies ---

  it("package.json has no runtime dependencies", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"));
    expect(pkg.dependencies).toBeUndefined();
  });

  // --- Prompt-caching fields (#68) ---

  it("SdkRunResult.usage exposes optional cache_read_tokens + cache_write_tokens", async () => {
    // Server returns the wire-format cache fields → SDK passes them through.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => ({
        run_id: "r",
        status: "completed",
        agent_version: "1.0.0",
        output: {},
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cache_read_tokens: 2048,
          cache_write_tokens: 1024,
        },
        cost: { estimated: 0.01 },
        duration_ms: 500,
      }),
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const result = await client.run("dev/agent", {});

    // Cache fields surfaced through the SDK return type unchanged.
    expect(result.usage.cache_read_tokens).toBe(2048);
    expect(result.usage.cache_write_tokens).toBe(1024);
    // Pre-#68 fields preserved.
    expect(result.usage.prompt_tokens).toBe(100);
    expect(result.usage.completion_tokens).toBe(50);
    expect(result.usage.total_tokens).toBe(150);
  });

  it("SdkRunResult.usage omits cache fields when server doesn't return them (back-compat)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => ({
        run_id: "r",
        status: "completed",
        agent_version: "1.0.0",
        output: {},
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        cost: { estimated: 0.01 },
        duration_ms: 500,
      }),
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const result = await client.run("dev/agent", {});

    expect(result.usage.cache_read_tokens).toBeUndefined();
    expect(result.usage.cache_write_tokens).toBeUndefined();
  });
});
