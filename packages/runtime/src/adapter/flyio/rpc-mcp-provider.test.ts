import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../tools/types.js";
import { RpcMcpToolProvider } from "./rpc-mcp-provider.js";
import { TOOL_ANSWER_REFUSED } from "./rpc-script-provider.js";

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

  it("sends Authorization: Bearer <token> when a token is configured", async () => {
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

  it("refuses an answer past 1 MiB as a tool result in error — an MCP result has no cap of its own", async () => {
    const head = JSON.stringify({ isError: false, content: "" });
    const answer = `${head.slice(0, -2)}${"m".repeat(1024 * 1024 + 1 - head.length)}"}`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(answer, { status: 200 }));
    const provider = new RpcMcpToolProvider("http://machine:9000", SAMPLE_TOOLS, {
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock
      fetchImpl: fetchImpl as any,
    });

    const result = await provider.callTool("playwright_navigate", {});

    expect(result).toEqual({
      content: TOOL_ANSWER_REFUSED,
      isError: true,
    });
  });
});

describe("RpcMcpToolProvider — a redirect from the sandbox is never followed", () => {
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
      res.writeHead(307, { Location: `${target.url}/internal` });
      res.end();
    });
    // No fetch given: the provider's own, on the loopback address.
    const provider = new RpcMcpToolProvider(runner.url, SAMPLE_TOOLS);

    const result = await provider.callTool("playwright_navigate", {});

    expect(target.hits).toEqual([]);
    expect(result).toEqual({
      content: "RPC failed: /tool answered with a redirect, which is never followed",
      isError: true,
    });
  });
});
