import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../tools/types.js";
import { RpcMcpToolProvider } from "./rpc-mcp-provider.js";

const SAMPLE_TOOLS: ToolDefinition[] = [
  { name: "playwright_navigate", description: "navigate browser", parameters: {} },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RpcMcpToolProvider", () => {
  it("returns the cached tools without making any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });
    const tools = await provider.listTools();
    expect(tools).toEqual(SAMPLE_TOOLS);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends Authorization: Bearer <token> when a token is configured (SEC-2026-002)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: "ok", isError: false }));
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
      token: "run-token-mcp",
    });
    await provider.callTool("playwright_navigate", {});
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer run-token-mcp");
  });

  it("POSTs to /tool with kind=mcp (the discriminator the runner switches on)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ content: "navigated to https://skrun.sh", isError: false }),
      );
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("playwright_navigate", { url: "https://skrun.sh" });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.kind).toBe("mcp");
    expect(body.name).toBe("playwright_navigate");
    expect(body.args).toEqual({ url: "https://skrun.sh" });
  });

  it("preserves isError=true (MCP server returned a tool failure, e.g. browser navigation refused)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        content: "Navigation blocked: host not in allowed_hosts",
        isError: true,
      }),
    );
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("playwright_navigate", { url: "https://evil.example" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation blocked");
  });

  it("translates a network error into a ToolResult with isError=true", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("connect ETIMEDOUT"));
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("playwright_navigate", { url: "https://skrun.sh" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ETIMEDOUT");
  });
});
