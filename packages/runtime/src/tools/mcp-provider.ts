import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@skrun-dev/schema";
import { McpConnectError } from "../errors.js";
import { describeBytes } from "../files/output-rules.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { isHostAllowed } from "../security/network.js";
import { createGuardedFetch } from "../security/safe-fetch.js";
import { errorFields } from "../utils/error-fields.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

// Bumped from 30s to 120s after empirical measurement: `npx -y @playwright/mcp`
// cold-start (package resolve + Playwright init handshake) takes ~70s even
// when chromium is already cached on disk. A 30s bound failed 100% of the
// time on fresh registry processes when it was investigated. 120s
// leaves headroom for true cold cache (chromium download).
// In a cloud sandbox, a connection follows the dependency install inside the
// runner's /init: this value and the install's limit together stay under the
// harness's wait for /init (INIT_RPC_TIMEOUT_MS, adapter/flyio/adapter.ts), and
// a test there compares the three.
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 120_000;

// MCP SDK's JSON-RPC `RequestTimeout` error code (see
// @modelcontextprotocol/sdk types.ts ErrorCode enum). Surfaced by the SDK
// itself when `client.connect(transport, { timeout })` exceeds the bound.
const MCP_SDK_REQUEST_TIMEOUT_CODE = -32001;

/**
 * The JSON-RPC codes the SDK gives failures of its own on a connection: a
 * transport it saw close (`ConnectionClosed`, -32000) and a request that timed
 * out (`RequestTimeout`). Neither is an answer of the server's, so neither is
 * kept as one — and a server that answers -32000 itself cannot be told from
 * them.
 */
const SDK_MADE_RPC_CODES: ReadonlySet<number> = new Set([-32000, MCP_SDK_REQUEST_TIMEOUT_CODE]);

/**
 * What a failed connection's server answered, read from the SDK's own error
 * classes, never from a message: the status a remote server refused it with —
 * a Streamable HTTP server (`StreamableHTTPError.code`), or an SSE server that
 * refused its event stream (`SseError.code`), a status only between 100 and
 * 599 —, and the code of a JSON-RPC error the server sent (`McpError.code`), on
 * any transport. An SSE server that refuses the request the handshake sends
 * once its stream is open keeps no status: the SDK says that refusal only in
 * its text. The SDK's modules are the ones the connection already loaded; one
 * that does not load leaves its fact out.
 */
async function answeredFacts(
  err: unknown,
  mode: "stdio" | "sse" | "streamable-http",
): Promise<{ httpStatus?: number; rpcCode?: number }> {
  const facts: { httpStatus?: number; rpcCode?: number } = {};
  try {
    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    if (
      err instanceof McpError &&
      Number.isInteger(err.code) &&
      !SDK_MADE_RPC_CODES.has(err.code)
    ) {
      facts.rpcCode = err.code;
    }
  } catch {
    // Not loaded: no code read.
  }
  if (mode === "stdio") return facts;
  try {
    let status: unknown;
    if (mode === "streamable-http") {
      const { StreamableHTTPError } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      status = err instanceof StreamableHTTPError ? err.code : undefined;
    } else {
      const { SseError } = await import("@modelcontextprotocol/sdk/client/sse.js");
      status = err instanceof SseError ? err.code : undefined;
    }
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      facts.httpStatus = status;
    }
  } catch {
    // Not loaded: no status read.
  }
  return facts;
}

/**
 * The most a local (stdio) MCP server may write in one message: 10 MiB, counted
 * as the bytes of the JSON-RPC message it writes, envelope and escapes included.
 * The SDK's stdio transport reads a server's output into a buffer of at most
 * this size — a message, and what of the next one arrived in the same read as
 * its end; past it, the transport reports an error and closes the connection.
 * 10 MiB is the SDK's own default since 1.30.0 (`STDIO_DEFAULT_MAX_BUFFER_SIZE`),
 * passed explicitly so that the bound is ours: an SDK release that moved its
 * default would not move it. A remote server (SSE, Streamable HTTP) has no such
 * bound. A text that names the bound says it through `describeBytes` of this.
 */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * How the SDK's stdio transport words the error it reports when a server's
 * message passes the bound (`ReadBuffer.append`, `shared/stdio.js`). It has no
 * class or code of its own, so it is recognised by its text; a test drives a
 * real server past the bound and fails if a release of the SDK rewords it.
 */
const STDIO_MESSAGE_TOO_LARGE = /^ReadBuffer exceeded maximum size/;

/**
 * What the model reads when a call's connection closed on a message past the
 * bound. Every call waiting on that connection reads it, and the message may
 * have been another call's answer, or one no call asked for: the text never
 * says it was this call's.
 */
function messageTooLargeResult(server: string): ToolResult {
  return {
    content: `The connection to MCP server "${server}" was closed because the server sent a message larger than ${describeBytes(MCP_STDIO_MAX_MESSAGE_BYTES)}, the most a local (stdio) MCP server may send at once: this call's result could not be read. The tool may have run; the call was not retried.`,
    isError: true,
  };
}

/** What a log line writes for a remote server's URL it cannot reduce to an origin. */
const UNPARSEABLE_SERVER_URL = "(unparseable server URL, not logged)";

/** What a failed connection's error says of a remote server's URL that has no origin. */
const URL_WITH_NO_ORIGIN = "a URL with no origin";

/**
 * A remote MCP server's origin, that is its scheme, host and port — nothing
 * else of its URL, which can carry a credential in its user-info, its path or
 * its query. Undefined for a value that does not parse, or whose scheme has no
 * origin.
 */
function originOf(url: string | undefined): string | undefined {
  let origin: string;
  try {
    origin = new URL(url ?? "").origin;
  } catch {
    return undefined;
  }
  return origin === "null" ? undefined : origin;
}

/**
 * What a log line may say about a remote MCP server: its origin. A value with
 * no origin is not written at all.
 */
function serverOrigin(url: string | undefined): string {
  return originOf(url) ?? UNPARSEABLE_SERVER_URL;
}

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
  /** The connections a local server closed by sending a message past the bound. */
  private readonly pastBound = new WeakSet<Client>();

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
      // What the error names the server by. It reaches whoever called the run
      // — the local route answers with the error's message and details —, so a
      // remote server is named by its origin only, as the log line names it.
      const location =
        mode === "stdio"
          ? `command "${this.config.command}"`
          : (originOf(this.config.url) ?? URL_WITH_NO_ORIGIN);
      // The SDK throws `McpError` with code `-32001` (RequestTimeout) when
      // `client.connect(transport, { timeout })` exceeds the bound — that's
      // our timeout, plumbed through (see connectStdio/SSE/HTTP below).
      const errCode =
        err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
      const isTimeout = errCode === MCP_SDK_REQUEST_TIMEOUT_CODE;
      // The line names a remote server by its origin, a local one by its
      // command, and the error by its class, code and status — never its
      // message, which can quote the URL.
      this.logger.warn(
        {
          event: isTimeout ? "mcp_connect_timeout" : "mcp_connect_failed",
          server: this.config.name,
          transport: mode,
          location: mode === "stdio" ? location : serverOrigin(this.config.url),
          timeout_ms: isTimeout ? this.connectTimeoutMs : undefined,
          ...errorFields(err),
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
      // MCP_CONNECT_FAILED to the caller. The error keeps what the server
      // answered, which tells a refusal of the server's from a failure to reach it.
      throw new McpConnectError(
        {
          server: this.config.name,
          transport: mode,
          location,
          isTimeout,
          ...(isTimeout && { timeoutMs: this.connectTimeoutMs }),
          ...(await answeredFacts(err, mode)),
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
      maxBufferSize: MCP_STDIO_MAX_MESSAGE_BYTES,
    });

    // Plumb our timeout through the SDK — without this option the SDK
    // falls back to DEFAULT_REQUEST_TIMEOUT_MSEC (60s) and any larger
    // skrun-side bound is unreachable (same constraint Anthropic
    // documents in claude-code #16837). Single source of truth.
    const client = this.client;
    if (!client) throw new Error("MCP client not initialized");
    // A message past the bound reaches us only here: the transport reports it,
    // then closes, and the pending call fails with a bare "Connection closed".
    // The client chains this handler when it takes the transport over. Once
    // per connection: the rest of the message can still arrive and fail too.
    transport.onerror = (error) => {
      if (!STDIO_MESSAGE_TOO_LARGE.test(error.message) || this.pastBound.has(client)) return;
      this.pastBound.add(client);
      this.logger.warn(
        {
          event: "mcp_message_too_large",
          server: this.config.name,
          transport: "stdio",
          max_bytes: MCP_STDIO_MAX_MESSAGE_BYTES,
          ...errorFields(error),
        },
        `MCP server "${this.config.name}" sent a message larger than ${describeBytes(MCP_STDIO_MAX_MESSAGE_BYTES)}: connection closed`,
      );
    };
    await client.connect(transport, { timeout: this.connectTimeoutMs });
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
    // SSRF guard: validate the address at connect time (the string host check
    // above can't see DNS), and hold every connection — redirect hops included —
    // to the agent's allowed_hosts. The SDK routes every transport request
    // through this fetch.
    const transport = new SSEClientTransport(new URL(url), {
      fetch: createGuardedFetch({ allowedHosts: this.allowedHosts }) as unknown as typeof fetch,
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
    // SSRF guard: address and allowed_hosts at every connection (see connectSSE).
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: createGuardedFetch({ allowedHosts: this.allowedHosts }) as unknown as typeof fetch,
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
    // A connection closed past the bound between two calls — by a message the
    // server sent unasked — is replaced before this call goes out: the call
    // never reached that server, and has no reason to fail.
    if (this.client && this.pastBound.has(this.client)) {
      await this.replaceConnection(this.client);
    }
    const client = this.client;
    if (!this.connected || !client) {
      return { content: "MCP server not connected", isError: true };
    }

    try {
      return await this.executeCallTool(name, args);
    } catch (err) {
      // A connection a local server closed by sending a message past the bound,
      // during this call: the call reached the server, so it is never replayed
      // — the tool would run a second time, and most likely answer past the
      // bound again. The dead connection is replaced, so the next call finds a
      // live one.
      if (this.pastBound.has(client)) {
        await this.replaceConnection(client);
        return messageTooLargeResult(this.config.name);
      }
      // Reconnect-on-error: if the call fails with a connection-like error, retry once
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isConnectionError(msg)) {
        this.logger.warn(
          { event: "mcp_reconnect", server: this.config.name, ...errorFields(err) },
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

  /**
   * Closes `client`'s connection and opens a new one — unless another call has
   * already replaced it: two calls failed by the same message start one server,
   * not two. A new connection that fails leaves the provider disconnected, as a
   * failed reconnection does; `connect` logs why. It never throws: the call
   * that waits on it returns a result, where an error would reach the model
   * router as a failure of the model, and fail the run — a tool having run, no
   * fallback model takes over.
   */
  private async replaceConnection(client: Client): Promise<void> {
    if (this.client !== client) return;
    await this.disconnect();
    try {
      await this.connect();
    } catch {
      // Logged by connect(); the provider stays disconnected.
    }
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
    const client = this.client;
    // Cleared before the close is awaited: a call running meanwhile sees the
    // provider disconnected, never a client being closed.
    this.client = null;
    this.connected = false;
    if (client) {
      try {
        // StdioClientTransport handles killing the subprocess on close
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}
