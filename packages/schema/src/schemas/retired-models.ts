import type { ValidationIssue } from "../errors.js";
import type { ModelConfig, ModelProvider } from "./model-config.js";

/**
 * A model its provider stops serving — or has stopped: from that day, every
 * call to it fails, unless the provider answers the id with another model
 * (`redirectsTo`).
 *
 * Each entry names one exact id. A dated form and an alias of the same model
 * are separate entries: a family prefix (`claude-sonnet-4`) would also match a
 * current model that extends it (`claude-sonnet-4-6`).
 */
export interface RetiredModel {
  provider: ModelProvider;
  /** The exact id the provider served, as an `agent.yaml` names it. */
  id: string;
  /** The day the provider stops serving it, YYYY-MM-DD — a day still to come is allowed. */
  retiredOn: string;
  /**
   * The model to use instead: an id of the same provider that the capability
   * matrix covers, and whose row takes every input the retired model's own
   * row took — the provider's recommendation when it is such a model, else
   * another of its models that is. Absent when the provider names none,
   * when none of its models in the matrix takes those inputs, or when the one
   * it names belongs to a specialised family the matrix does not carry (a
   * robotics model): `note` then says why.
   */
  replacement?: string;
  /**
   * What else an author should know: a retirement that spares some
   * customers, or why the replacement is not the provider's own pick.
   */
  note?: string;
  /**
   * The model the provider serves under this id from its retirement day, an
   * id of the same provider: a call keeps working, answered and billed as
   * that model. Absent when a call to the retired id fails.
   */
  redirectsTo?: string;
}

/**
 * The models providers have retired, or have announced the day they retire,
 * that `agent.yaml` files may still name. `validateAgent` warns
 * `MODEL_RETIRED` on an agent whose model or fallback is one of them; the
 * repository's guard refuses them in the code that ships a model id. An entry
 * joins the list in the change that takes the model out of the catalog. This
 * module imports types only and has no side effect.
 */
export const RETIRED_MODELS: readonly RetiredModel[] = [
  // Anthropic — model deprecations page.
  {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    retiredOn: "2026-06-15",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-0",
    retiredOn: "2026-06-15",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-20250514",
    retiredOn: "2026-06-15",
    replacement: "claude-opus-4-8",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-0",
    retiredOn: "2026-06-15",
    replacement: "claude-opus-4-8",
  },
  {
    provider: "anthropic",
    id: "claude-3-7-sonnet-20250219",
    retiredOn: "2026-02-19",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-3-5-sonnet-20241022",
    retiredOn: "2025-10-28",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-3-5-sonnet-20240620",
    retiredOn: "2025-10-28",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-3-5-sonnet-latest",
    retiredOn: "2025-10-28",
    replacement: "claude-sonnet-4-6",
  },
  {
    provider: "anthropic",
    id: "claude-3-5-haiku-20241022",
    retiredOn: "2026-02-19",
    replacement: "claude-haiku-4-5-20251001",
  },
  {
    provider: "anthropic",
    id: "claude-3-haiku-20240307",
    retiredOn: "2026-04-20",
    replacement: "claude-haiku-4-5-20251001",
  },
  {
    provider: "anthropic",
    id: "claude-3-opus-20240229",
    retiredOn: "2026-01-05",
    replacement: "claude-opus-4-8",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-1-20250805",
    retiredOn: "2026-08-05",
    replacement: "claude-opus-4-8",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-1",
    retiredOn: "2026-08-05",
    replacement: "claude-opus-4-8",
  },
  // Deprecated on 2026-09-30, retired on 2026-11-30, replacement
  // claude-sonnet-5-5 (Anthropic's model-deprecations page, 2026-11-17). Out
  // of the catalog before its day: models.dev marks it deprecated already.
  // Sonnet 4.5 accepts a temperature, Sonnet 5.5 refuses one.
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    retiredOn: "2026-11-30",
    replacement: "claude-sonnet-5-5",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5-20250929",
    retiredOn: "2026-11-30",
    replacement: "claude-sonnet-5-5",
  },
  // Google — deprecations page.
  {
    provider: "google",
    id: "gemini-3.1-flash-lite-preview",
    retiredOn: "2026-05-25",
    replacement: "gemini-3.5-flash-lite",
  },
  // Deprecated with no shutdown day ("the endpoint is not shutting down",
  // the deprecations page) and served as another model: Google's changelog
  // entry of 2026-10-08 says "API requests to gemini-3.7-flash are
  // automatically routed to gemini-3.8-flash", and gemini-3.5-flash to
  // gemini-3.6-flash. The day is that entry's, when the routing is in force.
  {
    provider: "google",
    id: "gemini-3.7-flash",
    retiredOn: "2026-10-08",
    replacement: "gemini-3.8-flash",
    redirectsTo: "gemini-3.8-flash",
  },
  {
    provider: "google",
    id: "gemini-3.5-flash",
    retiredOn: "2026-10-08",
    replacement: "gemini-3.6-flash",
    redirectsTo: "gemini-3.6-flash",
  },
  // The text models the deprecations page (updated 2026-10-22) gives a
  // shutdown date, by its table: "gemini-3.1-flash-lite May 7, 2026 May 7,
  // 2027 gemini-3.5-flash-lite" — release, shutdown, replacement —, and the
  // Gemini 2.0, 2.5 and 3 previews it shut down. Where the page names
  // gemini-3.1-flash-lite, itself retiring, the replacement is the one it
  // names for that model.
  {
    provider: "google",
    id: "gemini-3.1-flash-lite",
    retiredOn: "2027-05-07",
    replacement: "gemini-3.5-flash-lite",
  },
  {
    provider: "google",
    id: "gemini-3-pro-preview",
    retiredOn: "2026-03-09",
    replacement: "gemini-3.1-pro-preview",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro-preview-03-25",
    retiredOn: "2025-12-02",
    replacement: "gemini-3.1-pro-preview",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro-preview-05-06",
    retiredOn: "2025-12-02",
    replacement: "gemini-3.1-pro-preview",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro-preview-06-05",
    retiredOn: "2025-12-02",
    replacement: "gemini-3.1-pro-preview",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-lite-preview-09-2025",
    retiredOn: "2026-03-31",
    replacement: "gemini-3.5-flash-lite",
    note: "Google names gemini-3.1-flash-lite, itself retiring on 2027-05-07",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-preview-05-20",
    retiredOn: "2025-11-18",
    replacement: "gemini-3.6-flash",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-preview-09-25",
    retiredOn: "2026-02-17",
    replacement: "gemini-3.6-flash",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash",
    retiredOn: "2026-06-01",
    replacement: "gemini-3.6-flash",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash-001",
    retiredOn: "2026-06-01",
    replacement: "gemini-3.6-flash",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash-lite",
    retiredOn: "2026-06-01",
    replacement: "gemini-3.5-flash-lite",
    note: "Google names gemini-3.1-flash-lite, itself retiring on 2027-05-07",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash-lite-001",
    retiredOn: "2026-06-01",
    replacement: "gemini-3.5-flash-lite",
    note: "Google names gemini-3.1-flash-lite, itself retiring on 2027-05-07",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash-lite-preview",
    retiredOn: "2025-12-09",
    replacement: "gemini-3.5-flash-lite",
    note: "Google names gemini-3.1-flash-lite, itself retiring on 2027-05-07",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash-lite-preview-02-05",
    retiredOn: "2025-12-09",
    replacement: "gemini-3.5-flash-lite",
    note: "Google names gemini-3.1-flash-lite, itself retiring on 2027-05-07",
  },
  // The computer-use and robotics previews the same page shuts down:
  // "gemini-2.5-computer-use-preview-10-2025 October 7, 2025 July 28, 2026
  // gemini-3.8-flash"; "gemini-robotics-er-1.6-preview April 14, 2026 August
  // 31, 2026 gemini-robotics-er-2-preview"; "gemini-robotics-er-1.5-preview
  // September 25, 2025 April 30, 2026 gemini-robotics-er-2-preview".
  {
    provider: "google",
    id: "gemini-2.5-computer-use-preview-10-2025",
    retiredOn: "2026-07-28",
    replacement: "gemini-3.8-flash",
  },
  {
    provider: "google",
    id: "gemini-robotics-er-1.6-preview",
    retiredOn: "2026-08-31",
    note: "Google recommends gemini-robotics-er-2-preview, not in our catalog",
  },
  {
    provider: "google",
    id: "gemini-robotics-er-1.5-preview",
    retiredOn: "2026-04-30",
    note: "Google recommends gemini-robotics-er-2-preview, not in our catalog",
  },
  // OpenAI — deprecations page.
  { provider: "openai", id: "o3-mini", retiredOn: "2026-10-23", replacement: "gpt-5.6-sol" },
  {
    provider: "openai",
    id: "o3-mini-2025-01-31",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "o1",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "o1-2024-12-17",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-4-turbo",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-4-turbo-2024-04-09",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-audio",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "gpt-audio-2025-08-28",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "o1-mini",
    retiredOn: "2025-10-27",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "gpt-4o-audio-preview",
    retiredOn: "2026-05-07",
    replacement: "gpt-audio-1.5",
  },
  // Its two snapshots, retired with the gpt-4o-audio family.
  {
    provider: "openai",
    id: "gpt-4o-audio-preview-2025-06-03",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "gpt-4o-audio-preview-2024-12-17",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  // The gpt-4o-mini-audio and gpt-audio-mini families, retired with the
  // legacy audio models.
  {
    provider: "openai",
    id: "gpt-4o-mini-audio-preview",
    retiredOn: "2026-05-07",
    replacement: "gpt-audio-1.5",
    note: "OpenAI named gpt-audio-mini, itself retiring on 2027-01-20",
  },
  {
    provider: "openai",
    id: "gpt-4o-mini-audio-preview-2024-12-17",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "gpt-audio-mini",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "gpt-audio-mini-2025-12-15",
    retiredOn: "2027-01-20",
    replacement: "gpt-audio-1.5",
  },
  {
    provider: "openai",
    id: "gpt-audio-mini-2025-10-06",
    retiredOn: "2026-07-23",
    replacement: "gpt-audio-1.5",
  },
  // The legacy snapshots its notice of 2026-04-22 shuts down on 2026-10-23,
  // each id with its dated form.
  {
    provider: "openai",
    id: "o4-mini",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "o4-mini-2025-04-16",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "gpt-4.1-nano",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4.1-nano-2025-04-14",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-4-0613",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-4-1106-preview",
    retiredOn: "2026-03-26",
    replacement: "gpt-5.6-sol",
    note: "OpenAI's notice of 2025-09-26 shut it down on 2026-03-26; its notice of 2026-04-22 lists it again, for 2026-10-23",
  },
  {
    provider: "openai",
    id: "gpt-3.5-turbo",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "gpt-3.5-turbo-0125",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "o1-pro",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  {
    provider: "openai",
    id: "o1-pro-2025-03-19",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  // The first GPT-4o snapshot, which its notice of 2026-04-22 shuts down on
  // 2026-10-23: not the gpt-4o alias.
  {
    provider: "openai",
    id: "gpt-4o-2024-05-13",
    retiredOn: "2026-10-23",
    replacement: "gpt-5.6-sol",
  },
  // The GPT-4o, GPT-4o mini, GPT-4.1 and GPT-4.1 mini snapshots its notice of
  // 2026-10-14 shuts down on 2027-01-14. The notice names no alias: gpt-4o
  // and gpt-4o-mini are not on this list.
  {
    provider: "openai",
    id: "gpt-4o-2024-08-06",
    retiredOn: "2027-01-14",
    replacement: "gpt-6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4o-2024-11-20",
    retiredOn: "2027-01-14",
    replacement: "gpt-6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4o-mini-2024-07-18",
    retiredOn: "2027-01-14",
    replacement: "gpt-6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4.1-2025-04-14",
    retiredOn: "2027-01-14",
    replacement: "gpt-6-luna",
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini-2025-04-14",
    retiredOn: "2027-01-14",
    replacement: "gpt-6-luna",
  },
  // The GPT-5 and o3 models its notice of 2026-06-11 shuts down on
  // 2026-12-11, each id with its dated form — but gpt-5, gpt-5-mini and
  // gpt-5-nano, which the capability matrix and the pricing table offer until
  // that day: they join this list with the change that takes their rows out.
  {
    provider: "openai",
    id: "gpt-5-2025-08-07",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "gpt-5-mini-2025-08-07",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-terra",
  },
  {
    provider: "openai",
    id: "gpt-5-nano-2025-08-07",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-luna",
  },
  {
    provider: "openai",
    id: "gpt-5-pro",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  {
    provider: "openai",
    id: "gpt-5-pro-2025-10-06",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  {
    provider: "openai",
    id: "o3",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "o3-2025-04-16",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
  },
  {
    provider: "openai",
    id: "o3-pro",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  {
    provider: "openai",
    id: "o3-pro-2025-06-10",
    retiredOn: "2026-12-11",
    replacement: "gpt-5.6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  // The models its notice of 2026-10-01 shuts down on 2027-04-01, each id
  // with its dated form where the notice names one — but gpt-5.4-nano, which
  // the capability matrix and the pricing table offer until that day.
  {
    provider: "openai",
    id: "gpt-5.3-codex",
    retiredOn: "2027-04-01",
    replacement: "gpt-6-sol",
    note: "served only by the Responses API, which the runtime does not call",
  },
  {
    provider: "openai",
    id: "gpt-5.4-nano-2026-03-17",
    retiredOn: "2027-04-01",
    replacement: "gpt-6-luna",
  },
  {
    provider: "openai",
    id: "gpt-5.1",
    retiredOn: "2027-04-01",
    replacement: "gpt-6-sol",
  },
  {
    provider: "openai",
    id: "gpt-5.1-2025-11-13",
    retiredOn: "2027-04-01",
    replacement: "gpt-6-sol",
  },
  // Mistral — models page, deprecated and retired models.
  {
    provider: "mistral",
    id: "mistral-small-2503",
    retiredOn: "2025-11-30",
    replacement: "mistral-small-2603",
  },
  {
    provider: "mistral",
    id: "magistral-medium-2509",
    retiredOn: "2026-07-31",
    replacement: "mistral-medium-2604",
  },
  {
    provider: "mistral",
    id: "ministral-8b-2410",
    retiredOn: "2025-12-31",
    replacement: "mistral-small-2603",
    note: "Mistral recommends ministral-8b-2512, not in our catalog",
  },
  {
    provider: "mistral",
    id: "mistral-medium-2508",
    retiredOn: "2026-08-31",
    replacement: "mistral-medium-2604",
  },
  {
    provider: "mistral",
    id: "mistral-small-2506",
    retiredOn: "2026-07-31",
    replacement: "mistral-small-2603",
  },
  // Pixtral Large and Pixtral 12B, by dated id and by the alias that named
  // each.
  {
    provider: "mistral",
    id: "pixtral-large-2411",
    retiredOn: "2026-05-31",
    replacement: "mistral-medium-2604",
  },
  {
    provider: "mistral",
    id: "pixtral-large-latest",
    retiredOn: "2026-05-31",
    replacement: "mistral-medium-2604",
  },
  {
    provider: "mistral",
    id: "pixtral-12b-2409",
    retiredOn: "2025-12-31",
    replacement: "mistral-small-2603",
    note: "Mistral recommends ministral-14b-2512, not in our catalog",
  },
  {
    provider: "mistral",
    id: "pixtral-12b",
    retiredOn: "2025-12-31",
    replacement: "mistral-small-2603",
    note: "Mistral recommends ministral-14b-2512, not in our catalog",
  },
  // Groq — deprecations page.
  {
    provider: "groq",
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    retiredOn: "2026-07-17",
    note: "Groq serves no vision model in our catalog today: pick a vision model from another provider",
  },
  {
    provider: "groq",
    id: "meta-llama/llama-4-maverick-17b-128e-instruct",
    retiredOn: "2026-03-09",
    replacement: "openai/gpt-oss-120b",
  },
  {
    provider: "groq",
    id: "qwen/qwen3-32b",
    retiredOn: "2026-07-17",
    replacement: "openai/gpt-oss-120b",
  },
  {
    provider: "groq",
    id: "groq/compound",
    retiredOn: "2026-09-21",
  },
  {
    provider: "groq",
    id: "groq/compound-mini",
    retiredOn: "2026-09-21",
  },
  {
    provider: "groq",
    id: "llama-3.3-70b-versatile",
    retiredOn: "2026-08-16",
    replacement: "openai/gpt-oss-120b",
    note: "on its free and developer tiers; enterprise contracts keep it",
  },
  {
    provider: "groq",
    id: "llama-3.1-8b-instant",
    retiredOn: "2026-08-16",
    replacement: "openai/gpt-oss-20b",
    note: "on its free and developer tiers; enterprise contracts keep it",
  },
  {
    provider: "groq",
    id: "meta-llama/llama-guard-4-12b",
    retiredOn: "2026-03-05",
    replacement: "openai/gpt-oss-safeguard-20b",
  },
  {
    provider: "groq",
    id: "llama-3.2-90b-vision-preview",
    retiredOn: "2025-04-14",
    note: "Groq serves no vision model in our catalog today: pick a vision model from another provider",
  },
  {
    provider: "groq",
    id: "llama-3.2-11b-vision-preview",
    retiredOn: "2025-04-14",
    note: "Groq serves no vision model in our catalog today: pick a vision model from another provider",
  },
  // xAI — the May 15, 2026 retirement page: the ids still resolve, redirected.
  {
    provider: "xai",
    id: "grok-4-1-fast-reasoning",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-4-1-fast-non-reasoning",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-4-fast-reasoning",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-4-fast-non-reasoning",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-4-0709",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-3",
    retiredOn: "2026-05-15",
    replacement: "grok-4.3",
    redirectsTo: "grok-4.3",
  },
  {
    provider: "xai",
    id: "grok-code-fast-1",
    retiredOn: "2026-05-15",
    replacement: "grok-build-0.1",
    redirectsTo: "grok-build-0.1",
  },
];

/** Today, in UTC, as YYYY-MM-DD. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One `MODEL_RETIRED` issue for the model, and one for its fallback, that the
 * list names — matched on the provider and the exact id, never on a prefix.
 * The message names the model, the day it retires (or retired, on `today` or
 * before), what a call to it does from that day — it fails, or the provider
 * serves it as another model, at that model's price — and the replacement,
 * when there is one, or its absence.
 */
export function findRetiredModels(
  config: { model: Pick<ModelConfig, "provider" | "name" | "fallback"> },
  list: readonly RetiredModel[] = RETIRED_MODELS,
  today: string = utcToday(),
): ValidationIssue[] {
  const { model } = config;
  const issues: ValidationIssue[] = [];
  const declared = [
    { m: model, field: "model.name", role: "model" },
    ...(model.fallback
      ? [{ m: model.fallback, field: "model.fallback.name", role: "fallback model" }]
      : []),
  ];
  for (const { m, field, role } of declared) {
    const retired = list.find((r) => r.provider === m.provider && r.id === m.name);
    if (!retired) continue;
    const toCome = retired.retiredOn > today;
    const day = toCome
      ? `retires on ${retired.retiredOn}`
      : `was retired by its provider on ${retired.retiredOn}`;
    const note = retired.note ? ` (${retired.note})` : "";
    let outcome: string;
    if (retired.redirectsTo) {
      const target = `${retired.provider}/${retired.redirectsTo}`;
      outcome = toCome
        ? `from that day, the provider serves it as ${target}, at that model's price`
        : `the provider now serves it as ${target}, at that model's price`;
    } else {
      outcome = toCome ? "from that day, a call to it fails" : "a call to it fails";
    }
    const advice = retired.replacement
      ? `use ${retired.provider}/${retired.replacement} instead`
      : "no replacement named: pick a current model";
    issues.push({
      code: "MODEL_RETIRED",
      message: `${role} ${m.provider}/${m.name} ${day}${note}: ${outcome} — ${advice}.`,
      file: "agent.yaml",
      field,
    });
  }
  return issues;
}
