// Runtime-level typed errors.
//
// Each class extends `SkrunError` from `@skrun-dev/schema` so callers can use
// a single `instanceof SkrunError` check at API boundaries.

import { SkrunError } from "@skrun-dev/schema";
import type { InitStage } from "./runner-contract.js";

export interface ScriptDepsInstallErrorDetails {
  ecosystem: "node" | "python";
  /** The command line that failed (for debug/log surfacing). */
  command: string;
  /** Subprocess exit code, or `null` if the process never spawned (ENOENT, etc.). */
  exitCode: number | null;
  /** Captured stderr from the failed install. May be empty. */
  stderr: string;
  /**
   * Set when the install was stopped because it ran out of time: the limit, in
   * milliseconds. `exitCode` is then `null`, and `stderr` holds what the command
   * printed before it was stopped, when it handed that back.
   */
  timeoutMs?: number;
}

/** A duration as the install error says it: whole seconds when it is a whole number of them. */
function describeDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * Raised when `pip` / `npm` / `pnpm` / `yarn` fails to install an agent's
 * declared dependencies. The runtime catches this in `ScriptToolProvider`
 * and surfaces it as `{ isError: true }` to the LLM tool-call loop without
 * ever spawning the script.
 *
 * Thrown by:
 *   - `installPython` / `installNode` in `tools/script-deps-installers.ts`
 *   - the install's time limit there (`withInstallDeadline`), when a command
 *     is still running once the install's time is spent
 *   - Subsequently propagated through `DepsCache.ensure` and the
 *     `ScriptDepsResolver` orchestrator
 *
 * Code: `SCRIPT_DEPS_INSTALL_FAILED`
 */
export class ScriptDepsInstallError extends SkrunError {
  readonly details: ScriptDepsInstallErrorDetails;

  constructor(details: ScriptDepsInstallErrorDetails) {
    const exitDescription =
      details.timeoutMs !== undefined
        ? `timed out: the install did not finish within ${describeDuration(details.timeoutMs)}`
        : details.exitCode === null
          ? "process did not spawn"
          : `exit code ${details.exitCode}`;
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
  /**
   * What the server is named by: a local (stdio) server by its command,
   * `command "<command>"`, without its arguments; a remote server by its origin
   * — its scheme, host and port, never the rest of its URL —, or by
   * `a URL with no origin`. The message carries it too, and the local runtime's
   * route answers the run's caller with both.
   */
  location: string;
  /** True when the failure was a connect timeout (vs. a non-timeout error). */
  isTimeout: boolean;
  /** Connect timeout in milliseconds — present when `isTimeout` is true. */
  timeoutMs?: number;
  /**
   * The HTTP status a remote server refused the connection with: a Streamable
   * HTTP server, or an SSE server that refused its event stream. Absent when no
   * server answered with one — and when an SSE server refused the request the
   * handshake sends once its stream is open, a status the SDK says only in its
   * text, never read.
   */
  httpStatus?: number;
  /**
   * The code of the JSON-RPC error the server answered while the connection
   * was made or its tools listed. Never a code the SDK gives a failure of its
   * own — a connection it saw close, a request that timed out.
   */
  rpcCode?: number;
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

/**
 * How a bundle download failed: no answer to read (`network`), an answer that
 * refused it (`status`), or a body that did not arrive whole (`incomplete`).
 */
export type BundleFetchFailureKind = "network" | "status" | "incomplete";

export interface BundleFetchFailedErrorDetails {
  /** Presigned URL the machine tried to download (host only — never the signature). */
  urlHost: string;
  /** HTTP status returned by the storage backend, or `null` if connection failed. */
  httpStatus: number | null;
  /** Bytes downloaded before failure (useful to distinguish 0-byte vs partial). */
  bytesDownloaded: number;
  /** How the download failed. Absent from an error built before it was recorded. */
  kind?: BundleFetchFailureKind;
}

/**
 * Raised when a machine fails to fetch the agent bundle from its presigned URL:
 * the runner's download at `/init` (`downloadBundle`). Causes include: a
 * transient 5xx of the object store, an expired URL, a network partition on the
 * sandbox side, a connection cut in the middle of the body; `kind` says which
 * of the three it was.
 *
 * Code: `BUNDLE_FETCH_FAILED`
 */
export class BundleFetchFailedError extends SkrunError {
  readonly details: BundleFetchFailedErrorDetails;

  constructor(details: BundleFetchFailedErrorDetails, cause?: unknown) {
    const statusPart =
      details.httpStatus === null ? "connection failed" : `HTTP ${details.httpStatus}`;
    const cutPart = details.kind === "incomplete" ? ", body incomplete" : "";
    super(
      "BUNDLE_FETCH_FAILED",
      `Bundle fetch from ${details.urlHost} failed (${statusPart}, ${details.bytesDownloaded} bytes downloaded${cutPart})`,
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
 * The first four are the create-a-machine-per-run path: `presign` is the signing
 * of the run's `/init` URLs, once the machine created for it answers — a failure
 * there leaves a machine to destroy —, or, before the creation, of the probe URL
 * that shows the object store's host — no machine yet. The last two only occur
 * when a pre-created machine is woken and assigned, and they are separate values
 * on purpose: "we could not wake a machine that was supposed to be ready" and
 * "we woke it but could not assign it" are different operational stories, and both
 * differ again from "there was no machine to wake". Collapsing them would make a
 * pool that is full but entirely unwakeable look exactly like a pool that is empty.
 */
export type MachineSpawnPhase =
  | "create"
  | "boot-probe"
  | "presign"
  | "init-rpc"
  | "pool-resume"
  | "pool-claim";

export interface MachineSpawnErrorDetails {
  /** Machine name we attempted to create (skrun-run-{runId} convention), or the pooled machine's id. */
  machineName: string;
  /** Fly.io machine ID if creation succeeded but boot probe failed; null if creation itself failed. */
  machineId: string | null;
  /** Phase of the lifecycle where the spawn failed. */
  phase: MachineSpawnPhase;
  /**
   * HTTP status of the answer the phase failed on — the machines platform's, or,
   * at `init-rpc` and `pool-claim`, the runner's —, or `null` when there was no
   * answer to read one from.
   */
  httpStatus: number | null;
  /**
   * At `init-rpc`, the step the runner said its `/init` failed at, when its
   * answer named one this side reads. Absent otherwise: an older runner's
   * answer, no answer at all, any other phase.
   */
  stage?: InitStage;
}

/**
 * Whether the HTTP status a phase fails with is one the runner answered — its
 * `/init`, its `/claim` —, rather than the machines platform. Only a status of
 * the platform's is told in the message. Exhaustive on purpose: a new phase does
 * not compile until it is decided here.
 */
const STATUS_IS_THE_RUNNERS: Record<MachineSpawnPhase, boolean> = {
  create: false,
  "boot-probe": false,
  presign: false,
  "init-rpc": true,
  "pool-resume": false,
  "pool-claim": true,
};

/**
 * What a run's caller reads of a failed `/init`'s step: fixed words, the
 * harness's own. The runner's text never reaches the caller — it can quote what
 * the agent declares, a server's URL among it. Exhaustive on purpose: a new
 * step does not compile until it is worded here.
 */
const INIT_STAGE_WORDS: Record<InitStage, string> = {
  "bundle-network": "the agent's bundle could not be downloaded: no answer came",
  "bundle-status": "the agent's bundle could not be downloaded: its download was refused",
  "bundle-incomplete": "the agent's bundle could not be downloaded: it arrived incomplete",
  "bundle-checksum": "the agent's bundle does not match its recorded checksum",
  "bundle-extract": "the agent's bundle could not be extracted",
  "disk-full": "the machine's disk was full",
  "mcp-connect": "the connection to one of the agent's MCP servers failed",
  other: "the machine could not prepare the agent",
};

/**
 * Raised by `FlyioAdapter` when a Fly.io Machine cannot be brought to a ready
 * state for a run. Distinguishes the failure phase so operators can diagnose
 * (API issue vs image issue vs runner issue). Harness emits `run_error` with
 * this code and destroys any machine that was created (avoiding leaks).
 *
 * Its message is what the run's caller reads, and what the run's row keeps:
 * built here, in fixed words — the phase, a status the platform answered, and,
 * for a failed `/init`, the step the runner named and its words
 * (`INIT_STAGE_WORDS`). Never the machine's name or id, which are the
 * operator's topology, nor anything else the runner answered: those stay in
 * `details` and the cause, for the logs.
 *
 * Code: `MACHINE_SPAWN_FAILED`
 */
export class MachineSpawnError extends SkrunError {
  readonly details: MachineSpawnErrorDetails;
  /**
   * `details.httpStatus`, when there is one, where any error's HTTP status is
   * read: a log line gives it as `error_status`. Absent — not `undefined`,
   * absent — when there was no answer.
   */
  declare readonly status?: number;

  constructor(details: MachineSpawnErrorDetails, cause?: unknown) {
    const told =
      details.httpStatus === null || STATUS_IS_THE_RUNNERS[details.phase]
        ? ""
        : `, HTTP ${details.httpStatus}`;
    const step = details.stage === undefined ? "" : `, step "${details.stage}"`;
    const words = details.stage === undefined ? "" : `: ${INIT_STAGE_WORDS[details.stage]}`;
    super(
      "MACHINE_SPAWN_FAILED",
      `The run's machine could not be started (phase "${details.phase}"${told}${step})${words}.`,
      cause,
    );
    this.name = "MachineSpawnError";
    this.details = details;
    if (details.httpStatus !== null) this.status = details.httpStatus;
  }
}
