import type { ModelProvider } from "./schemas/model-config.js";

/** One model offered to an agent author when a tool asks them to pick one. */
export interface ModelChoice {
  provider: ModelProvider;
  /** The model name as `agent.yaml` writes it — it can itself contain a `/`. */
  name: string;
  /** What a picker shows. */
  label: string;
}

/**
 * The model choices offered by `skrun init` and by `generateAgentYaml`, in
 * display order; the first one is preselected. One list, so the two cannot
 * drift apart. One current model per provider, Google's first, each by a
 * pinned id: a `-latest` alias changes model and price without a word. This
 * module imports types only and has no side effect.
 */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { provider: "google", name: "gemini-3.8-flash", label: "Google — gemini-3.8-flash" },
  { provider: "anthropic", name: "claude-sonnet-5-5", label: "Anthropic — claude-sonnet-5-5" },
  { provider: "openai", name: "gpt-6.1-sol", label: "OpenAI — gpt-6.1-sol" },
  { provider: "xai", name: "grok-4.7", label: "xAI — grok-4.7" },
  { provider: "mistral", name: "mistral-medium-2604", label: "Mistral — mistral-medium-2604" },
  { provider: "groq", name: "openai/gpt-oss-120b", label: "Groq — openai/gpt-oss-120b" },
];
