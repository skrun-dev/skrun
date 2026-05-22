import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { McpConnectError } from "../errors.js";
import { McpToolProvider } from "./mcp-provider.js";

const MOCK_SERVER = resolve(import.meta.dirname, "../../tests/fixtures/mock-mcp-server.js");

describe("McpToolProvider — stdio transport", () => {
  it("should connect to a stdio MCP server and list tools", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    const tools = await provider.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === "echo")).toBe(true);

    await provider.disconnect();
  });

  it("should call a tool via stdio and get result", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    await provider.listTools(); // triggers connect
    const result = await provider.callTool("echo", { text: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");

    await provider.disconnect();
  });

  it("throws McpConnectError when command is not found (no silent tools=[])", async () => {
    // Previously this swallowed the spawn error and returned tools=[].
    // The LLM then had no tools and could hallucinate plausible answers
    // that passed output-validation repair retry — silent garbage.
    // Now the failure surfaces as a typed error the route can convert to
    // 502 MCP_CONNECT_FAILED.
    const provider = new McpToolProvider({
      name: "test-missing",
      transport: "stdio",
      command: "nonexistent-command-xyz",
      args: [],
      auth: "none",
    });

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    await provider.disconnect();
  });

  it("should return transport mode correctly", async () => {
    const stdioProvider = new McpToolProvider({
      name: "t1",
      transport: "stdio",
      command: "node",
      auth: "none",
    });
    // Access private method via any for testing
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((stdioProvider as any).getTransportMode()).toBe("stdio");

    const urlProvider = new McpToolProvider({
      name: "t2",
      url: "https://example.com/mcp",
      auth: "none",
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((urlProvider as any).getTransportMode()).toBe("streamable-http");

    const sseProvider = new McpToolProvider({
      name: "t3",
      url: "https://example.com/sse",
      transport: "sse",
      auth: "none",
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((sseProvider as any).getTransportMode()).toBe("sse");
  });

  it("getConfigKey returns stable key for same config (VT-8)", () => {
    const config = {
      name: "test",
      url: "https://example.com/mcp",
      transport: "streamable-http" as const,
      auth: "none" as const,
    };
    const p1 = new McpToolProvider(config);
    const p2 = new McpToolProvider(config);
    expect(p1.getConfigKey()).toBe(p2.getConfigKey());
    expect(p1.getConfigKey()).toContain("example.com");
  });

  it("reconnect-on-error retries after connection drop (VT-9)", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    await provider.listTools(); // connect

    // Simulate connection drop by forcibly disconnecting the client
    // biome-ignore lint/suspicious/noExplicitAny: testing reconnect behavior
    const client = (provider as any).client;
    await client.close();

    // callTool should detect the connection error, reconnect, and succeed on retry
    const result = await provider.callTool("echo", { text: "after-reconnect" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("after-reconnect");

    await provider.disconnect();
  });

  it("throws McpConnectError when host not in allowedHosts (VT-11)", async () => {
    // allowed_hosts mismatch is a misconfiguration — fail the run loudly
    // rather than silently dropping tools (which led to hallucinated output
    // pre-fix, see post-#83 investigation).
    const provider = new McpToolProvider(
      {
        name: "blocked-remote",
        url: "https://mcp.blocked.com/sse",
        transport: "sse",
        auth: "none",
      },
      undefined,
      ["other.com"], // allowedHosts does NOT include mcp.blocked.com
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    await provider.disconnect();
  });

  it("stdio transport is not affected by allowedHosts", async () => {
    // allowedHosts=[] (all blocked) should NOT block stdio (local process)
    const provider = new McpToolProvider(
      {
        name: "test-stdio-allowed",
        transport: "stdio",
        command: "node",
        args: [MOCK_SERVER],
        auth: "none",
      },
      undefined,
      [], // empty = all blocked, but stdio is local — should still work
    );

    const tools = await provider.listTools();
    expect(tools.length).toBeGreaterThan(0);

    await provider.disconnect();
  });
});

describe("McpToolProvider — connect timeout", () => {
  const HANGING_SERVER = resolve(import.meta.dirname, "../../tests/fixtures/hanging-mcp-server.js");

  it("aborts connect with McpConnectError after the configured timeout when the MCP server never answers", async () => {
    // Subprocess spawns instantly but never speaks the MCP protocol — the
    // client.connect() handshake hangs forever waiting for `initialize`.
    // A small timeout (500ms) proves the bound fires; the throw is what
    // surfaces the failure to the route (502 MCP_CONNECT_FAILED).
    const provider = new McpToolProvider(
      {
        name: "test-hanging",
        transport: "stdio",
        command: "node",
        args: [HANGING_SERVER],
        auth: "none",
      },
      undefined,
      [],
      500, // connectTimeoutMs override
    );

    const t0 = Date.now();
    let caught: McpConnectError | null = null;
    try {
      await provider.listTools();
    } catch (err) {
      caught = err instanceof McpConnectError ? err : null;
    }
    const elapsed = Date.now() - t0;

    expect(caught).toBeInstanceOf(McpConnectError);
    expect(caught?.details.isTimeout).toBe(true);
    expect(caught?.details.timeoutMs).toBe(500);
    expect(caught?.details.server).toBe("test-hanging");
    // The bound should fire close to 500ms; allow generous slack for CI.
    expect(elapsed).toBeLessThan(5_000);

    await provider.disconnect();
  });
});
