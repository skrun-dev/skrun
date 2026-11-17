import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_RESPONSE_MAX_BYTES } from "../../files/output-rules.js";
import type { ToolDefinition } from "../../tools/types.js";
import { RpcScriptToolProvider, TOOL_ANSWER_REFUSED } from "./rpc-script-provider.js";

const SAMPLE_TOOLS: ToolDefinition[] = [
  { name: "search", description: "search the web", parameters: {} },
  { name: "fetch_url", description: "fetch a URL", parameters: {} },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

describe("RpcScriptToolProvider", () => {
  describe("listTools", () => {
    it("returns the cached tools supplied at construction without making any HTTP call", async () => {
      const fetchImpl = vi.fn();
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });
      const tools = await provider.listTools();
      expect(tools).toEqual(SAMPLE_TOOLS);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("callTool — happy path", () => {
    it("POSTs to /tool with the kind=script discriminator and returns the runner result verbatim", async () => {
      const runnerResult = { content: "search results: skrun", isError: false };
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(runnerResult));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });

      const result = await provider.callTool("search", { query: "skrun" });

      expect(result).toEqual(runnerResult);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("http://machine:9000/tool");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        kind: "script",
        name: "search",
        args: { query: "skrun" },
      });
    });

    it("strips trailing slashes from the baseUrl so callers can pass either form", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: "ok", isError: false }));
      const provider = new RpcScriptToolProvider("http://machine:9000/", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });
      await provider.callTool("search", {});
      expect(fetchImpl.mock.calls[0][0]).toBe("http://machine:9000/tool");
    });
  });

  describe("callTool — RPC auth", () => {
    it("sends Authorization: Bearer <token> when a token is configured", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: "ok", isError: false }));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
        token: "run-token-abc",
      });
      await provider.callTool("search", {});
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer run-token-abc");
    });

    it("omits the Authorization header when no token is configured", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: "ok", isError: false }));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });
      await provider.callTool("search", {});
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Authorization).toBeUndefined();
    });
  });

  describe("callTool — isError passthrough", () => {
    it("preserves runner's isError=true so the LLM loop can react to tool failures", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          content: "search backend returned 500",
          isError: true,
        }),
      );
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });

      const result = await provider.callTool("search", { query: "skrun" });
      expect(result.isError).toBe(true);
      expect(result.content).toBe("search backend returned 500");
    });
  });

  describe("callTool — error translation", () => {
    it("translates a non-2xx HTTP response into a ToolResult with isError=true", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(textResponse("upstream timeout", 503));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });

      const result = await provider.callTool("search", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("HTTP 503");
      expect(result.content).toContain("upstream timeout");
    });

    it("translates a network error into a ToolResult with isError=true (machine unreachable)", async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });

      const result = await provider.callTool("search", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("fetch failed");
    });

    it("translates a request timeout into a ToolResult with isError=true citing the configured bound", async () => {
      const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit | undefined) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
        timeoutMs: 50,
      });

      const result = await provider.callTool("search", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("50ms timeout");
    });

    it("translates a malformed runner response into a ToolResult with isError=true", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ wat: "no content field" }));
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
        // biome-ignore lint/suspicious/noExplicitAny: vitest mock
        fetchImpl: fetchImpl as any,
      });

      const result = await provider.callTool("search", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("malformed body");
    });
  });

  describe("disconnect", () => {
    it("is a no-op (no persistent connection)", async () => {
      const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS);
      await expect(provider.disconnect()).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// The answer to a tool call comes from the sandbox, where the agent's code
// runs: it is read up to 1 MiB — the most the runner answers once it has cut a
// result — and a redirect is never followed.
// ---------------------------------------------------------------------------

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * A body in memory that counts what its reader took: one chunk per read, none
 * read ahead. It ends by itself.
 */
function countedBody(text: string, chunk = 4 * KIB) {
  const bytes = Buffer.from(text);
  const state = { delivered: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.delivered >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, state.delivered + chunk);
        controller.enqueue(new Uint8Array(bytes.subarray(state.delivered, end)));
        state.delivered = end;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** A tool answer, as the runner serializes it, of exactly `size` bytes. */
function toolAnswer(size: number): string {
  const head = JSON.stringify({ isError: false, content: "" });
  return `${head.slice(0, -2)}${"r".repeat(size - head.length)}"}`;
}

describe("RpcScriptToolProvider — the sandbox's answer is read up to 1 MiB", () => {
  it("takes an answer of exactly 1 MiB, as the runner sends it once it has cut a result", async () => {
    const answer = toolAnswer(MIB);
    expect(Buffer.byteLength(answer)).toBe(MIB);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(answer, { status: 200 }));
    const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("search", {});

    const envelope = Buffer.byteLength(JSON.stringify({ isError: false, content: "" }));
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(MIB - envelope);
  });

  it("refuses an answer one byte past 1 MiB — a runner that did not cut it — as a tool result in error, past which it reads nothing", async () => {
    const body = countedBody(toolAnswer(MIB + 1));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body.stream, { status: 200 }));
    const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("search", {});

    expect(result).toEqual({
      content: TOOL_ANSWER_REFUSED,
      isError: true,
    });
    expect(body.state.delivered).toBeLessThanOrEqual(MIB + 4 * KIB);
    expect(body.state.cancelled).toBe(true);
  });

  it("names in its refusal the bound it reads to: the constant's, never a copy of it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(toolAnswer(TOOL_RESPONSE_MAX_BYTES + 1), { status: 200 }));
    const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("search", {});

    expect(result.isError).toBe(true);
    const named = /more than (\d+) (MiB|KiB|bytes)\./.exec(result.content);
    const unit = { MiB: MIB, KiB: KIB, bytes: 1 }[named?.[2] as "MiB" | "KiB" | "bytes"];
    expect(named && Number(named[1]) * unit).toBe(TOOL_RESPONSE_MAX_BYTES);
  });

  it("reads 4 KiB of a 1 MiB error answer", async () => {
    const body = countedBody("e".repeat(MIB));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body.stream, { status: 502, statusText: "Bad Gateway" }));
    const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("search", {});

    expect(result.isError).toBe(true);
    expect(result.content).toBe(`RPC failed: HTTP 502 Bad Gateway ${"e".repeat(4 * KIB)}`);
    expect(body.state.delivered).toBeLessThanOrEqual(4 * KIB + 4 * KIB);
    expect(body.state.cancelled).toBe(true);
  });

  it("cuts an answer still coming at the call's bound, as the timeout it is", async () => {
    // The head of an answer at once, then one byte every 20 ms, ending by itself
    // after 3 s; a bound of 200 ms — ten intervals.
    let headSent = false;
    let ticks = 0;
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!headSent) {
            headSent = true;
            controller.enqueue(new TextEncoder().encode('{"isError":false,"content":"'));
            return;
          }
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!state.cancelled) {
                ticks += 1;
                if (ticks > 150) controller.close();
                else controller.enqueue(new Uint8Array([0x72]));
              }
              resolve();
            }, 20);
          });
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const provider = new RpcScriptToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
      timeoutMs: 200,
    });
    const startedAt = Date.now();

    const result = await provider.callTool("search", {});

    expect(result).toEqual({
      content: 'RPC failed: tool "search" exceeded 200ms timeout',
      isError: true,
    });
    expect(state.cancelled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("RpcScriptToolProvider — a redirect from the sandbox is never followed", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            // Stop accepting first, then end every connection: the order Node documents.
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.on("error", () => {});
      handler(req, res);
    });
    server.on("connection", (socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }

  it("turns a redirect into a tool result in error, and the address it points at is never asked", async () => {
    const target = await listen((_req, res) =>
      res.end(JSON.stringify({ content: "an internal answer", isError: false })),
    );
    const runner = await listen((_req, res) => {
      res.writeHead(302, { Location: `${target.url}/internal` });
      res.end();
    });
    // No fetch given: the provider's own, on the loopback address.
    const provider = new RpcScriptToolProvider(runner.url, SAMPLE_TOOLS);

    const result = await provider.callTool("search", {});

    expect(target.hits).toEqual([]);
    expect(result).toEqual({
      content: "RPC failed: /tool answered with a redirect, which is never followed",
      isError: true,
    });
    expect(runner.hits).toEqual(["/tool"]);
  });
});
