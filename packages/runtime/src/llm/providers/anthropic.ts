import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createLogger } from "../../logger.js";
import { LLMCapabilityError, LLMHistoryError } from "../errors.js";
import { fingerprintBytes, type ProviderFileCache } from "../file-cache.js";
import { getCacheMinTokens, getMaxOutputTokens } from "../model-tables.js";
import type { SkrunPart } from "../parts.js";
import type { ResolvedToolChoice } from "../tool-choice.js";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

const ANTHROPIC_FILES_BETA = "files-api-2025-04-14";
/** Above this raw-bytes threshold of non-text parts, pre-upload via Files API. */
const PRE_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

/**
 * The most `max_tokens` this adapter sends: the model's output limit
 * (`getMaxOutputTokens`) when it is lower, this bound otherwise — and for a
 * model the table does not know. The API requires the field; a thinking
 * model's reasoning counts toward it, so a low value cuts the answer off.
 *
 * Kept under the SDK's own guard for a call that does not stream: past
 * 21 333 tokens it refuses the call ("Streaming is required for operations
 * that may take longer than 10 minutes"). Going further means streaming.
 */
const MAX_TOKENS_BOUND = 16_384;
const log = createLogger("llm:anthropic");

/**
 * Heuristic token estimator for prefix-size threshold check.
 *
 * Uses the length of `JSON.stringify(prefix)`, divided by 4 — the industry
 * rule-of-thumb of ~4 chars per token. Direction note: JSON serialization adds quotes,
 * braces, and escape chars beyond semantic content, so this heuristic
 * typically OVER-estimates true semantic tokens. That's the safe direction
 * for our purpose: we'll inject `cache_control` when marginally above
 * threshold even if true tokens are slightly below — Anthropic then processes
 * the request without caching, and no error is returned (Anthropic, "Prompt
 * caching" § Cache limitations): the point caches nothing and costs nothing.
 * The opposite direction (under-estimating) would cause silent missed-cache
 * scenarios. Do NOT replace with a more precise tokenizer that
 * under-estimates without re-evaluating this trade-off.
 *
 * Returning a true tokenizer (anthropic-tokenizer-typescript) is intentionally
 * deferred — adds a dependency for marginal accuracy gain on a threshold
 * decision where the safe error mode is over-estimation.
 *
 * A file sent inline is counted, never serialized. An image or a document
 * block travels with its file as a base64 string — the `data` of its
 * `source`, `{ type: "base64", media_type, data }`, the exact shape
 * `translateUserContent` builds — and base64 needs no escaping: serialized,
 * it adds its own length and two quotes. The estimate adds that length and
 * serializes the rest — the same number as serializing everything, without
 * copying the file into a JSON string, which would cost as much as the file
 * (inline up to `PRE_UPLOAD_THRESHOLD_BYTES`) at every turn of a tool loop,
 * the conversation's input included. Only that shape, under an image or a
 * document block, is counted so: any other `data` — a tool call's arguments
 * that happen to say `type: "base64"`, a text source — may need escaping, and
 * is serialized.
 *
 * Exported for its tests; the package's entry point does not re-export it.
 */
export function estimatePrefixTokens(prefix: unknown): number {
  let inlineChars = 0;
  const inlineSources = new WeakSet<object>();
  const json = JSON.stringify(prefix, function (this: unknown, key: string, value: unknown) {
    if (key === "source" && isMediaBlock(this) && isInlineSource(value)) {
      inlineSources.add(value);
    } else if (
      key === "data" &&
      typeof value === "string" &&
      typeof this === "object" &&
      this !== null &&
      inlineSources.has(this)
    ) {
      inlineChars += value.length;
      return "";
    }
    return value;
  });
  return Math.ceil((json.length + inlineChars) / 4);
}

/** Whether an object is an image or a document content block. */
function isMediaBlock(holder: unknown): boolean {
  if (typeof holder !== "object" || holder === null) return false;
  const type = (holder as { type?: unknown }).type;
  return type === "image" || type === "document";
}

/** Whether a block's source is the inline one: exactly `{ type: "base64", media_type, data }`. */
function isInlineSource(source: unknown): source is object {
  if (typeof source !== "object" || source === null) return false;
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown };
  return (
    s.type === "base64" &&
    typeof s.media_type === "string" &&
    typeof s.data === "string" &&
    Object.keys(source).length === 3
  );
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
    const { messages, usedFilesApi } = await this.buildMessages(request);

    const tools: Anthropic.Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const toolChoice = buildToolChoice(request.toolChoice, request.parallelTools);

    // Prompt caching: inject `cache_control: { type: "ephemeral" }` on the
    // LAST block of each stable-prefix when that prefix alone exceeds the
    // model's min-tokens threshold. The runtime auto-places up to 3 of
    // Anthropic's 4 allowed breakpoints (last `tools` block, last `system`
    // block, and the conversation's last message — below); the fourth stays
    // free for a future agent.yaml override.
    //
    // Per-prefix threshold check: each block is evaluated independently, on
    // its own estimate. A point on a prefix below the model's threshold
    // would cache nothing: Anthropic processes the request without caching,
    // and no error is returned (Anthropic, "Prompt caching" § Cache
    // limitations).
    //
    // Default TTL is 5m (omit `ttl` field → Anthropic default). The 1h
    // toggle is intentionally not exposed — see "Cost & caching" in
    // docs/concepts.md for the break-even reasoning.
    //
    // A third point goes on the conversation itself, when there is one to
    // grow: see `injectConversationCacheControl`.
    const cacheMinTokens = getCacheMinTokens(request.model);
    const cachedTools = injectToolsCacheControl(tools, cacheMinTokens);
    const cachedSystem = injectSystemCacheControl(request.systemPrompt, cacheMinTokens);
    const cachedMessages =
      (tools?.length ?? 0) > 0 || (request.history?.length ?? 0) > 0
        ? injectConversationCacheControl(messages, cachedTools, cachedSystem, cacheMinTokens)
        : messages;

    const baseParams = {
      model: request.model,
      max_tokens: Math.min(getMaxOutputTokens(request.model) ?? MAX_TOKENS_BOUND, MAX_TOKENS_BOUND),
      system: cachedSystem,
      messages: cachedMessages,
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
      // The whole `content` array, untouched: the thinking blocks and their
      // signatures must go back with the turn that carried them.
      assistantTurn: { provider: this.name, content: response.content },
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        ...(cacheReadTokens !== undefined && cacheReadTokens > 0 && { cacheReadTokens }),
        ...(cacheWriteTokens !== undefined && cacheWriteTokens > 0 && { cacheWriteTokens }),
      },
    };
  }

  /**
   * The conversation as Anthropic messages: the input, then each entry of the
   * history in order — an assistant turn exactly as the API returned it (its
   * thinking blocks and their signatures included: they go back with the turn
   * that carried them), the results of its tool calls as `tool_result` blocks
   * paired by `tool_use_id`, a later user message. A user message that follows
   * a user turn — tool results, or the input — joins it, after its blocks. An
   * assistant turn with no block is left out.
   *
   * Throws `LLMHistoryError` on a turn another provider produced.
   */
  private async buildMessages(
    request: LLMCallRequest,
  ): Promise<{ messages: Anthropic.MessageParam[]; usedFilesApi: boolean }> {
    const input = await this.translateUserContent(request.userContent, request._fileCache);
    let usedFilesApi = input.usedFilesApi;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.blocks }];

    for (const entry of request.history ?? []) {
      switch (entry.kind) {
        case "assistant": {
          if (entry.turn.provider !== this.name) {
            throw new LLMHistoryError(this.name, entry.turn.provider);
          }
          // An empty turn (Claude sometimes ends one with no block at all) is
          // left out: the API refuses an assistant message with no content
          // before the last one, and the turn carried nothing to send back.
          const blocks = entry.turn.content as Anthropic.ContentBlockParam[];
          if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
          break;
        }
        case "tool_results":
          messages.push({
            role: "user",
            content: entry.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id ?? r.name,
              content: r.result,
            })),
          });
          break;
        case "user": {
          const later = await this.translateUserContent(entry.parts, request._fileCache);
          usedFilesApi ||= later.usedFilesApi;
          const last = messages[messages.length - 1];
          if (last.role === "user" && Array.isArray(last.content)) {
            last.content = [...last.content, ...later.blocks];
          } else {
            messages.push({ role: "user", content: later.blocks });
          }
          break;
        }
      }
    }

    return { messages, usedFilesApi };
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
 * model's min-tokens threshold for prompt caching.
 *
 * Returns the tools array unmodified when:
 * - `tools` is undefined or empty (nothing to cache)
 * - estimated tokens < threshold (silent no-op below threshold; a point
 *   there would cache nothing — Anthropic processes the request without
 *   caching, and no error is returned)
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

/** Anthropic accepts at most this many `cache_control` points in one request. */
const MAX_CACHE_POINTS = 4;

/** The `cache_control` points a request already carries. */
function countCachePoints(
  tools: Anthropic.Tool[] | undefined,
  system: string | Array<Anthropic.TextBlockParam>,
  messages: Anthropic.MessageParam[],
): number {
  const marked = (blocks: ReadonlyArray<object>) =>
    blocks.filter((b) => "cache_control" in b && b.cache_control).length;
  return (
    marked(tools ?? []) +
    (Array.isArray(system) ? marked(system) : 0) +
    messages.reduce((n, m) => n + (Array.isArray(m.content) ? marked(m.content) : 0), 0)
  );
}

/**
 * The third cache point: `cache_control: { type: "ephemeral" }` on the last
 * block of the last message, so that the next turn of a tool loop reads the
 * whole conversation so far — every earlier turn and result — from the cache.
 * The caller places it only when the request declares tools or carries a
 * conversation: on a single call, the 1.25× write would have nothing to read
 * it back.
 *
 * Placed when the prefix up to that point — tools, system, messages — reaches
 * the model's threshold, when the request has a point left under Anthropic's
 * four, and when the last block can carry one (a thinking block cannot).
 *
 * Returns a NEW array whose last message and last block are copies: the other
 * messages are the conversation's stored turns, sent back exactly as the API
 * returned them, and they must stay so.
 */
function injectConversationCacheControl(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[] | undefined,
  system: string | Array<Anthropic.TextBlockParam>,
  minTokens: number,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  if (countCachePoints(tools, system, messages) >= MAX_CACHE_POINTS) return messages;
  if (estimatePrefixTokens([tools, system, messages]) < minTokens) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock || lastBlock.type === "thinking" || lastBlock.type === "redacted_thinking") {
    return messages;
  }
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [
        ...blocks.slice(0, -1),
        { ...lastBlock, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam,
      ],
    },
  ];
}

/**
 * Inject `cache_control: { type: "ephemeral" }` on the system block if and
 * only if the system content's own token estimate exceeds the model's
 * min-tokens threshold for prompt caching.
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
