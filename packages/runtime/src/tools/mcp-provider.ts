import type { McpServer } from "@skrun-dev/schema";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import { isHostAllowed } from "../security/network.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

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

  private allowedHosts: string[];

  constructor(
    private config: McpServer,
    logger?: Logger,
    allowedHosts: string[] = [],
  ) {
    this.logger = logger ?? createLogger("mcp");
    this.allowedHosts = allowedHosts;
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
    // Allowlist enforcement for remote URLs
    if (this.config.url) {
      const hostname = new URL(this.config.url).hostname;
      if (!isHostAllowed(hostname, this.allowedHosts)) {
        throw new Error(`Blocked connection — host "${hostname}" is not in allowed_hosts`);
      }
    }

    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const url = this.config.url ?? "";
    const transport = new SSEClientTransport(new URL(url));
    await this.client.connect(transport);
  }

  private async connectStreamableHTTP(): Promise<void> {
    // Allowlist enforcement for remote URLs
    if (this.config.url) {
      const hostname = new URL(this.config.url).hostname;
      if (!isHostAllowed(hostname, this.allowedHosts)) {
        throw new Error(`Blocked connection — host "${hostname}" is not in allowed_hosts`);
      }
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
      return await this.executeCallTool(name, args);
    } catch (err) {
      // Reconnect-on-error: if the call fails with a connection-like error, retry once
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isConnectionError(msg)) {
        this.logger.warn(
          { event: "mcp_reconnect", server: this.config.name, error: msg },
          `MCP connection lost, reconnecting "${this.config.name}"`,
        );
        try {
          await this.disconnect();
          await this.connect();
          return await this.executeCallTool(name, args);
        } catch (retryErr) {
          return {
            content: retryErr instanceof Error ? retryErr.message : String(retryErr),
            isError: true,
          };
        }
      }
      return { content: msg, isError: true };
    }
  }

  private async executeCallTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    const content =
      result.content
        ?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
        .join("") ?? "";
    return { content, isError: result.isError ?? false };
  }

  private isConnectionError(msg: string): boolean {
    const patterns = ["closed", "ECONNRESET", "EPIPE", "ECONNREFUSED", "not connected"];
    return patterns.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
  }

  /** Stable key for caching this MCP provider by its config. */
  getConfigKey(): string {
    return JSON.stringify({
      name: this.config.name,
      url: this.config.url,
      command: this.config.command,
      args: this.config.args,
      transport: this.config.transport,
    });
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
