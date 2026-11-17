import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
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
  "errorFields",
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
  // The machines client's bounds and labels: what a caller budgets a creation
  // from, and the keys a machine is found by.
  "CREATE_DIRECT_RETRY_WAITS_MS",
  "createWorstCaseMs",
  "FLY_429_BACKOFF_MS",
  "FLY_429_MAX_RETRIES",
  "FLY_APP_ACTION_BURST",
  "FLY_APP_ACTION_RATE_PER_S",
  "FLY_RETRY_AFTER_CAP_MS",
  "POOL_LABEL_KEY",
  "RUN_LABEL_KEY",
  "SEARCH_READS",
  "SEARCH_SPACING_MS",
  "storageInfraHosts",
  // The rules a run's output files are held to, one definition for the local
  // engine, the cloud runner and the harness.
  "assertNoLinkInPath",
  "CollectRequestSchema",
  "CollectResponseSchema",
  "DEFAULT_OUTPUT_LIMITS",
  "isSafeOutputName",
  "OUTPUT_EXCLUSION_REASONS",
  "OUTPUT_MAX_COUNT_LIMIT",
  "OUTPUT_MAX_SIZE_BYTES_LIMIT",
  "OUTPUT_NAME_MAX_BYTES",
  "OutputLimitsSchema",
  "outputFileReadRange",
  "outputNameRefusal",
  "readOutputLimits",
  "reportedExclusions",
  "selectOutputFiles",
  "TOOL_RESPONSE_MAX_BYTES",
  "TOOL_RESULT_TRUNCATION_MARKER",
  "truncateToolResult",
  "walkAndSelectOutputFiles",
  "walkOutputFiles",
  // The bounds of a cloud run's outputs upload: its time, its error, and the
  // output bytes a process holds at once.
  "OUTPUT_BYTES_BUDGET",
  "OUTPUTS_UPLOAD_BUDGET_MS",
  "OutputBytesBudget",
  "OutputsUploadError",
  "processOutputBytesBudget",
  // The time a cloud run may spend acquiring its machine, and the margin a seat
  // keeps past its timeout — both derived from the bounds above.
  "acquisitionBudgetMs",
  "seatDeadlineMarginMs",
  // How long a run's machine may live: what the harness writes into it, and what
  // the sweep of the run machines and the operator's cleanup read back.
  "DEFAULT_RUN_TIMEOUT_MS",
  "declaredLifetimeMs",
  "MACHINE_LIFETIME_GRACE_MS",
  "MAX_TIMER_DELAY_MS",
  "machineLifetimeSeconds",
  "RUNNER_LIFETIME_ENV",
  "undeclaredLifetimeFallbackMs",
  // What the harness and the runner say to each other to prepare a run: the
  // bodies of /claim and /init, their answers, and a failed /init's body.
  "ClaimRequestSchema",
  "ClaimResultSchema",
  "InitErrorBodySchema",
  "InitRequestSchema",
  "InitResultSchema",
  // ...and to run a tool, and to tell a runner ready: the body of /tool, the
  // answer to /healthz.
  "HealthzResultSchema",
  "ToolRequestSchema",
  // How a failed /init is told — its step, what an MCP server answered, in a
  // body whose message is bounded — and judged, the run's own fault or not.
  "classifyInitFailure",
  "INIT_ERROR_MESSAGE_MAX_BYTES",
  "INIT_STAGES",
  "initErrorBody",
  "initErrorMessage",
  // What a pre-created machine measured of its infrastructure hosts, which a
  // runner reports in its answer to /init.
  "INFRA_HOSTS_CHECKS",
  "InitStepError",
  "initStageOf",
  "mcpFactsOf",
] as const;

/**
 * What the runner takes from the output rules: the walk and the selection it
 * answers a collect request with, the request's and the answer's shapes, the
 * default limits, the bytes it serves for one file and the refusal of a path
 * through a link, and the cut of a tool result.
 */
const OUTPUT_RULES_FOR_THE_RUNNER = [
  "assertNoLinkInPath",
  "CollectRequestSchema",
  "CollectResponseSchema",
  "DEFAULT_OUTPUT_LIMITS",
  "outputFileReadRange",
  "selectOutputFiles",
  "truncateToolResult",
  "walkAndSelectOutputFiles",
  "walkOutputFiles",
] as const;

/**
 * What the runner takes from the contract it shares with the harness: the
 * schemas it parses the bodies of /claim, /init and /tool with, and those of
 * its answers, /healthz's included; the steps a failed /init is told by, the
 * error it names its own steps with, what reads the step and an MCP server's
 * answer from an error, and the body it answers a failed /init with, its
 * message bounded; the words of the infrastructure check it reports.
 */
const RUNNER_CONTRACT_FOR_THE_RUNNER = [
  "ClaimRequestSchema",
  "ClaimResultSchema",
  "HealthzResultSchema",
  "INFRA_HOSTS_CHECKS",
  "INIT_ERROR_MESSAGE_MAX_BYTES",
  "INIT_STAGES",
  "InitErrorBodySchema",
  "InitRequestSchema",
  "InitResultSchema",
  "InitStepError",
  "initErrorBody",
  "initErrorMessage",
  "initStageOf",
  "mcpFactsOf",
  "ToolRequestSchema",
] as const;

/**
 * What the runner takes that the main entry does not expose: the download of
 * the bundle it initialises from — the harness never downloads one.
 */
const RUNNER_ONLY = ["downloadBundle"] as const;

/** Everything the slim entry is allowed to expose at runtime. */
const RUNNER_ENTRY_EXPORTS = [
  ...RUNNER_ONLY,
  "DepsCache",
  "McpToolProvider",
  "ScriptToolProvider",
  "authorizeRunnerRequest",
  "errorFields",
  "isRpcAuthorized",
  ...OUTPUT_RULES_FOR_THE_RUNNER,
  ...RUNNER_CONTRACT_FOR_THE_RUNNER,
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
    expect(runnerEntry.DepsCache).toBe(mainEntry.DepsCache);
    expect(runnerEntry.McpToolProvider).toBe(mainEntry.McpToolProvider);
    expect(runnerEntry.ScriptToolProvider).toBe(mainEntry.ScriptToolProvider);
    expect(runnerEntry.isRpcAuthorized).toBe(mainEntry.isRpcAuthorized);
    expect(runnerEntry.authorizeRunnerRequest).toBe(mainEntry.authorizeRunnerRequest);
    expect(runnerEntry.errorFields).toBe(mainEntry.errorFields);
    const runnerValues = new Map(Object.entries(runnerEntry));
    const mainValues = new Map(Object.entries(mainEntry));
    for (const name of [...OUTPUT_RULES_FOR_THE_RUNNER, ...RUNNER_CONTRACT_FOR_THE_RUNNER]) {
      expect(runnerValues.get(name), name).toBeDefined();
      expect(runnerValues.get(name), name).toBe(mainValues.get(name));
    }
  });
});

/**
 * The slim entry's import graph, read from the sources rather than from the
 * names it exports: every module a value import or re-export reaches from
 * `runner.ts`, followed through relative paths. A type-only import or export
 * (`import type`, `export type`) is erased at compile time and loads nothing,
 * so it is not followed; an import with inline `type` markers still loads its
 * module, so it is. Paths are compared relative to `src/`, with forward
 * slashes, so the check reads the same on every platform.
 */
const SRC_ROOT = import.meta.dirname;
const MODEL_SDKS = ["@anthropic-ai/sdk", "openai", "@google/generative-ai"];

interface ImportGraph {
  /** Each module reached, relative to `src/`, and the module that first reached it. */
  reachedFrom: Map<string, string | null>;
  /** Each package a reached module loads, and that module. */
  packages: Array<{ from: string; pkg: string }>;
}

function fromSrc(file: string): string {
  return relative(SRC_ROOT, file).split("\\").join("/");
}

/** The module specifiers a source loads when it runs. */
function loadedSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** The source a relative specifier names: `./x.js` is `./x.ts`, or a directory's `index.ts`. */
function resolveSource(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [
    target.replace(/\.js$/, ".ts"),
    `${target}.ts`,
    resolve(target, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${fromSrc(from)} imports ${specifier}, which names no source`);
}

function importGraph(entry: string): ImportGraph {
  const reachedFrom = new Map<string, string | null>([[fromSrc(entry), null]]);
  const packages: ImportGraph["packages"] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const specifier of loadedSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        const target = resolveSource(file, specifier);
        if (!reachedFrom.has(fromSrc(target))) {
          reachedFrom.set(fromSrc(target), fromSrc(file));
          queue.push(target);
        }
      } else if (!specifier.startsWith("node:")) {
        packages.push({ from: fromSrc(file), pkg: specifier });
      }
    }
  }
  return { reachedFrom, packages };
}

/** How the entry reaches `module`: `runner.ts → files/x.ts → …`. */
function chainTo(graph: ImportGraph, module: string): string {
  const chain = [module];
  for (let parent = graph.reachedFrom.get(module); parent; parent = graph.reachedFrom.get(parent)) {
    chain.unshift(parent);
  }
  return chain.join(" → ");
}

/** Every module under `llm/`, every router, every model SDK the graph reaches, with its chain. */
function forbiddenReaches(graph: ImportGraph): string[] {
  const findings: string[] = [];
  for (const module of graph.reachedFrom.keys()) {
    if (module.startsWith("llm/") || basename(module, ".ts") === "router") {
      findings.push(chainTo(graph, module));
    }
  }
  for (const { from, pkg } of graph.packages) {
    if (MODEL_SDKS.some((sdk) => pkg === sdk || pkg.startsWith(`${sdk}/`))) {
      findings.push(`${chainTo(graph, from)} → ${pkg}`);
    }
  }
  return findings;
}

describe("the slim runner entry's import graph", () => {
  it("reaches no module under llm/, no router, and no model SDK", () => {
    const graph = importGraph(resolve(SRC_ROOT, "runner.ts"));

    // The walk must see what the entry loads, or an empty walk would pass.
    expect([...graph.reachedFrom.keys()]).toEqual(
      expect.arrayContaining([
        "runner.ts",
        "files/bundle-download.ts",
        "files/output-rules.ts",
        "runner-contract.ts",
        "tools/script-provider.ts",
        "tools/mcp-provider.ts",
      ]),
    );
    expect(forbiddenReaches(graph)).toEqual([]);
  });

  it("finds them from the main entry, which loads the model router on purpose", () => {
    const findings = forbiddenReaches(importGraph(resolve(SRC_ROOT, "index.ts")));

    expect(findings).toEqual(expect.arrayContaining(["index.ts → llm/router.ts"]));
    expect(findings.some((finding) => finding.endsWith(" → @anthropic-ai/sdk"))).toBe(true);
  });
});
