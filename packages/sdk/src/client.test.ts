import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkrunClient } from "./client.js";
import { SkrunApiError, SkrunFileUploadError, SkrunInputFilesLimitError } from "./errors.js";
import type { UsageResponse } from "./types.js";

const BASE_URL = "http://localhost:4000";
const TOKEN = "test-token";

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

/** An event stream body, one `event:`/`data:` block per event. */
function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The events of a run that completes, `complete` overriding the run_complete fields. */
function completedRunEvents(
  complete: Record<string, unknown> = {},
  runId = "run_1",
): Array<Record<string, unknown>> {
  return [
    {
      type: "run_start",
      run_id: runId,
      timestamp: "t",
      agent: "dev/agent",
      agent_version: "1.0.0",
    },
    {
      type: "run_complete",
      run_id: runId,
      timestamp: "t",
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      files: [],
      ...complete,
    },
  ];
}

/** A `fetch` that answers every call with the stream of a completed run (a fresh body each time). */
function mockFetchRunStream(complete: Record<string, unknown> = {}, runId = "run_1") {
  return vi.fn().mockImplementation(async () => sseResponse(completedRunEvents(complete, runId)));
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

  it("run() with Blob input auto-uploads via /api/files and substitutes file_id", async () => {
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
    // Second call: POST /run → streams the run to its result
    fetchMock.mockResolvedValueOnce(sseResponse(completedRunEvents()));
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

  it("text-only input does not call /api/files", async () => {
    const fetchMock = mockFetchRunStream();
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
    fetchMock.mockResolvedValueOnce(sseResponse(completedRunEvents()));
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

  it("an upload refused for the account's live uploads carries the typed refusal, and its wait, as its cause", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "INPUT_FILES_LIMIT_REACHED", message: "limit reached" },
          }),
          { status: 429, headers: { "Retry-After": "85400" } },
        ),
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const blob = new Blob([new Uint8Array(10)], { type: "image/jpeg" });

    for (const attempt of [
      () => client.uploadFile(blob),
      () => client.run("dev/agent", { photo: blob }),
    ]) {
      const err = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SkrunFileUploadError);
      const cause = (err as SkrunFileUploadError).cause;
      expect(cause).toBeInstanceOf(SkrunInputFilesLimitError);
      expect(cause).toMatchObject({
        code: "INPUT_FILES_LIMIT_REACHED",
        status: 429,
        retryAfterSeconds: 85400,
      });
    }
  });

  it("deleteFile() sends DELETE /api/files/:id with the token, the id encoded, and resolves on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.deleteFile("fil_abc")).resolves.toBeUndefined();
    await client.deleteFile("fil_a/b?c");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE_URL}/api/files/fil_abc`,
      `${BASE_URL}/api/files/fil_a%2Fb%3Fc`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe("DELETE");
      expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    }
  });

  it("deleteFile() of a file the server does not have, or the caller may not use, throws its typed SkrunApiError", async () => {
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    for (const [code, status] of [
      ["FILE_NOT_FOUND", 404],
      ["FORBIDDEN", 403],
      ["DELETE_OUTPUT_FORBIDDEN", 403],
    ] as const) {
      globalThis.fetch = mockFetchError({ code, message: "refused" }, status);
      const err = await client.deleteFile("fil_x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SkrunApiError);
      expect(err).toMatchObject({ code, status });
    }
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
    fetchMock.mockResolvedValueOnce(sseResponse(completedRunEvents()));
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
    globalThis.fetch = mockFetchRunStream({ output: { score: 95 } }, "abc");
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.run("dev/code-review", { code: "x" });

    expect(result.run_id).toBe("abc");
    expect(result.output).toEqual({ score: 95 });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/code-review/run`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(JSON.parse(init.body)).toEqual({ input: { code: "x" } });
  });

  it("run() sends an input field named __proto__ as any other — a value, and a list", async () => {
    // `JSON.parse` makes `__proto__` a field of the input's own: assigned to a
    // copy, it would set the copy's prototype, and leave the body.
    globalThis.fetch = mockFetchRunStream();
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run("dev/agent", JSON.parse('{"q":"hi","__proto__":{"k":1}}'));
    await client.run("dev/agent", JSON.parse('{"__proto__":[1,2]}'));

    const bodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, init]) => init.body,
    );
    expect(bodies).toEqual([
      '{"input":{"q":"hi","__proto__":{"k":1}}}',
      '{"input":{"__proto__":[1,2]}}',
    ]);
  });

  it("run() with agent object format", async () => {
    globalThis.fetch = mockFetchRunStream();
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run({ namespace: "dev", name: "my-agent" }, { query: "hi" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/my-agent/run`);
  });

  it("run() with llmKeys option sends X-LLM-API-Key header", async () => {
    globalThis.fetch = mockFetchRunStream();
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run("dev/agent", {}, { llmKeys: { google: "AIza..." } });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-LLM-API-Key"]).toBe(JSON.stringify({ google: "AIza..." }));
    // Without llmBaseUrls the header is absent, not empty — the server treats
    // "absent" and "declared" differently.
    expect(init.headers["X-LLM-Base-URL"]).toBeUndefined();
  });

  it("run() with llmBaseUrls option sends X-LLM-Base-URL header", async () => {
    globalThis.fetch = mockFetchRunStream();
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.run(
      "dev/agent",
      {},
      {
        llmKeys: { deepseek: "sk-..." },
        llmBaseUrls: { deepseek: "https://api.deepseek.com/v1" },
      },
    );

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-LLM-Base-URL"]).toBe(
      JSON.stringify({ deepseek: "https://api.deepseek.com/v1" }),
    );
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

  // list / getAgent / getVersions must send the Authorization
  // header. The endpoints were public once, so these methods worked
  // without it; once the multi-tenant filter lands, an anonymous fetch
  // would silently 401. Asserting the header is sent locks the contract.
  it("list() sends Authorization header", async () => {
    globalThis.fetch = mockFetchJson({ agents: [], total: 0, page: 1, limit: 20 });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await client.list();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("getAgent() sends Authorization header", async () => {
    globalThis.fetch = mockFetchJson({
      name: "x",
      namespace: "y",
      latest_version_verified: false,
      latest_version: "1.0.0",
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await client.getAgent("y/x");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("getVersions() sends Authorization header", async () => {
    globalThis.fetch = mockFetchJson({ versions: ["1.0.0", "2.0.0"] });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    await client.getVersions("y/x");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  // list() returns { agents: [], total: 0 } cleanly for a
  // user who owns no agents (new OAuth sign-up scenario). Must NOT throw.
  it("list() returns clean empty result for a user with 0 owned agents", async () => {
    globalThis.fetch = mockFetchJson({ agents: [], total: 0, page: 1, limit: 20 });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const result = await client.list();
    expect(result.agents).toEqual([]);
    expect(result.total).toBe(0);
  });

  // 404 propagates as SkrunApiError with code === 'NOT_FOUND'.
  // The fromResponse dispatch table (shipped earlier) already handles this
  // generically — no typed SkrunNotFoundError subclass needed.
  it("getAgent() propagates 404 as SkrunApiError(code='NOT_FOUND')", async () => {
    globalThis.fetch = mockFetchError(
      { code: "NOT_FOUND", message: "Agent other/foo not found" },
      404,
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    // Single call — a Response body can only be read once, so we can't both
    // .rejects.toBeInstanceOf(...) AND inspect the thrown error from a
    // second call against the same mock.
    let thrown: unknown;
    try {
      await client.getAgent("other/foo");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SkrunApiError);
    const err = thrown as SkrunApiError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  });

  it("getAgent() returns metadata", async () => {
    const meta = {
      name: "agent",
      namespace: "dev",
      latest_version_verified: true,
      latest_version: "1.0.0",
    };
    globalThis.fetch = mockFetchJson(meta);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.getAgent("dev/agent");

    expect(result.latest_version_verified).toBe(true);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/agents/dev/agent`);
  });

  it("getVersions() returns string array", async () => {
    globalThis.fetch = mockFetchJson({ versions: ["1.0.0", "1.1.0"] });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const versions = await client.getVersions("dev/agent");

    expect(versions).toEqual(["1.0.0", "1.1.0"]);
  });

  it("verifyVersion() sends PATCH to per-version endpoint with verified flag", async () => {
    globalThis.fetch = mockFetchJson({ version: "1.0.0", verified: true });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.verifyVersion("dev/agent", "1.0.0", true);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/agents/dev/agent/versions/1.0.0/verify");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ verified: true });
  });

  it("setVisibility() sends PATCH to the visibility endpoint with the new value", async () => {
    globalThis.fetch = mockFetchJson({ name: "agent", namespace: "dev", visibility: "public" });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    await client.setVisibility("dev/agent", "public");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/agents/dev/agent/visibility");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ visibility: "public" });
  });

  it("usage() reads GET /api/usage with the token, and hands back the account's usage as the server sent it", async () => {
    const sent: UsageResponse = {
      plan: "free",
      quotas: {
        concurrent_runs: { limit: 2, in_use: 1 },
        compute: {
          limit_seconds: 3600,
          used_seconds: 390,
          window: { start: "2026-10-18T12:00:00.000Z", end: "2026-10-18T18:00:00.000Z" },
        },
        fast_runs: { limit: 3, remaining: 1, resets_at: "2026-10-18T13:10:00.000Z" },
      },
    };
    globalThis.fetch = mockFetchJson(sent);
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    expect(await client.usage()).toEqual(sent);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/usage`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("usage() on a server that sets no quota hands back quotas: null", async () => {
    globalThis.fetch = mockFetchJson({ plan: "free", quotas: null });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const usage = await client.usage();
    expect(usage).toEqual({ plan: "free", quotas: null });
  });

  it("usage() with a key that does not carry full access throws SkrunApiError KEY_SCOPE_FORBIDDEN", async () => {
    globalThis.fetch = mockFetchError(
      {
        code: "KEY_SCOPE_FORBIDDEN",
        message:
          "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
      },
      403,
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const error = await client.usage().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkrunApiError);
    expect({
      code: (error as SkrunApiError).code,
      status: (error as SkrunApiError).status,
    }).toEqual({ code: "KEY_SCOPE_FORBIDDEN", status: 403 });
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
    globalThis.fetch = mockFetchRunStream();
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
    globalThis.fetch = mockFetchRunStream();
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

  // --- Prompt-caching fields ---

  it("SdkRunResult.usage exposes optional cache_read_tokens + cache_write_tokens", async () => {
    // Server returns the wire-format cache fields → SDK passes them through.
    globalThis.fetch = mockFetchRunStream({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 2048,
        cache_write_tokens: 1024,
      },
      cost: { estimated: 0.01 },
      duration_ms: 500,
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const result = await client.run("dev/agent", {});

    // Cache fields surfaced through the SDK return type unchanged.
    expect(result.usage.cache_read_tokens).toBe(2048);
    expect(result.usage.cache_write_tokens).toBe(1024);
    // The fields from before prompt caching, preserved.
    expect(result.usage.prompt_tokens).toBe(100);
    expect(result.usage.completion_tokens).toBe(50);
    expect(result.usage.total_tokens).toBe(150);
  });

  it("SdkRunResult.usage omits cache fields when server doesn't return them (back-compat)", async () => {
    globalThis.fetch = mockFetchRunStream({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      cost: { estimated: 0.01 },
      duration_ms: 500,
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });
    const result = await client.run("dev/agent", {});

    expect(result.usage.cache_read_tokens).toBeUndefined();
    expect(result.usage.cache_write_tokens).toBeUndefined();
  });
});

describe("SkrunClient.run() reads the event stream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("collects a completed run into the synchronous result, skipping every other event", async () => {
    const [start, complete] = completedRunEvents(
      {
        output: { answer: "ok" },
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cache_read_tokens: 7 },
        cost: { estimated: 0.01, saved: 0.002 },
        duration_ms: 42,
        files: [{ name: "report.txt", size: 5, url: "/api/runs/r1/files/report.txt" }],
        files_excluded: { too_large: 1, pull_failed: 2 },
      },
      "r1",
    );
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        start as Record<string, unknown>,
        { type: "run_heartbeat", run_id: "r1", timestamp: "t", stage: "acquiring_runner" },
        { type: "runner_spawned", run_id: "r1", timestamp: "t", phases: { create_api_ms: 1 } },
        { type: "run_heartbeat", run_id: "r1", timestamp: "t", stage: "a_stage_not_known_yet" },
        { type: "an_event_not_known_yet", run_id: "r1", timestamp: "t" },
        {
          type: "llm_complete",
          run_id: "r1",
          timestamp: "t",
          provider: "p",
          model: "m",
          tokens: 5,
        },
        complete as Record<string, unknown>,
      ]),
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.run("dev/agent", {});

    expect(result).toStrictEqual({
      run_id: "r1",
      status: "completed",
      agent_version: "1.0.0",
      output: { answer: "ok" },
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cache_read_tokens: 7 },
      cost: { estimated: 0.01, saved: 0.002 },
      duration_ms: 42,
      files: [{ name: "report.txt", size: 5, url: "/api/runs/r1/files/report.txt" }],
      files_excluded: { too_large: 1, pull_failed: 2 },
    });
  });

  it("returns the failed result of a run that ends on run_error, as the synchronous call does", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        {
          type: "run_start",
          run_id: "r2",
          timestamp: "t",
          agent: "dev/agent",
          agent_version: "2.0.0",
        },
        {
          type: "run_error",
          run_id: "r2",
          timestamp: "t",
          error: { code: "TIMEOUT", message: "Agent execution timed out" },
        },
      ]),
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const result = await client.run("dev/agent", {});

    expect(result).toStrictEqual({
      run_id: "r2",
      status: "failed",
      agent_version: "2.0.0",
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      files: [],
      files_excluded: {},
      error: "Agent execution timed out",
    });
  });

  it("throws STREAM_INTERRUPTED when the stream ends before the run does", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        {
          type: "run_start",
          run_id: "r3",
          timestamp: "t",
          agent: "dev/agent",
          agent_version: "1.0.0",
        },
        { type: "run_heartbeat", run_id: "r3", timestamp: "t", stage: "waiting_llm" },
      ]),
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const err = await client.run("dev/agent", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SkrunApiError);
    expect((err as SkrunApiError).code).toBe("STREAM_INTERRUPTED");
  });

  it("throws the typed error of a request refused before the stream opens", async () => {
    globalThis.fetch = mockFetchError(
      { code: "LLM_KEY_REQUIRED", message: "No API key for google" },
      400,
    );
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const err = await client.run("dev/agent", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SkrunApiError);
    expect((err as SkrunApiError).code).toBe("LLM_KEY_REQUIRED");
    expect((err as SkrunApiError).status).toBe(400);
  });
});

describe("a streamed call times out on a silence, not on its length", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    // AbortSignal.timeout counts on a clock the fake timers do not drive
    // (measured): this stand-in keeps its behaviour on the clock they do, so a
    // total deadline and a silence deadline are measured by the same clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          ),
        ms,
      );
      return controller.signal;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  /** Resolve after `ms`, or reject with the signal's reason once it aborts. */
  function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * A `fetch` that answers after `headersAfterMs`, then sends each chunk after
   * its own delay. Like the platform's, it obeys the request's signal: an abort
   * rejects the wait for the answer, or errors the body being read.
   */
  function timedFetch(opts: {
    headersAfterMs?: number;
    chunks: Array<{ afterMs: number; text: string }>;
    contentType?: string;
  }) {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      await abortableSleep(opts.headersAfterMs ?? 0, signal);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => controller.error(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          void (async () => {
            for (const chunk of opts.chunks) {
              try {
                await abortableSleep(chunk.afterMs, signal);
              } catch {
                return;
              }
              controller.enqueue(encoder.encode(chunk.text));
            }
            signal.removeEventListener("abort", onAbort);
            controller.close();
          })();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": opts.contentType ?? "text/event-stream" },
      });
    });
  }

  const [START, COMPLETE] = completedRunEvents({ output: { answer: "ok" } }, "r");
  const start = { afterMs: 0, text: sseBody([START as Record<string, unknown>]) };
  const complete = (afterMs: number) => ({
    afterMs,
    text: sseBody([COMPLETE as Record<string, unknown>]),
  });
  const beat = (afterMs: number) => ({
    afterMs,
    text: sseBody([{ type: "run_heartbeat", run_id: "r", timestamp: "t", stage: "waiting_llm" }]),
  });
  /** A run of 440 ms whose longest silence is 40 ms: ten beats, then the result. */
  const longRunShortSilences = [start, ...Array.from({ length: 10 }, () => beat(40)), complete(40)];
  /** A run whose third silence (150 ms) outlasts a 100 ms timeout. */
  const oneLongSilence = [start, beat(40), beat(150), complete(40)];

  /** Settle `promise` once the fake clock has moved `ms` ahead. */
  async function settleAfter<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<{ value?: T; error?: unknown }> {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  }

  async function drain(events: AsyncIterable<{ type: string }>): Promise<string[]> {
    const types: string[] = [];
    for await (const event of events) types.push(event.type);
    return types;
  }

  it("run() waits through a run longer than the timeout whose silences are all shorter", async () => {
    globalThis.fetch = timedFetch({ chunks: longRunShortSilences });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN, timeout: 100 });

    const { value, error } = await settleAfter(client.run("dev/agent", {}), 1_000);

    expect(error).toBeUndefined();
    expect(value?.status).toBe("completed");
    expect(value?.output).toEqual({ answer: "ok" });
  });

  it("stream() yields a whole run longer than the timeout whose silences are all shorter", async () => {
    globalThis.fetch = timedFetch({ chunks: longRunShortSilences });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const { value, error } = await settleAfter(
      drain(client.stream("dev/agent", {}, { timeout: 100 })),
      1_000,
    );

    expect(error).toBeUndefined();
    expect(value?.at(0)).toBe("run_start");
    expect(value?.filter((type) => type === "run_heartbeat")).toHaveLength(10);
    expect(value?.at(-1)).toBe("run_complete");
  });

  it("run() times out when one silence outlasts the timeout", async () => {
    globalThis.fetch = timedFetch({ chunks: oneLongSilence });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const { error } = await settleAfter(client.run("dev/agent", {}, { timeout: 100 }), 1_000);

    expect(error).toBeInstanceOf(SkrunApiError);
    expect((error as SkrunApiError).code).toBe("TIMEOUT");
  });

  it("stream() times out when one silence outlasts the timeout", async () => {
    globalThis.fetch = timedFetch({ chunks: oneLongSilence });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN, timeout: 100 });

    const { error } = await settleAfter(drain(client.stream("dev/agent", {})), 1_000);

    expect(error).toBeInstanceOf(SkrunApiError);
    expect((error as SkrunApiError).code).toBe("TIMEOUT");
  });

  it("stream(): leaving it early (a break) closes the connection", async () => {
    const fetchMock = timedFetch({ chunks: longRunShortSilences });
    globalThis.fetch = fetchMock;
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const leftEarly = (async () => {
      for await (const event of client.stream("dev/agent", {})) {
        if (event.type === "run_start") break;
      }
    })();
    const { error } = await settleAfter(leftEarly, 10);

    expect(error).toBeUndefined();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    expect(signal?.aborted, "the request's signal, once the consumer has left").toBe(true);
  });

  it("stream(): a stream read to its end leaves the request alone", async () => {
    const fetchMock = timedFetch({ chunks: [start, complete(10)] });
    globalThis.fetch = fetchMock;
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const { value } = await settleAfter(drain(client.stream("dev/agent", {})), 100);

    expect(value).toEqual(["run_start", "run_complete"]);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
  });

  it("times out when the answer itself takes longer than the timeout", async () => {
    globalThis.fetch = timedFetch({ headersAfterMs: 150, chunks: [start, complete(10)] });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN, timeout: 100 });

    const { error } = await settleAfter(client.run("dev/agent", {}), 1_000);

    expect(error).toBeInstanceOf(SkrunApiError);
    expect((error as SkrunApiError).code).toBe("TIMEOUT");
  });

  it("still completes a run that ends within the default timeout, as it always did", async () => {
    // 40 s in all, under the 60 s default: no silence can be longer than the
    // whole, so a call that succeeded under a total timeout succeeds here.
    globalThis.fetch = timedFetch({ chunks: [start, beat(20_000), complete(20_000)] });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN });

    const { value, error } = await settleAfter(client.run("dev/agent", {}), 60_000);

    expect(error).toBeUndefined();
    expect(value?.status).toBe("completed");
  });

  it("keeps a total timeout on a call that is not streamed", async () => {
    // Two chunks 60 ms apart each: no silence reaches 100 ms, the whole does.
    globalThis.fetch = timedFetch({
      contentType: "application/json",
      chunks: [
        { afterMs: 60, text: '{"agents":[],"total":0,' },
        { afterMs: 60, text: '"page":1,"limit":20}' },
      ],
    });
    const client = new SkrunClient({ baseUrl: BASE_URL, token: TOKEN, timeout: 100 });

    const { value, error } = await settleAfter(client.list(), 1_000);

    expect(value).toBeUndefined();
    expect((error as Error).name).toBe("TimeoutError");
  });
});

describe("the client never follows a redirect — two real servers", () => {
  const originalFetch = globalThis.fetch;
  let servers: Server[] = [];

  /** A server on 127.0.0.1, on a free port; its address. */
  async function listen(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    servers = [];
  });

  /** B records every request it receives; A answers each request with `status`, towards `location(B)`. */
  async function redirectingPair(
    status: number,
    location: (target: string) => string | undefined,
  ): Promise<{ a: string; b: string; atA: IncomingHttpHeaders[]; atB: string[] }> {
    const atB: string[] = [];
    const b = await listen((req, res) => {
      atB.push(`${req.method} ${req.url}`);
      res.end("b");
    });
    const atA: IncomingHttpHeaders[] = [];
    const target = location(b);
    const a = await listen((req, res) => {
      atA.push(req.headers);
      req.resume();
      res.writeHead(status, target === undefined ? {} : { Location: target });
      res.end();
    });
    return { a, b, atA, atB };
  }

  /** What a refusal says: its code, its status, its message. */
  const said = (err: unknown) => ({
    code: (err as SkrunApiError).code,
    status: (err as SkrunApiError).status,
    message: (err as SkrunApiError).message,
  });

  const CALLS: Array<[string, (client: SkrunClient) => Promise<unknown>]> = [
    [
      "run(), with a model key and a body",
      (client) => client.run("dev/agent", { query: "hello" }, { llmKeys: { google: "model-key" } }),
    ],
    ["uploadFile()", (client) => client.uploadFile(new Uint8Array([1, 2, 3]))],
    ["list()", (client) => client.list()],
  ];
  const CASES = [301, 302, 303, 307, 308].flatMap((status) =>
    CALLS.map(([name, call]) => [status, name, call] as const),
  );

  it.each(
    CASES,
  )("HTTP %i to %s: the target receives nothing, and the error names its origin", async (status, name, call) => {
    const { a, b, atA, atB } = await redirectingPair(status, (target) => `${target}/elsewhere`);

    const err = await call(new SkrunClient({ baseUrl: a, token: TOKEN })).catch((e: unknown) => e);

    expect(atB).toEqual([]);
    // An upload hands a refusal on as the cause of its own error, as it always did.
    const refused = name === "uploadFile()" ? (err as SkrunFileUploadError).cause : err;
    if (name === "uploadFile()") expect(err).toBeInstanceOf(SkrunFileUploadError);
    expect(refused).toBeInstanceOf(SkrunApiError);
    expect(said(refused)).toEqual({
      code: "REDIRECT_REFUSED",
      status,
      message: `The server at ${a} answered with a redirect to ${b}, which the client does not follow.`,
    });
    // The request that met the redirect did carry the token: the target is spared by the client.
    expect(atA.map((headers) => headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("a relative Location names the server itself", async () => {
    const { a, atB } = await redirectingPair(307, () => "/elsewhere");

    const err = await new SkrunClient({ baseUrl: a, token: TOKEN }).list().catch((e: unknown) => e);

    expect(atB).toEqual([]);
    expect(said(err)).toEqual({
      code: "REDIRECT_REFUSED",
      status: 307,
      message: `The server at ${a} answered with a redirect to ${a}, which the client does not follow.`,
    });
  });

  it.each([
    ["without a Location", () => undefined],
    ["towards an address that is not http:// or https://", () => "ftp://elsewhere.example/x"],
  ])("a redirect %s says so, and names no target", async (_case, location) => {
    const { a, atB } = await redirectingPair(302, location);

    const err = await new SkrunClient({ baseUrl: a, token: TOKEN }).list().catch((e: unknown) => e);

    expect(atB).toEqual([]);
    expect(said(err)).toEqual({
      code: "REDIRECT_REFUSED",
      status: 302,
      message: `The server at ${a} answered with a redirect (HTTP 302), which the client does not follow.`,
    });
  });

  it("a browser's opaque redirect: the same code, status 0, and the target it does not reveal left unnamed", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      statusText: "",
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(opaque);
    globalThis.fetch = fetchMock;

    const err = await new SkrunClient({ baseUrl: BASE_URL, token: TOKEN })
      .list()
      .catch((e: unknown) => e);

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(err).toBeInstanceOf(SkrunApiError);
    expect(said(err)).toEqual({
      code: "REDIRECT_REFUSED",
      status: 0,
      message: `The server at ${BASE_URL} answered with a redirect, whose target a browser does not reveal; the client does not follow it.`,
    });
  });
});
