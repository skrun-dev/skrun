import type { AgentConfig } from "@skrun-dev/schema";
import type { SkrunPart } from "./llm/parts.js";

export interface FileInfo {
  name: string;
  size: number;
  /**
   * Unified-namespace file_id (`fil_<32 hex>`) assigned at collection time.
   * Used by `GET /api/files/:id/content` for output retrieval.
   */
  file_id?: string;
}

export interface RunRequest {
  agentConfig: AgentConfig;
  skillContent: string;
  agentsMdContent?: string;
  input: Record<string, unknown>;
  runId: string;
  state?: Record<string, unknown>;
  /** Caller-provided LLM API keys (provider name → API key). Overrides server-side env keys. */
  callerKeys?: Record<string, string>;
  /** Resolved agent version (semver) actually being executed. Echoed in run_start and final results. */
  agent_version?: string;
  /** Directory where tool scripts can write output files. Set by the runtime. */
  outputDir?: string;
  /**
   * Resolved file-typed inputs as SkrunPart[] per field name. Set by the API
   * layer after validating + resolving wire-format file inputs (id/data/url).
   * Consumed by the adapter to build LLMCallRequest.userContent.
   */
  resolvedInputs?: Map<string, SkrunPart[]>;
  /**
   * Environment identifier for prompt-cache routing. Combined with agent
   * name + version to derive a stable cache key. Defaults to `"default"`
   * when the API doesn't have persistent environment records keyed by ID
   * — caching is then per (agent, version) only. Refine with a hash of the
   * environment override shape in a future feature for per-environment-shape
   * isolation.
   */
  environmentId?: string;
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
    /** Tokens served from provider-side cache. Optional — undefined when no cache activity. */
    cacheReadTokens?: number;
    /** Tokens written to provider-side cache. Anthropic only. Optional. */
    cacheWriteTokens?: number;
  };
  durationMs: number;
  error?: string;
  files?: FileInfo[];
}

// --- Streaming event types ---

interface BaseRunEvent {
  run_id: string;
  timestamp: string;
}

export interface RunStartEvent extends BaseRunEvent {
  type: "run_start";
  agent: string;
  /** Resolved version of the agent being executed. Fallback: "unknown" if the runtime is invoked outside the API (e.g., unit tests). */
  agent_version: string;
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
    /** Tokens served from provider-side cache. Snake_case wire format. */
    cache_read_tokens?: number;
    /** Tokens written to provider-side cache. Anthropic only. */
    cache_write_tokens?: number;
  };
  cost: { estimated: number };
  duration_ms: number;
  files: FileInfo[];
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
