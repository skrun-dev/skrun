import { type FunctionDeclaration, GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

// Fields not supported by Gemini's function declaration schema
const UNSUPPORTED_SCHEMA_FIELDS = new Set(["additionalProperties", "$schema", "default"]);

/** Recursively strip fields that Gemini API doesn't accept in JSON schemas */
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

export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  private client: GoogleGenerativeAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenerativeAI(apiKey ?? process.env.GOOGLE_API_KEY ?? "");
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    // Map tools to function declarations — clean schemas for Gemini compatibility
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

    const contents = [];

    // User message
    contents.push({ role: "user", parts: [{ text: request.userMessage }] });

    // Tool results from previous iteration
    if (request.toolResults?.length) {
      // Model response with function calls (use original args if available)
      contents.push({
        role: "model",
        parts: request.toolResults.map((tr, i) => ({
          functionCall: { name: tr.name, args: request.toolCalls?.[i]?.args ?? {} },
        })),
      });
      // Function responses
      contents.push({
        role: "function" as const,
        parts: request.toolResults.map((tr) => ({
          functionResponse: { name: tr.name, response: { result: tr.result } },
        })),
      });
    }

    const result = await model.generateContent({
      contents,
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

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}
