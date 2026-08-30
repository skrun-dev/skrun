import type { ToolDefinition, ToolProvider, ToolResult } from "../../tools/types.js";
import { type RpcToolProviderOptions, rpcToolCall } from "./rpc-script-provider.js";

/**
 * `RpcMcpToolProvider` — harness-side stub that forwards MCP tool calls
 * to the runner over HTTP RPC. Symmetric to `RpcScriptToolProvider`, but
 * carries the `kind: "mcp"` discriminator so the runner can dispatch to
 * the right `McpToolProvider` instance internally.
 *
 * `listTools()` returns the cached array supplied at construction (the
 * harness gets it from the runner's `/init` response). A single instance
 * fronts ALL MCP servers configured for the agent — the runner side
 * already maps tool name → server, so the harness only needs one stub.
 */
export class RpcMcpToolProvider implements ToolProvider {
  private readonly baseUrl: string;
  private readonly tools: ToolDefinition[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly token?: string;

  constructor(baseUrl: string, tools: ToolDefinition[], options: RpcToolProviderOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.tools = tools;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.token = options.token;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return rpcToolCall(this.fetchImpl, this.baseUrl, this.timeoutMs, "mcp", name, args, {
      token: this.token,
    });
  }

  async disconnect(): Promise<void> {
    // No persistent connection — POST /tool is stateless.
  }
}
