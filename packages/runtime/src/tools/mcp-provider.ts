import type { McpServer } from "@skrun-dev/schema";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

// Block list for SSRF protection — internal/private IP ranges (remote only)
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BLOCKED_HOSTS.some((pattern) => pattern.test(parsed.hostname));
  } catch {
    return true;
  }
}

/**
 * MCP Tool Provider — connects to an MCP server and exposes its tools.
 *
 * Supports 3 transport modes:
 * - stdio: local MCP server spawned as subprocess (command + args)
 * - streamable-http: new MCP standard for remote servers (default when url provided)
 * - sse: legacy remote transport (explicit opt-in)
 */
export class McpToolProvider implements ToolProvider {
  private tools: ToolDefinition[] = [];
  private connected = false;
  private logger: Logger;
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK Client type not easily importable at top level
  private client: any = null;

  constructor(
    private config: McpServer,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("mcp");
  }

  private getTransportMode(): "stdio" | "sse" | "streamable-http" {
    if (this.config.transport === "stdio") return "stdio";
    if (this.config.transport === "sse") return "sse";
    if (this.config.transport === "streamable-http") return "streamable-http";
    // Default: url without explicit transport → streamable-http
    if (this.config.url) return "streamable-http";
    return "stdio";
  }

  async connect(): Promise<void> {
    const mode = this.getTransportMode();

    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      this.client = new Client({ name: "skrun-runtime", version: "0.1.0" }, { capabilities: {} });

      if (mode === "stdio") {
        await this.connectStdio();
      } else if (mode === "sse") {
        await this.connectSSE();
      } else {
        await this.connectStreamableHTTP();
      }

      // List tools after connection
      const result = await this.client.listTools();
      this.tools = (result.tools ?? []).map(
        (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
          name: t.name,
          description: t.description ?? `MCP tool: ${t.name}`,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        }),
      );

      this.connected = true;
    } catch (err) {
      const location = mode === "stdio" ? `command "${this.config.command}"` : `${this.config.url}`;
      this.logger.warn(
        {
          event: "mcp_connect_failed",
          server: this.config.name,
          transport: mode,
          location,
          error: err instanceof Error ? err.message : String(err),
        },
        `MCP connection failed for "${this.config.name}"`,
      );
      this.tools = [];
    }
  }

  private async connectStdio(): Promise<void> {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const command = this.config.command ?? "";
    const args = this.config.args ?? [];

    // MCP servers are npm packages launched via npx (ecosystem standard).
    // npx handles dependency resolution — no NODE_PATH needed.
    // This is the same pattern Claude Desktop uses.
    const transport = new StdioClientTransport({
      command,
      args,
    });

    await this.client.connect(transport);
  }

  private async connectSSE(): Promise<void> {
    // SSRF protection for remote URLs
    if (this.config.url && isBlockedUrl(this.config.url)) {
      throw new Error(
        `Blocked connection — URL "${this.config.url}" points to internal/private address`,
      );
    }

    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const url = this.config.url ?? "";
    const transport = new SSEClientTransport(new URL(url));
    await this.client.connect(transport);
  }

  private async connectStreamableHTTP(): Promise<void> {
    // SSRF protection for remote URLs
    if (this.config.url && isBlockedUrl(this.config.url)) {
      throw new Error(
        `Blocked connection — URL "${this.config.url}" points to internal/private address`,
      );
    }

    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const url = this.config.url ?? "";
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await this.client.connect(transport);
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.connected) {
      await this.connect();
    }
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.connected || !this.client) {
      return { content: "MCP server not connected", isError: true };
    }

    try {
      const result = await this.client.callTool({ name, arguments: args });
      const content =
        result.content
          ?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
          .join("") ?? "";
      return { content, isError: result.isError ?? false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // StdioClientTransport handles killing the subprocess on close
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
    this.connected = false;
  }
}
