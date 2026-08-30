import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../tools/types.js";
import { RpcScriptToolProvider } from "./rpc-script-provider.js";

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

  describe("callTool — RPC auth (SEC-2026-002)", () => {
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
