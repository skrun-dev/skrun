import type { AgentConfig } from "@skrun-dev/schema";

export interface RunRequest {
  agentConfig: AgentConfig;
  skillContent: string;
  agentsMdContent?: string;
  input: Record<string, unknown>;
  runId: string;
  state?: Record<string, unknown>;
  /** Caller-provided LLM API keys (provider name → API key). Overrides server-side env keys. */
  callerKeys?: Record<string, string>;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed";
  output: Record<string, unknown>;
  newState?: Record<string, unknown>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  durationMs: number;
  error?: string;
}

// --- Streaming event types ---

interface BaseRunEvent {
  run_id: string;
  timestamp: string;
}

export interface RunStartEvent extends BaseRunEvent {
  type: "run_start";
  agent: string;
}

export interface ToolCallEvent extends BaseRunEvent {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseRunEvent {
  type: "tool_result";
  tool: string;
  result: string;
  is_error: boolean;
}

export interface LlmCompleteEvent extends BaseRunEvent {
  type: "llm_complete";
  provider: string;
  model: string;
  tokens: number;
}

export interface RunCompleteEvent extends BaseRunEvent {
  type: "run_complete";
  output: Record<string, unknown>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost: { estimated: number };
  duration_ms: number;
}

export interface RunErrorEvent extends BaseRunEvent {
  type: "run_error";
  error: { code: string; message: string };
}

export type RunEvent =
  | RunStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | LlmCompleteEvent
  | RunCompleteEvent
  | RunErrorEvent;
