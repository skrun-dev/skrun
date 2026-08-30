import { describe, expect, it } from "vitest";
import * as mainEntry from "./index.js";
import * as runnerEntry from "./runner.js";

/**
 * Guards the two contracts that make the slim runner entry safe.
 *
 * 1. The MAIN entry point must keep exporting everything it exported before the
 *    slim entry existed. Adding a subpath is additive by construction, but a
 *    later refactor could quietly move a symbol out of the barrel and break a
 *    consumer without any test noticing. The frozen list below is that alarm.
 *
 * 2. The SLIM entry must stay slim. Its whole purpose is to avoid loading the
 *    model SDKs in the sandbox; re-exporting one more symbol from the barrel
 *    would silently pull them back in and undo it.
 */

/** Public export surface of the main entry, captured 2026-08-07. Never shrink. */
const MAIN_ENTRY_EXPORTS = [
  "BundleFetchFailedError",
  "CALLER_KEY_FIELDS",
  "DepsCache",
  "FlyMachinesApi",
  "FlyioAdapter",
  "INLINE_BASE64_MAX_BYTES",
  "INSTALL_REGISTRY_ALLOWLIST",
  "InMemoryProviderFileCache",
  "LLMCapabilityError",
  "LLMRouter",
  "ListMachinesResponseSchema",
  "LocalAdapter",
  "MachineSchema",
  "MachineSpawnError",
  "McpConnectError",
  "McpToolProvider",
  "NPM_REGISTRY_URL",
  "NotSupportedError",
  "PYPI_INDEX_URL",
  "ResolveError",
  "RpcMcpToolProvider",
  "RpcScriptToolProvider",
  "RunnerPool",
  "ScriptDepsInstallError",
  "ScriptDepsResolver",
  "ScriptToolProvider",
  "SsrfBlockedError",
  "TTLCache",
  "TimeoutError",
  "ToolOomKilledError",
  "ToolRegistry",
  "YARN_REGISTRY_URL",
  "buildMachineConfig",
  "checkCost",
  "collectOutputFiles",
  "computeDepsHash",
  "createLogger",
  "estimateCacheSavings",
  "estimateCost",
  "execFileRunner",
  "fingerprintBytes",
  "installNode",
  "installPython",
  "isHostAllowed",
  "authorizeRunnerRequest",
  "isRpcAuthorized",
  "buildPoolMachineConfig",
  "machineNameForPool",
  "machineNameForRun",
  "POOL_MACHINE_NAME_PREFIX",
  "parseTimeout",
  "redactCallerKeys",
  "redactSecretsFromString",
  "resolveInput",
  "resolveScriptDeps",
  "resolveToolChoice",
  "safeFetch",
  "withTimeout",
] as const;

/** Everything the slim entry is allowed to expose at runtime. */
const RUNNER_ENTRY_EXPORTS = [
  "McpToolProvider",
  "ScriptToolProvider",
  "authorizeRunnerRequest",
  "isRpcAuthorized",
];

describe("main entry point", () => {
  it("still exports every symbol it exported before the slim entry was added", () => {
    const actual = new Set(Object.keys(mainEntry));
    const missing = MAIN_ENTRY_EXPORTS.filter((name) => !actual.has(name));
    expect(missing).toEqual([]);
  });
});

describe("slim runner entry point", () => {
  it("exposes exactly the values the sandbox runner needs", () => {
    expect(Object.keys(runnerEntry).sort()).toEqual([...RUNNER_ENTRY_EXPORTS].sort());
  });

  it("does not re-export the model router", () => {
    // The router is what drags in the Anthropic / OpenAI / Google SDKs. If it
    // ever appears here, the slim entry has stopped being slim.
    expect(runnerEntry).not.toHaveProperty("LLMRouter");
  });

  it("exposes the same implementations as the main entry", () => {
    // The slim entry is a narrower door onto the same modules, never a copy.
    // Divergence here would mean the sandbox runs different code from the
    // harness for the two most security-sensitive components.
    expect(runnerEntry.McpToolProvider).toBe(mainEntry.McpToolProvider);
    expect(runnerEntry.ScriptToolProvider).toBe(mainEntry.ScriptToolProvider);
    expect(runnerEntry.isRpcAuthorized).toBe(mainEntry.isRpcAuthorized);
    expect(runnerEntry.authorizeRunnerRequest).toBe(mainEntry.authorizeRunnerRequest);
  });
});
