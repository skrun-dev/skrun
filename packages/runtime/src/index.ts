// @skrun-dev/runtime — Agent execution engine

// Adapter
export type { RuntimeAdapter } from "./adapter/adapter.js";
// FlyioAdapter — cloud-runtime adapter
export type {
  AcquisitionBudgetInput,
  BuildMachineConfigInput,
  CreateMachineRequest,
  CreateProgress,
  FlyCallOptions,
  FlyDestroyOptions,
  FlyioAdapterOptions,
  FlyMachinesApiOptions,
  Machine,
  MachineConfig,
  MachineDestroyOutcome,
  MachineLifetimeInput,
  MachineState,
  OutputsUploadStep,
  PooledMachine,
  PooledMachineState,
  PresignedStorageAdapter,
  ReleaseOutputBytes,
  RpcToolProviderOptions,
} from "./adapter/flyio/index.js";
export {
  acquisitionBudgetMs,
  authorizeRunnerRequest,
  buildMachineConfig,
  buildPoolMachineConfig,
  CREATE_DIRECT_RETRY_WAITS_MS,
  createWorstCaseMs,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STARTED_ORPHAN_WINDOW_MS,
  declaredLifetimeEndMs,
  declaredLifetimeMs,
  FLY_429_BACKOFF_MS,
  FLY_429_MAX_RETRIES,
  FLY_APP_ACTION_BURST,
  FLY_APP_ACTION_RATE_PER_S,
  FLY_RETRY_AFTER_CAP_MS,
  FlyioAdapter,
  FlyMachinesApi,
  isRpcAuthorized,
  LIFETIME_END_KEY,
  ListMachinesResponseSchema,
  MACHINE_LIFETIME_GRACE_MS,
  MAX_TIMER_DELAY_MS,
  MachineSchema,
  machineLifetimeSeconds,
  machineNameForPool,
  machineNameForRun,
  OUTPUT_BYTES_BUDGET,
  OUTPUTS_UPLOAD_BUDGET_MS,
  OutputBytesBudget,
  OutputsUploadError,
  POOL_LABEL_KEY,
  POOL_MACHINE_NAME_PREFIX,
  processOutputBytesBudget,
  RpcMcpToolProvider,
  RpcScriptToolProvider,
  RUN_LABEL_KEY,
  RUN_OUTPUTS_PREFIX,
  RUNNER_LIFETIME_ENV,
  RunnerPool,
  runLabelOf,
  runOutputKey,
  runOutputsArchiveKey,
  SEARCH_READS,
  SEARCH_SPACING_MS,
  seatDeadlineMarginMs,
  storageInfraHosts,
  undeclaredLifetimeFallbackMs,
} from "./adapter/flyio/index.js";
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
export type {
  BundleFetchFailedErrorDetails,
  MachineSpawnErrorDetails,
  MachineSpawnPhase,
  McpConnectErrorDetails,
  ScriptDepsInstallErrorDetails,
  ToolOomKilledErrorDetails,
} from "./errors.js";
// Runtime-level typed errors
export {
  BundleFetchFailedError,
  MachineSpawnError,
  McpConnectError,
  NotSupportedError,
  ScriptDepsInstallError,
  ToolOomKilledError,
} from "./errors.js";
// Files
export { attachmentDisposition } from "./files/content-disposition.js";
export type { CollectOptions } from "./files/output-collector.js";
export { collectOutputFiles } from "./files/output-collector.js";
export type {
  CollectResponse,
  OutputCandidate,
  OutputExclusion,
  OutputExclusionCounts,
  OutputExclusionReason,
  OutputFileReadRange,
  OutputLimits,
  OutputNameRefusal,
  OutputSelection,
} from "./files/output-rules.js";
// The rules a run's output files are held to, one definition
export {
  assertNoLinkInPath,
  CollectRequestSchema,
  CollectResponseSchema,
  DEFAULT_OUTPUT_LIMITS,
  isSafeOutputName,
  OUTPUT_EXCLUSION_REASONS,
  OUTPUT_MAX_COUNT_LIMIT,
  OUTPUT_MAX_SIZE_BYTES_LIMIT,
  OUTPUT_NAME_MAX_BYTES,
  OutputLimitsSchema,
  outputFileReadRange,
  outputNameRefusal,
  readOutputLimits,
  reportedExclusions,
  selectOutputFiles,
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
  walkAndSelectOutputFiles,
  walkOutputFiles,
} from "./files/output-rules.js";
export { estimateCacheSavings, estimateCost } from "./llm/cost.js";
// LLM errors
export { LLMCapabilityError } from "./llm/errors.js";
export type { ProviderFileCache } from "./llm/file-cache.js";
// Provider file cache
export { fingerprintBytes, InMemoryProviderFileCache } from "./llm/file-cache.js";
export type { ResolveContext, SkrunPart } from "./llm/parts.js";
// Multimodal IR
export { INLINE_BASE64_MAX_BYTES, ResolveError, resolveInput } from "./llm/parts.js";
// The conversation a router call returns, opaque — continued by passing it back
export type { ConversationHistory } from "./llm/providers/types.js";
export type { LLMRouterOptions, LLMRouterResponse, ToolCallHandler } from "./llm/router.js";
// LLM — and the strict read of the failover delay, for the process that builds
// the run route's router (a malformed value refuses its start).
export { LLMRouter, readPrimaryFailoverMs } from "./llm/router.js";
// Tool-choice IR
export type { ResolvedToolChoice } from "./llm/tool-choice.js";
export { resolveToolChoice } from "./llm/tool-choice.js";
export type { Logger } from "./logger.js";
// Logger
export { createLogger } from "./logger.js";
// What the harness and the runner say to each other to prepare a run and to
// run its tools, and how a failed /init is told and judged
export type {
  ClaimRequest,
  ClaimResult,
  HealthzResult,
  InfraHostsCheck,
  InitErrorBody,
  InitMcpFacts,
  InitRequest,
  InitStage,
  RunnerNamedStage,
  ToolRequest,
} from "./runner-contract.js";
export {
  ClaimRequestSchema,
  ClaimResultSchema,
  classifyInitFailure,
  HealthzResultSchema,
  INFRA_HOSTS_CHECKS,
  INIT_ERROR_MESSAGE_MAX_BYTES,
  INIT_STAGES,
  InitErrorBodySchema,
  InitRequestSchema,
  InitResultSchema,
  InitStepError,
  initErrorBody,
  initErrorMessage,
  initStageOf,
  mcpFactsOf,
  ToolRequestSchema,
} from "./runner-contract.js";
export { BLOCKED_RANGES } from "./security/blocked-ranges.js";
export { checkCost } from "./security/cost-checker.js";
export { isHostAllowed, isPrivateHost } from "./security/network.js";
export type { PrivateResolution } from "./security/safe-fetch.js";
export { ResponseBodyTooLargeError, SsrfBlockedError, safeFetch } from "./security/safe-fetch.js";
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
  FileExclusionReason,
  FileInfo,
  FilesExcluded,
  InitResult,
  LlmCompleteEvent,
  OnRunnerSpawned,
  OnSpawnFailed,
  OutputValidationWarningEvent,
  RunCompleteEvent,
  RunErrorEvent,
  RunEvent,
  RunHeartbeatEvent,
  RunnerSpawnedEvent,
  RunnerSpawnedInfo,
  RunRequest,
  RunResult,
  RunStartEvent,
  SpawnPhases,
  ToolCallErrorEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./types.js";

// Utils
export { type ErrorFields, errorFields } from "./utils/error-fields.js";
// How deeply a run's output, and a run row's copy of its content, may nest — one bound
export { exceedsNestingDepth, MAX_JSON_NESTING_DEPTH } from "./utils/json-depth.js";
export { CALLER_KEY_FIELDS, redactCallerKeys, redactSecretsFromString } from "./utils/redact.js";
