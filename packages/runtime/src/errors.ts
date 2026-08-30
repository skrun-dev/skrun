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

/**
 * Raised when a feature is not supported by the current backend implementation.
 * Typically used by polymorphic interfaces where one impl supports a method but
 * others don't — e.g., `StorageAdapter.getPresignedDownloadUrl` is implemented by
 * `R2Storage` but `MemoryStorage` / `LocalStorage` throw this (those backends
 * don't need presigned URLs because callers have direct local access).
 *
 * Code: `NOT_SUPPORTED`
 */
export class NotSupportedError extends SkrunError {
  readonly feature: string;

  constructor(feature: string, hint?: string) {
    const hintSuffix = hint ? ` — ${hint}` : "";
    super("NOT_SUPPORTED", `${feature} is not supported by this backend${hintSuffix}`);
    this.name = "NotSupportedError";
    this.feature = feature;
  }
}

export interface BundleFetchFailedErrorDetails {
  /** Presigned URL the machine tried to download (host only — never the signature). */
  urlHost: string;
  /** HTTP status returned by the storage backend, or `null` if connection failed. */
  httpStatus: number | null;
  /** Bytes downloaded before failure (useful to distinguish 0-byte vs partial). */
  bytesDownloaded: number;
}

/**
 * Raised when the in-machine entrypoint fails to fetch the agent bundle from the
 * presigned URL passed at boot. Causes include: R2 transient 5xx, URL expired
 * (machine boot took longer than the TTL margin), network partition on the
 * sandbox side. The harness emits `run_error` with this code and destroys the
 * machine.
 *
 * Code: `BUNDLE_FETCH_FAILED`
 */
export class BundleFetchFailedError extends SkrunError {
  readonly details: BundleFetchFailedErrorDetails;

  constructor(details: BundleFetchFailedErrorDetails, cause?: unknown) {
    const statusPart =
      details.httpStatus === null ? "connection failed" : `HTTP ${details.httpStatus}`;
    super(
      "BUNDLE_FETCH_FAILED",
      `Bundle fetch from ${details.urlHost} failed (${statusPart}, ${details.bytesDownloaded} bytes downloaded)`,
      cause,
    );
    this.name = "BundleFetchFailedError";
    this.details = details;
  }
}

export interface ToolOomKilledErrorDetails {
  /** Tool name from agent.yaml (script tool basename or MCP tool name). */
  tool: string;
  /** Bytes the tool attempted to write before OOM (best-effort estimate). */
  bytesAttempted: number;
  /** Tmpfs limit configured on the machine. */
  tmpfsLimitBytes: number;
}

/**
 * Raised when a tool inside the sandbox is killed by the kernel OOM killer —
 * typically because a script wrote more bytes to `/mnt/session/outputs/` (tmpfs)
 * than the configured limit. The in-machine runner detects the SIGKILL exit
 * signal and reports this to the harness via the tool RPC response.
 *
 * Code: `TOOL_OOM_KILLED`
 */
export class ToolOomKilledError extends SkrunError {
  readonly details: ToolOomKilledErrorDetails;

  constructor(details: ToolOomKilledErrorDetails) {
    super(
      "TOOL_OOM_KILLED",
      `Tool "${details.tool}" killed by OOM (${details.bytesAttempted} bytes attempted, tmpfs limit ${details.tmpfsLimitBytes})`,
    );
    this.name = "ToolOomKilledError";
    this.details = details;
  }
}

/**
 * Where in a machine's path to readiness the failure happened.
 *
 * The first three are the create-a-machine-per-run path. The last two only occur
 * when a pre-created machine is woken and assigned, and they are separate values
 * on purpose: "we could not wake a machine that was supposed to be ready" and
 * "we woke it but could not assign it" are different operational stories, and both
 * differ again from "there was no machine to wake". Collapsing them would make a
 * pool that is full but entirely unwakeable look exactly like a pool that is empty.
 */
export type MachineSpawnPhase = "create" | "boot-probe" | "init-rpc" | "pool-resume" | "pool-claim";

export interface MachineSpawnErrorDetails {
  /** Machine name we attempted to create (skrun-run-{runId} convention). */
  machineName: string;
  /** Fly.io machine ID if creation succeeded but boot probe failed; null if creation itself failed. */
  machineId: string | null;
  /** Phase of the lifecycle where the spawn failed. */
  phase: MachineSpawnPhase;
  /** HTTP status from Fly.io Machines API, or `null` if connection failed / phase != "create". */
  httpStatus: number | null;
}

/**
 * Raised by `FlyioAdapter` when a Fly.io Machine cannot be brought to a ready
 * state for a run. Distinguishes the failure phase so operators can diagnose
 * (API issue vs image issue vs runner issue). Harness emits `run_error` with
 * this code and destroys any machine that was created (avoiding leaks).
 *
 * Code: `MACHINE_SPAWN_FAILED`
 */
export class MachineSpawnError extends SkrunError {
  readonly details: MachineSpawnErrorDetails;

  constructor(details: MachineSpawnErrorDetails, cause?: unknown) {
    const idPart = details.machineId === null ? "no machine" : `machine ${details.machineId}`;
    const httpPart = details.httpStatus === null ? "" : ` (HTTP ${details.httpStatus})`;
    super(
      "MACHINE_SPAWN_FAILED",
      `Failed to spawn ${details.machineName} at phase "${details.phase}"${httpPart} — ${idPart}`,
      cause,
    );
    this.name = "MachineSpawnError";
    this.details = details;
  }
}
