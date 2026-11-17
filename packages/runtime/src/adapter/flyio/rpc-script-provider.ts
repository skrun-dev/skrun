import { describeBytes, TOOL_RESPONSE_MAX_BYTES } from "../../files/output-rules.js";
import type { ToolRequest } from "../../runner-contract.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "../../tools/types.js";
import {
  callRunner,
  RunnerBodyTimeout,
  RunnerCallTimeout,
  RunnerResponseTooLarge,
  readRunnerErrorText,
  readRunnerJson,
} from "./runner-call.js";

export interface RpcToolProviderOptions {
  /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 60_000 (most tool calls finish in seconds; long-poll tools should set their own bound). */
  timeoutMs?: number;
  /** Per-run RPC bearer token. When set, sent as `Authorization: Bearer <token>` on every RPC. */
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
 * What the model reads in place of an answer past {@link TOOL_RESPONSE_MAX_BYTES}.
 * The runner cuts a result to fit that bound; an answer beyond it comes from a
 * runner that did not — one too old, or something answering in its place — and
 * none of it is read. It names the bound from its constant.
 */
export const TOOL_ANSWER_REFUSED = `The tool's result was refused: the sandbox answered more than ${describeBytes(TOOL_RESPONSE_MAX_BYTES)}.`;

/**
 * Shared HTTP RPC body builder + response handler for both providers: the
 * body is the contract's (`ToolRequest`, runner-contract.ts), the one the runner
 * parses. A network error or non-2xx response returns a `ToolResult` with
 * `isError: true` rather than throwing — the LLM loop treats it as a
 * tool failure (the tool's "behavior") instead of an adapter crash.
 *
 * The call goes through the runner-call module: a redirect is refused, the
 * answer is read up to {@link TOOL_RESPONSE_MAX_BYTES} — the bound the runner
 * cuts a result to, the same constant — and an error answer up to its first
 * 4 KiB. `timeoutMs` bounds the whole call, its answer's body included.
 */
export async function rpcToolCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  kind: ToolRequest["kind"],
  name: string,
  args: ToolRequest["args"],
  opts: { token?: string } = {},
): Promise<ToolResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  // One bound for the whole call: the headers within it, the body within what is left.
  const startedAt = Date.now();
  const left = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
  const request: ToolRequest = { kind, name, args };
  try {
    const response = await callRunner(
      fetchImpl,
      `${baseUrl}/tool`,
      { method: "POST", headers, body: JSON.stringify(request) },
      { headersTimeoutMs: timeoutMs },
    );

    if (!response.ok) {
      const text = await readRunnerErrorText(response, { deadlineMs: left(), what: "/tool" });
      return {
        content: `RPC failed: HTTP ${response.status} ${response.statusText} ${text}`.trim(),
        isError: true,
      };
    }

    // The runner returns `{ content, isError }` directly (the ToolResult
    // shape). Preserve isError so the LLM loop can decide whether to
    // continue or surface the failure.
    let answer: unknown;
    try {
      answer = await readRunnerJson(response, {
        maxBytes: TOOL_RESPONSE_MAX_BYTES,
        deadlineMs: left(),
        what: "/tool",
      });
    } catch (err) {
      if (err instanceof RunnerResponseTooLarge)
        return { content: TOOL_ANSWER_REFUSED, isError: true };
      throw err;
    }
    const body = answer as ToolResult | null;
    if (!body || typeof body.content !== "string" || typeof body.isError !== "boolean") {
      return {
        content: `RPC failed: runner returned malformed body for tool "${name}"`,
        isError: true,
      };
    }
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The call's own bound, whichever wait it ended: the headers or the body.
    const timedOut = err instanceof RunnerCallTimeout || err instanceof RunnerBodyTimeout;
    return {
      content: timedOut
        ? `RPC failed: tool "${name}" exceeded ${timeoutMs}ms timeout`
        : `RPC failed: ${message}`,
      isError: true,
    };
  }
}
