/**
 * Slim entry point for the in-sandbox runner — `@skrun-dev/runtime/runner`.
 *
 * WHY THIS FILE EXISTS
 * The runner needs a handful of runtime values from this package. Taking them from
 * the main entry point pulls the whole barrel, which re-exports the model router and
 * therefore statically loads the Anthropic, OpenAI and Google SDKs. The runner can
 * never use those: the model loop runs in the harness, and the sandbox is given zero
 * model credentials by design. Loading them anyway dominated sandbox start-up time.
 *
 * TWO RULES THIS FILE MUST KEEP
 *
 * 1. Import the LEAF modules directly. Never reach through `./index.js` or
 *    `./adapter/flyio/index.js` — either barrel pulls the model SDKs straight back
 *    in and silently undoes the whole point of this file. (`isRpcAuthorized` is also
 *    exported by the flyio barrel; that is NOT the path to use here.)
 *
 * 2. Re-export types with `export type`, never as values. `verbatimModuleSyntax` is
 *    enabled, so type-only re-exports are erased at compile time — which is what
 *    keeps `./types.js` and its own transitive imports out of the emitted JavaScript.
 *
 * The main entry point is deliberately unchanged: everything it exported before is
 * still exported from the same place, so nothing that imports this package breaks.
 */

export type {
  RunnerAuthDecision,
  RunnerAuthState,
  RunnerCredentials,
} from "./adapter/flyio/rpc-auth.js";
export { authorizeRunnerRequest, isRpcAuthorized } from "./adapter/flyio/rpc-auth.js";
// The script dependencies' disk cache, a leaf module: the runner installs an
// agent's declared dependencies into it while it initialises.
export { DepsCache } from "./cache/deps-cache.js";
// The download of an agent's bundle, a leaf module: the runner fetches the
// bundle it initialises from with it, a failure typed by how it failed.
export type { DownloadBundleOptions } from "./files/bundle-download.js";
export { downloadBundle } from "./files/bundle-download.js";
// The rules a run's output files are held to, a leaf module: the runner walks
// and selects its outputs with them, serves each file within them — never
// through a link —, and cuts a tool result to fit its answer — the same
// definitions the harness applies.
export type {
  CollectResponse,
  OutputCandidate,
  OutputExclusionCounts,
  OutputFileReadRange,
  OutputLimits,
  OutputSelection,
} from "./files/output-rules.js";
export {
  assertNoLinkInPath,
  CollectRequestSchema,
  CollectResponseSchema,
  DEFAULT_OUTPUT_LIMITS,
  outputFileReadRange,
  selectOutputFiles,
  truncateToolResult,
  walkAndSelectOutputFiles,
  walkOutputFiles,
} from "./files/output-rules.js";
// What the harness and the runner say to each other to prepare a run and to
// run its tools, a leaf module: the runner parses the bodies of /claim, /init
// and /tool with these schemas and types its answers with them — /healthz's
// included, the same declarations the harness reads —, and tells a failed /init
// by its step and what an MCP server answered, in a body whose message is
// bounded.
export type {
  ClaimRequest,
  ClaimResult,
  HealthzResult,
  InfraHostsCheck,
  InitErrorBody,
  InitMcpFacts,
  InitRequest,
  InitResult,
  InitStage,
  RunnerNamedStage,
  ToolRequest,
} from "./runner-contract.js";
export {
  ClaimRequestSchema,
  ClaimResultSchema,
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
export { McpToolProvider } from "./tools/mcp-provider.js";
export { ScriptToolProvider } from "./tools/script-provider.js";
export type { ToolDefinition, ToolProvider, ToolResult } from "./tools/types.js";
// What a log line may say about an error, a leaf module: the runner logs a
// failure by its class and code, as the harness does.
export type { ErrorFields } from "./utils/error-fields.js";
export { errorFields } from "./utils/error-fields.js";
