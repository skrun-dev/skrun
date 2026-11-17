import type { ValidationResult } from "@skrun-dev/schema";
import * as format from "./format.js";

/**
 * Print the validator's warnings, one line each: where it points (when it
 * points at a file), what it says, and its code.
 *
 * A warning never fails a command. It is how the author learns that a field is
 * ignored, or that a script's dependencies cannot be resolved, before the agent
 * is called — every command that validates an agent prints them.
 */
export function printValidationWarnings(result: Pick<ValidationResult, "warnings">): void {
  for (const warning of result.warnings) {
    const where = warning.file ? `${warning.file}: ` : "";
    format.warn(`${where}${warning.message} [${warning.code}]`);
  }
}
