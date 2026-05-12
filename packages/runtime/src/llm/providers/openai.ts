import OpenAI, { toFile } from "openai";
import { createLogger } from "../../logger.js";
import { LLMCapabilityError } from "../errors.js";
import { fingerprintBytes, type ProviderFileCache } from "../file-cache.js";
import type { SkrunPart } from "../parts.js";
import type { ResolvedToolChoice } from "../tool-choice.js";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

const PRE_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
const log = createLogger("llm:openai");

/**
 * Translate the provider-agnostic ResolvedToolChoice IR into OpenAI's
 * `tool_choice` shape. OpenAI accepts:
 *   - "auto" / "required" / "none"
 *   - { type: "function", function: { name } } for a specific named tool
 *
 * Subset-of-N is not natively supported; we soft-fallback to `"required"`
 * (any declared tool fires) and log a structured warning.
 *
 * Returns `undefined` for the default ({ mode: "auto" }) so the field is
 * omitted from the request.
 *
 * Used for openai, mistral, groq, and xai providers (all OpenAI-compatible).
 */
function buildToolChoice(
  toolChoice: ResolvedToolChoice | undefined,
  providerName: string,
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice || toolChoice.mode === "auto") return undefined;
  switch (toolChoice.mode) {
    case "none":
      return "none";
    case "required":
      return "required";
    case "specific":
      return { type: "function", function: { name: toolChoice.tool } };
    case "subset":
      log.warn(
        {
          event: "provider_gap",
          provider: providerName,
          gap: "subset_not_supported",
          fallback: "required",
          subset: toolChoice.tools,
        },
        `${providerName} does not natively support subset-of-N tool_choice; collapsing to "required" (any declared tool fires)`,
      );
      return "required";
  }
}

/** Whether this provider name (using OpenAI-compatible client) supports a given media kind. */
function isMediaSupported(providerName: string, kind: "image" | "document" | "audio"): boolean {
  if (kind === "image") return true; // openai, mistral, groq, xai all support image
  // Mistral/Groq/xAI (Grok): image only — no document/audio
  if (providerName === "mistral" || providerName === "groq" || providerName === "xai") {
    return false;
  }
  return true; // openai supports document + audio (audio only on gpt-4o-audio-*)
}

/**
 * Cache behavior config for the OpenAI-compatible factory variants.
 *
 * Each factory tunes one of the 4 cache-related dimensions independently:
 * - `passPromptCacheKey`: pass `prompt_cache_key` body field (OpenAI; xAI Responses)
 * - `setGrokConvIdHeader`: set `x-grok-conv-id` HTTP header (xAI Chat Completions)
 * - `extractCachedTokens`: parse `prompt_tokens_details.cached_tokens` from response
 * - `skipCaching`: log structured no-op event and skip all cache behavior (Mistral)
 *
 * Defaults are deliberately conservative (no passing of cache_key, no header set,
 * but DO extract — extraction is harmless when fields are absent and gives free
 * cost-tracking accuracy on whatever the provider supports implicitly).
 */
export interface CacheBehavior {
  passPromptCacheKey?: boolean;
  setGrokConvIdHeader?: boolean;
  extractCachedTokens?: boolean;
  skipCaching?: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private cacheBehavior: CacheBehavior;

  constructor(name: string, apiKey: string, baseURL?: string, cacheBehavior?: CacheBehavior) {
    this.name = name;
    this.client = new OpenAI({ apiKey, baseURL });
    this.cacheBehavior = cacheBehavior ?? { extractCachedTokens: true };
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const userContentParts = await this.translateUserContent(
      request.userContent,
      request._fileCache,
    );

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: userContentParts },
    ];

    if (request.toolResults?.length) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: request.toolResults.map((tr, i) => ({
          id: tr.id ?? tr.name,
          type: "function" as const,
          function: {
            name: tr.name,
            arguments: JSON.stringify(request.toolCalls?.[i]?.args ?? {}),
          },
        })),
      });
      for (const tr of request.toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.id ?? tr.name,
          content: tr.result,
        });
      }
    }

    const tools: OpenAI.ChatCompletionTool[] | undefined = request.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const toolChoice = buildToolChoice(request.toolChoice, this.name);

    // Cache routing: pass `prompt_cache_key` body field when the factory
    // variant opts in (OpenAI, xAI Responses) and the router gave us a
    // hashed key. Mistral factory has `skipCaching: true` — we explicitly
    // emit a structured no-op event and don't pass cache params.
    const requestOptions: { headers?: Record<string, string> } = {};
    let promptCacheKey: string | undefined;

    if (this.cacheBehavior.skipCaching) {
      log.debug(
        {
          event: "cache_skipped",
          provider: this.name,
          reason: "no_native_caching",
        },
        `${this.name} does not support prompt caching; skipping cache primitives`,
      );
    } else {
      if (this.cacheBehavior.passPromptCacheKey && request.cacheKey) {
        promptCacheKey = request.cacheKey;
      }
      if (this.cacheBehavior.setGrokConvIdHeader && request.cacheKey) {
        requestOptions.headers = { "x-grok-conv-id": request.cacheKey };
      }
    }

    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages,
        tools,
        ...(toolChoice !== undefined && { tool_choice: toolChoice }),
        ...(request.parallelTools === false && { parallel_tool_calls: false }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(promptCacheKey !== undefined && { prompt_cache_key: promptCacheKey }),
      },
      requestOptions,
    );

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";
    const toolCalls: ToolCallRequest[] = [];

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        // OpenAI v6 introduced a discriminated union: function tools (type: "function")
        // vs custom tools (type: "custom"). We only emit function tools.
        if (tc.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // Malformed tool arguments from LLM — use empty args
        }
        toolCalls.push({
          name: tc.function.name,
          args,
          id: tc.id,
        });
      }
    }

    // Cache usage extraction. OpenAI / xAI / Groq all share the
    // `usage.prompt_tokens_details.cached_tokens` shape on Chat Completions,
    // OR `usage.input_tokens_details.cached_tokens` on the Responses API
    // (verified May 2026). Try Chat shape first, fall back to Responses
    // shape — same field semantically. Skipped entirely when the factory
    // has `skipCaching: true` (Mistral).
    //
    // Apply gross→net normalization: OpenAI / xAI / Groq report
    // `prompt_tokens` as GROSS (cached + uncached). Subtract cached portion
    // so the uniform `promptTokens` is the FULL-RATE residual.
    const grossPromptTokens = response.usage?.prompt_tokens ?? 0;
    let cacheReadTokens: number | undefined;
    if (this.cacheBehavior.extractCachedTokens && !this.cacheBehavior.skipCaching) {
      // Chat Completions native shape (current runtime usage).
      const chatCachedTokens = response.usage?.prompt_tokens_details?.cached_tokens;
      // Responses API shape — kept for forward-compat when the runtime adds
      // Responses path support. Field names differ (`input_tokens_details`).
      const responsesCachedTokens = (
        response.usage as { input_tokens_details?: { cached_tokens?: number } } | undefined
      )?.input_tokens_details?.cached_tokens;
      const cached = chatCachedTokens ?? responsesCachedTokens;
      if (cached !== undefined && cached > 0) cacheReadTokens = cached;
    }

    const promptTokens = Math.max(0, grossPromptTokens - (cacheReadTokens ?? 0));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens: response.usage?.completion_tokens ?? 0,
        ...(cacheReadTokens !== undefined && { cacheReadTokens }),
        // OpenAI / xAI / Groq don't have a separate write surcharge — implicit
        // caching is free beyond the normal input bill. cacheWriteTokens stays
        // undefined for these providers.
      },
    };
  }

  /**
   * Translate SkrunPart[] into OpenAI Chat Completions content parts.
   *
   * - text → {type: "text", text}
   * - image → {type: "image_url", image_url: {url: "data:..."}} inline, or via Files API + file_id when >20MB
   * - document (PDF) → {type: "file", file: {filename, file_data: "data:..."}} inline, or {type: "file", file: {file_id}} when >20MB
   * - audio → {type: "input_audio", input_audio: {data, format}} (always inline; gpt-4o-audio-* only)
   *
   * Mistral/Groq variants of OpenAI-compatible: only image is allowed; document/audio throw LLMCapabilityError.
   */
  private async translateUserContent(
    parts: SkrunPart[],
    fileCache?: ProviderFileCache,
  ): Promise<OpenAI.ChatCompletionContentPart[]> {
    const totalNonTextBytes = parts.reduce(
      (sum, p) => (p.kind === "text" ? sum : sum + p.bytes.length),
      0,
    );
    const usePreUpload = totalNonTextBytes > PRE_UPLOAD_THRESHOLD_BYTES;

    const out: OpenAI.ChatCompletionContentPart[] = [];

    for (const part of parts) {
      if (part.kind === "text") {
        out.push({ type: "text", text: part.text });
        continue;
      }

      if (!isMediaSupported(this.name, part.kind)) {
        throw new LLMCapabilityError(this.name, "(any)", part.kind);
      }

      const data = Buffer.from(part.bytes).toString("base64");
      const dataUri = `data:${part.media_type};base64,${data}`;

      if (part.kind === "image") {
        if (usePreUpload && this.name === "openai") {
          const fileId = await this.uploadOrCache(part, fileCache);
          out.push({
            type: "file",
            file: { file_id: fileId },
          } as unknown as OpenAI.ChatCompletionContentPart);
        } else {
          out.push({
            type: "image_url",
            image_url: { url: dataUri },
          });
        }
        continue;
      }

      if (part.kind === "document") {
        if (usePreUpload && this.name === "openai") {
          const fileId = await this.uploadOrCache(part, fileCache);
          out.push({
            type: "file",
            file: { file_id: fileId },
          } as unknown as OpenAI.ChatCompletionContentPart);
        } else {
          out.push({
            type: "file",
            file: {
              filename: part.filename ?? `upload.${guessExt(part.media_type)}`,
              file_data: dataUri,
            },
          } as unknown as OpenAI.ChatCompletionContentPart);
        }
        continue;
      }

      // part.kind === "audio"
      out.push({
        type: "input_audio",
        input_audio: { data, format: audioFormatFromMime(part.media_type) },
      } as unknown as OpenAI.ChatCompletionContentPart);
    }

    return out;
  }

  /**
   * Look up the provider file cache before uploading; populate after.
   * Within a single agent run's tool loop, repeated calls with the same bytes
   * upload only once.
   */
  private async uploadOrCache(
    part: Exclude<SkrunPart, { kind: "text" }>,
    fileCache?: ProviderFileCache,
  ): Promise<string> {
    const fingerprint = fingerprintBytes(part.bytes);
    const cached = fileCache?.get(this.name, fingerprint);
    if (cached) return cached;

    const filename = part.filename ?? `upload.${guessExt(part.media_type)}`;
    const uploaded = await this.client.files.create({
      file: await toFile(Buffer.from(part.bytes), filename, { type: part.media_type }),
      purpose: "user_data",
    });
    fileCache?.set(this.name, fingerprint, uploaded.id);
    return uploaded.id;
  }
}

function guessExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return mime.slice(6);
  if (mime.startsWith("audio/")) return mime.slice(6);
  return "bin";
}

function audioFormatFromMime(mime: string): "wav" | "mp3" {
  if (mime === "audio/mp3" || mime === "audio/mpeg") return "mp3";
  return "wav";
}

export function createOpenAIProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "openai",
    apiKey ?? process.env.OPENAI_API_KEY ?? "",
    undefined,
    {
      // OpenAI uses `prompt_cache_key` body field for sticky-routing across
      // both Chat Completions and Responses API. Pass it whenever the router
      // provides a hashed key.
      passPromptCacheKey: true,
      extractCachedTokens: true,
    },
  );
}

export function createMistralProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "mistral",
    apiKey ?? process.env.MISTRAL_API_KEY ?? "",
    "https://api.mistral.ai/v1",
    {
      // Mistral has no native prompt-caching API as of May 2026 (verified
      // docs.mistral.ai). The adapter is a no-op for cache primitives:
      // emit a structured `cache_skipped` log on every call so operators
      // can observe (or silence) the gap without runtime overhead, don't
      // pass any cache parameters, and don't extract cache fields. Flip
      // these flags when Mistral ships a caching primitive.
      skipCaching: true,
    },
  );
}

export function createGrokProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "xai",
    apiKey ?? process.env.XAI_API_KEY ?? "",
    "https://api.x.ai/v1",
    {
      // xAI Grok cache routing: the runtime uses the OpenAI-compatible
      // Chat Completions endpoint, where xAI takes the cache hint via the
      // `x-grok-conv-id` HTTP header (NOT the body field — body
      // `prompt_cache_key` is for Responses API only per docs.x.ai). When
      // the runtime gains Responses path support, also enable
      // `passPromptCacheKey: true` here.
      setGrokConvIdHeader: true,
      // Response shape mirrors OpenAI Chat Completions per research-notes
      // — `usage.prompt_tokens_details.cached_tokens`. Same extraction code
      // path as the openai factory.
      extractCachedTokens: true,
    },
  );
}

export function createGroqProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "groq",
    apiKey ?? process.env.GROQ_API_KEY ?? "",
    "https://api.groq.com/openai/v1",
    {
      // Groq caching is fully implicit (no parameter to pass). On the
      // openai/gpt-oss-* family + kimi-k2 only — other Groq models
      // (Llama / Qwen / compound) ignore the response field. Extracting is
      // harmless when fields are absent: the conditional preserves
      // promptTokens=gross when no cache hit. No request-side primitive
      // needed; the response shape mirrors OpenAI Chat Completions.
      extractCachedTokens: true,
      // No body field, no header — Groq routes implicitly on stable prefix.
    },
  );
}
