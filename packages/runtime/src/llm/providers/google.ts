import {
  FunctionCallingMode,
  type FunctionDeclaration,
  GoogleGenerativeAI,
  SchemaType,
  type ToolConfig,
} from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { createLogger } from "../../logger.js";
import { fingerprintBytes, type ProviderFileCache } from "../file-cache.js";
import type { SkrunPart } from "../parts.js";
import type { ResolvedToolChoice } from "../tool-choice.js";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

const PRE_UPLOAD_THRESHOLD_BYTES = 18 * 1024 * 1024;
const log = createLogger("llm:google");

/**
 * Translate the provider-agnostic ResolvedToolChoice IR into Gemini's
 * `toolConfig.functionCallingConfig` shape. Gemini natively supports the
 * subset case via `allowedFunctionNames`.
 *
 * Returns `undefined` for the default ({ mode: "auto" }) so the field is
 * omitted entirely.
 *
 * Note: Gemini has no native equivalent of `disable_parallel_tool_use` /
 * `parallel_tool_calls`. When `parallelTools === false`, log a structured
 * warning and let the request proceed (no-op).
 */
function buildToolConfig(
  toolChoice: ResolvedToolChoice | undefined,
  parallelTools: boolean | undefined,
): ToolConfig | undefined {
  if (parallelTools === false) {
    log.warn(
      {
        event: "provider_gap",
        provider: "google",
        gap: "parallel_tools_not_supported",
        fallback: "noop",
      },
      "Gemini does not natively support disabling parallel tool calls; parallel_tools:false is a no-op",
    );
  }
  if (!toolChoice || toolChoice.mode === "auto") {
    return undefined;
  }
  switch (toolChoice.mode) {
    case "none":
      return { functionCallingConfig: { mode: FunctionCallingMode.NONE } };
    case "required":
      return { functionCallingConfig: { mode: FunctionCallingMode.ANY } };
    case "specific":
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: [toolChoice.tool],
        },
      };
    case "subset":
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: toolChoice.tools,
        },
      };
  }
}

// Gemini's tool-declaration parser rejects a number of JSON Schema keywords
// that are valid elsewhere. Strip them on the way out — the underlying tool
// (npm/pnpm/Playwright MCP/etc.) keeps the original schema; we just hide
// the offending fields from Gemini.
//   - additionalProperties: long-standing Gemini restriction
//   - $schema / default: not part of Gemini's accepted draft
//   - propertyNames: surfaced by the Playwright MCP tool schemas — Gemini
//     returns a 400 with "Unknown name 'propertyNames'" when present.
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "additionalProperties",
  "$schema",
  "default",
  "propertyNames",
]);

function cleanSchema(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => cleanSchema(item));
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    cleaned[key] = cleanSchema(value);
  }
  return cleaned;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
}

export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  private client: GoogleGenerativeAI;
  private fileManager: GoogleAIFileManager;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.client = new GoogleGenerativeAI(key);
    this.fileManager = new GoogleAIFileManager(key);
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const userParts = await this.translateUserContent(request.userContent, request._fileCache);

    const functionDeclarations = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: cleanSchema({
        type: SchemaType.OBJECT,
        properties: (t.parameters as Record<string, unknown>).properties ?? {},
      }),
    })) as FunctionDeclaration[] | undefined;

    const model = this.client.getGenerativeModel({
      model: request.model,
      systemInstruction: request.systemPrompt,
      tools: functionDeclarations ? [{ functionDeclarations }] : undefined,
    });

    const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

    contents.push({ role: "user", parts: userParts });

    if (request.toolResults?.length) {
      contents.push({
        role: "model",
        parts: request.toolResults.map((tr, i) => ({
          functionCall: { name: tr.name, args: request.toolCalls?.[i]?.args ?? {} },
        })),
      });
      contents.push({
        role: "function",
        parts: request.toolResults.map((tr) => ({
          functionResponse: { name: tr.name, response: { result: tr.result } },
        })),
      });
    }

    const toolConfig = buildToolConfig(request.toolChoice, request.parallelTools);

    // SDK's Part type uses `?: never` discriminants — our broader GeminiPart
    // is structurally equivalent but TS treats them as incompatible.
    const result = await model.generateContent({
      // biome-ignore lint/suspicious/noExplicitAny: SDK type has overly-strict never discriminants
      contents: contents as any,
      ...(toolConfig !== undefined && { toolConfig }),
      generationConfig: {
        temperature: request.temperature,
      },
    });

    const response = result.response;
    const candidate = response.candidates?.[0];
    let content = "";
    const toolCalls: ToolCallRequest[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if ("text" in part && part.text) {
          content += part.text;
        } else if ("functionCall" in part && part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    const usage = response.usageMetadata;

    // Cache usage extraction. Gemini's usageMetadata.promptTokenCount is
    // GROSS (cached + uncached). The adapter computes
    // promptTokens = promptTokenCount - cachedContentTokenCount so the
    // uniform Usage shape always represents promptTokens as the FULL-RATE
    // residual. Gemini implicit caching is the default on 2.5+/3.x;
    // explicit Cache API integration is intentionally not wired here
    // (deferred to a future "managed cache" feature given the storage-
    // fee modeling complexity).
    const grossPromptTokens = usage?.promptTokenCount ?? 0;
    const cachedContentTokens = usage?.cachedContentTokenCount ?? 0;
    const promptTokens = Math.max(0, grossPromptTokens - cachedContentTokens);

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        ...(cachedContentTokens > 0 && { cacheReadTokens: cachedContentTokens }),
        // Gemini does not have a write surcharge (implicit caching is free
        // beyond the normal input bill). cacheWriteTokens stays undefined.
      },
    };
  }

  /**
   * Translate SkrunPart[] into Gemini parts.
   *
   * - text → {text}
   * - image/document/audio ≤ 18MB total → {inlineData: {mimeType, data}}
   * - image/document/audio > 18MB total → upload via Files API → {fileData: {fileUri, mimeType}}
   *
   * Gemini supports image, document (PDF), and audio natively — no LLMCapabilityError thrown here.
   */
  private async translateUserContent(
    parts: SkrunPart[],
    fileCache?: ProviderFileCache,
  ): Promise<GeminiPart[]> {
    const totalNonTextBytes = parts.reduce(
      (sum, p) => (p.kind === "text" ? sum : sum + p.bytes.length),
      0,
    );
    const usePreUpload = totalNonTextBytes > PRE_UPLOAD_THRESHOLD_BYTES;

    const out: GeminiPart[] = [];

    for (const part of parts) {
      if (part.kind === "text") {
        out.push({ text: part.text });
        continue;
      }

      if (usePreUpload) {
        const fileUri = await this.uploadOrCache(part, fileCache);
        out.push({ fileData: { fileUri, mimeType: part.media_type } });
      } else {
        out.push({
          inlineData: {
            mimeType: part.media_type,
            data: Buffer.from(part.bytes).toString("base64"),
          },
        });
      }
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

    const displayName = part.filename ?? `upload.${guessExt(part.media_type)}`;
    const result = await this.fileManager.uploadFile(Buffer.from(part.bytes), {
      mimeType: part.media_type,
      displayName,
    });
    fileCache?.set(this.name, fingerprint, result.file.uri);
    return result.file.uri;
  }
}

function guessExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return mime.slice(6);
  if (mime.startsWith("audio/")) return mime.slice(6);
  return "bin";
}
