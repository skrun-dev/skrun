import type { AgentConfig } from "@skrun-dev/schema";

/**
 * Provider-agnostic intermediate representation of an agent's tool-choice
 * directive after resolving the top-level `tool_choice` field and per-tool
 * `required: true` overrides into a single decision.
 *
 * Each provider adapter translates this into its native API shape:
 *  - Anthropic `tool_choice: { type: "auto" | "any" | "tool" | "none", ... }`
 *  - Gemini `tool_config.function_calling_config.{mode, allowed_function_names?}`
 *  - OpenAI `tool_choice: "auto" | "required" | "none" | { type, function }`
 */
export type ResolvedToolChoice =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "required" }
  | { mode: "specific"; tool: string }
  | { mode: "subset"; tools: string[] };

/**
 * Resolve an agent's top-level `tool_choice` and per-tool `required: true`
 * flags into a single normalized decision.
 *
 * Precedence rules:
 *  - top-level `none` or a specific tool name wins outright (per-tool ignored)
 *  - top-level `auto` (the default) ignores per-tool unless at least one tool
 *    has `required: true` — then the per-tool list takes effect
 *  - top-level `required` combines with per-tool to form a subset (or specific
 *    if exactly one tool is required)
 *
 * Returns `{ mode: "auto" }` for an agent that did not opt into the feature
 * at all (the default state, equivalent to no provider-side `tool_choice`).
 */
export function resolveToolChoice(agentConfig: AgentConfig): ResolvedToolChoice {
  const toolChoice = agentConfig.tool_choice;
  // Defensive fallback for tests / paths that bypass Zod's default([]).
  const tools = agentConfig.tools ?? [];
  const requiredTools = tools.filter((t) => t.required).map((t) => t.name);

  if (toolChoice === "none") {
    return { mode: "none" };
  }

  if (toolChoice === "required") {
    if (requiredTools.length === 1 && requiredTools[0]) {
      return { mode: "specific", tool: requiredTools[0] };
    }
    if (requiredTools.length > 1) {
      return { mode: "subset", tools: requiredTools };
    }
    return { mode: "required" };
  }

  if (toolChoice && toolChoice !== "auto") {
    return { mode: "specific", tool: toolChoice };
  }

  if (requiredTools.length === 1 && requiredTools[0]) {
    return { mode: "specific", tool: requiredTools[0] };
  }
  if (requiredTools.length > 1) {
    return { mode: "subset", tools: requiredTools };
  }

  return { mode: "auto" };
}
