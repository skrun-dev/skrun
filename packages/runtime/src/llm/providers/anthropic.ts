import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createLogger } from "../../logger.js";
import { LLMCapabilityError } from "../errors.js";
import { fingerprintBytes, type ProviderFileCache } from "../file-cache.js";
import type { SkrunPart } from "../parts.js";
import type { ResolvedToolChoice } from "../tool-choice.js";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

const ANTHROPIC_FILES_BETA = "files-api-2025-04-14";
/** Above this raw-bytes threshold of non-text parts, pre-upload via Files API. */
const PRE_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
const log = createLogger("llm:anthropic");

/**
 * Per-model minimum-tokens threshold for prompt-caching.
 *
 * Anthropic silently no-ops `cache_control` injection on prefixes shorter than
 * the model's threshold. Setting `cache_control` below threshold pays the
 * 1.25× write surcharge with ZERO chance of a cache hit — strictly worse than
 * not injecting at all. The runtime evaluates each prefix (tools, system)
 * independently and only injects when that prefix's own token estimate
 * exceeds the threshold.
 *
 * Source: verified May 2026 against platform.claude.com docs.
 *
 * Default fallback for unmapped IDs is 1024 (the lowest of all current
 * Anthropic thresholds — safe over-injection rather than missed cache hits).
 */
const MODEL_CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-4-7": 4096,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-opus-4-1": 1024,
  "claude-opus-4": 1024,
  "claude-sonnet-4-6": 2048,
  "claude-sonnet-4-5": 1024,
  "claude-sonnet-4": 1024,
  "claude-3-7-sonnet": 1024,
  "claude-haiku-4-5": 4096,
  "claude-haiku-4": 4096,
  "claude-3-5-haiku": 2048,
  "claude-3-haiku": 2048,
};

const DEFAULT_CACHE_MIN_TOKENS = 1024;

/**
 * Look up the per-model min-tokens threshold via prefix match against
 * `MODEL_CACHE_MIN_TOKENS`. Mirrors the prefix-match pattern used by
 * `getModelCapabilities` for snapshot/dated model IDs (e.g.
 * `claude-opus-4-7-20260416` resolves to `claude-opus-4-7`).
 */
function getCacheMinTokens(model: string): number {
  if (model in MODEL_CACHE_MIN_TOKENS) return MODEL_CACHE_MIN_TOKENS[model];
  let bestMatch: { key: string; threshold: number } | undefined;
  for (const [key, threshold] of Object.entries(MODEL_CACHE_MIN_TOKENS)) {
    if (model.startsWith(`${key}-`) && (!bestMatch || key.length > bestMatch.key.length)) {
      bestMatch = { key, threshold };
    }
  }
  return bestMatch?.threshold ?? DEFAULT_CACHE_MIN_TOKENS;
}

/**
 * Heuristic token estimator for prefix-size threshold check.
 *
 * Uses `JSON.stringify(prefix).length / 4` — the industry rule-of-thumb of
 * ~4 chars per token. Direction note: JSON serialization adds quotes,
 * braces, and escape chars beyond semantic content, so this heuristic
 * typically OVER-estimates true semantic tokens. That's the safe direction
 * for our purpose: we'll inject `cache_control` when marginally above
 * threshold even if true tokens are slightly below, paying the 1.25× write
 * surcharge in rare borderline cases. The opposite direction (under-
 * estimating) would cause silent missed-cache scenarios. Do NOT replace
 * with a more precise tokenizer that under-estimates without re-evaluating
 * this trade-off.
 *
 * Returning a true tokenizer (anthropic-tokenizer-typescript) is intentionally
 * deferred — adds a dependency for marginal accuracy gain on a threshold
 * decision where the safe error mode is over-estimation.
 */
function estimatePrefixTokens(prefix: unknown): number {
  return Math.ceil(JSON.stringify(prefix).length / 4);
}

/**
 * Translate the provider-agnostic ResolvedToolChoice IR into Anthropic's
 * native `tool_choice` shape, with `disable_parallel_tool_use` for parallel
 * control. Returns `undefined` for the default ({ mode: "auto" } + no parallel
 * override) so the field is omitted from the request entirely.
 *
 * Subset-of-N is not natively supported by Anthropic; we soft-fallback to
 * `{ type: "any" }` (any declared tool fires) and log a structured warning.
 */
function buildToolChoice(
  toolChoice: ResolvedToolChoice | undefined,
  parallelTools: boolean | undefined,
): Anthropic.ToolChoice | undefined {
  const disableParallel = parallelTools === false ? { disable_parallel_tool_use: true } : {};
  if (!toolChoice || toolChoice.mode === "auto") {
    return parallelTools === false ? { type: "auto", ...disableParallel } : undefined;
  }
  switch (toolChoice.mode) {
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any", ...disableParallel };
    case "specific":
      return { type: "tool", name: toolChoice.tool, ...disableParallel };
    case "subset":
      log.warn(
        {
          event: "provider_gap",
          provider: "anthropic",
          gap: "subset_not_supported",
          fallback: "any",
          subset: toolChoice.tools,
        },
        "Anthropic does not natively support subset-of-N tool_choice; collapsing to {type:'any'} (any declared tool fires)",
      );
      return { type: "any", ...disableParallel };
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const { blocks, usedFilesApi } = await this.translateUserContent(
      request.userContent,
      request._fileCache,
    );

    const messages: Anthropic.MessageParam[] = [];

    if (request.toolResults?.length) {
      messages.push({ role: "user", content: blocks });

      const toolUseBlocks: Anthropic.ContentBlockParam[] = request.toolResults.map((tr, i) => ({
        type: "tool_use" as const,
        id: tr.id ?? tr.name,
        name: tr.name,
        input: request.toolCalls?.[i]?.args ?? {},
      }));
      messages.push({ role: "assistant", content: toolUseBlocks });

      const toolResultContent: Anthropic.ToolResultBlockParam[] = request.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.id ?? tr.name,
        content: tr.result,
      }));
      messages.push({ role: "user", content: toolResultContent });
    } else {
      messages.push({ role: "user", content: blocks });
    }

    const tools: Anthropic.Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const toolChoice = buildToolChoice(request.toolChoice, request.parallelTools);

    // Prompt caching: inject `cache_control: { type: "ephemeral" }` on the
    // LAST block of each stable-prefix when that prefix alone exceeds the
    // model's min-tokens threshold. The runtime auto-places 2 of Anthropic's
    // 4 allowed breakpoints (last `tools` block + last `system` block); the
    // remaining 2 are reserved for a future agent.yaml override.
    //
    // Per-prefix threshold check: combined check would pay 1.25× write
    // surcharge with zero hit potential when each prefix alone is below
    // threshold but their sum exceeds it. Each block is evaluated
    // independently.
    //
    // Default TTL is 5m (omit `ttl` field → Anthropic default). The 1h
    // toggle is intentionally not exposed — see "Cost & caching" in
    // docs/concepts.md for the break-even reasoning.
    const cacheMinTokens = getCacheMinTokens(request.model);
    const cachedTools = injectToolsCacheControl(tools, cacheMinTokens);
    const cachedSystem = injectSystemCacheControl(request.systemPrompt, cacheMinTokens);

    const baseParams = {
      model: request.model,
      max_tokens: 4096,
      system: cachedSystem,
      messages,
      tools: cachedTools,
      ...(toolChoice !== undefined && { tool_choice: toolChoice }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };

    // When file_id refs are in message blocks, the Files API beta header is required.
    // Inline base64 paths use the standard endpoint.
    const response = usedFilesApi
      ? await this.client.beta.messages.create({
          ...(baseParams as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
          betas: [ANTHROPIC_FILES_BETA],
        })
      : await this.client.messages.create(baseParams);

    let content = "";
    const toolCalls: ToolCallRequest[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          name: block.name,
          args: block.input as Record<string, unknown>,
          id: block.id,
        });
      }
    }

    // Cache usage extraction. Anthropic's native shape is already
    // non-overlapping: `input_tokens` is the post-breakpoint residual (full-rate
    // billed), `cache_read_input_tokens` is what we got from cache (0.10×
    // billed), `cache_creation_input_tokens` is what we wrote to cache
    // (1.25× / 2.0× billed). Map directly to the uniform Usage shape — no
    // gross→net subtraction needed for Anthropic.
    //
    // Both fields are optional in the Anthropic response: undefined when no
    // cache_control was set, or when cache was disabled / invalidated. We
    // only surface them when they're present and non-zero so the consumer
    // can treat undefined as "no cache activity."
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? undefined;
    const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? undefined;

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        ...(cacheReadTokens !== undefined && cacheReadTokens > 0 && { cacheReadTokens }),
        ...(cacheWriteTokens !== undefined && cacheWriteTokens > 0 && { cacheWriteTokens }),
      },
    };
  }

  /**
   * Translate SkrunPart[] into Anthropic content blocks. Pre-uploads non-text parts
   * via the Files API (beta) when their cumulative size exceeds the threshold;
   * otherwise embeds them as inline base64.
   *
   * Throws LLMCapabilityError for audio parts (Anthropic models don't accept audio).
   */
  private async translateUserContent(
    parts: SkrunPart[],
    fileCache?: ProviderFileCache,
  ): Promise<{
    blocks: Anthropic.ContentBlockParam[];
    usedFilesApi: boolean;
  }> {
    const totalNonTextBytes = parts.reduce(
      (sum, p) => (p.kind === "text" ? sum : sum + p.bytes.length),
      0,
    );
    const usePreUpload = totalNonTextBytes > PRE_UPLOAD_THRESHOLD_BYTES;

    const blocks: Anthropic.ContentBlockParam[] = [];

    for (const part of parts) {
      if (part.kind === "text") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }
      if (part.kind === "audio") {
        throw new LLMCapabilityError("anthropic", "(any)", "audio");
      }

      if (usePreUpload) {
        const fileId = await this.uploadOrCache(part, fileCache);
        blocks.push({
          type: part.kind,
          source: { type: "file", file_id: fileId },
        } as unknown as Anthropic.ContentBlockParam);
      } else {
        const data = Buffer.from(part.bytes).toString("base64");
        blocks.push({
          type: part.kind,
          source: {
            type: "base64",
            media_type: part.media_type,
            data,
          },
        } as Anthropic.ContentBlockParam);
      }
    }

    return { blocks, usedFilesApi: usePreUpload };
  }

  /**
   * Look up the provider file cache before uploading; populate after.
   * Within a single agent run's tool loop, repeated calls with the same bytes
   * upload only once.
   * TODO: when Files API graduates from beta, drop the beta header.
   */
  private async uploadOrCache(
    part: Exclude<SkrunPart, { kind: "text" }>,
    fileCache?: ProviderFileCache,
  ): Promise<string> {
    const fingerprint = fingerprintBytes(part.bytes);
    const cached = fileCache?.get(this.name, fingerprint);
    if (cached) return cached;

    const filename = part.filename ?? `upload.${guessExt(part.media_type)}`;
    const uploaded = await this.client.beta.files.upload(
      {
        file: await toFile(Buffer.from(part.bytes), filename, { type: part.media_type }),
      },
      { headers: { "anthropic-beta": ANTHROPIC_FILES_BETA } },
    );
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

/**
 * Inject `cache_control: { type: "ephemeral" }` on the LAST tool of the
 * tools array if and only if the array's own token estimate exceeds the
 * model's min-tokens threshold (#68 prompt-caching).
 *
 * Returns the tools array unmodified when:
 * - `tools` is undefined or empty (nothing to cache)
 * - estimated tokens < threshold (silent no-op below threshold; injecting
 *   would just pay the 1.25× write surcharge with no hit potential)
 *
 * Returns a NEW array with the last tool annotated otherwise. Does not
 * mutate the input.
 */
function injectToolsCacheControl(
  tools: Anthropic.Tool[] | undefined,
  minTokens: number,
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return tools;
  if (estimatePrefixTokens(tools) < minTokens) return tools;
  // Annotate the last tool. Spread + override to avoid mutating input.
  const lastIdx = tools.length - 1;
  const lastTool = tools[lastIdx];
  return [
    ...tools.slice(0, lastIdx),
    { ...lastTool, cache_control: { type: "ephemeral" } } as Anthropic.Tool,
  ];
}

/**
 * Inject `cache_control: { type: "ephemeral" }` on the system block if and
 * only if the system content's own token estimate exceeds the model's
 * min-tokens threshold (#68 prompt-caching).
 *
 * Anthropic accepts `system` as either a string or an array of TextBlockParam.
 * To attach `cache_control`, we MUST convert to the array form (the string
 * form has no field to annotate). When below threshold or empty, returns the
 * original string to preserve the simpler shape for the API call.
 */
function injectSystemCacheControl(
  systemPrompt: string,
  minTokens: number,
): string | Array<Anthropic.TextBlockParam> {
  if (!systemPrompt || systemPrompt.length === 0) return systemPrompt;
  if (estimatePrefixTokens(systemPrompt) < minTokens) return systemPrompt;
  return [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
}
