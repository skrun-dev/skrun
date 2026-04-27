// @skrun-dev/runtime — Agent execution engine

// Types
export type {
  FileInfo,
  RunRequest,
  RunResult,
  RunEvent,
  RunStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  LlmCompleteEvent,
  RunCompleteEvent,
  RunErrorEvent,
} from "./types.js";

// Files
export { collectOutputFiles } from "./files/output-collector.js";
export type { CollectOptions } from "./files/output-collector.js";

// Adapter
export type { RuntimeAdapter } from "./adapter/adapter.js";
export { LocalAdapter } from "./adapter/local.js";

// LLM
export { LLMRouter } from "./llm/router.js";
export type { LLMRouterResponse, ToolCallHandler } from "./llm/router.js";
export { estimateCost } from "./llm/cost.js";

// Tools
export type { ToolDefinition, ToolResult, ToolProvider } from "./tools/types.js";
export { ToolRegistry } from "./tools/registry.js";
export { ScriptToolProvider } from "./tools/script-provider.js";
export { McpToolProvider } from "./tools/mcp-provider.js";

// State callbacks
export type { StateCallbacks } from "./adapter/local.js";

// Security
export { withTimeout, parseTimeout, TimeoutError } from "./security/timeout.js";
export { checkCost } from "./security/cost-checker.js";
export { isHostAllowed } from "./security/network.js";

// Logger
export { createLogger } from "./logger.js";
export type { Logger } from "./logger.js";

// Cache
export { TTLCache } from "./cache/ttl-cache.js";
export type { TTLCacheOptions } from "./cache/ttl-cache.js";

// Utils
export { redactCallerKeys, redactSecretsFromString, CALLER_KEY_FIELDS } from "./utils/redact.js";
