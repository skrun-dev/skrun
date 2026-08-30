import type { ToolDefinition, ToolProvider, ToolResult } from "../../tools/types.js";

export interface RpcToolProviderOptions {
  /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 60_000 (most tool calls finish in seconds; long-poll tools should set their own bound). */
  timeoutMs?: number;
  /** Per-run RPC bearer token. When set, sent as `Authorization: Bearer <token>` on every RPC (SEC-2026-002). */
  token?: string;
}

/**
 * `RpcScriptToolProvider` — harness-side stub that forwards script tool
 * calls to the runner over HTTP RPC. The actual script execution happens
 * in the sandboxed machine; this class only proxies.
 *
 * `listTools()` returns the cached array supplied at construction (the
 * harness gets it from the runner's `/init` response — no extra
 * round-trip needed).
 */
export class RpcScriptToolProvider implements ToolProvider {
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
    return rpcToolCall(this.fetchImpl, this.baseUrl, this.timeoutMs, "script", name, args, {
      token: this.token,
    });
  }

  async disconnect(): Promise<void> {
    // No persistent connection — POST /tool is stateless.
  }
}

/**
 * Shared HTTP RPC body builder + response handler for both providers. A
 * network error or non-2xx response returns a `ToolResult` with
 * `isError: true` rather than throwing — the LLM loop treats it as a
 * tool failure (the tool's "behavior") instead of an adapter crash.
 */
export async function rpcToolCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  kind: "script" | "mcp",
  name: string,
  args: Record<string, unknown>,
  opts: { token?: string } = {},
): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    const response = await fetchImpl(`${baseUrl}/tool`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind, name, args }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      return {
        content: `RPC failed: HTTP ${response.status} ${response.statusText} ${text}`.trim(),
        isError: true,
      };
    }

    // The runner returns `{ content, isError }` directly (the ToolResult
    // shape). Preserve isError so the LLM loop can decide whether to
    // continue or surface the failure.
    const body = (await response.json().catch(() => null)) as ToolResult | null;
    if (!body || typeof body.content !== "string" || typeof body.isError !== "boolean") {
      return {
        content: `RPC failed: runner returned malformed body for tool "${name}"`,
        isError: true,
      };
    }
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      content: aborted
        ? `RPC failed: tool "${name}" exceeded ${timeoutMs}ms timeout`
        : `RPC failed: ${message}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
