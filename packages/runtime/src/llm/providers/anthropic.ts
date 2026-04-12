import Anthropic from "@anthropic-ai/sdk";
import type { LLMCallRequest, LLMCallResponse, LLMProvider, ToolCallRequest } from "./types.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    const messages: Anthropic.MessageParam[] = [];

    // Tool results from previous iteration — build conversation history:
    // [user(message), assistant(tool_use), user(tool_result)]
    if (request.toolResults?.length) {
      // Original user message
      messages.push({ role: "user", content: request.userMessage });

      // Assistant message with tool_use blocks (use original args if available)
      const toolUseBlocks: Anthropic.ContentBlockParam[] = request.toolResults.map((tr, i) => ({
        type: "tool_use" as const,
        id: tr.id ?? tr.name,
        name: tr.name,
        input: request.toolCalls?.[i]?.args ?? {},
      }));
      messages.push({ role: "assistant", content: toolUseBlocks });

      // User message with tool_result blocks
      const toolResultContent: Anthropic.ToolResultBlockParam[] = request.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.id ?? tr.name,
        content: tr.result,
      }));
      messages.push({ role: "user", content: toolResultContent });
    } else {
      // No tool results — simple user message
      messages.push({ role: "user", content: request.userMessage });
    }

    // Map tools
    const tools: Anthropic.Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages,
      tools,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    });

    // Parse response
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

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }
}
