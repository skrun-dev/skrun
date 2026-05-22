import { z } from "zod";
import type { OutputField } from "../schemas/index.js";

/**
 * Build a Zod object schema from an agent's declared output fields.
 *
 * Mapping:
 *  - `string`  → `z.string()`
 *  - `number`  → `z.number()`
 *  - `boolean` → `z.boolean()`
 *  - `array`   → `z.array(z.any())` (any element shape)
 *  - `object`  → `z.record(z.string(), z.unknown())` (any internal shape, passthrough)
 *
 * Semantics:
 *  - All declared top-level keys are required.
 *  - Extra top-level keys are accepted (z.object default `strip` — extras don't fail validation).
 *  - Nested arrays/objects accept any internal shape (intentional looseness — agent authors
 *    declare top-level contract only; deep typing is out of scope for v0.9.0).
 *
 * Intended use: validate the parsed JSON output that the LLM produced at the end of an
 * agentic loop, surfacing a missing-required-key as `OUTPUT_SCHEMA_INVALID` rather than
 * silently emitting a broken `run_complete`.
 */
export function outputsToZod(outputs: OutputField[]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of outputs) {
    shape[field.name] = fieldToZod(field.type);
  }
  return z.object(shape);
}

function fieldToZod(type: OutputField["type"]): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.any());
    case "object":
      return z.record(z.string(), z.unknown());
  }
}
