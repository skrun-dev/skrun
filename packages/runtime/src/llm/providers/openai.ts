import OpenAI from "openai";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;

  constructor(name: string, apiKey: string, baseURL?: string) {
    this.name = name;
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userMessage },
    ];

    // Tool results from previous iteration
    if (request.toolResults?.length) {
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: request.toolResults.map((tr) => ({
          id: tr.id ?? tr.name,
          type: "function" as const,
          function: { name: tr.name, arguments: "{}" },
        })),
      });
      // Add tool results
      for (const tr of request.toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.id ?? tr.name,
          content: tr.result,
        });
      }
    }

    // Map tools
    const tools: OpenAI.ChatCompletionTool[] | undefined = request.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
      tools,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";
    const toolCalls: ToolCallRequest[] = [];

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
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

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export function createOpenAIProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("openai", apiKey ?? process.env.OPENAI_API_KEY ?? "");
}

export function createMistralProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "mistral",
    apiKey ?? process.env.MISTRAL_API_KEY ?? "",
    "https://api.mistral.ai/v1",
  );
}

export function createGroqProvider(apiKey?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    "groq",
    apiKey ?? process.env.GROQ_API_KEY ?? "",
    "https://api.groq.com/openai/v1",
  );
}
