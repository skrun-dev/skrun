import OpenAI, { toFile } from "openai";
import { createLogger } from "../../logger.js";
import { LLMCapabilityError, LLMHistoryError } from "../errors.js";
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

/**
 * A token count as an endpoint reported it, when it is one — a whole number,
 * not negative, within the numbers JavaScript holds exactly. Undefined when
 * the endpoint reported none, and when it reported anything else — a
 * fraction, a negative, a string —, whose field is then named in `invalid`.
 * A count too large for a run's record is bounded where the record is
 * written, not here.
 */
function reportedCount(value: unknown, field: string, invalid: string[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  invalid.push(field);
  return undefined;
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
 * An assistant message as it goes back, with the one field outside the Chat
 * Completions spec that it may carry (see `assistantMessageOf`).
 */
type AssistantTurn = OpenAI.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/**
 * The assistant message as Chat Completions accepts it back as input, by an
 * allowlist: its role; its content as returned (its text, or the list of
 * chunks a provider returns — Mistral puts its reasoning there, and asks for
 * it back); its function tool calls with their `arguments` in the string the
 * model wrote — never parsed and re-serialized; and `reasoning_content`, when
 * the response carries one (a string), exactly as returned. That field is not
 * in the Chat Completions spec: DeepSeek and Kimi return the model's reasoning
 * there, and refuse with a 400 a request with tools whose earlier assistant
 * turns do not carry it back. Every other field a response carries and a
 * request may refuse (refusal, annotations, audio, another provider's
 * extension) is left out.
 */
function assistantMessageOf(message: OpenAI.ChatCompletionMessage | undefined): AssistantTurn {
  const toolCalls = (message?.tool_calls ?? []).flatMap((tc) =>
    tc.type === "function"
      ? [
          {
            id: tc.id,
            type: "function" as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          },
        ]
      : [],
  );
  const reasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  return {
    role: "assistant",
    content: message?.content ?? null,
    ...(typeof reasoning === "string" && { reasoning_content: reasoning }),
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  };
}

/** Whether an assistant message carries text, content chunks or a call. */
function carriesSomething(message: OpenAI.ChatCompletionAssistantMessageParam): boolean {
  if (message.tool_calls?.length) return true;
  const content = message.content;
  return typeof content === "string" ? content.length > 0 : (content?.length ?? 0) > 0;
}

/**
 * Cache behavior config for the OpenAI-compatible factory variants.
 *
 * Each factory tunes one of the 3 cache-related dimensions independently:
 * - `passPromptCacheKey`: pass `prompt_cache_key` body field (OpenAI, Mistral; xAI Responses)
 * - `setGrokConvIdHeader`: set `x-grok-conv-id` HTTP header (xAI Chat Completions)
 * - `extractCachedTokens`: parse `prompt_tokens_details.cached_tokens` from response
 *
 * Defaults are deliberately conservative (no passing of cache_key, no header set,
 * but DO extract — extraction is harmless when fields are absent and gives free
 * cost-tracking accuracy on whatever the provider supports implicitly).
 */
export interface CacheBehavior {
  passPromptCacheKey?: boolean;
  setGrokConvIdHeader?: boolean;
  extractCachedTokens?: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private cacheBehavior: CacheBehavior;

  /**
   * `fetchImpl` overrides the SDK's transport. It exists for **one** caller:
   * `LLMRouter.createProvider`, when the endpoint is an agent-declared
   * `model.base_url` and therefore attacker-influenced — it passes the
   * connect-time SSRF guard so every resolved address is validated before the
   * socket opens. The four first-party factories below
   * serve fixed endpoints and deliberately leave it undefined, keeping the
   * SDK's own transport. Appended last so those four call sites are untouched.
   */
  constructor(
    name: string,
    apiKey: string,
    baseURL?: string,
    cacheBehavior?: CacheBehavior,
    fetchImpl?: typeof fetch,
  ) {
    this.name = name;
    this.client = new OpenAI({ apiKey, baseURL, ...(fetchImpl && { fetch: fetchImpl }) });
    this.cacheBehavior = cacheBehavior ?? { extractCachedTokens: true };
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const messages = await this.buildMessages(request);

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
    // variant opts in (OpenAI, Mistral, xAI Responses) and the router gave us
    // a hashed key; the `x-grok-conv-id` header for xAI Chat Completions.
    const requestOptions: { headers?: Record<string, string> } = {};
    let promptCacheKey: string | undefined;
    if (this.cacheBehavior.passPromptCacheKey && request.cacheKey) {
      promptCacheKey = request.cacheKey;
    }
    if (this.cacheBehavior.setGrokConvIdHeader && request.cacheKey) {
      requestOptions.headers = { "x-grok-conv-id": request.cacheKey };
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

    // Cache usage extraction. OpenAI / xAI / Groq / Mistral all share the
    // `usage.prompt_tokens_details.cached_tokens` shape on Chat Completions,
    // OR `usage.input_tokens_details.cached_tokens` on the Responses API
    // (verified May 2026). Try Chat shape first, fall back to Responses
    // shape — same field semantically.
    //
    // Apply gross→net normalization: OpenAI / xAI / Groq / Mistral report
    // `prompt_tokens` as GROSS (cached + uncached). Subtract cached portion
    // so the uniform `promptTokens` is the FULL-RATE residual.
    //
    // Each count is taken only when it is one — a whole number, not negative
    // (`reportedCount`): an endpoint an agent declares (`model.base_url`)
    // answers what it likes. Anything else counts nothing, and one line names
    // the fields.
    const invalid: string[] = [];
    const grossPromptTokens =
      reportedCount(response.usage?.prompt_tokens, "prompt_tokens", invalid) ?? 0;
    let cacheReadTokens: number | undefined;
    if (this.cacheBehavior.extractCachedTokens) {
      // Chat Completions native shape (current runtime usage).
      const chatCachedTokens = response.usage?.prompt_tokens_details?.cached_tokens;
      // Responses API shape — kept for forward-compat when the runtime adds
      // Responses path support. Field names differ (`input_tokens_details`).
      const responsesCachedTokens = (
        response.usage as { input_tokens_details?: { cached_tokens?: number } } | undefined
      )?.input_tokens_details?.cached_tokens;
      const cached = reportedCount(
        chatCachedTokens ?? responsesCachedTokens,
        "cached_tokens",
        invalid,
      );
      if (cached !== undefined && cached > 0) cacheReadTokens = cached;
    }
    const completionTokens =
      reportedCount(response.usage?.completion_tokens, "completion_tokens", invalid) ?? 0;
    if (invalid.length > 0) {
      log.warn(
        { event: "llm_usage_invalid", provider: this.name, fields: invalid },
        `${this.name} reported a usage that is not a token count; it counts nothing`,
      );
    }

    const promptTokens = Math.max(0, grossPromptTokens - (cacheReadTokens ?? 0));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      assistantTurn: { provider: this.name, content: assistantMessageOf(choice?.message) },
      usage: {
        promptTokens,
        completionTokens,
        ...(cacheReadTokens !== undefined && { cacheReadTokens }),
        // cacheWriteTokens stays undefined: this adapter reads no written
        // count. OpenAI bills a cache write at 1.25× input on GPT-6.1, GPT-6
        // and GPT-5.6 (its pricing page, noted in cost.ts); not modelled, the
        // written part is estimated at the input rate.
      },
    };
  }

  /**
   * The conversation as Chat Completions messages: the system prompt, the
   * input, then each entry of the history in order — an assistant message as
   * the model returned it, restricted when it was stored (`assistantMessageOf`:
   * its text, or its content chunks, its function calls with their
   * `arguments` in the model's own string, and the `reasoning_content` the
   * response carried, if any), the results of its calls as `tool`
   * messages paired by `tool_call_id`, a later user message. A user message
   * that follows a user message joins it, after its parts.
   *
   * An assistant message with neither text nor a call is left out: Chat
   * Completions requires one or the other, and such a turn carried nothing to
   * send back.
   *
   * Throws `LLMHistoryError` on a turn another provider produced — another
   * OpenAI-compatible one included: a turn goes back to the provider that
   * wrote it, whatever its shape.
   */
  private async buildMessages(
    request: LLMCallRequest,
  ): Promise<OpenAI.ChatCompletionMessageParam[]> {
    const input = await this.translateUserContent(request.userContent, request._fileCache);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: input },
    ];

    for (const entry of request.history ?? []) {
      switch (entry.kind) {
        case "assistant": {
          if (entry.turn.provider !== this.name) {
            throw new LLMHistoryError(this.name, entry.turn.provider);
          }
          const turn = entry.turn.content as OpenAI.ChatCompletionAssistantMessageParam;
          if (carriesSomething(turn)) messages.push(turn);
          break;
        }
        case "tool_results":
          for (const r of entry.results) {
            messages.push({ role: "tool", tool_call_id: r.id ?? r.name, content: r.result });
          }
          break;
        case "user": {
          const later = await this.translateUserContent(entry.parts, request._fileCache);
          const last = messages[messages.length - 1];
          if (last.role === "user" && Array.isArray(last.content)) {
            messages[messages.length - 1] = { role: "user", content: [...last.content, ...later] };
          } else {
            messages.push({ role: "user", content: later });
          }
          break;
        }
      }
    }

    return messages;
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
      // Mistral caches a repeated prompt prefix and bills the cached part at
      // a tenth of the input rate (models.dev and LiteLLM, 2026-10). Same
      // Chat Completions path as OpenAI: the
      // `prompt_cache_key` body field routes the run's calls to the same
      // cache, and `usage.prompt_tokens_details.cached_tokens` says how much
      // was read from it.
      passPromptCacheKey: true,
      extractCachedTokens: true,
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
