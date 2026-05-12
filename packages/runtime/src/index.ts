// @skrun-dev/runtime — Agent execution engine

// Adapter
export type { RuntimeAdapter } from "./adapter/adapter.js";
// State callbacks
export type { StateCallbacks } from "./adapter/local.js";
export { LocalAdapter } from "./adapter/local.js";
export type {
  DepsCacheClearResult,
  DepsCacheEntry,
  DepsCacheOptions,
  InstallFn,
} from "./cache/deps-cache.js";
// Script dependency cache
export { computeDepsHash, DepsCache } from "./cache/deps-cache.js";
export type { TTLCacheOptions } from "./cache/ttl-cache.js";
// Cache
export { TTLCache } from "./cache/ttl-cache.js";
export type { ScriptDepsInstallErrorDetails } from "./errors.js";
// Runtime-level typed errors
export { ScriptDepsInstallError } from "./errors.js";
export type { CollectOptions } from "./files/output-collector.js";
// Files
export { collectOutputFiles } from "./files/output-collector.js";
export { estimateCacheSavings, estimateCost } from "./llm/cost.js";
// LLM errors
export { LLMCapabilityError } from "./llm/errors.js";
export type { ProviderFileCache } from "./llm/file-cache.js";
// Provider file cache
export { fingerprintBytes, InMemoryProviderFileCache } from "./llm/file-cache.js";
export type { ResolveContext, SkrunPart } from "./llm/parts.js";
// Multimodal IR
export { INLINE_BASE64_MAX_BYTES, ResolveError, resolveInput } from "./llm/parts.js";
export type { LLMRouterResponse, ToolCallHandler } from "./llm/router.js";
// LLM
export { LLMRouter } from "./llm/router.js";
// Tool-choice IR
export type { ResolvedToolChoice } from "./llm/tool-choice.js";
export { resolveToolChoice } from "./llm/tool-choice.js";
export type { Logger } from "./logger.js";
// Logger
export { createLogger } from "./logger.js";
export { checkCost } from "./security/cost-checker.js";
export { isHostAllowed } from "./security/network.js";
// Security
export { parseTimeout, TimeoutError, withTimeout } from "./security/timeout.js";
export { McpToolProvider } from "./tools/mcp-provider.js";
export { ToolRegistry } from "./tools/registry.js";
// Script dependency installers — public registry allowlist + install fns
export {
  type CommandResult,
  type CommandRunner,
  execFileRunner,
  INSTALL_REGISTRY_ALLOWLIST,
  type InstallRegistryHost,
  installNode,
  installPython,
  type NodeManifest,
  NPM_REGISTRY_URL,
  PYPI_INDEX_URL,
  type PythonManifest,
  YARN_REGISTRY_URL,
} from "./tools/script-deps-installers.js";
export type { ResolvedDeps, ResolveOptions } from "./tools/script-deps-resolver.js";
// Script dependency resolver
export { resolveScriptDeps, ScriptDepsResolver } from "./tools/script-deps-resolver.js";
export type { ScriptToolProviderOptions } from "./tools/script-provider.js";
export { ScriptToolProvider } from "./tools/script-provider.js";
// Tools
export type { ToolDefinition, ToolProvider, ToolResult } from "./tools/types.js";
// Types
export type {
  FileInfo,
  LlmCompleteEvent,
  RunCompleteEvent,
  RunErrorEvent,
  RunEvent,
  RunRequest,
  RunResult,
  RunStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./types.js";

// Utils
export { CALLER_KEY_FIELDS, redactCallerKeys, redactSecretsFromString } from "./utils/redact.js";
