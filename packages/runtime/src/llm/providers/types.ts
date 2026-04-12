export interface ToolDefinitionForLLM {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolCallResult {
  name: string;
  result: string;
  id?: string;
}

export interface LLMCallRequest {
  systemPrompt: string;
  userMessage: string;
  tools?: ToolDefinitionForLLM[];
  /** Original tool call requests from the previous LLM response (contains args) */
  toolCalls?: ToolCallRequest[];
  /** Tool execution results matching the toolCalls above */
  toolResults?: ToolCallResult[];
  temperature?: number;
  model: string;
}

export interface LLMCallResponse {
  content: string;
  toolCalls?: ToolCallRequest[];
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface LLMProvider {
  readonly name: string;
  call(request: LLMCallRequest): Promise<LLMCallResponse>;
}
