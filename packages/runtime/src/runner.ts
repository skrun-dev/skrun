/**
 * Slim entry point for the in-sandbox runner — `@skrun-dev/runtime/runner`.
 *
 * WHY THIS FILE EXISTS
 * The runner needs exactly three runtime values from this package. Taking them from
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
export { McpToolProvider } from "./tools/mcp-provider.js";
export { ScriptToolProvider } from "./tools/script-provider.js";
export type { ToolDefinition, ToolProvider, ToolResult } from "./tools/types.js";
export type { InitResult } from "./types.js";
