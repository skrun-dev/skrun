import type { ValidationIssue } from "../errors.js";

/**
 * A field that `agent.yaml` used to accept and no longer means anything.
 *
 * Retiring a field from a schema that is not strict would make it vanish
 * without a word: the parser drops a key it does not know. A retired field is
 * therefore listed here, and whoever reads the raw document says so by name —
 * `validateAgent` warns about it in an `agent.yaml`; a caller that must refuse
 * it (a request's environment override) refuses it.
 */
export interface RetiredField {
  /** Where the field sits, from the document's root: `["environment", "sandbox"]`. */
  path: readonly string[];
  /** What the author is told: that it has no effect, and what to do. */
  message: string;
}

export const RETIRED_FIELDS: readonly RetiredField[] = [
  {
    path: ["environment", "sandbox"],
    message: "environment.sandbox has no effect and is ignored — remove it.",
  },
  {
    path: ["environment", "filesystem"],
    message: "environment.filesystem has no effect and is ignored — remove it.",
  },
];

/**
 * The retired fields `data` carries, one `RETIRED_FIELD` issue each, with the
 * field's dotted path. A field counts as present when its key is there, whatever
 * its value. `data` is the raw document, before any schema parsed it.
 */
export function findRetiredFields(
  data: unknown,
  fields: readonly RetiredField[] = RETIRED_FIELDS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    let node: unknown = data;
    let present = field.path.length > 0;
    for (const key of field.path) {
      if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
        present = false;
        break;
      }
      node = (node as Record<string, unknown>)[key];
    }
    if (present) {
      issues.push({ code: "RETIRED_FIELD", message: field.message, field: field.path.join(".") });
    }
  }
  return issues;
}
