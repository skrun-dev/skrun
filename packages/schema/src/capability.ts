import type { AgentConfig } from "./schemas/agent-config.js";
import type { FileInputField } from "./schemas/file-input.js";
import type { ModelProvider } from "./schemas/model-config.js";

export interface ModelCapabilities {
  image: boolean;
  document: boolean;
  audio: boolean;
  /**
   * Whether the model exposes a native prompt-caching primitive: cache_control
   * (Anthropic), prompt_cache_key (OpenAI/Mistral/xAI), a sticky-routing
   * header (Grok), implicit caching (Gemini/Groq). Descriptive: no runtime
   * code reads it — each adapter wires its provider's primitive whatever the
   * flag, and the cost helper prices cached tokens from the pricing table's
   * own cache rates. The `cache` column of the docs' matrix mirrors it (a
   * parity test checks). Groq caches its `openai/gpt-oss-*` models, the ones
   * this matrix lists.
   */
  caching: boolean;
  /**
   * Whether the model accepts a `temperature` other than its default. `false`
   * on the rows of models whose provider refuses one with a 400
   * (`claude-opus-4-7`, `gpt-5`), says to remove it at the reasoning effort
   * the runtime leaves at its default (the GPT-6 models), or ignores it (Google,
   * from `gemini-3.6-flash` on); and kept `false` as a precaution where the
   * provider's page says nothing (`gpt-5.5`, the GPT-5.6 models). A row covers
   * every id it resolves, so a dated id takes its base model's flag. `validateAgent` warns
   * `TEMPERATURE_UNSUPPORTED` when an `agent.yaml` declares one for such a
   * model, and the runtime does not send it. A model absent from the matrix
   * takes its provider's default instead (`acceptsTemperature`).
   */
  temperature: boolean;
  /**
   * `false` for a model that refuses a forced tool choice — a required tool,
   * a named one, or a subset, which the Anthropic adapter sends as "any" —
   * with a 400 on every request (some Claude models with thinking always on).
   * `validateAgent` warns `TOOL_CHOICE_UNSUPPORTED` when an `agent.yaml`
   * forces a choice on such a model, and the runtime sends `auto` instead.
   * Absent everywhere else: no source carries it, so it is set by hand, from
   * the provider's page, for each model added. A successor whose id extends a
   * key — claude-fable-5-2 extends claude-fable-5 — takes that row's flags
   * until it gets a row of its own, and nothing flags it meanwhile: the drift
   * check counts no such id as a novelty.
   */
  forcedToolChoice?: false;
}

export type CapabilityValidationOutcome = { ok: true } | { ok: false; errors: string[] };

/**
 * The day the model catalog — this matrix, the runtime's pricing table and its
 * cache thresholds — was last reviewed against the providers' own docs. Each
 * catalog refresh moves it. Exported for tooling that reads it from this
 * module; it is not re-exported by the package's entry point.
 */
export const MODEL_CATALOG_REVIEWED_ON = "2026-10-28";

// Model IDs use longest-prefix match: a versioned name like
// `claude-opus-4-7-20260416` resolves to the `claude-opus-4-7` entry.
//
// A key is an id the provider's API takes, for a text model our adapter calls
// — no commercial name, no family prefix with no model of its own, no model
// served only by another endpoint. A deprecated model keeps its row, its
// retirement day in a comment, until that day — unless keeping it would cost
// the drift check a waiver that no run depends on (a catalog marks it
// deprecated already, or does not list it): it then leaves the matrix before
// its day, for `RETIRED_MODELS` (`./schemas/retired-models.ts`), that day
// still to come. A retired one leaves the matrix for the same list — so does
// one its provider already serves as another model with no shutdown day,
// redirected to it (`redirectsTo`).
export const MODEL_CAPABILITIES: Record<ModelProvider, Record<string, ModelCapabilities>> = {
  anthropic: {
    // Claude 5.x: every one refuses a temperature (models.dev, LiteLLM).
    // Claude Opus 5.5, Sonnet 5.5, Fable 5.2, Mythos 5.2, Fable 5.1 and
    // Mythos 5.1 refuse a forced tool choice with a 400 on every request
    // (Anthropic, "Thinking" page, 2026-11-17).
    "claude-opus-5-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    "claude-sonnet-5-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    "claude-fable-5-2": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    // Limited availability (Anthropic's pricing page).
    "claude-mythos-5-2": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    "claude-fable-5-1": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    // Limited availability (Anthropic's pricing page).
    "claude-mythos-5-1": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
      forcedToolChoice: false,
    },
    "claude-fable-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    // Limited availability (Anthropic's pricing page).
    "claude-mythos-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "claude-opus-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "claude-sonnet-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    // Claude 4.x family. All support cache_control.
    "claude-opus-4-8": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "claude-opus-4-7": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "claude-opus-4-6": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    },
    "claude-opus-4-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    },
    "claude-sonnet-4-6": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    },
    "claude-haiku-4-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    },
    // Claude Haiku 5.5: thinking on by default, yet it accepts a forced tool
    // choice — Anthropic's "Thinking" page names only Opus 5.5, Sonnet 5.5,
    // Fable 5.2, Mythos 5.2, Fable 5.1 and Mythos 5.1 as refusing one.
    "claude-haiku-5-5": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
  },
  google: {
    // Gemini 4, 3.x and 2.5, stable unless the id says `-preview`
    // (ai.google.dev/gemini-api/docs/models). Gemini 2.5 is open only to
    // accounts that have used it before (Google's deprecations page).
    // All Gemini 2.5, 3.x and 4 have implicit caching enabled by default (free win,
    // no parameter to pass). Skrun only parses cachedContentTokenCount for cost.
    // Gemini 4 Argon and Gemini 3.6 and 3.8 Flash take no temperature:
    // Google deprecated the sampling parameters on 2026-07-21 (Gemini API
    // changelog); from Gemini 3.6 Flash on they stay at their defaults, any
    // value is ignored — Gemini 4 Argon's migration guide says the same —,
    // and Google says its next models will refuse one. models.dev still
    // marks them as accepting one; LiteLLM marks the two Flash as not.
    // Gemini 3.7 Flash and 3.5 Flash have no row: since 2026-10-08 Google
    // answers them as gemini-3.8-flash and gemini-3.6-flash
    // (`RETIRED_MODELS`, `redirectsTo`).
    // Gemini 4 Argon, on generateContent: implicit caching only.
    "gemini-4-argon": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: false,
    },
    "gemini-3.8-flash": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: false,
    },
    "gemini-3.6-flash": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: false,
    },
    "gemini-3.5-flash-lite": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
    "gemini-3.1-pro-preview": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
    "gemini-3-flash-preview": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
    "gemini-2.5-pro": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
    "gemini-2.5-flash": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
    "gemini-2.5-flash-lite": {
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    },
  },
  openai: {
    // GPT-6.1, GPT-6, GPT-5.x and GPT-4o, on Chat Completions. Vision + PDF via Files
    // API (input_file content block extracts text+images server-side for any
    // vision-capable model). Audio goes to a dedicated model (gpt-audio-1.5).
    // These chat models support implicit caching past 1024 tokens; gpt-5.5
    // uses 24h-only retention (in-memory excluded). Skrun sets
    // prompt_cache_key on every request for sticky-routing.
    "gpt-6.1-sol": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-6.1-terra": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "gpt-6-astra": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-6-sol": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-6-luna": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-5.6-sol": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-5.6-terra": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "gpt-5.6-luna": {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: false,
    },
    "gpt-5.5": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-5.4": { image: true, document: true, audio: false, caching: true, temperature: true },
    "gpt-5.4-mini": { image: true, document: true, audio: false, caching: true, temperature: true },
    // Deprecated: gpt-5.4-nano and its dated snapshot retire 2027-04-01
    // (OpenAI's notice of 2026-10-01, which recommends gpt-6-luna); the row
    // stays until that day.
    "gpt-5.4-nano": { image: true, document: true, audio: false, caching: true, temperature: true },
    "gpt-5.2": { image: true, document: true, audio: false, caching: true, temperature: true },
    // Deprecated: gpt-5, gpt-5-mini, gpt-5-nano and their dated snapshots
    // retire 2026-12-11 (OpenAI's notice of 2026-06-11); the rows stay until
    // that day.
    "gpt-5": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-5-mini": { image: true, document: true, audio: false, caching: true, temperature: false },
    "gpt-5-nano": { image: true, document: true, audio: false, caching: true, temperature: false },
    // gpt-4o, gpt-4o-mini: OpenAI's notice of 2026-10-14 retires the dated
    // snapshots it names on 2027-01-14, and names neither alias.
    "gpt-4o": { image: true, document: true, audio: false, caching: true, temperature: true },
    "gpt-4o-mini": { image: true, document: true, audio: false, caching: true, temperature: true },
    // Audio-capable chat-completions model (text + audio; no image/document).
    // Skrun runtime calls /v1/chat/completions only — it accepts audio content
    // blocks at that endpoint. No cached-input rate: OpenAI publishes none for
    // it. Transcription-only models like gpt-4o-transcribe live at
    // /v1/audio/transcriptions and are not in this matrix; multi-endpoint
    // routing is on the runtime backlog.
    "gpt-audio-1.5": {
      image: false,
      document: false,
      audio: true,
      caching: false,
      temperature: true,
    },
    // Specialist endpoints — NOT routed by Skrun runtime today (calls
    // /v1/chat/completions only). Routing them is on the runtime backlog.
    // gpt-realtime + gpt-realtime-1.5: voice on /v1/realtime (WSS).
    // gpt-image-2 + gpt-image-1.5: image generation on /v1/images/*.
    // The models served by the Responses API only (the -pro and -codex
    // families) have no row either — but an id that extends a key here takes
    // that key's row: gpt-5.5-pro resolves to gpt-5.5. A model with no row is
    // not refused: getModelCapabilities() returns undefined, the capability
    // check passes it and the runtime sends its inputs as declared; a call to
    // an endpoint that does not serve the model fails at the provider.
  },
  mistral: {
    // Vision-capable per Mistral vision docs (text + image, no PDF/audio).
    // ALL Mistral models: caching=true. Mistral caches a repeated prefix,
    // billed at a tenth of the input rate; the adapter passes the run's
    // prompt_cache_key and reads prompt_tokens_details.cached_tokens back.
    // Mistral Medium 3.5, the April 2026 release, by its dated id.
    "mistral-medium-2604": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    // Mistral Large 3, by its dated id and its alias.
    "mistral-large-2512": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    // Mistral Large 4; `mistral-large-latest` still serves Large 3.
    "mistral-large-4": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    "mistral-large-latest": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    // Mistral Small 4, by its dated id.
    "mistral-small-2603": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    // Specialist endpoints — NOT routed by Skrun runtime today. Tracked on
    // the runtime backlog (multi-endpoint routing).
    // voxtral-small: audio chat on /v1/chat/completions (could go live once
    //   specialist routing ships — for now treated as specialist for consistency).
    // voxtral-mini-transcribe-2 + voxtral-mini-transcribe-realtime: STT on
    //   /v1/audio/transcriptions.
    // voxtral-tts: TTS on /v1/audio/speech.
    // mistral-ocr-3: document OCR on /v1/ocr.
  },
  groq: {
    // Groq's own ids. Prompt caching on the openai/gpt-oss family (Groq's
    // prompt-caching page).
    "openai/gpt-oss-120b": {
      image: false,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    "openai/gpt-oss-20b": {
      image: false,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    // openai/gpt-oss-safeguard-20b is Groq's current safety classifier.
    "openai/gpt-oss-safeguard-20b": {
      image: false,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
  },
  xai: {
    // Per xAI docs: Grok 4.x takes text + image (jpg/png, 20MiB max).
    // Native video input is supported but not yet wired in the runtime —
    // on the runtime backlog (video input). Voice/audio is routed through
    // xAI's Voice API, not chat — also on the runtime backlog.
    // All Grok language models support implicit caching with `x-grok-conv-id`
    // sticky-routing (Chat Completions) / `prompt_cache_key` (Responses).
    // Document false on every Grok row: xAI reads PDFs, but this runtime's
    // xAI adapter sends images only. grok-4.20-multi-agent is served by the
    // Responses API only: not in this matrix.
    "grok-4.7": { image: true, document: false, audio: false, caching: true, temperature: true },
    "grok-4.6": { image: true, document: false, audio: false, caching: true, temperature: true },
    "grok-4.5": { image: true, document: false, audio: false, caching: true, temperature: true },
    "grok-4.3": { image: true, document: false, audio: false, caching: true, temperature: true },
    "grok-4.20-0309-reasoning": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    "grok-4.20-0309-non-reasoning": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
    "grok-build-0.1": {
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    },
  },
  meta: {},
};

export function getModelCapabilities(
  provider: ModelProvider,
  modelName: string,
): ModelCapabilities | undefined {
  const providerMatrix = MODEL_CAPABILITIES[provider];
  if (!providerMatrix) return undefined;

  if (modelName in providerMatrix) return providerMatrix[modelName];

  let bestMatch: { key: string; caps: ModelCapabilities } | undefined;
  for (const [key, caps] of Object.entries(providerMatrix)) {
    if (modelName.startsWith(`${key}-`) && (!bestMatch || key.length > bestMatch.key.length)) {
      bestMatch = { key, caps };
    }
  }
  return bestMatch?.caps;
}

/**
 * Whether a model absent from the matrix, called at its provider's own API,
 * is sent a declared `temperature`, by provider. Anthropic, Google and
 * OpenAI: no — their latest models take none (every Claude 5.x refuses one;
 * GPT-5 and every GPT-6 have their row at false, GPT-5.5 and 5.6 keep theirs
 * at false where OpenAI's pages say nothing; Gemini ignores it from 3.6 Flash
 * on and Google says its next models will refuse it), so a model released since
 * the matrix was reviewed most likely takes none either. Left out, a model
 * that would have taken one runs at its default; sent, a model that refuses
 * one fails the request. Mistral, Groq and xAI: every row of theirs takes
 * one, so they get it as declared.
 */
const UNLISTED_MODEL_TEMPERATURE: Record<ModelProvider, boolean> = {
  anthropic: false,
  google: false,
  openai: false,
  mistral: true,
  groq: true,
  xai: true,
  meta: true,
};

/**
 * Whether a declared `temperature` is sent to this model: its matrix row's
 * flag; for a model the matrix does not resolve, the declared value when it
 * is called at a `base_url` — the agent's, for its primary model only;
 * whatever the provider's name, the runtime reaches that endpoint through
 * its OpenAI-compatible adapter, and a self-hosted model takes one —, its
 * provider's default (`UNLISTED_MODEL_TEMPERATURE`) otherwise. The runtime sends none where
 * this is `false`, and `validateAgent` warns `TEMPERATURE_UNSUPPORTED`.
 */
export function acceptsTemperature(
  provider: ModelProvider,
  modelName: string,
  baseUrl?: string,
): boolean {
  const caps = getModelCapabilities(provider, modelName);
  if (caps) return caps.temperature;
  if (baseUrl !== undefined) return true;
  return UNLISTED_MODEL_TEMPERATURE[provider] ?? true;
}

export function validateAgentCapabilities(config: AgentConfig): CapabilityValidationOutcome {
  const fileInputs = config.inputs.filter(
    (input): input is FileInputField => input.type === "file",
  );

  if (fileInputs.length === 0) {
    return { ok: true };
  }

  const errors: string[] = [];

  const primaryCaps = getModelCapabilities(config.model.provider, config.model.name);
  if (primaryCaps) {
    for (const input of fileInputs) {
      if (!primaryCaps[input.media]) {
        errors.push(
          `Input '${input.name}' requires '${input.media}' but primary model '${config.model.provider}/${config.model.name}' does not support it`,
        );
      }
    }
  }

  if (config.model.fallback) {
    const fallbackCaps = getModelCapabilities(
      config.model.fallback.provider,
      config.model.fallback.name,
    );
    if (fallbackCaps) {
      for (const input of fileInputs) {
        if (!fallbackCaps[input.media]) {
          errors.push(
            `Input '${input.name}' requires '${input.media}' but fallback model '${config.model.fallback.provider}/${config.model.fallback.name}' does not support it`,
          );
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
