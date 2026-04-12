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

    // User message
    messages.push({ role: "user", content: request.userMessage });

    // Tool results from previous iteration
    if (request.toolResults?.length) {
      // Add assistant message with tool_use blocks, then user message with tool_result blocks
      const toolUseBlocks: Anthropic.ContentBlockParam[] = request.toolResults.map((tr) => ({
        type: "tool_use" as const,
        id: tr.id ?? tr.name,
        name: tr.name,
        input: {},
      }));
      messages.splice(messages.length - 1, 0, { role: "assistant", content: toolUseBlocks });

      const toolResultContent: Anthropic.ToolResultBlockParam[] = request.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.id ?? tr.name,
        content: tr.result,
      }));
      messages.push({ role: "user", content: toolResultContent });
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
