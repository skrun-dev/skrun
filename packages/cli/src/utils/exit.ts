import type { Command } from "commander";
import * as format from "./format.js";

/**
 * Thrown by `exitWith()`: the command is over, and the process should end
 * with `code`. Caught once, by `runCli()`. A `catch` that wraps a call which
 * may exit rethrows it untouched — reporting it as an error would print a
 * second message and lose the code.
 */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`The command ended with exit code ${code}.`);
    this.name = "CliExit";
    this.code = code;
  }
}

/**
 * End the current command with `code` (1 by default), after it printed why.
 *
 * It throws, and never ends the process itself: `runCli()` sets the exit code
 * and lets the process end on its own, once its last handle is closed. Calling
 * `process.exit()` while a network connection is still closing aborts the
 * process on Windows (status 3221226505 instead of 1).
 */
export function exitWith(code = 1): never {
  throw new CliExit(code);
}

/**
 * Parse the command line and run the command, then leave the exit code to the
 * process: a `CliExit` sets it to its code; any other error is printed, its
 * message only, and sets it to 1. Nothing here calls `process.exit()`.
 * `argv`, when given, is the user's arguments (tests); absent, `process.argv`.
 */
export async function runCli(program: Command, argv?: readonly string[]): Promise<void> {
  try {
    if (argv) await program.parseAsync([...argv], { from: "user" });
    else await program.parseAsync();
  } catch (err) {
    if (err instanceof CliExit) {
      process.exitCode = err.code;
      return;
    }
    format.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
