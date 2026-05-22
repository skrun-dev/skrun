// Runtime-level typed errors.
//
// Each class extends `SkrunError` from `@skrun-dev/schema` so callers can use
// a single `instanceof SkrunError` check at API boundaries.

import { SkrunError } from "@skrun-dev/schema";

export interface ScriptDepsInstallErrorDetails {
  ecosystem: "node" | "python";
  /** The command line that failed (for debug/log surfacing). */
  command: string;
  /** Subprocess exit code, or `null` if the process never spawned (ENOENT, etc.). */
  exitCode: number | null;
  /** Captured stderr from the failed install. May be empty. */
  stderr: string;
}

/**
 * Raised when `pip` / `npm` / `pnpm` / `yarn` fails to install an agent's
 * declared dependencies. The runtime catches this in `ScriptToolProvider`
 * and surfaces it as `{ isError: true }` to the LLM tool-call loop without
 * ever spawning the script.
 *
 * Thrown by:
 *   - `installPython` / `installNode` in `tools/script-deps-installers.ts`
 *   - Subsequently propagated through `DepsCache.ensure` and the
 *     `ScriptDepsResolver` orchestrator
 *
 * Code: `SCRIPT_DEPS_INSTALL_FAILED`
 */
export class ScriptDepsInstallError extends SkrunError {
  readonly details: ScriptDepsInstallErrorDetails;

  constructor(details: ScriptDepsInstallErrorDetails) {
    const exitDescription =
      details.exitCode === null ? "process did not spawn" : `exit code ${details.exitCode}`;
    super(
      "SCRIPT_DEPS_INSTALL_FAILED",
      `Script dependency install failed for ecosystem '${details.ecosystem}' (${exitDescription}). Command: ${details.command}`,
    );
    this.name = "ScriptDepsInstallError";
    this.details = details;
  }
}

export interface McpConnectErrorDetails {
  /** Name of the MCP server (from agent.yaml mcp_servers[].name). */
  server: string;
  /** Transport that failed: "stdio" | "sse" | "streamable-http". */
  transport: string;
  /** stdio command-line or remote URL, for diagnostic context. */
  location: string;
  /** True when the failure was a connect timeout (vs. a non-timeout error). */
  isTimeout: boolean;
  /** Connect timeout in milliseconds — present when `isTimeout` is true. */
  timeoutMs?: number;
}

/**
 * Raised when an MCP server declared by `agent.yaml.mcp_servers[]` cannot be
 * connected to (timeout, transport error, allowed_hosts block, missing
 * command, etc.). The runtime previously swallowed these failures and
 * continued with `tools=[]`, which let the LLM hallucinate plausible-looking
 * but ungrounded answers (especially under output-validation repair retry).
 * Failing the run loudly forces operators to fix the underlying connection
 * instead of shipping silent garbage.
 *
 * Code: `MCP_CONNECT_FAILED`
 */
export class McpConnectError extends SkrunError {
  readonly details: McpConnectErrorDetails;

  constructor(details: McpConnectErrorDetails, cause?: unknown) {
    const suffix = details.isTimeout ? ` after ${details.timeoutMs ?? "?"}ms timeout` : "";
    super(
      "MCP_CONNECT_FAILED",
      `MCP server "${details.server}" (${details.transport}) failed to connect${suffix}: ${details.location}`,
      cause,
    );
    this.name = "McpConnectError";
    this.details = details;
  }
}
