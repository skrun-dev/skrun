import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@skrun-dev/schema";
import { McpConnectError } from "../errors.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { isHostAllowed } from "../security/network.js";
import { createGuardedFetch } from "../security/safe-fetch.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

// Bumped from 30s to 120s after empirical measurement: `npx -y @playwright/mcp`
// cold-start (package resolve + Playwright init handshake) takes ~70s even
// when chromium is already cached on disk. A 30s bound failed 100% of the
// time on fresh registry processes — see the post-#83 investigation. 120s
// leaves headroom for true cold cache (chromium download).
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 120_000;

// MCP SDK's JSON-RPC `RequestTimeout` error code (see
// @modelcontextprotocol/sdk types.ts ErrorCode enum). Surfaced by the SDK
// itself when `client.connect(transport, { timeout })` exceeds the bound.
const MCP_SDK_REQUEST_TIMEOUT_CODE = -32001;

function resolveConnectTimeoutMs(): number {
  const raw = process.env.MCP_CONNECT_TIMEOUT_MS;
  if (!raw) return DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_CONNECT_TIMEOUT_MS;
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
  private client: Client | null = null;

  private allowedHosts: string[];
  private connectTimeoutMs: number;

  constructor(
    private config: McpServer,
    logger?: Logger,
    allowedHosts: string[] = [],
    connectTimeoutMs?: number,
  ) {
    this.logger = logger ?? createLogger("mcp");
    this.allowedHosts = allowedHosts;
    this.connectTimeoutMs = connectTimeoutMs ?? resolveConnectTimeoutMs();
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
      // The SDK throws `McpError` with code `-32001` (RequestTimeout) when
      // `client.connect(transport, { timeout })` exceeds the bound — that's
      // our timeout, plumbed through (see connectStdio/SSE/HTTP below).
      const errCode =
        err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
      const isTimeout = errCode === MCP_SDK_REQUEST_TIMEOUT_CODE;
      this.logger.warn(
        {
          event: isTimeout ? "mcp_connect_timeout" : "mcp_connect_failed",
          server: this.config.name,
          transport: mode,
          location,
          timeout_ms: isTimeout ? this.connectTimeoutMs : undefined,
          error: err instanceof Error ? err.message : String(err),
        },
        isTimeout
          ? `MCP connect timed out for "${this.config.name}" after ${this.connectTimeoutMs}ms`
          : `MCP connection failed for "${this.config.name}"`,
      );
      // Tear down any half-open transport (subprocess / HTTP connection) so we
      // don't leak resources when connect() throws partway through.
      try {
        await this.client?.close();
      } catch {
        // disconnect best-effort
      }
      this.client = null;
      this.tools = [];
      // Surface the failure to the caller. Swallowing here previously let the
      // run continue with `tools=[]`, the LLM would hallucinate plausible
      // outputs, and output-validation repair retry would massage them into
      // schema-compliant garbage — a silent success that masked a real
      // connection bug. Fail loudly instead so the route can return
      // MCP_CONNECT_FAILED to the caller.
      throw new McpConnectError(
        {
          server: this.config.name,
          transport: mode,
          location,
          isTimeout,
          ...(isTimeout && { timeoutMs: this.connectTimeoutMs }),
        },
        err,
      );
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

    // Plumb our timeout through the SDK — without this option the SDK
    // falls back to DEFAULT_REQUEST_TIMEOUT_MSEC (60s) and any larger
    // skrun-side bound is unreachable (same constraint Anthropic
    // documents in claude-code #16837). Single source of truth.
    if (!this.client) throw new Error("MCP client not initialized");
    await this.client.connect(transport, { timeout: this.connectTimeoutMs });
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
    // SSRF guard: validate the RESOLVED IP at connect time (the string host check
    // above can't see DNS). The SDK routes every transport request through this fetch.
    const transport = new SSEClientTransport(new URL(url), {
      fetch: createGuardedFetch() as unknown as typeof fetch,
    });
    if (!this.client) throw new Error("MCP client not initialized");
    await this.client.connect(transport, { timeout: this.connectTimeoutMs });
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
    // SSRF guard: validate the RESOLVED IP at connect time (see connectSSE).
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: createGuardedFetch() as unknown as typeof fetch,
    });
    if (!this.client) throw new Error("MCP client not initialized");
    await this.client.connect(transport, { timeout: this.connectTimeoutMs });
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
    if (!this.client) throw new Error("MCP client not initialized");
    // The SDK types callTool's result loosely; narrow the content/isError shape.
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const content =
      result.content?.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("") ?? "";
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
