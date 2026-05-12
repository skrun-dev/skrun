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
