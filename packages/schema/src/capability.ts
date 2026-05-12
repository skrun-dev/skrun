import type { AgentConfig } from "./schemas/agent-config.js";
import type { FileInputField } from "./schemas/file-input.js";
import type { ModelProvider } from "./schemas/model-config.js";

export interface ModelCapabilities {
  image: boolean;
  document: boolean;
  audio: boolean;
  /**
   * Whether the model exposes a native prompt-caching primitive.
   * `true` = the runtime can wire cache_control (Anthropic) / prompt_cache_key
   * (OpenAI/xAI) / sticky-routing header (Grok) / implicit caching benefits
   * (Gemini/Groq) for this model. `false` = no native caching available;
   * the runtime skips caching primitives and the cost helper does not apply
   * any cached-rate discount. Mistral is currently the only `false` provider
   * (verified May 2026). Groq is `true` only on the `openai/gpt-oss-*` family
   * + `moonshotai/kimi-k2-instruct`; its Llama / Qwen / Mixtral models are `false`.
   */
  caching: boolean;
}

export type CapabilityValidationOutcome = { ok: true } | { ok: false; errors: string[] };

// Model IDs use longest-prefix match: a versioned name like
// `claude-opus-4-7-20260416` resolves to the `claude-opus-4-7` entry.
// Refreshed 2026-05-04 against current provider docs (May 2026 audit).
export const MODEL_CAPABILITIES: Record<ModelProvider, Record<string, ModelCapabilities>> = {
  anthropic: {
    // Claude 4.x family (current generation). All support cache_control.
    "claude-opus-4-7": { image: true, document: true, audio: false, caching: true },
    "claude-opus-4-6": { image: true, document: true, audio: false, caching: true },
    // claude-opus-4-20250514: deprecated, retires 2026-06-15 — drop in a follow-up
    "claude-opus-4": { image: true, document: true, audio: false, caching: true },
    "claude-sonnet-4-6": { image: true, document: true, audio: false, caching: true },
    "claude-sonnet-4-5": { image: true, document: true, audio: false, caching: true },
    // claude-sonnet-4-20250514: deprecated, retires 2026-06-15 — drop in a follow-up
    "claude-sonnet-4": { image: true, document: true, audio: false, caching: true },
    "claude-haiku-4-5": { image: true, document: true, audio: false, caching: true },
    "claude-haiku-4": { image: true, document: true, audio: false, caching: true },
    // Claude 3.x family (legacy — kept for back-compat with older agents)
    "claude-3-7-sonnet": { image: true, document: true, audio: false, caching: true },
    "claude-3-5-sonnet": { image: true, document: true, audio: false, caching: true },
    "claude-3-5-haiku": { image: true, document: true, audio: false, caching: true },
    "claude-3-haiku": { image: true, document: false, audio: false, caching: true },
    "claude-3-opus": { image: true, document: true, audio: false, caching: true },
  },
  google: {
    // Gemini 3.x family — all preview as of May 2026, hence the `-preview` suffix
    // in the actual model IDs returned by the developer API. Confirmed via
    // ai.google.dev/gemini-api/docs/models.
    // All Gemini 2.5+/3.x have implicit caching enabled by default (free win,
    // no parameter to pass). #68 only parses cachedContentTokenCount for cost.
    "gemini-3.1-pro-preview": { image: true, document: true, audio: true, caching: true },
    "gemini-3.1-flash-preview": { image: true, document: true, audio: true, caching: true },
    "gemini-3.1-flash-lite-preview": { image: true, document: true, audio: true, caching: true },
    "gemini-3-flash-preview": { image: true, document: true, audio: true, caching: true },
    "gemini-3-deep-think-preview": { image: true, document: true, audio: true, caching: true },
    // Gemini 2.5 family (GA, still available alongside 3.x preview)
    "gemini-2.5-pro": { image: true, document: true, audio: true, caching: true },
    "gemini-2.5-flash": { image: true, document: true, audio: true, caching: true },
    "gemini-2.5-flash-lite": { image: true, document: true, audio: true, caching: true },
  },
  openai: {
    // GPT-5.x family (current). Vision + PDF via Files API
    // (input_file content block extracts text+images server-side for any
    // vision-capable model). Audio is handled by dedicated models
    // (gpt-audio, gpt-4o-audio-preview, gpt-4o-transcribe).
    // All recent models (gpt-4o and newer) support implicit caching past 1024
    // tokens; gpt-5.5/5.5-pro use 24h-only retention (in-memory excluded).
    // #68 sets prompt_cache_key on every request for sticky-routing.
    "gpt-5.5-pro": { image: true, document: true, audio: false, caching: true },
    "gpt-5.5": { image: true, document: true, audio: false, caching: true },
    "gpt-5.4-pro": { image: true, document: true, audio: false, caching: true },
    "gpt-5.4-mini": { image: true, document: true, audio: false, caching: true },
    "gpt-5.4-nano": { image: true, document: true, audio: false, caching: true },
    "gpt-5.4": { image: true, document: true, audio: false, caching: true },
    "gpt-5.3-codex": { image: true, document: true, audio: false, caching: true },
    "gpt-5-pro": { image: true, document: true, audio: false, caching: true },
    "gpt-5": { image: true, document: true, audio: false, caching: true },
    // GPT-4 family (legacy — same Files API support, caching live since launch).
    "gpt-4o": { image: true, document: true, audio: false, caching: true },
    "gpt-4o-mini": { image: true, document: true, audio: false, caching: true },
    "gpt-4-turbo": { image: true, document: false, audio: false, caching: true },
    o1: { image: true, document: false, audio: false, caching: true },
    "o1-mini": { image: false, document: false, audio: false, caching: true },
    // Audio-capable chat-completions models (text + audio; no image/document).
    // Skrun runtime calls /v1/chat/completions only — these accept audio
    // content blocks at that endpoint. Transcription-only models like
    // gpt-4o-transcribe live at /v1/audio/transcriptions and are not in
    // this matrix; multi-endpoint routing is on the runtime backlog.
    "gpt-audio": { image: false, document: false, audio: true, caching: true },
    "gpt-audio-1.5": { image: false, document: false, audio: true, caching: true },
    "gpt-4o-audio-preview": { image: false, document: false, audio: true, caching: true },
    // Specialist endpoints — NOT routed by Skrun runtime today (calls
    // /v1/chat/completions only). Tracked at #74 specialist-endpoint-routing.
    // gpt-realtime + gpt-realtime-1.5: voice on /v1/realtime (WSS).
    // gpt-image-2 + gpt-image-1.5: image generation on /v1/images/*.
    // No live entries here so getCapability() returns undefined and deploy-time
    // capability check refuses agents declaring them, which is the intended
    // behavior until #74 lands.
  },
  mistral: {
    // Vision-capable per Mistral vision docs (text + image, no PDF/audio).
    // Pixtral standalone deprecated 2026 — folded into mistral-large-3 / mistral-small-4.
    // ALL Mistral models: caching=false. No native prompt-caching API as of
    // May 2026 (verified docs.mistral.ai). Runtime adapter is no-op + logs
    // a structured "cache_skipped" event. When Mistral adds native caching,
    // flip these flags + wire the adapter.
    "mistral-large-3": { image: true, document: false, audio: false, caching: false },
    "mistral-large-2512": { image: true, document: false, audio: false, caching: false },
    "mistral-medium-3.5": { image: true, document: false, audio: false, caching: false },
    "mistral-medium-2508": { image: true, document: false, audio: false, caching: false },
    "mistral-medium-3": { image: true, document: false, audio: false, caching: false },
    "mistral-small-3.2": { image: true, document: false, audio: false, caching: false },
    "mistral-small-2506": { image: true, document: false, audio: false, caching: false },
    "mistral-small-3.1": { image: true, document: false, audio: false, caching: false },
    "ministral-14b-2512": { image: true, document: false, audio: false, caching: false },
    "ministral-8b-2512": { image: true, document: false, audio: false, caching: false },
    "ministral-3b-2512": { image: true, document: false, audio: false, caching: false },
    // Text-only (NOT in Mistral vision docs list)
    "mistral-small-4": { image: false, document: false, audio: false, caching: false },
    "mistral-large-latest": { image: false, document: false, audio: false, caching: false },
    "ministral-8b": { image: false, document: false, audio: false, caching: false },
    // Reasoning-focused (chain-of-thought, text-only per Mistral docs).
    "magistral-medium-1.2": { image: false, document: false, audio: false, caching: false },
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
    // Caching support per Groq docs (May 2026): only the `openai/gpt-oss-*`
    // family + `moonshotai/kimi-k2-instruct` (not yet in this matrix).
    // Llama / Qwen / compound = false until Groq rolls out caching to them.
    // Vision: Llama 4 Scout (preview) per Groq vision docs (May 2026).
    "llama-4-scout-17b-16e-instruct": {
      image: true,
      document: false,
      audio: false,
      caching: false,
    },
    // Text-only.
    "meta-llama/llama-4-maverick-17b-128e-instruct": {
      image: false,
      document: false,
      audio: false,
      caching: false,
    },
    "openai/gpt-oss-120b": { image: false, document: false, audio: false, caching: true },
    "openai/gpt-oss-20b": { image: false, document: false, audio: false, caching: true },
    // openai/gpt-oss-safeguard-20b is Groq's current safety classifier.
    "openai/gpt-oss-safeguard-20b": {
      image: false,
      document: false,
      audio: false,
      caching: true,
    },
    "qwen/qwen3-32b": { image: false, document: false, audio: false, caching: false },
    "llama-3.3-70b-versatile": { image: false, document: false, audio: false, caching: false },
    "llama-3.1-8b-instant": { image: false, document: false, audio: false, caching: false },
    // Back-compat: unprefixed gpt-oss-* names. The actual Groq IDs use the
    // `openai/` prefix; keep these for any agent.yaml that hardcoded the short form.
    "gpt-oss-120b": { image: false, document: false, audio: false, caching: true },
    "gpt-oss-20b": { image: false, document: false, audio: false, caching: true },
    // Built-in agent system (web_search + code_execution baked in).
    // Functional overlap with Skrun's POST /run + tools — see #74 for routing.
    "groq/compound": { image: false, document: false, audio: false, caching: false },
    "groq/compound-mini": { image: false, document: false, audio: false, caching: false },
    // Legacy Llama-3.2 vision-preview models (90b / 11b) removed from Groq's
    // catalog as of 2026-05; Llama-Guard-4 deprecated 2026-02-10. Both dropped.
    // See `scripts/check-stale-model-ids.ts` DEPRECATED_IDS for the full list.
  },
  xai: {
    // Per xAI docs: Grok 4.3 supports text + image (jpg/png, 20MiB max).
    // Native video input is supported but not yet wired in the runtime —
    // on the runtime backlog (video input). Voice/audio is routed through
    // xAI's Voice API, not chat — also on the runtime backlog.
    // All Grok language models support implicit caching with `x-grok-conv-id`
    // sticky-routing (Chat Completions) / `prompt_cache_key` (Responses).
    "grok-4.3": { image: true, document: false, audio: false, caching: true },
    "grok-4.1-fast": { image: true, document: false, audio: false, caching: true },
    // Multi-agent: 4 native sub-agents (Grok+Harper+Benjamin+Lucas).
    // `reasoning.effort` controls agent count (4 vs 16), not depth.
    "grok-4.20-multi-agent": { image: true, document: false, audio: false, caching: true },
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
