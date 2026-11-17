import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileInfo,
  Logger,
  RunErrorEvent,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
  SpawnPhases,
} from "@skrun-dev/runtime";
import {
  createLogger,
  estimateCacheSavings,
  exceedsNestingDepth,
  FlyioAdapter,
  isHostAllowed,
  LLMRouter,
  LocalAdapter,
  MAX_JSON_NESTING_DEPTH,
  MAX_TIMER_DELAY_MS,
  McpConnectError,
  McpToolProvider,
  parseTimeout,
  ResolveError,
  redactSecretsFromString,
  resolveInput,
  ScriptToolProvider,
  type SkrunPart,
  ToolRegistry,
  TTLCache,
} from "@skrun-dev/runtime";
import {
  type AgentConfig,
  BundleDecompressedTooLargeError,
  decompressedCapText,
  EnvironmentConfigSchema,
  type FileInputField,
  findRefusedSettings,
  findRetiredFields,
  runBodyInput,
  runDeclaredInputsRefusal,
  runInputTypeRefusal,
  sandboxHostForm,
  sandboxRefusalMessage,
  sandboxRefusedHosts,
} from "@skrun-dev/schema";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type BundleCacheEntry,
  type BundleConfigRead,
  bundleCache,
  configObject,
  getOrExtract,
  getOrReadManifests,
} from "../cache/bundle-cache.js";
import { depsCache } from "../cache/deps-cache.js";
import { getInputFile } from "../cache/input-cache.js";
import { holdOutputDir, OUTPUT_DIR_PREFIX, registerOutput } from "../cache/output-cache.js";
import { type DbAdapter, SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import type { Agent } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { type QuotaRefusal, runQuota } from "../quotas/admission.js";
import { parseQuotaEnv, type QuotaConfig } from "../quotas/thresholds.js";
import { runAcquisitionBounds } from "../runtime/acquisition-bounds.js";
import type { FlyioRuntimeDeps, RuntimeMode } from "../runtime/adapter-selection.js";
import {
  beginAdmission,
  type InFlightRun,
  isServerStopping,
  registerInFlightRun,
  trackBackgroundCleanup,
} from "../runtime/in-flight-runs.js";
import { assertAgentRunnableOrThrow } from "../services/access.js";
import { createStateCallbacks } from "../services/agent-state.js";
import { AgentYamlReaderError } from "../services/agent-yaml-reader.js";
import { decryptCreatorKeys } from "../services/creator-llm-key.js";
import {
  assertKeyScopeOrThrow,
  isInstanceAdmin,
  isMasterCredential,
  mayUseUpload,
  stateCaller,
} from "../services/key-scope.js";
import type { RegistryService } from "../services/registry.js";
import { RegistryError } from "../services/registry.js";
import type { KeyProvider } from "../services/secrets/key-provider.js";
import {
  isRunGatedByVerification,
  type VerificationPolicy,
} from "../services/verification-policy.js";
import { BundleWriteError } from "../utils/bundle.js";
import { errorFields } from "../utils/error-fields.js";
import { SEMVER_STRICT } from "../utils/semver.js";
import { formatSSEEvent } from "../utils/sse.js";
import {
  dispatchRegistryError,
  type FinalizeRunResult,
  failureToTell,
  finalEventFor,
  finalizeRun,
  RUN_DEADLINE_ERROR_CODE,
  SERVER_STOPPING_REFUSAL,
  SHUTDOWN_RUN_ERROR_CODE,
  stopVerdictOf,
} from "./_helpers.js";

const logger = createLogger("api");

/**
 * How long a streamed run's final event — `run_complete` or `run_error` —
 * waits for the write of the run's final status. The event follows the write:
 * a caller who reads it, then asks for the run or starts the next one, finds
 * this one finished. Past this wait the event goes anyway — a caller is never
 * held by a write that does not end — and the write goes on by itself: the run
 * settles once it has ended (`settleOnceWritten`). The waits between the
 * write's attempts (`FINAL_WRITE_RETRY_DELAYS_MS`, five seconds in all) fit
 * within this bound when the database refuses at once.
 */
export const FINAL_WRITE_WAIT_MS = 10_000;

/**
 * The error a run's row is given when the run ends by an exception instead of
 * a final event of its own: thrown by the adapter, out of the stream or the
 * background task, or after the row was written and before the run was handed
 * to either.
 */
const UNEXPECTED_END_ERROR = "The run ended unexpectedly.";

/**
 * What an input nested deeper than `MAX_JSON_NESTING_DEPTH` is told, refused
 * `400 INVALID_INPUT_TYPE` — the code of an input of the wrong shape. The bound
 * the agent loop holds an output to, and the row's copy any content to.
 */
const INPUT_TOO_DEEP = `Input nested more than ${MAX_JSON_NESTING_DEPTH} levels deep (the input itself is the first level; each object or array inside another is one more)`;

/**
 * What a synchronous request is told on the flyio runtime, refused
 * `400 SYNC_MODE_UNSUPPORTED`: that runtime serves a run through its event
 * stream or a webhook, never as one response. It names what works.
 */
const SYNC_MODE_REFUSAL =
  "This server's runtime does not run an agent synchronously: read the run's event stream instead — an HTTP request with the 'Accept: text/event-stream' header, skrun run, or the SDK's client.run() (both return the one-shot result) — or send a webhook_url to receive the result when the run ends.";

/**
 * Wait for a streamed run's final write, `FINAL_WRITE_WAIT_MS` at most, and
 * hand back what it resolved to. A write that rejects is a log line
 * (`run_completion_failed`, the error's class and code), a write still going
 * at the bound another (`final_write_slow`); either way the wait ends,
 * undefined, and the caller's event goes. The bound's timer is cleared however
 * the wait ends.
 */
async function waitForFinalWrite<T>(
  write: Promise<T>,
  log: Logger,
  runId: string,
  status: "completed" | "failed",
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<{ slow: true }>((resolve) => {
    timer = setTimeout(() => resolve({ slow: true }), FINAL_WRITE_WAIT_MS);
  });
  const settled = write.then(
    (value) => ({ value }),
    (err) => {
      log.error(
        { event: "run_completion_failed", run_id: runId, ...errorFields(err) },
        `Recording the run's ${status === "completed" ? "completion" : "failure"} failed; the run may remain in 'running' state`,
      );
      return { value: undefined };
    },
  );
  try {
    const outcome = await Promise.race([settled, bound]);
    if ("slow" in outcome) {
      log.warn(
        { event: "final_write_slow", run_id: runId, status, waited_ms: FINAL_WRITE_WAIT_MS },
        "The run's final status was not written in time; its final event goes without it",
      );
      return undefined;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Close a streamed run's adapter at its final event: its `finally` starts at
 * once — on the cloud runtime, the destruction of the run's machine —, before
 * the final event is written to a caller who may not be reading. Resolved
 * with what the adapter's end threw, if anything; never rejected, so that
 * nothing is left unhandled while the final event's write is waited on.
 */
function closeAdapter(events: AsyncGenerator<RunEvent>): Promise<{ error: unknown } | null> {
  return events.return(undefined).then(
    () => null,
    (error: unknown) => ({ error }),
  );
}

/**
 * A run's events, as its adapter streams them — read through here and nowhere
 * else, by both readings of the route, the stream and the background task. On
 * `runner_spawned`, the run's machine ready, `onSpawned` is handed the event's
 * phases before the event goes on: it is called before the caller can read
 * the event, and before the adapter resumes past it. A write it starts
 * without waiting may land after — on Postgres the give-back's `UPDATE` can
 * still be in flight when the caller reads the event; only a store whose
 * write is done when called (in memory, SQLite) has it done by then.
 * `onSpawned` must not throw — the adapter is suspended at that event, and
 * an exception here would close it there. A `return()` — `closeAdapter`'s —
 * reaches the adapter's own generator through the `for await`: its `finally`,
 * the cloud one destroying the run's machine, starts as it always did.
 */
async function* engineEvents(
  adapter: RuntimeAdapter,
  request: RunRequest,
  onSpawned: (phases: SpawnPhases) => void,
): AsyncGenerator<RunEvent> {
  for await (const event of adapter.executeStream(request)) {
    if (event.type === "runner_spawned") onSpawned(event.phases);
    yield event;
  }
}

/**
 * Settle a streamed run once its final write has ended — at once when none was
 * begun. The write may go on past the bound its final event waits for
 * (`FINAL_WRITE_WAIT_MS`), its attempts spaced by seconds
 * (`FINAL_WRITE_RETRY_DELAYS_MS`): a run settles only once its final status is
 * written or given up on, and the server's stop waits for the runs to settle,
 * within its grace. The stream itself does not wait: it ends after the final
 * event, as it always did.
 */
function settleOnceWritten(claim: { settle(): void }, write: Promise<unknown> | undefined): void {
  if (write === undefined) {
    claim.settle();
    return;
  }
  const settle = () => claim.settle();
  void write.then(settle, settle);
}

/**
 * The answer to a run sent once the server's stop has begun: refused before
 * anything of it is written — no row, nothing run —, `503` under the stop's
 * code, and its connection closed. The server's close takes no new connection,
 * but one kept alive across the signal still carries requests; this one
 * carries no more.
 */
function refusedWhileStopping(c: Context): Response {
  c.header("Connection", "close");
  return c.json(
    { error: { code: SHUTDOWN_RUN_ERROR_CODE, message: SERVER_STOPPING_REFUSAL } },
    503,
  );
}

/**
 * The answer to a run its account or the instance has no room for — at the
 * pre-check or at the admission: its status, code and message, `Retry-After`,
 * and the account's numbers when the credential may be told them
 * (quotas/admission.ts). Nothing of the run is written.
 */
function quotaRefused(c: Context, refusal: QuotaRefusal): Response {
  return c.json(
    { error: { code: refusal.code, message: refusal.message } },
    refusal.status,
    refusal.headers,
  );
}

/**
 * The timeout a version's recorded configuration declares, in seconds — null
 * when it records none in the `"Ns"` form (a version pushed while its
 * `agent.yaml` could not be read keeps no configuration).
 */
function snapshotTimeoutS(snapshot: Record<string, unknown> | undefined): number | null {
  const environment = snapshot?.environment as { timeout?: unknown } | undefined;
  const timeout = environment?.timeout;
  if (typeof timeout !== "string") return null;
  const match = /^(\d+)s$/.exec(timeout);
  return match ? Number(match[1]) : null;
}

/**
 * What a run is told, refused `422 BUNDLE_DECOMPRESSED_TOO_LARGE`: the stored
 * version of its agent decompresses to more than this server now unpacks. The
 * caller may not be its creator, so it says who can act — the creator, by
 * pushing a smaller version; the operator, by raising the setting. The decoder
 * stops at the cap: the size is told as more than the cap, rounded down.
 */
function runDecompressedTooLarge(agent: string, version: string, maxBytes: number): string {
  return `Agent ${agent} version ${version} decompresses to more than ${decompressedCapText(maxBytes)}, the most this server now unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Its creator can push a smaller version — leaving out the files the agent does not need when it runs —, or the server's operator raise BUNDLE_MAX_DECOMPRESSED_MB.`;
}

/**
 * The message of a run refused for want of a model key — for its primary
 * model, and for its fallback when it has one (neither found a key, or the run
 * would not be refused). Each provider is named once: a fallback on the
 * primary's provider is not a second one. It names what the caller can do —
 * the way the route lets through — then the server's own settings, last, as
 * what they are: the operator's.
 *
 * The caller's way: under `creator_only`, none — the header would be refused
 * with 403 CALLER_KEY_NOT_ALLOWED. Under a declared `model.base_url`, for a
 * caller the endpoint gate does not exempt, a key for the primary model's
 * provider only together with that endpoint's origin in X-LLM-Base-URL:
 * without it, that key is refused with 403 CALLER_BASE_URL_NOT_CONSENTED. It is
 * the one key sent there — a fallback on the same provider uses it too. A key
 * for a fallback on another provider goes to that provider, never to the
 * endpoint, and needs none named — nor may one be: an origin named for any
 * provider but the primary's is refused, and one named for the primary's
 * provider must be the endpoint's (endpointConsentRefusal).
 *
 * A primary model on meta with no `model.base_url` — a version published
 * before the push refused one — is served by no key: the message says what
 * would serve it, then, of a fallback with no key, the sentence that says so
 * and the ways to serve it — never a key for the primary. A meta fallback
 * with no base_url, which no key serves either, is not spoken of at all: the
 * message reads as for an agent with no fallback.
 */
function llmKeyRequiredMessage(
  agent: string,
  model: { provider: string; base_url?: string; fallback?: { provider: string } },
  keys: ReturnType<LLMRouter["checkModelKeys"]>,
  caller: { keysAllowed: boolean; mustNameEndpoint: boolean },
): string {
  const { provider } = model;
  const primaryRefusal = "refused" in keys.primary ? keys.primary.refused : undefined;
  const baseUrlRefused = primaryRefusal === "base-url-needs-own-key";
  const noKeyServes = primaryRefusal === "meta-needs-base-url";
  // A fallback no key serves is left out: nothing said of it could serve the run.
  const fallback =
    keys.fallback && "refused" in keys.fallback && keys.fallback.refused === "meta-needs-base-url"
      ? undefined
      : model.fallback;
  const sameProvider = fallback?.provider === provider;
  // The fallback in a sentence of its own: the server holds no key for it
  // either, it does not hold one back.
  const fallbackOnItsOwn = sameProvider
    ? " No model key is available for its fallback model, on the same provider, either."
    : ` No model key is available for "${fallback?.provider}", the provider of its ` +
      "fallback model, either.";
  let problem: string;
  if (noKeyServes) {
    problem =
      "This agent's model is meta, which has no endpoint of its own, and this version " +
      "declares no model.base_url: no key can serve it. Set model.base_url to the " +
      "OpenAI-compatible endpoint that serves the model, then publish a new version.";
    if (fallback) problem += fallbackOnItsOwn;
  } else if (baseUrlRefused) {
    problem =
      `This agent sends its model requests for provider "${provider}" to its own endpoint ` +
      "(model.base_url), and this server does not send its own key there.";
    if (fallback) problem += fallbackOnItsOwn;
  } else {
    problem = `No model key is available for provider "${provider}"`;
    if (fallback) {
      problem += sameProvider
        ? ", which its fallback model uses too."
        : `, nor for "${fallback.provider}", the provider of its fallback model.`;
    } else {
      problem += ".";
    }
  }
  const ownerWayFor = (name: string) =>
    `ask the agent's owner to attach one (skrun llm-key set ${name} --agent ${agent})`;
  const ownerWay = ownerWayFor(provider);
  const forWhich = fallback && !sameProvider ? "either" : "it";
  let callerWays: string | undefined;
  if (noKeyServes) {
    // Only the fallback can serve the run: its ways alone. None names an
    // endpoint — the agent declares none.
    if (fallback) {
      callerWays = caller.keysAllowed
        ? `Send a key for "${fallback.provider}" in the X-LLM-API-Key header, e.g. ` +
          `{"${fallback.provider}": "<key>"}, or ${ownerWayFor(fallback.provider)}.`
        : `This agent runs on its owner's keys only: ${ownerWayFor(fallback.provider)}.`;
    }
  } else if (!caller.keysAllowed) {
    callerWays = `This agent runs on its owner's keys only: ${ownerWay}.`;
  } else if (caller.mustNameEndpoint) {
    callerWays =
      `To send a key of your own for "${provider}" in the X-LLM-API-Key header, name this ` +
      `agent's endpoint in the X-LLM-Base-URL header beside it, e.g. {"${provider}": ` +
      `"${originOf(model.base_url)}"}: without it, that key is refused.`;
    if (fallback && !sameProvider) {
      callerWays +=
        ` A key for "${fallback.provider}", the provider of its fallback model, needs no ` +
        "endpoint named, and naming one for it is refused: it goes to that provider, never " +
        "to this endpoint.";
    }
    callerWays += ` Or ${ownerWay}.`;
  } else {
    callerWays =
      `Send a key for ${forWhich} in the X-LLM-API-Key header, e.g. {"${provider}": "<key>"}, ` +
      `or ${ownerWay}.`;
  }
  const operatorWays: string[] = [];
  if (baseUrlRefused) {
    operatorWays.push(
      "An operator whose agents are all their own can allow the server's key there " +
        "(SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true).",
    );
  }
  // The fallback is never sent to the agent's endpoint: a server key serves it.
  const serverKeys = [
    ...new Set([
      ...(baseUrlRefused || noKeyServes ? [] : [provider]),
      ...(fallback ? [fallback.provider] : []),
    ]),
  ].map((name) => `${name.toUpperCase()}_API_KEY`);
  if (serverKeys.length > 0) {
    operatorWays.push(
      `An operator can ${operatorWays.length > 0 ? "also" : "instead"} give this server ` +
        `its own key (${serverKeys.join(" or ")}).`,
    );
  }
  return [problem, ...(callerWays ? [callerWays] : []), ...operatorWays].join(" ");
}

/** The origin of an agent-declared endpoint, as a caller names it in X-LLM-Base-URL. */
function originOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return "<its endpoint's origin>";
  }
}

/**
 * Why the endpoint gate (5b) refuses a caller it does not exempt — the message
 * of its 403 — or `undefined` when it lets them through. Two rules:
 *
 * (i) Every origin the caller names in X-LLM-Base-URL must be where that
 * provider's key goes for this agent: for the primary model's provider under a
 * declared `base_url`, that endpoint's origin; for any other provider — the
 * fallback's, or one the agent does not use — none, as the agent declares no
 * endpoint for it (the schema keeps `base_url` off the fallback); and on an
 * agent with no `base_url`, none for any provider. A wrong declaration is the
 * caller mistaken about where a key of theirs goes, whatever keys are sent.
 *
 * (ii) Under a declared `base_url`, a key for the primary model's provider
 * needs that origin named: it is the only key the router sends there. The
 * fallback is called without `base_url`, at its provider's default endpoint —
 * a key for a fallback on another provider never reaches the agent's endpoint,
 * so it alone, with no origin named, is no reason to refuse. A fallback on the
 * primary's provider uses that very key. A key counts as sent once the header
 * names the provider, empty or not: the gate never reads less than the router
 * sends.
 *
 * Origins, not exact strings: legitimate paths differ ("/v1" vs
 * "/api/paas/v4/") and the exfiltration risk is the host. Both headers are
 * parsed before this is called: each value is a URL.
 */
function endpointConsentRefusal(
  model: { provider: string; base_url?: string; fallback?: { provider: string } },
  keys: Record<string, string> | undefined,
  baseUrls: Record<string, string> | undefined,
): string | undefined {
  const { provider } = model;
  const declaredOrigin = model.base_url ? new URL(model.base_url).origin : undefined;
  const sendsPrimaryKey = keys !== undefined && Object.hasOwn(keys, provider);
  const theEntry = `{"${provider}": "${declaredOrigin}"}`;
  const keyWouldGoThere =
    `This agent sends model requests to ${declaredOrigin}, which you did not choose. ` +
    "Your X-LLM-API-Key would be sent there. To proceed, declare that origin in the " +
    `X-LLM-Base-URL header, e.g. ${theEntry}.`;
  // (i) Every entry, in the order the caller wrote them.
  for (const [named, url] of Object.entries(baseUrls ?? {})) {
    const namedOrigin = new URL(url).origin;
    const used = named === provider || named === model.fallback?.provider;
    if (declaredOrigin === undefined) {
      return (
        `You declared ${namedOrigin} for "${named}" in the X-LLM-Base-URL header, but this ` +
        "agent does not use a custom endpoint: " +
        (used
          ? `its model requests for "${named}" go to that provider's default endpoint.`
          : `it sends no model request to "${named}".`) +
        " Omit the header to proceed."
      );
    }
    if (named !== provider) {
      return (
        `You declared ${namedOrigin} for "${named}" in the X-LLM-Base-URL header, but this ` +
        `agent declares no endpoint for "${named}": ` +
        (used
          ? `its fallback model is called at that provider's default endpoint.`
          : `it sends no model request to "${named}".`) +
        ` Leave "${named}" out of that header: the one entry this agent takes there is ${theEntry}.`
      );
    }
    if (namedOrigin === declaredOrigin) continue;
    return sendsPrimaryKey
      ? `${keyWouldGoThere} You declared ${namedOrigin}, which does not match.`
      : // No key of this caller's would go to the endpoint: say the origin
        // named is not the agent's, and which is.
        `You declared ${namedOrigin} for "${provider}" in the X-LLM-Base-URL header, but this ` +
          `agent sends its primary model's requests to ${declaredOrigin}. To proceed, declare ` +
          `that origin instead, e.g. ${theEntry}, or leave "${provider}" out of that header: ` +
          "you send no key for it, so none would go there.";
  }
  // (ii) The key that would go to the endpoint, with no origin named for it.
  if (declaredOrigin !== undefined && sendsPrimaryKey && !Object.hasOwn(baseUrls ?? {}, provider)) {
    return keyWouldGoThere;
  }
  return undefined;
}

// MCP connection cache — reuse connected providers across runs
const DEFAULT_MCP_TTL_S = 600;
const DEFAULT_MCP_MAX = 20;
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}
const mcpCache = new TTLCache<string, McpToolProvider>({
  ttlMs: readEnvInt("MCP_CACHE_TTL", DEFAULT_MCP_TTL_S) * 1000,
  maxEntries: readEnvInt("MCP_CACHE_MAX", DEFAULT_MCP_MAX),
  onEvict: (_key, provider) => {
    provider.disconnect().catch(() => {});
  },
});

function hintForBadVersion(raw: string): string {
  if (raw === "") return ". An empty string is not accepted — omit the field to target latest.";
  if (raw === "latest" || raw === "HEAD") {
    return `. The "${raw}" keyword is not supported — omit the field to target latest.`;
  }
  if (/[\^~*]/.test(raw)) {
    return '. Semver ranges (^, ~, *) are not supported — pass an exact version like "1.0.0".';
  }
  return "";
}

export interface CreateRunRoutesOptions {
  /** Default `"local"`. `"flyio"` switches each run to a Fly.io sandbox machine. */
  runtimeMode?: RuntimeMode;
  /** Required when `runtimeMode === "flyio"`. Constructed at startup by `buildFlyioDeps`. */
  flyioDeps?: FlyioRuntimeDeps;
  /** Operator verification policy. Default `"admin"` (legacy gate) when unset. */
  verificationPolicy?: VerificationPolicy;
  /**
   * Encryption provider for creator-attached LLM keys, built once at startup via
   * `getKeyProvider()` (the boot interlock). Used at run time to decrypt an
   * agent's creator keys harness-side. When omitted (or unconfigured), no creator
   * key is resolved and resolution falls back to caller > server.
   */
  keyProvider?: KeyProvider;
  /**
   * The per-plan quota settings, read once at startup by `createApp`
   * (`readQuotaConfig`): the run's admission takes an account's thresholds
   * from them.
   */
  quotaConfig?: QuotaConfig;
  /**
   * How long one call of a primary model may go unanswered before a declared
   * fallback takes over, while no tool of the run has been called: read once
   * at startup by `createApp` (`readPrimaryFailoverMs`, which refuses a
   * malformed SKRUN_PRIMARY_FAILOVER_MS). Omitted: the router's own default.
   */
  primaryFailoverMs?: number;
}

/**
 * Build the per-run ToolRegistry for the active runtime mode.
 *
 * - LocalAdapter path: instantiates real `ScriptToolProvider` (from the
 *   extracted bundle dir on disk) + per-MCP-server `McpToolProvider`
 *   (cached across runs by config key). Throws `McpConnectError` on
 *   handshake failure; the route layer surfaces 502.
 * - FlyioAdapter path: returns an EMPTY registry. The cloud adapter
 *   builds its own per-request registry post-spawn from the runner's
 *   `/init` response (script tools + MCP tools live in the sandbox, not
 *   the harness). Passing an empty registry preserves the constructor
 *   contract until a future refactor splits the ctor.
 */
async function buildToolRegistryForAdapter(
  runtimeMode: RuntimeMode,
  agentConfig: import("@skrun-dev/schema").AgentConfig,
  bundleDir: string,
  allowedHosts: string[],
  runOutputDir: string,
): Promise<ToolRegistry> {
  const toolRegistry = new ToolRegistry();
  if (runtimeMode === "flyio") {
    return toolRegistry;
  }

  // LocalAdapter path — register real providers.
  if (bundleDir) {
    const { existsSync } = await import("node:fs");
    const scriptsDir = join(bundleDir, "scripts");
    if (existsSync(scriptsDir)) {
      const scriptProvider = new ScriptToolProvider(
        scriptsDir,
        agentConfig.tools,
        allowedHosts,
        runOutputDir,
        { bundleRoot: bundleDir, depsCache },
      );
      await toolRegistry.addProvider(scriptProvider);
    }
  }

  for (const mcpServer of agentConfig.mcp_servers) {
    const tempProvider = new McpToolProvider(mcpServer, undefined, allowedHosts);
    const configKey = `${tempProvider.getConfigKey()}:${JSON.stringify(allowedHosts)}`;
    let mcpProvider = mcpCache.get(configKey);
    if (!mcpProvider) {
      mcpProvider = tempProvider;
      // Throws `McpConnectError` on timeout / transport failure.
      await mcpProvider.listTools();
      mcpCache.set(configKey, mcpProvider);
    }
    await toolRegistry.addProvider(mcpProvider);
  }

  return toolRegistry;
}

/**
 * What one run holds on this process's disk until it ends: its output
 * directory and, on the local runtime, the bundle extraction its scripts are
 * launched from. The route's
 * handler releases it when it returns, whatever way it returns — a refusal, a
 * response, an error thrown. A run that goes on after the handler has returned
 * (the SSE stream, the webhook task) is handed the hold, and releases it itself
 * when it ends. Every lease releases once, so a second release does nothing.
 */
class RunHold {
  private readonly leases: Array<{ release(): void }> = [];
  private passed = false;

  add(lease: { release(): void }): void {
    this.leases.push(lease);
  }

  /** The run continues past the handler: whoever takes it over releases, and ends the run. */
  handOff(): void {
    this.passed = true;
  }

  /** Whether the run went on past the handler — to its stream or its background task. */
  get handedOff(): boolean {
    return this.passed;
  }

  release(): void {
    for (const lease of this.leases) lease.release();
  }

  releaseUnlessHandedOff(): void {
    if (!this.passed) this.release();
  }
}

/**
 * The run a request admitted — its row written, `running` — as the route's
 * handler finds it once `handleRun` has returned or thrown.
 */
interface AdmittedRun {
  /**
   * End the run `failed` (`UNEXPECTED_END_ERROR`) unless its final status is
   * already taken: undefined then, nothing written. The promise never rejects.
   */
  endFailedUnlessFinal(): Promise<void> | undefined;
  /** The run has settled: it leaves the registry of runs in flight. */
  settle(): void;
}

export function createRunRoutes(
  service: RegistryService,
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  opts: CreateRunRoutesOptions = {},
): Hono {
  const router = new Hono();
  // The model router of every run these routes start, built once with them —
  // with the failover delay the start read, and the server keys of the process
  // environment as it is when the routes are built.
  const llmRouter = new LLMRouter(undefined, { primaryFailoverMs: opts.primaryFailoverMs });
  const runtimeMode: RuntimeMode = opts.runtimeMode ?? "local";
  const flyioDeps = opts.flyioDeps;
  if (runtimeMode === "flyio" && !flyioDeps) {
    throw new Error(
      "createRunRoutes: runtimeMode=flyio requires flyioDeps — set both via createApp.",
    );
  }
  // The quota settings; none handed in, nothing bounds a run.
  const quotaConfig = opts.quotaConfig ?? parseQuotaEnv({});
  // A runner pool runs: only then does a run have a right to a pooled machine.
  const poolRunning = runtimeMode === "flyio" && flyioDeps?.pool?.enabled === true;
  // The acquisition budget the cloud adapter is handed and the margin a seat
  // keeps past its run's timeout, computed where everything that must agree
  // with them reads them: the margin covers the very budget the adapter is held to.
  const { acquisitionBudgetMs: runAcquisitionBudgetMs, seatMarginMs } = runAcquisitionBounds(
    quotaConfig,
    poolRunning,
  );

  // POST /run is run-authorized (see assertAgentRunnableOrThrow): public agents
  // run for any authenticated caller; private agents only for their owner or the
  // instance administrator.
  const handleRun = async (c: Context, hold: RunHold, admitted: { run?: AdmittedRun }) => {
    // A server that is stopping starts no run: refused before anything of it is read.
    if (isServerStopping()) return refusedWhileStopping(c);
    const { namespace, name } = c.req.param();
    const runId = randomUUID();

    // --- Detect execution mode ---
    const acceptHeader = c.req.header("Accept") ?? "";
    const isSSE = acceptHeader.includes("text/event-stream");

    // 1. Parse request body
    let input: Record<string, unknown>;
    let webhookUrl: string | undefined;
    let requestedVersion: string | undefined;
    let environmentOverride: Record<string, unknown> | undefined;
    try {
      const body = await c.req.json();
      // The agent's input is the body's `input` field. A body that is not an
      // object, an object with no `input` — `{}` included — and an `input`
      // null are refused here, by name, the first thing done with the body
      // read: before its response mode, its version or its override are
      // judged. The whole body is never taken for the input.
      const reading = runBodyInput(body);
      if ("refusal" in reading) return c.json({ error: reading.refusal }, 400);
      const given = reading.input;
      // An input of the wrong shape is refused here, right after — the caller
      // authenticated before it, the rate limit counted: it depends on the body
      // alone, so it reveals nothing of the agent, and comes before anything is
      // read of it, any quota is looked at, the row's copy is built or the row
      // written. Two shapes. An input that is a string, a number or a boolean:
      // it reached the check of the agent's inputs, which threw on it — or, for
      // an agent whose every input is an optional file, ran with the value
      // dropped. An array is not refused here: it goes on to that check, as
      // before. The rule and its words are the schema's, read by the server of
      // `skrun dev` too.
      const typeRefusal = runInputTypeRefusal(given);
      if (typeRefusal) return c.json({ error: typeRefusal }, 400);
      input = given as Record<string, unknown>;
      // And an input nested deeper than the bound. The measure goes no deeper
      // than the first level past the bound, without recursion. What it holds
      // is bounded by the depth and the keys of the objects open on its path —
      // one frame per open level, never anything per value still to visit. It
      // reads an array in place, but lists the keys of each object it meets:
      // short-lived garbage, at most one list per open level held at once,
      // that a wide array of objects makes proportional to its width (about
      // 68 MB allocated for 2.2 million empty objects at the body cap).
      if (exceedsNestingDepth(input)) {
        return c.json({ error: { code: "INVALID_INPUT_TYPE", message: INPUT_TOO_DEEP } }, 400);
      }
      webhookUrl = body.webhook_url;
      // `version` is optional: undefined or null = latest; string = strict semver.
      if (body.version !== undefined && body.version !== null) {
        if (typeof body.version !== "string") {
          return c.json(
            {
              error: {
                code: "INVALID_VERSION_FORMAT",
                message: `version must be a string in strict semver format (e.g. "1.0.0"). Got: ${typeof body.version}`,
              },
            },
            400,
          );
        }
        if (!SEMVER_STRICT.test(body.version)) {
          const hint = hintForBadVersion(body.version);
          return c.json(
            {
              error: {
                code: "INVALID_VERSION_FORMAT",
                message: `version must be strict semver (e.g. "1.0.0"). Got: "${body.version}"${hint}`,
              },
            },
            400,
          );
        }
        requestedVersion = body.version;
      }
      // Optional environment override (shallow-merged onto agent.yaml defaults)
      if (body.environment !== undefined && body.environment !== null) {
        if (typeof body.environment !== "object" || Array.isArray(body.environment)) {
          return c.json(
            {
              error: {
                code: "INVALID_ENVIRONMENT",
                message: "environment must be an object",
              },
            },
            400,
          );
        }
        environmentOverride = body.environment as Record<string, unknown>;
      }
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    // --- Validate mutual exclusion (BR-3) ---
    if (isSSE && webhookUrl) {
      return c.json(
        {
          error: {
            code: "SSE_WEBHOOK_CONFLICT",
            message: "Cannot use both SSE streaming and webhook in the same request",
          },
        },
        400,
      );
    }

    // --- The response mode, read once: the event stream, a webhook, or one
    // response. A webhook_url that JavaScript reads as false (an empty string,
    // 0) is no webhook: the request is synchronous. The refusal just below and
    // the path the run takes at the end both read this one value.
    const mode = isSSE ? "sse" : webhookUrl ? "webhook" : "sync";

    // The flyio runtime serves a run through its event stream or a webhook,
    // never as one response: a synchronous request is refused here, by what the
    // request says alone — after the checks of the body's shape, before any key
    // header is read, the agent, its inputs, the override's settings, the quota
    // or the bundle. It reveals nothing of the agent, and nothing of the run is
    // written: no row, no seat. (A webhook_url's own checks, just below, only
    // concern a request whose mode is the webhook.)
    if (runtimeMode === "flyio" && mode === "sync") {
      return c.json({ error: { code: "SYNC_MODE_UNSUPPORTED", message: SYNC_MODE_REFUSAL } }, 400);
    }

    // --- Validate webhook_url ---
    if (webhookUrl) {
      try {
        const url = new URL(webhookUrl);
        // Fail-closed: reject non-HTTPS / private webhook hosts unless the
        // operator explicitly opts in for local testing (the same
        // SKRUN_ALLOW_LOCAL_WEBHOOKS flag honored by utils/webhook.ts at
        // delivery time, so local http://localhost webhooks work end to end).
        const allowLocal = process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS === "true";
        if (!allowLocal && url.protocol !== "https:") {
          return c.json(
            {
              error: {
                code: "INVALID_WEBHOOK_URL",
                message: "webhook_url must use HTTPS",
              },
            },
            400,
          );
        }
        // Reject private / cloud-metadata / link-local hosts even in
        // unrestricted ["*"] mode. This is a string-level fast-fail at intake;
        // the delivery-time guard in utils/webhook.ts re-checks the RESOLVED
        // IP (connect-time, DNS-rebinding-safe). The opt-in above relaxes both
        // for local testing; the default keeps AWS IMDS / localhost unreachable.
        if (!allowLocal && !isHostAllowed(url.hostname, ["*"])) {
          return c.json(
            {
              error: {
                code: "INVALID_WEBHOOK_URL",
                message: "webhook_url resolves to a private or reserved address",
              },
            },
            400,
          );
        }
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_WEBHOOK_URL",
              message: "Invalid webhook_url: must be a valid URL",
            },
          },
          400,
        );
      }
    }

    // 2. Parse caller-provided LLM API keys (optional)
    let callerKeys: Record<string, string> | undefined;
    const llmKeyHeader = c.req.header("X-LLM-API-Key");
    if (llmKeyHeader) {
      try {
        const parsed = JSON.parse(llmKeyHeader);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return c.json(
            {
              error: {
                code: "INVALID_LLM_KEY_HEADER",
                message: 'X-LLM-API-Key must be a JSON object, e.g. {"anthropic": "sk-..."}',
              },
            },
            400,
          );
        }
        const entries = Object.entries(parsed);
        if (entries.length === 0) {
          return c.json(
            {
              error: {
                code: "INVALID_LLM_KEY_HEADER",
                message: "X-LLM-API-Key must contain at least one provider key",
              },
            },
            400,
          );
        }
        for (const [key, value] of entries) {
          if (typeof value !== "string") {
            return c.json(
              {
                error: {
                  code: "INVALID_LLM_KEY_HEADER",
                  message: `X-LLM-API-Key value for "${key}" must be a string`,
                },
              },
              400,
            );
          }
        }
        callerKeys = parsed as Record<string, string>;
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_LLM_KEY_HEADER",
              message: "X-LLM-API-Key header is not valid JSON",
            },
          },
          400,
        );
      }
    }

    // 2a. Parse the caller's base-URL declaration (optional).
    // Same shape as X-LLM-API-Key — a {provider: url} map. Semantics: "the
    // endpoint MY key for this provider belongs to". It is a statement of intent
    // by the credential's owner, checked, entry by entry, against where each
    // provider's key goes for this agent once the bundle is parsed (see the
    // caller gate below), whether or not a key is sent. Absent stays `undefined`
    // rather than `{}`: the gate reads a request that carries either header.
    let callerBaseUrls: Record<string, string> | undefined;
    const llmBaseUrlHeader = c.req.header("X-LLM-Base-URL");
    if (llmBaseUrlHeader) {
      try {
        const parsed = JSON.parse(llmBaseUrlHeader);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return c.json(
            {
              error: {
                code: "INVALID_LLM_BASE_URL_HEADER",
                message:
                  'X-LLM-Base-URL must be a JSON object, e.g. {"anthropic": "https://api.example.com/v1"}',
              },
            },
            400,
          );
        }
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value !== "string") {
            return c.json(
              {
                error: {
                  code: "INVALID_LLM_BASE_URL_HEADER",
                  message: `X-LLM-Base-URL value for "${key}" must be a string`,
                },
              },
              400,
            );
          }
          try {
            new URL(value);
          } catch {
            return c.json(
              {
                error: {
                  code: "INVALID_LLM_BASE_URL_HEADER",
                  message: `X-LLM-Base-URL value for "${key}" is not a valid URL`,
                },
              },
              400,
            );
          }
        }
        callerBaseUrls = parsed as Record<string, string>;
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_LLM_BASE_URL_HEADER",
              message: "X-LLM-Base-URL header is not valid JSON",
            },
          },
          400,
        );
      }
    }

    // 2b. Run-authorization: load the agent row once, gate by visibility, and
    // reuse it for the bundle pull + run tracking (single DB read). Private
    // agents are for the owner or the instance administrator (the role on a
    // master credential); anyone else gets a 404 byte-identical to a
    // genuinely-absent agent. Runs BEFORE the bundle pull so no storage work
    // happens for an unauthorized caller (constant-time opacity).
    const user = getUser(c);
    let agent: Agent | null;
    try {
      agent = await db.getAgent(namespace, name);
      assertAgentRunnableOrThrow(agent, user, namespace, name);
      // 2c. API-key scope (operation + resource). The key resolved to the owner
      // account by run-auth above; this NARROWS what that key may do (a run-only
      // or agent-scoped key restricts even an admin owner). Throws
      // 403 KEY_SCOPE_FORBIDDEN — only reachable once ownership passed (so no
      // existence leak), and BEFORE the bundle pull (no storage work on denial).
      assertKeyScopeOrThrow(user, agent, "agent:run");
    } catch (err) {
      return dispatchRegistryError(c, err);
    }

    // 2d. Environment-override authorization: only the owner presenting a
    // management credential — or the instance administrator — may override the
    // creator's declared environment. What an override actually reaches
    // downstream is `allowed_hosts` (the sandbox egress allowlist), `timeout`
    // and `max_cost`, so widening it is a real privilege, not a preference.
    //
    // Ownership alone is not enough: a delegated key carries its minter's id,
    // so the owner's own restricted key would satisfy an ownership-only test
    // and could widen the very environment it was scoped down from. The
    // credential type has to be read too — for an administrator as for anyone:
    // the administrator disjunct is `isInstanceAdmin` (the role on a master
    // credential), so an administrator's reduced or delegated key overrides
    // nothing an ordinary account's same key could not.
    //
    // The administrator stays a standalone disjunct — they may override an
    // agent they do not own — while the destination gate further down does
    // not exempt them, deliberately.
    //
    // Checked BEFORE the bundle pull so an unauthorized override fails fast;
    // the actual shallow merge happens at step 5c.
    if (
      environmentOverride &&
      !((agent?.owner_id === user.id && isMasterCredential(user)) || isInstanceAdmin(user))
    ) {
      return c.json(
        {
          error: {
            code: "ENV_OVERRIDE_FORBIDDEN",
            message: "environment override is restricted to the agent owner",
          },
        },
        403,
      );
    }
    // A retired field in the override is refused, never ignored: a stream has no
    // channel for a warning, and a request, unlike a published bundle, can be
    // corrected at its source. The list is the one agent.yaml is checked
    // against.
    const retired = environmentOverride
      ? findRetiredFields({ environment: environmentOverride })
      : [];
    if (retired.length > 0) {
      const fields = retired.map((issue) => issue.field).join(", ");
      return c.json(
        {
          error: {
            code: "RETIRED_FIELD",
            message: `The environment override carries a retired field (${fields}): it has no effect. Remove it from the request.`,
          },
        },
        400,
      );
    }
    // Then a setting that no code honours, or a timeout outside the range a run
    // can hold, by the function validation reads: judged on the override as
    // sent, never on the environment it is merged into — a version that
    // declares one itself, published before the push refused it, runs with an
    // override as it runs without one. Its first one's code; every message.
    const refused = environmentOverride
      ? findRefusedSettings({ environment: environmentOverride })
      : [];
    const [firstRefused] = refused;
    if (firstRefused) {
      return c.json(
        {
          error: {
            code: firstRefused.code,
            message: `The environment override is refused: ${refused.map((issue) => issue.message).join(" ")}`,
          },
        },
        400,
      );
    }

    // 2e. Caller-key policy + creator-key resolution. AFTER the key scope gate (2c) and
    // BEFORE the bundle pull. `creator_only` rejects a run that carries its own
    // X-LLM-API-Key — loud (a caller must never wrongly believe their key, or
    // their billing, is in play). creatorKeys are decrypted harness-side HERE
    // (early) so the sanitizeEvent closure below captures them for redaction.
    if (agent?.llm_key_policy === "creator_only" && callerKeys !== undefined) {
      return c.json(
        {
          error: {
            code: "CALLER_KEY_NOT_ALLOWED",
            message:
              "This agent does not accept caller-provided LLM keys — it runs on the creator's key. Omit the X-LLM-API-Key header.",
          },
        },
        403,
      );
    }
    let creatorKeys: Record<string, string> | undefined;
    if (agent && opts.keyProvider) {
      // Read outside the catch below: a database that fails, or does not answer
      // in time, goes to the app's error handler like any route's — a
      // DATABASE_TIMEOUT, or the server's 500 —, never taken for a key this
      // server cannot decrypt.
      const records = await db.getAgentLlmKeySecrets(agent.id);
      try {
        creatorKeys = decryptCreatorKeys(opts.keyProvider, records);
      } catch {
        // A creator key is attached but cannot be decrypted (e.g. the master key
        // was rotated away). Fail loud — never silently fall through to a wrong
        // tier / wrong payer — without surfacing the underlying crypto error.
        return c.json(
          {
            error: {
              code: "CREATOR_KEY_UNREADABLE",
              message:
                "A creator LLM key is attached but could not be decrypted on this server (check SKRUN_SECRETS_ENCRYPTION_KEY).",
            },
          },
          500,
        );
      }
    }

    // The run's quota: the thresholds of the caller's plan, read once. The
    // timeout checks (2f, 5c'') log their refusals through it, the pre-check
    // (2g) and the admission (8) read it.
    const quota = runQuota({ db, config: quotaConfig, user, poolRunning, log: logger });

    // 2f. The longest timeout this server accepts, early: a version whose
    // recorded configuration declares more is refused here, before its bundle
    // is pulled — the version the pull would resolve, and only when no
    // environment override is sent, since one could change the timeout. The
    // merged environment is checked once the bundle is read, and that check
    // is the one that holds (step 5c'').
    if (quotaConfig.maxTimeoutS !== null && environmentOverride === undefined && agent) {
      const version = requestedVersion
        ? await db.getVersionByNumber(agent.id, requestedVersion)
        : await db.getLatestVersion(agent.id);
      const declaredS = snapshotTimeoutS(version?.config_snapshot);
      if (declaredS !== null && declaredS > quotaConfig.maxTimeoutS) {
        return quotaRefused(
          c,
          quota.refuseTimeout({ declaredS, maxS: quotaConfig.maxTimeoutS, overridden: false }),
        );
      }
    }

    // 2g. The quota pre-check: when a bound applies, the account's usage, read
    // without a lock. A run its account or the instance has no room for is
    // refused here, before the bundle is pulled: a refusal costs a few reads,
    // never a pull, an extraction or a connection. It decides nothing for
    // good — the admission reads everything again as it writes the run
    // (step 8).
    const refusedEarly = await quota.precheck();
    if (refusedEarly) return quotaRefused(c, refusedEarly);

    // 3. Load agent from registry (optionally pinned to `requestedVersion`)
    let bundleBuffer: Buffer;
    let resolvedVersion: string;
    let resolvedVerified: boolean;
    // Checksum on record for the resolved version. Null for a bundle published
    // before checksums were recorded; it then travels as undefined and the
    // sandbox extracts as before.
    let resolvedBundleSha256: string | null;
    try {
      const result = await service.pull(namespace, name, requestedVersion, {
        preloadedAgent: agent ?? undefined,
      });
      bundleBuffer = result.buffer;
      resolvedVersion = result.version;
      resolvedVerified = result.verified;
      resolvedBundleSha256 = result.sha256;
    } catch (err) {
      // Special-case: enrich VERSION_NOT_FOUND with up to 10 most recent
      // versions so the caller can recover without a separate round-trip.
      // All other RegistryError shapes go through the shared helper.
      if (err instanceof RegistryError && err.code === "VERSION_NOT_FOUND") {
        let available: string[] = [];
        try {
          const all = await service.getVersions(namespace, name);
          available = all
            .map((v) => v.version)
            .slice(-10)
            .reverse();
        } catch {
          // Swallow — don't mask the original 404 if listing itself fails.
        }
        return c.json({ error: { code: err.code, message: err.message, available } }, err.status);
      }
      return dispatchRegistryError(c, err);
    }

    // 3b. Verified gate, governed by the operator verification policy. Under the
    // `admin` policy a version must be approved before it can run (the legacy
    // behavior); under `owner`/`disabled` the owner is the trust authority and
    // private agents run without this gate (reactive abuse, and a sandbox machine
    // per run on the flyio runtime only — on the local runtime, scripts run as
    // child processes of this server, with an advisory egress list).
    // The gate is visibility-independent: setting an agent public is disabled, so
    // every live agent is private. Pre-empts LLM allocation, MCP connect, file
    // alloc, DB write — none of which should happen for a gated version.
    if (isRunGatedByVerification(opts.verificationPolicy ?? "admin", resolvedVerified)) {
      return c.json(
        {
          error: {
            code: "AGENT_NOT_VERIFIED",
            message: `Agent ${namespace}/${name} version ${resolvedVersion} must be verified by an admin before it can run.`,
          },
        },
        403,
      );
    }

    // 4. Read the bundle — on the local runtime, extract it to disk —, cached
    // by the SHA-256 of its bytes. Never by the agent's name and version:
    // those can come back with other bytes (an agent deleted, then published
    // again under the same number), and an instance still holding the first
    // extraction would run the old content. The checksum on record is the one
    // pull() just compared the bytes to; a version with none on record is
    // keyed by the checksum of the bytes read. The cache keeps the text of the
    // three manifests read below, nothing else of the bundle — and the
    // configuration of its agent.yaml, read once for the entry (step 5).
    let skillContent = "";
    let agentYamlContent = "";
    let agentsMdContent: string | undefined;
    let bundleDir = "";
    let configRead: BundleConfigRead | undefined;

    try {
      const cacheKey =
        resolvedBundleSha256 ?? createHash("sha256").update(bundleBuffer).digest("hex");
      // Read through the reading threads, with their budget, by a bundle's
      // first run while the cache keeps it — step 5 says what a run makes of it.
      const readConfig = (agentYaml: string) =>
        service.readRunConfig(namespace, name, resolvedVersion, agentYaml);
      // On the local runtime the run's scripts are launched from the
      // extraction's directory while it goes on: held until the run ends, it
      // outlives the entry's expiry. The cache hands it over already held. A
      // cloud run reads the manifests only, before its machine — its sandbox
      // fetches its own copy of the bundle —: nothing is written to this
      // process's disk, and nothing is held.
      let entry: BundleCacheEntry;
      if (runtimeMode === "local") {
        const held = await getOrExtract(bundleCache, cacheKey, bundleBuffer, {
          acquire: true,
          readConfig,
        });
        hold.add(held.lease);
        entry = held.entry;
        bundleDir = held.entry.dir;
      } else {
        entry = await getOrReadManifests(bundleCache, cacheKey, bundleBuffer, { readConfig });
      }
      skillContent = entry.files["SKILL.md"] ?? "";
      agentYamlContent = entry.files["agent.yaml"] ?? "";
      agentsMdContent = entry.files["AGENTS.md"];
      configRead = entry.config;
    } catch (err) {
      // A reading thread that failed judged nothing of the bundle: a fault of
      // the server, the app's error handler's, as at a push.
      if (err instanceof AgentYamlReaderError) throw err;
      // Every way the extraction fails is one line, its cause named: no run
      // exists yet, so the agent and its version say which. The line takes
      // the error's class and code, never its message — a decoder's or the
      // filesystem's can quote a file name of the bundle.
      const agentRef = `${namespace}/${name}`;
      if (err instanceof BundleDecompressedTooLargeError) {
        // The version was stored under a higher cap — this server's own,
        // since lowered, or another instance's —, or by a server that did not
        // refuse it at push: the creator can push a smaller one.
        logger.warn(
          {
            event: "bundle_extraction_failed",
            agent: agentRef,
            agent_version: resolvedVersion,
            cause: "too_large",
            max_decompressed_bytes: err.maxBytes,
            ...errorFields(err),
          },
          "A run was refused: its agent's bundle decompresses past this server's cap",
        );
        return c.json(
          {
            error: {
              code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
              message: runDecompressedTooLarge(agentRef, resolvedVersion, err.maxBytes),
            },
          },
          422,
        );
      }
      if (err instanceof BundleWriteError) {
        logger.error(
          {
            event: "bundle_extraction_failed",
            agent: agentRef,
            agent_version: resolvedVersion,
            cause: "filesystem",
            ...errorFields(err),
          },
          "A run's bundle could not be extracted: a file or directory of it could not be written out on this server",
        );
      } else {
        // Not a readable archive — or, stored before the push refused it, one
        // an entry of which cannot be written out: its class says which
        // (`BundleEntryError`), before anything was written.
        logger.error(
          {
            event: "bundle_extraction_failed",
            agent: agentRef,
            agent_version: resolvedVersion,
            cause: "unreadable",
            ...errorFields(err),
          },
          "A run's bundle could not be extracted: it is not a readable archive",
        );
      }
      return c.json(
        { error: { code: "BUNDLE_CORRUPT", message: "Failed to extract agent bundle" } },
        500,
      );
    }

    if (!agentYamlContent) {
      return c.json(
        { error: { code: "MISSING_CONFIG", message: "agent.yaml not found in bundle" } },
        500,
      );
    }

    // 5. The agent's configuration: its agent.yaml, parsed by `parseAgentYaml`
    // in a reading thread, within the push's budget, once for the bundle's
    // cache entry (step 4) — never on the event loop, whatever the file's
    // shape. The entry keeps it as JSON: each run parses its own object, the
    // keys in the order the parse gave them (`configObject`). A file refused —
    // or whose read outlasted the budget, a version stored before the push
    // held it — is a 500 INVALID_CONFIG, with the refusal's message, for as
    // long as the entry lasts.
    if (configRead === undefined) {
      throw new Error("The run cache returned a bundle with an agent.yaml and no configuration");
    }
    if ("refused" in configRead) {
      return c.json({ error: { code: "INVALID_CONFIG", message: configRead.refused } }, 500);
    }
    let agentConfig: AgentConfig = configObject(configRead);

    // 5b. Caller gate — layer 3 of the credential-destination rule.
    //
    // The rule the whole finding reduces to: a credential may only be sent to an
    // endpoint chosen by the credential's OWNER. `model.base_url` is chosen by
    // the agent's author; an `X-LLM-API-Key` belongs to the caller. When those
    // are different people, the caller must have named the destination.
    //
    // This is the earliest possible point: `base_url` lives inside the versioned
    // bundle, so it is not knowable before its agent.yaml is read (step 5) —
    // unlike the `creator_only` reject, which fires pre-pull. It still precedes
    // every LLM allocation, which is what matters.
    //
    // The exemption is `owner AND master credential`, not `owner` alone: a
    // delegated `scope_kind:"agents"` key carries the OWNER's `user.id` by
    // construction (auth.ts builds the context from the key's owner, and such a
    // key can only be minted over agents the minter owns), so `owner_id ===
    // user.id` is true for the very party this gate exists to protect against.
    // An admin is deliberately NOT exempt — unlike the env-override gate above —
    // because an admin does not own the caller's LLM key either.
    //
    // One definition of the exemption: the message of a run refused for want of
    // a key (5d) reads it too, to name the way this gate lets through.
    //
    // Read as soon as either header is sent, X-LLM-Base-URL alone included: a
    // declaration is the caller's word on where a key of theirs goes, wrong
    // with no key sent as with one. What the gate asks of the two headers is
    // endpointConsentRefusal's to say, above.
    const isSamePrincipal =
      agent !== null && agent.owner_id === user.id && isMasterCredential(user);
    if ((callerKeys !== undefined || callerBaseUrls !== undefined) && agent && !isSamePrincipal) {
      const refusal = endpointConsentRefusal(agentConfig.model, callerKeys, callerBaseUrls);
      if (refusal !== undefined) {
        return c.json({ error: { code: "CALLER_BASE_URL_NOT_CONSENTED", message: refusal } }, 403);
      }
    }

    const modelStr = agentConfig.model
      ? `${agentConfig.model.provider}/${agentConfig.model.name}`
      : null;

    // Strip the leading provider prefix so cost.ts PRICING entries match.
    // PRICING uses bare model names (e.g., "claude-sonnet-4-6") for most
    // providers, except Groq which uses prefixed entries like
    // "openai/gpt-oss-120b". So we strip ONLY the first segment.
    // Examples:
    //   "anthropic/claude-sonnet-4-6" -> "claude-sonnet-4-6"
    //   "groq/openai/gpt-oss-120b"    -> "openai/gpt-oss-120b"
    //   "claude-sonnet-4-6"           -> "claude-sonnet-4-6" (unchanged)
    // Note: this uses the primary model from agent.yaml. If the runtime
    // falls back to the fallback model (e.g., on primary 5xx), savings are
    // still computed using the primary's rates — acceptable approximation
    // (would need RunResult.model exposure for precision).
    const modelForCostLookup = modelStr?.includes("/")
      ? modelStr.slice(modelStr.indexOf("/") + 1)
      : (modelStr ?? "");

    // 5c. Merge environment override (owner/admin-only — authorized at step 2d).
    // A networking override that is an object is merged into the agent's; any
    // other value is kept as sent, for the validation below to refuse.
    if (environmentOverride) {
      const { networking: netOverride, ...flatOverride } = environmentOverride as {
        networking?: unknown;
        [key: string]: unknown;
      };
      const mergedNetworking =
        netOverride === undefined || netOverride === null
          ? agentConfig.environment.networking
          : typeof netOverride === "object" && !Array.isArray(netOverride)
            ? { ...agentConfig.environment.networking, ...netOverride }
            : netOverride;
      const merged = { ...agentConfig.environment, ...flatOverride, networking: mergedNetworking };

      // 5c''. The merged environment is validated again, as agent.yaml's is: the
      // override was checked for its author, its retired fields and the
      // settings no code honours only, and a timeout that is not "Ns", or a
      // networking that is not an object, would otherwise reach the adapter.
      // Refused 400 INVALID_ENVIRONMENT, naming each field.
      const validated = EnvironmentConfigSchema.safeParse(merged);
      if (!validated.success) {
        const fields = validated.error.issues
          .map((issue) => `environment.${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT",
              message: `The environment, once the override is merged, is invalid — ${fields}`,
            },
          },
          400,
        );
      }
      agentConfig = { ...agentConfig, environment: validated.data };
    }

    // The longest timeout this server accepts, on the merged environment: the
    // check that holds, whatever the version recorded (step 2f).
    if (quotaConfig.maxTimeoutS !== null) {
      const declaredS = parseTimeout(agentConfig.environment.timeout) / 1000;
      if (declaredS > quotaConfig.maxTimeoutS) {
        return quotaRefused(
          c,
          quota.refuseTimeout({
            declaredS,
            maxS: quotaConfig.maxTimeoutS,
            overridden: environmentOverride?.timeout !== undefined,
          }),
        );
      }
    }

    // 5c'. On the cloud runtime, an allowed host the sandbox cannot enforce is
    // refused before any machine, by its form — a host pattern (`*.slack.com`),
    // a host with a port, a URL, a path, or any other text the sandbox does not
    // read. The sandbox filters addresses: accepted, a pattern or a host with a
    // port would leave the agent without that egress, in silence, and a form the
    // sandbox refuses at a pooled machine's assignment would cost a machine.
    // After the merge, since an override can bring one. The local runtime
    // refuses nothing: it honours patterns, and the other forms match nothing
    // there.
    if (runtimeMode === "flyio") {
      const hosts = agentConfig.environment.networking.allowed_hosts;
      const refused = sandboxRefusedHosts(hosts);
      if (refused.length > 0) {
        return c.json(
          {
            error: {
              code: "EGRESS_HOST_UNSUPPORTED",
              message: sandboxRefusalMessage(hosts, refused),
            },
          },
          400,
        );
      }
    }

    // 5d. A model key must be resolvable for the primary model or, failing it,
    // for the fallback — by the router's own decision (caller > creator >
    // server, base_url orthogonal), read for each model as the router calls it,
    // never a copy of it. A primary with no key fails at its first call and the
    // router turns to the fallback, so a run the fallback can serve goes ahead.
    // Here: after every refusal above, `creator_only` and an unreadable creator
    // key included, and before the inputs are validated, a file input fetched,
    // the run recorded or a machine acquired. A run no model of it could serve
    // is refused in HTTP, on both runtimes, in every response mode each serves:
    // a synchronous request on flyio was refused above, by its mode.
    const modelKeys = llmRouter.checkModelKeys(agentConfig.model, callerKeys, creatorKeys);
    if (!modelKeys.servable) {
      return c.json(
        {
          error: {
            code: "LLM_KEY_REQUIRED",
            message: llmKeyRequiredMessage(`${namespace}/${name}`, agentConfig.model, modelKeys, {
              keysAllowed: agent?.llm_key_policy !== "creator_only",
              mustNameEndpoint:
                Boolean(agentConfig.model.base_url) && agent !== null && !isSamePrincipal,
            }),
          },
        },
        400,
      );
    }

    // 6. Validate inputs: each input the agent declares, its absence — no
    // field of the input's own, null, or an empty list for a file input —, then
    // its type (a file input's absence only: resolveInput below judges the
    // rest). The rule and its words are the schema's, read by the server of
    // `skrun dev` too.
    const inputsRefusal = runDeclaredInputsRefusal(agentConfig.inputs, input);
    if (inputsRefusal) return c.json({ error: inputsRefusal }, 400);

    // 6b. Resolve file inputs to SkrunPart[] (Tasks 3.1, 6.1+6.2+6.4)
    let resolvedInputs: Map<string, SkrunPart[]> | undefined;
    const fileSchemas = agentConfig.inputs.filter((f): f is FileInputField => f.type === "file");
    if (fileSchemas.length > 0) {
      try {
        resolvedInputs = await resolveInput(input, fileSchemas, {
          fetchInputFile: async (fileId) => {
            const meta = getInputFile(fileId);
            // An upload the caller may not use reads as one that does not
            // exist: a file id travels (run history lists them), and knowing
            // one must not put another caller's file into this prompt.
            if (!meta || !mayUseUpload(user, meta)) return null;
            const bytes = readFileSync(meta.path);
            return { bytes: new Uint8Array(bytes), media_type: meta.media_type };
          },
          allowedHosts: agentConfig.environment.networking.allowed_hosts,
        });
        // Strict per-agent mime check
        for (const schema of fileSchemas) {
          const parts = resolvedInputs.get(schema.name);
          if (!parts) continue;
          const allowed = schema.mime_types ?? [];
          if (allowed.length === 0) continue; // no allowlist declared → accept any (defaults applied at runtime)
          for (const part of parts) {
            if (part.kind === "text") continue;
            if (!allowed.includes(part.media_type)) {
              return c.json(
                {
                  error: {
                    code: "MIME_NOT_ALLOWED",
                    message: `Input '${schema.name}' got media_type '${part.media_type}' but allowed: ${allowed.join(", ")}`,
                  },
                },
                415,
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof ResolveError) {
          // A name the URL reaches — its host or a redirect's — resolves to a
          // private or reserved address: the caller is told the name, the
          // operator the address too — it maps the network this server runs
          // on. Never the URL, whose path and query can carry personal data.
          // Who tried is there because nothing else records the attempt: the
          // API keeps no access log and the run is not recorded yet. The agent
          // names its owner. The key is recorded as a run records it: an id is
          // one of the owner's keys — one they keep, or one handed to a client,
          // which the client holds and only this line lets the operator name to
          // the owner — or an administrator's own; null is a session (the
          // owner's or an administrator's) or the development token: the line
          // does not tell them apart. No account id: the agent gives it. No run
          // id: no run exists.
          if (err.privateResolution) {
            logger.warn(
              {
                event: "input_url_private_address",
                agent: `${namespace}/${name}`,
                agent_version: resolvedVersion,
                api_key_id: user.key?.id ?? null,
                host: err.privateResolution.host,
                address: err.privateResolution.address,
              },
              "A file input URL was refused: a name it reaches resolves to a private or reserved address",
            );
          }
          const httpCode =
            err.code === "INLINE_TOO_LARGE" || err.code === "MAX_COUNT_EXCEEDED"
              ? 413
              : err.code === "URL_NOT_ALLOWED"
                ? 403
                : err.code === "FILE_NOT_FOUND"
                  ? 404
                  : err.code === "URL_FETCH_FAILED"
                    ? 502
                    : 400;
          return c.json({ error: { code: err.code, message: err.message } }, httpCode);
        }
        throw err;
      }
    }

    // 7. Setup tool registry via the adapter-aware helper.
    //    - LocalAdapter path builds real script + MCP providers inline.
    //    - FlyioAdapter path skips registry construction; the cloud
    //      adapter wires its own RPC providers post-spawn from /init.
    const warnings: string[] = [];
    const allowedHosts = agentConfig.environment.networking.allowed_hosts;

    // Create the per-run output directory NOW, before constructing the
    // script provider — the provider passes this path to spawned scripts
    // via SKRUN_OUTPUT_DIR. Re-used by LocalAdapter for output collection
    // (LocalAdapter no-ops when outputDir is already set).
    const runOutputDir = join(tmpdir(), `${OUTPUT_DIR_PREFIX}${runId}`);
    mkdirSync(runOutputDir, { recursive: true });
    // Held until the run ends: the cache learns of the directory only when the
    // run completes, and until then the sweep keeps it young for the orphan pass
    // of an instance sharing the temp root.
    hold.add(holdOutputDir(runOutputDir));

    let toolRegistry: ToolRegistry;
    try {
      toolRegistry = await buildToolRegistryForAdapter(
        runtimeMode,
        agentConfig,
        bundleDir,
        allowedHosts,
        runOutputDir,
      );
    } catch (err) {
      if (err instanceof McpConnectError) {
        return c.json(
          { error: { code: err.code, message: err.message, details: err.details } },
          502,
        );
      }
      throw err;
    }

    // The run's request-scoped child logger, ready before its row exists: from
    // that write on, every way the run ends logs through it.
    const log = logger.child({
      run_id: runId,
      agent: `${namespace}/${name}`,
      agent_version: resolvedVersion,
    });

    // The stop may have begun while the run was being prepared: still nothing
    // of it is written, and the output directory made for it goes. A row whose
    // write is under way as the stop begins is the registry's to end
    // (runtime/in-flight-runs.ts).
    if (isServerStopping()) {
      rmSync(runOutputDir, { recursive: true, force: true });
      return refusedWhileStopping(c);
    }

    // How long the run's seat is held: its timeout — at most the longest timer
    // this process can arm (`MAX_TIMER_DELAY_MS`): a timeout declared beyond it
    // — nothing bounds the number an agent writes — holds its seat no longer, and
    // its deadline stays a date — plus the margin that covers its machine's
    // acquisition and its outputs' upload. The admission writes the seat's
    // deadline from it, and the cloud adapter its machine's lifetime: the same
    // value, never a copy.
    const seatHoldMs =
      Math.min(parseTimeout(agentConfig.environment.timeout), MAX_TIMER_DELAY_MS) + seatMarginMs;
    // The admission is under way from here — nothing awaited since the look at
    // the stop above — until its run is registered, it is refused or its write
    // fails: a stop that begins meanwhile waits for it, the run reaching the
    // registry only once its row is written (runtime/in-flight-runs.ts).
    const endAdmission = beginAdmission();
    let finalClaim: InFlightRun;
    // The run's right to a pooled machine, as its admission gave it.
    let poolEntitled = false;
    try {
      // 8. Admit the run: its row is written only if its account and the
      // instance still have room — the reads and the write one step
      // (quotas/admission.ts; the agent and the user loaded at run-auth reused).
      // The run is counted for the caller's account, or for none when a
      // dev-token caller's account could not be recorded. Its seat is held for
      // `seatHoldMs` (above): the seat of a run whose process died frees itself
      // then.
      const admission = await quota.admit({
        run: {
          id: runId,
          agent_id: agent?.id ?? null,
          agent_version: `${namespace}/${name}@${resolvedVersion}`,
          model: modelStr,
          api_key_id: user.key?.id ?? null,
          input,
        },
        holdMs: seatHoldMs,
      });
      if (!admission.admitted) {
        // Refused, nothing written: the output directory made for the run goes,
        // its hold is given back by the route's handler, and the MCP connections
        // opened for it stay in their cache.
        rmSync(runOutputDir, { recursive: true, force: true });
        return quotaRefused(c, admission.refusal);
      }
      poolEntitled = admission.poolEntitled;
      // The account's numbers, on every response of this run from here on — the
      // result, the 202, the stream's opening.
      for (const [header, value] of Object.entries(admission.headers)) c.header(header, value);
      // The run is in flight from here until it settles: registered with the
      // process, which a stop of the server ends (runtime/in-flight-runs.ts). Its
      // entry is also its claim on its final status: every final write goes
      // through finalizeRun, which takes it once.
      // Its admission's instant — its row's creation — is where its charged time
      // counts from; its seat's deadline is where the registry stops it, if it
      // is still in flight then.
      finalClaim = registerInFlightRun({
        runId,
        db,
        log,
        mode,
        runtimeMode,
        admittedAt: admission.admittedAt,
        deadlineAt: admission.deadlineAt,
      });
    } finally {
      endAdmission();
    }
    // The net under every way this run can end without a final event of its
    // own — an exception out of the adapter, out of the stream or the
    // background task, or before the run is handed to either: the run ends
    // failed, unless its final status is already taken — the stop's
    // provisional failure counts as taken. What ended first stays.
    const endFailedUnlessFinal = (): Promise<void> | undefined => {
      if (finalClaim.claim !== "none") return undefined;
      return finalizeRun(db, log, runId, finalClaim, {
        status: "failed",
        error: UNEXPECTED_END_ERROR,
        now: new Date(),
        mode,
        runtimeMode,
      }).then(
        () => {},
        (err) => {
          log.error(
            { event: "run_completion_failed", run_id: runId, ...errorFields(err) },
            "Recording the run's failure failed; the run may remain in 'running' state",
          );
        },
      );
    };
    // From here on the route's handler ends the run if nothing else does.
    admitted.run = { endFailedUnlessFinal, settle: () => finalClaim.settle() };
    // A run its admission gave the right to a pooled machine gives it back
    // once its machine is ready (the engine's runner_spawned), if that machine
    // did not come from the pool and no pooled machine was taken for it — a
    // claim that failed after the run's handoff began counts as taken. Only a
    // right still held is given back (the store's write is conditional).
    // Never awaited, and never thrown out of here: the engine is suspended at
    // that event. A write that fails — rejected, or thrown at once by a store
    // without the method — is one line; the right stays spent and the run
    // goes on. The event's phases are read inside the same `try`: an event
    // without them is that line too, never an exception into the envelope.
    // A run whose machine never gets ready keeps its right spent.
    const giveBackPoolRight = (phases: SpawnPhases): void => {
      const failed = (err: unknown) =>
        log.error(
          { event: "pool_right_return_failed", run_id: runId, ...errorFields(err) },
          "The run's right to a pooled machine could not be given back; it stays spent",
        );
      try {
        if (poolEntitled && phases.pool_hit !== true && (phases.pool_handoffs_failed ?? 0) === 0) {
          db.returnPoolRight(runId).catch(failed);
        }
      } catch (err) {
        failed(err);
      }
    };

    // A run whose row was being written as the stop began is registered
    // abandoned: it is not started — no agent, no machine; a runtime that does
    // not listen to the stop would run it whole. It ends on the stop's path —
    // its row given the stop's failure, unless the registry gave it the
    // provisional one already —, its output directory goes, and it is answered
    // as a run sent during the stop is, in every mode: 503 under the stop's
    // code, with what its row says.
    if (finalClaim.reason === "shutdown") {
      const written =
        finalClaim.claim === "none"
          ? await finalizeRun(db, log, runId, finalClaim, {
              status: "failed",
              error: SHUTDOWN_RUN_ERROR,
              now: new Date(),
              mode,
              runtimeMode,
            })
          : stopVerdictOf(finalClaim);
      rmSync(runOutputDir, { recursive: true, force: true });
      const told = failureToTell(written);
      c.header("Connection", "close");
      return c.json(
        {
          error: {
            code: told?.code ?? SHUTDOWN_RUN_ERROR_CODE,
            message: told?.message ?? SHUTDOWN_RUN_ERROR,
          },
        },
        503,
      );
    }

    // 9. Create adapter
    // State callbacks: bound to the agent's id, the version's `state` block
    // and the caller the credential names — never to the name the loop
    // passes. `agent` is non-null here (assertAgentRunnableOrThrow, step 2b).
    const stateCallbacks = createStateCallbacks({
      db,
      agentId: agent.id,
      state: agentConfig.state,
      caller: stateCaller(user),
      log,
    });
    let adapter: RuntimeAdapter;
    if (runtimeMode === "flyio") {
      const deps = flyioDeps as FlyioRuntimeDeps; // ctor-validated; cast is safe
      adapter = new FlyioAdapter(
        deps.flyApi,
        deps.storage,
        llmRouter,
        toolRegistry,
        stateCallbacks,
        {
          runtimeImage: deps.runtimeImageTag,
          // Absent unless the operator configured one; then a run wakes a
          // pre-created machine instead of creating its own.
          pool: deps.pool,
          // The process's, like the pool: one for every run at once.
          outputsBudget: deps.outputsBudget,
          // The budget the seat's margin covers: the same value, never a copy.
          acquisitionBudgetMs: runAcquisitionBudgetMs,
          // The hold the admission gave the seat: the run's machine lives this
          // long plus a grace.
          seatHoldMs,
          // Persist the operator-only cold-start telemetry as soon as the runner
          // is ready (fire-and-forget) — captured even for runs that later fail.
          // machine_id / private_ip stay off the tenant-facing run response (they
          // are omitted by the GET /runs serializer); phase_timings is the public
          // breakdown also carried by the runner_spawned event.
          onRunnerSpawned: (info) => {
            db.updateRun(runId, {
              machine_id: info.machineId,
              private_ip: info.privateIp,
              phase_timings: info.phases as unknown as Record<string, number>,
            }).catch((err) =>
              log.error(
                { event: "db_update_failed", run_id: runId, ...errorFields(err) },
                "DB updateRun failed (runner_spawned telemetry)",
              ),
            );
          },
          // A machine that never got ready charges its run nothing: the phase
          // its acquisition stopped at is kept on the run's claim, told before
          // the run_error the run's end is written on (finalizeRun).
          onSpawnFailed: (info) => {
            finalClaim.spawnFailure = info;
          },
          // What the run leaves going once it has ended — the search for the
          // machine of a creation it abandoned — is handed to the server's stop,
          // which waits for it within its grace.
          onBackgroundCleanup: (cleanup) => trackBackgroundCleanup(cleanup),
        },
        log,
      );
    } else {
      adapter = new LocalAdapter(llmRouter, toolRegistry, stateCallbacks, log);
    }

    // Bundle key follows the registry's storage convention (see
    // RegistryService.pull). FlyioAdapter reads it to generate the
    // presigned download URL handed to the spawned runner — LocalAdapter
    // ignores it (bundle is already on the harness filesystem).
    const bundleKey = `${namespace}/${name}/${resolvedVersion}.agent`;

    const runRequest = {
      // The sandbox reads an IPv6 literal bare: one written in brackets — the
      // form a URL writes it in — reaches the cloud machine without them. What
      // ran before this point (the inputs' URLs) read the list as written.
      agentConfig:
        runtimeMode === "flyio"
          ? {
              ...agentConfig,
              environment: {
                ...agentConfig.environment,
                networking: {
                  ...agentConfig.environment.networking,
                  allowed_hosts:
                    agentConfig.environment.networking.allowed_hosts.map(sandboxHostForm),
                },
              },
            }
          : agentConfig,
      skillContent,
      agentsMdContent,
      input,
      runId,
      callerKeys,
      creatorKeys,
      agent_version: resolvedVersion,
      outputDir: runOutputDir as string | undefined,
      resolvedInputs,
      bundleKey,
      // Travels with the key so the sandbox can check the copy it downloads
      // for itself. The bytes verified in this process are not the bytes that
      // end up running the scripts — those come from a second read, made from
      // inside the sandbox.
      bundleSha256: resolvedBundleSha256 ?? undefined,
      // The caller's signal and the server stop's: the cloud adapter listens
      // on it to stop its loop and destroy its machine when the caller hangs
      // up mid-run — or when the server stops.
      abortSignal: AbortSignal.any([c.req.raw.signal, finalClaim.controller.signal]),
      // The admission's decision on the pool, while one runs: a run past its
      // account's fast runs of the hour takes the cold path. Without a pool no
      // run has the right, and the engine is told nothing.
      ...(poolRunning ? { poolEligible: poolEntitled } : {}),
      // environmentId for prompt-cache routing. The API doesn't have
      // persistent env records keyed by ID today; "default" gives stable
      // cache pools per (agent, version). Future feature can hash
      // environmentOverride for per-shape isolation.
      environmentId: "default",
    };

    // Helper: build files array with download URLs from FileInfo[]
    //
    // The url field follows the runtime that produced the file:
    // - Cloud mode (FlyioAdapter): the runtime sets `f.url` to a presigned
    //   R2 / MinIO GET URL — direct download from object storage, no proxy
    //   hop through this API. file_id is undefined in cloud mode (no
    //   /api/files/:id route hosts the bytes — they live in R2 only).
    // - Self-host mode (LocalAdapter): `f.url` is unset; we fall back to
    //   the run-scoped route + propagate file_id so the unified /api/files
    //   namespace works.
    const buildFilesResponse = (files: FileInfo[] | undefined) =>
      (files ?? []).map((f) => ({
        name: f.name,
        size: f.size,
        url: f.url ?? `/api/runs/${runId}/files/${encodeURIComponent(f.name)}`,
        ...(f.file_id && { file_id: f.file_id }),
      }));

    // --- Sanitize helpers: strip caller + creator key values from error
    // messages, both on the wire (sanitizeEvent) AND before the DB error column
    // (sanitizeError), on every failure path: the stream, the webhook, the sync
    // path's failed result and its thrown error. A provider 4xx can echo the key
    // it was sent; without this it would land in runs.error + GET /runs/:id, and
    // in the response. Only a whole key is recognised and replaced — a part of
    // one (a masked or cut form) passes as it is — and only the run's caller and
    // creator keys: the server's own keys are not in the list. ---
    const runSecrets = [...Object.values(callerKeys ?? {}), ...Object.values(creatorKeys ?? {})];
    const sanitizeError = (message: string): string =>
      runSecrets.length > 0 ? redactSecretsFromString(message, runSecrets) : message;
    const sanitizeEvent = (event: RunEvent): RunEvent => {
      if (event.type === "run_error" && runSecrets.length > 0) {
        return {
          ...event,
          error: {
            ...event.error,
            message: sanitizeError(event.error.message),
          },
        };
      }
      return event;
    };

    // ==================== SSE MODE ====================
    // Each path is the one the response mode names, read once above.
    if (mode === "sse") {
      // The stream outlives this handler: it releases what the run holds.
      hold.handOff();
      // The third argument of streamSSE takes an error that escapes the
      // callback once the stream is open; without it the helper prints the
      // whole error to stderr. Written in place: error-fields.test.ts requires
      // one on every streaming call, and reads its log line there.
      return streamSSE(
        c,
        async (stream) => {
          // Past its seat's deadline — its adapter's signal aborted then —, a
          // run that has not ended within the grace has its stream closed by
          // the registry: a write waiting on a caller who stopped reading is let
          // go — dropped, as every write after it —, and the run moves on to
          // its end.
          finalClaim.closeAtDeadline(() => stream.abort());
          const events = engineEvents(adapter, runRequest, giveBackPoolRight);
          // The run's final write, once begun: the run settles once it has ended.
          let finalWrite: Promise<unknown> | undefined;
          try {
            for await (const event of events) {
              let outgoing: RunEvent = event;
              if (event.type === "run_complete") {
                if (runRequest.outputDir) {
                  registerOutput(runId, runRequest.outputDir, event.files);
                }
                // Update run in DB (same as sync mode). The event waits for the
                // write, at most FINAL_WRITE_WAIT_MS: a caller who reads it finds
                // the run completed. A write that fails, or is still going at the
                // bound, is a log line, and the event goes.
                const sseCacheReadTokens = event.usage.cache_read_tokens ?? 0;
                const sseCacheWriteTokens = event.usage.cache_write_tokens ?? 0;
                const completion = finalizeRun(db, log, runId, finalClaim, {
                  status: "completed",
                  completion: {
                    output: event.output,
                    promptTokens: event.usage.prompt_tokens,
                    completionTokens: event.usage.completion_tokens,
                    totalTokens: event.usage.total_tokens,
                    cacheReadTokens: sseCacheReadTokens,
                    cacheWriteTokens: sseCacheWriteTokens,
                    estimatedCost: event.cost?.estimated ?? 0,
                    durationMs: event.duration_ms,
                    files: event.files,
                  },
                  modelForCostLookup,
                  now: new Date(),
                  mode: "sse",
                  runtimeMode,
                  outputStorage: flyioDeps?.storage,
                });
                finalWrite = completion;
                const written = await waitForFinalWrite(completion, log, runId, "completed");
                // The caller's copy has the shape of the sync result: each file
                // with its download url (and file_id), and the cache savings when
                // there are any — built by the functions the sync and webhook
                // results use, never copies of them. The count of files left out,
                // `files_excluded`, is the adapter's, as it is. The adapter's event
                // is left as it is. A row that stayed failed — the stop's
                // provisional failure on a row whose content was cleared — makes
                // it that failure instead: the caller is told what the row says.
                const saved = estimateCacheSavings(modelForCostLookup, sseCacheReadTokens);
                outgoing = finalEventFor(
                  {
                    ...event,
                    files: buildFilesResponse(event.files),
                    cost: { ...event.cost, ...(saved > 0 && { saved }) },
                  },
                  written,
                );
              } else if (event.type === "run_error") {
                // Waited for the same way: a caller who reads the event finds the
                // run failed — with the error the row holds, the stop's phrase
                // once the stop has abandoned the run. Past the bound, the write
                // has said nothing: on the stop's path the claim says the
                // failure is the stop's, and the caller is told so.
                const failure = finalizeRun(db, log, runId, finalClaim, {
                  status: "failed",
                  error: sanitizeError(event.error.message),
                  now: new Date(),
                  mode: "sse",
                  runtimeMode,
                });
                finalWrite = failure;
                const written = await waitForFinalWrite(failure, log, runId, "failed");
                outgoing = finalEventFor(event, written ?? stopVerdictOf(finalClaim));
              }
              const sanitized = sanitizeEvent(outgoing);
              const { event: eventName, data } = formatSSEEvent(sanitized);
              if (event.type !== "run_complete" && event.type !== "run_error") {
                await stream.writeSSE({ event: eventName, data });
                continue;
              }
              // The run is over, its status written: its adapter is closed now
              // — its `finally` reached, the cloud one destroying its machine —
              // while its final event goes to the caller. A caller who stopped
              // reading holds that write until the stream is closed, never the
              // machine. Nothing of the adapter comes after its final event.
              const closing = closeAdapter(events);
              await stream.writeSSE({ event: eventName, data });
              const closed = await closing;
              if (closed !== null) throw closed.error;
            }
          } catch (err) {
            // An exception, not a final event: the run still ends failed —
            // unless its final status is already written — waited for as a
            // final event's write is, before the error goes on to the handler
            // below (an Error) or to the helper (any other value).
            const write = endFailedUnlessFinal();
            if (write) {
              finalWrite = write;
              await waitForFinalWrite(write, log, runId, "failed");
            }
            throw err;
          } finally {
            // MCP disconnect handled by cache eviction
            hold.release();
            // Its machine destroyed, its hold given back, its final write
            // ended — which may outlast its stream —: the run has settled.
            settleOnceWritten(finalClaim, finalWrite);
          }
        },
        // After this handler the helper writes an `error` event carrying the
        // error's message. The stream is closed first, so that write lands on a
        // closed stream and is dropped: the caller's stream ends exactly as it
        // did, after the events already sent, with nothing added. The helper
        // hands over only an Error; a thrown value that is not one skips this.
        async (err, stream) => {
          log.error(
            { event: "sse_stream_failed", run_id: runId, ...errorFields(err, { stack: true }) },
            "A streamed run broke off after its stream had started",
          );
          await stream.close();
        },
      );
    }

    // ==================== WEBHOOK MODE ====================
    if (mode === "webhook") {
      // The mode is the webhook only when a webhook_url was sent.
      const targetUrl = webhookUrl as string;
      // The background task outlives this handler: it releases what the run holds.
      hold.handOff();
      /** A failed run's delivery: the failure cleaned of the run's keys. */
      const failedPayload = (failure: RunErrorEvent): Record<string, unknown> => ({
        run_id: runId,
        status: "failed",
        agent_version: resolvedVersion,
        error: (sanitizeEvent(failure) as RunErrorEvent).error,
      });
      // Fire and forget — execute in background
      (async () => {
        try {
          let finalResult: Record<string, unknown> | undefined;
          for await (const event of engineEvents(adapter, runRequest, giveBackPoolRight)) {
            if (event.type === "run_complete") {
              if (runRequest.outputDir) {
                registerOutput(runId, runRequest.outputDir, event.files);
              }
              // Persist usage to DB — mirrors sync/SSE pattern. This was a
              // latent gap since streaming landed: webhook-mode runs never wrote
              // usage data, so token counts and savings were silently 0 in
              // stats and run-detail.
              const whCacheReadTokens = event.usage.cache_read_tokens ?? 0;
              const whCacheWriteTokens = event.usage.cache_write_tokens ?? 0;
              const written = await finalizeRun(db, log, runId, finalClaim, {
                status: "completed",
                completion: {
                  output: event.output,
                  promptTokens: event.usage.prompt_tokens,
                  completionTokens: event.usage.completion_tokens,
                  totalTokens: event.usage.total_tokens,
                  cacheReadTokens: whCacheReadTokens,
                  cacheWriteTokens: whCacheWriteTokens,
                  estimatedCost: event.cost?.estimated ?? 0,
                  durationMs: event.duration_ms,
                  files: event.files,
                },
                modelForCostLookup,
                now: new Date(),
                mode: "webhook",
                runtimeMode,
                outputStorage: flyioDeps?.storage,
              });
              // Delivered as the row says: a row that stayed failed is delivered as that failure.
              const told = finalEventFor(event, written);
              finalResult =
                told.type === "run_complete"
                  ? {
                      run_id: runId,
                      status: "completed",
                      agent_version: resolvedVersion,
                      output: event.output,
                      usage: event.usage,
                      ...(warnings.length > 0 && { warnings }),
                      cost: {
                        ...(event.cost ?? {}),
                        // Surface cache savings on the webhook payload too
                        ...(written.cacheSavingsUsd > 0 && { saved: written.cacheSavingsUsd }),
                      },
                      duration_ms: event.duration_ms,
                      files: buildFilesResponse(event.files),
                      // How many output files were left out, by reason: counts, never a name.
                      files_excluded: event.files_excluded,
                    }
                  : failedPayload(told);
            } else if (event.type === "run_error") {
              // Persist failure to DB — no usage_* field: they stay at the DB
              // DEFAULT 0, no partial accounting for failed runs.
              const written = await finalizeRun(db, log, runId, finalClaim, {
                status: "failed",
                error: sanitizeError(event.error.message),
                now: new Date(),
                mode: "webhook",
                runtimeMode,
              });
              finalResult = failedPayload(finalEventFor(event, written));
            }
          }
          if (finalResult) {
            const { deliverWebhook } = await import("../utils/webhook.js");
            await deliverWebhook(targetUrl, finalResult, undefined, log);
          }
        } catch (err) {
          // An exception, not a final event: the run still ends failed, unless
          // its final status is already written — a delivery that throws after
          // the run completed leaves the completion as it is.
          await endFailedUnlessFinal();
          log.error(
            { event: "webhook_bg_error", ...errorFields(err) },
            "Background execution failed",
          );
        } finally {
          // MCP disconnect handled by cache eviction
          hold.release();
          // Its machine destroyed, its hold given back: the run has settled.
          finalClaim.settle();
        }
      })();

      return c.json({ run_id: runId, agent_version: resolvedVersion }, 202);
    }

    // ==================== SYNC MODE (default) ====================
    try {
      const result = await adapter.execute(runRequest);

      // Register output dir for file serving (file-id index for downloads)
      if (runRequest.outputDir) {
        registerOutput(runId, runRequest.outputDir, result.files);
      }

      // Track completed run. Cache-savings snapshot is computed at write
      // time (matches usage_estimated_cost pattern); always 0 for failed runs.
      const cacheReadTokens = result.usage.cacheReadTokens ?? 0;
      const cacheWriteTokens = result.usage.cacheWriteTokens ?? 0;
      let cacheSavingsUsd = 0;
      // A failed run's error is cleaned of the run's keys once, here, and that
      // one value goes both to the runs table and into the response.
      const resultError = result.error !== undefined ? sanitizeError(result.error) : undefined;
      let written: FinalizeRunResult;
      if (result.status === "completed") {
        written = await finalizeRun(db, log, runId, finalClaim, {
          status: "completed",
          completion: {
            output: result.output,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            cacheReadTokens,
            cacheWriteTokens,
            estimatedCost: result.usage.estimatedCost,
            durationMs: result.durationMs,
            files: result.files,
          },
          modelForCostLookup,
          now: new Date(),
          mode: "sync",
          runtimeMode,
          outputStorage: flyioDeps?.storage,
        });
        cacheSavingsUsd = written.cacheSavingsUsd;
      } else {
        // Failed run — status=failed + error, no usage_* (DB DEFAULT 0). As on
        // a completion, a run whose account was deleted while it ran loses the
        // output directory registered above: finalizeRun drops it.
        written = await finalizeRun(db, log, runId, finalClaim, {
          status: "failed",
          error: resultError ?? null,
          now: new Date(),
          mode: "sync",
          runtimeMode,
        });
      }
      // The response says what the row says: a row that stayed failed, or a
      // failure the stop's rule made the stop's, is answered as that failure.
      const told = failureToTell(written);
      // A run the server's stop ended did not fail on its own: 503 says so, and
      // that sending it again makes sense.
      if (told?.code === SHUTDOWN_RUN_ERROR_CODE) {
        return c.json({ error: { code: told.code, message: told.message } }, 503);
      }
      // A run its deadline stopped: 504, as a timeout is.
      if (told?.code === RUN_DEADLINE_ERROR_CODE) {
        return c.json({ error: { code: told.code, message: told.message } }, 504);
      }
      const answeredError = told ? told.message : resultError;

      return c.json({
        run_id: result.runId,
        status: told ? "failed" : result.status,
        agent_version: resolvedVersion,
        output: result.output,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
          // Prompt-caching fields — snake_case wire format. Surfaced
          // only when present (provider returned cache activity).
          ...(result.usage.cacheReadTokens !== undefined && {
            cache_read_tokens: result.usage.cacheReadTokens,
          }),
          ...(result.usage.cacheWriteTokens !== undefined && {
            cache_write_tokens: result.usage.cacheWriteTokens,
          }),
        },
        ...(warnings.length > 0 && { warnings }),
        cost: {
          estimated: result.usage.estimatedCost,
          // Surface cache savings when present (omit when 0 to keep responses lean)
          ...(cacheSavingsUsd > 0 && { saved: cacheSavingsUsd }),
        },
        duration_ms: result.durationMs,
        files: buildFilesResponse(result.files),
        // How many output files were left out, by reason — always present, `{}`
        // when none was (a failed run collected none).
        files_excluded: result.filesExcluded ?? {},
        ...(answeredError && { error: answeredError }),
      });
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      let errorMessage = err instanceof Error ? err.message : "Agent execution failed";
      errorMessage = sanitizeError(errorMessage);

      // Track failed run
      const written = await finalizeRun(db, log, runId, finalClaim, {
        status: "failed",
        error: errorMessage,
        now: new Date(),
        mode: "sync",
        runtimeMode,
      });
      // Answered as the row says; the stop's failure under its code, and 503;
      // the deadline's under its own, and 504.
      const told = failureToTell(written);
      const stopped = told?.code === SHUTDOWN_RUN_ERROR_CODE;
      const deadline = told?.code === RUN_DEADLINE_ERROR_CODE;

      return c.json(
        {
          error: {
            code: told?.code ?? (isTimeout ? "TIMEOUT" : "EXECUTION_FAILED"),
            message: told?.message ?? errorMessage,
          },
        },
        stopped ? 503 : isTimeout || deadline ? 504 : 502,
      );
    }
  };

  router.post("/agents/:namespace/:name/run", authMiddleware, async (c) => {
    const hold = new RunHold();
    const admitted: { run?: AdmittedRun } = {};
    try {
      return await handleRun(c, hold, admitted);
    } finally {
      // A run admitted — its row written — that has no final status and was
      // handed to no stream and no background task: an exception between its
      // row's write and its mode, or one its synchronous path let through. It
      // ends failed here, before its hold goes; the error goes on as it was.
      if (admitted.run && !hold.handedOff) await admitted.run.endFailedUnlessFinal();
      hold.releaseUnlessHandedOff();
      // A run not handed on has settled once its hold is given back: it leaves
      // the registry of runs in flight. One handed on settles at its own end.
      if (admitted.run && !hold.handedOff) admitted.run.settle();
    }
  });

  return router;
}
