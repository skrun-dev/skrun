import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileInfo, RunEvent } from "@skrun-dev/runtime";
import {
  createLogger,
  isHostAllowed,
  LLMRouter,
  LocalAdapter,
  McpConnectError,
  McpToolProvider,
  ResolveError,
  redactSecretsFromString,
  resolveInput,
  ScriptToolProvider,
  type SkrunPart,
  ToolRegistry,
  TTLCache,
} from "@skrun-dev/runtime";
import { type FileInputField, parseAgentYaml } from "@skrun-dev/schema";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bundleCache, getOrExtract } from "../cache/bundle-cache.js";
import { depsCache } from "../cache/deps-cache.js";
import { getInputFile } from "../cache/input-cache.js";
import { registerOutput } from "../cache/output-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import type { RegistryService } from "../services/registry.js";
import { RegistryError } from "../services/registry.js";
import { formatSSEEvent } from "../utils/sse.js";
import { dispatchRegistryError, persistRunCompletion } from "./_helpers.js";

const globalRouter = new LLMRouter();
const logger = createLogger("api");

/**
 * Wrap a DB's getState/setState so the runtime adapter's slug-only `name` is
 * automatically scoped under the request's namespace. The `agent_state` row
 * is keyed as `<namespace>/<slug>` — preventing two same-slug agents in
 * different namespaces from colliding on the same state.
 *
 * Exported so the multi-tenant wiring contract is testable in isolation.
 */
export function createNamespacedStateCallbacks(db: DbAdapter, namespace: string) {
  return {
    getState: (slug: string) => db.getState(`${namespace}/${slug}`),
    setState: (slug: string, state: Record<string, unknown>) =>
      db.setState(`${namespace}/${slug}`, state),
  };
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

const SEMVER_STRICT = /^\d+\.\d+\.\d+$/;

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

export function createRunRoutes(
  service: RegistryService,
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
): Hono {
  const router = new Hono();

  // POST /run is public — any authenticated user can run any agent (marketplace model)
  router.post("/agents/:namespace/:name/run", authMiddleware, async (c) => {
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
      input = body.input ?? body;
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

    // --- Validate webhook_url ---
    if (webhookUrl) {
      try {
        const url = new URL(webhookUrl);
        const isDev = process.env.NODE_ENV !== "production";
        if (!isDev && url.protocol !== "https:") {
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
        // unrestricted ["*"] mode (isHostAllowed defense-in-depth via isPrivateHost).
        // Dev mode bypass: same rationale as the HTTPS check above — local
        // webhook listeners on `http://localhost:NNNN/...` are the standard
        // way to test webhook delivery during development. Production keeps
        // the guard so AWS IMDS / localhost services are unreachable.
        if (!isDev && !isHostAllowed(url.hostname, ["*"])) {
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

    // 3. Load agent from registry (optionally pinned to `requestedVersion`)
    let bundleBuffer: Buffer;
    let resolvedVersion: string;
    let resolvedVerified: boolean;
    try {
      const result = await service.pull(namespace, name, requestedVersion);
      bundleBuffer = result.buffer;
      resolvedVersion = result.version;
      resolvedVerified = result.verified;
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

    // 3b. Hard verified gate — admin must approve a version before it can run.
    // Per-version flag enables incremental trust: a new push starts unverified
    // without invalidating prior verified versions (pinned callers protected).
    // Pre-empts LLM allocation, MCP connect, file alloc, DB write — none of
    // which should happen for an unapproved version.
    if (!resolvedVerified) {
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

    // 4. Extract bundle to disk (cached by namespace/name/version)
    let skillContent = "";
    let agentYamlContent = "";
    let agentsMdContent: string | undefined;
    let bundleDir = "";

    try {
      const cacheKey = `${namespace}/${name}/${resolvedVersion}`;
      const entry = getOrExtract(bundleCache, cacheKey, bundleBuffer);
      bundleDir = entry.dir;
      skillContent = entry.files["SKILL.md"] ?? "";
      agentYamlContent = entry.files["agent.yaml"] ?? "";
      agentsMdContent = entry.files["AGENTS.md"];
    } catch {
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

    // 5. Parse agent config
    let agentConfig: ReturnType<typeof parseAgentYaml>["config"];
    try {
      const parsed = parseAgentYaml(agentYamlContent);
      agentConfig = parsed.config;
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_CONFIG",
            message: err instanceof Error ? err.message : "Invalid agent.yaml",
          },
        },
        500,
      );
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

    // 5b. Merge environment override (if provided)
    if (environmentOverride) {
      const { networking: netOverride, ...flatOverride } = environmentOverride as {
        networking?: { allowed_hosts?: string[] };
        [key: string]: unknown;
      };
      const mergedNetworking = netOverride
        ? { ...agentConfig.environment.networking, ...netOverride }
        : agentConfig.environment.networking;
      agentConfig = {
        ...agentConfig,
        environment: { ...agentConfig.environment, ...flatOverride, networking: mergedNetworking },
      };
    }

    // 6. Validate inputs (primitive types only; file inputs are handled by resolveInput below)
    for (const field of agentConfig.inputs) {
      if (field.required && !(field.name in input)) {
        return c.json(
          { error: { code: "MISSING_INPUT", message: `Missing required input: ${field.name}` } },
          400,
        );
      }
      if (field.type === "file") continue; // file fields validated by resolveInput
      if (field.name in input) {
        const value = input[field.name];
        const actualType = Array.isArray(value) ? "array" : typeof value;
        const expectedType = field.type;
        if (
          expectedType !== "object" &&
          actualType !== expectedType &&
          !(expectedType === "array" && Array.isArray(value))
        ) {
          return c.json(
            {
              error: {
                code: "INVALID_INPUT_TYPE",
                message: `Input "${field.name}" expected ${expectedType}, got ${actualType}`,
              },
            },
            400,
          );
        }
      }
    }

    // 6b. Resolve file inputs to SkrunPart[] (Tasks 3.1, 6.1+6.2+6.4)
    let resolvedInputs: Map<string, SkrunPart[]> | undefined;
    const fileSchemas = agentConfig.inputs.filter((f): f is FileInputField => f.type === "file");
    if (fileSchemas.length > 0) {
      try {
        resolvedInputs = await resolveInput(input, fileSchemas, {
          fetchInputFile: async (fileId) => {
            const meta = getInputFile(fileId);
            if (!meta) return null;
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
          const httpCode =
            err.code === "INLINE_TOO_LARGE" || err.code === "MAX_COUNT_EXCEEDED"
              ? 413
              : err.code === "URL_NOT_ALLOWED"
                ? 403
                : err.code === "FILE_NOT_FOUND"
                  ? 404
                  : err.code === "REQUIRED_INPUT_MISSING"
                    ? 400
                    : err.code === "URL_FETCH_FAILED"
                      ? 502
                      : 400;
          return c.json({ error: { code: err.code, message: err.message } }, httpCode);
        }
        throw err;
      }
    }

    // 7. Setup tool registry
    const toolRegistry = new ToolRegistry();
    const warnings: string[] = [];
    const allowedHosts = agentConfig.environment.networking.allowed_hosts;

    // Create the per-run output directory NOW, before constructing the
    // script provider — the provider passes this path to spawned scripts
    // via SKRUN_OUTPUT_DIR. Re-used by LocalAdapter for output collection
    // (LocalAdapter no-ops when outputDir is already set).
    const runOutputDir = join(tmpdir(), `skrun-outputs-${runId}`);
    mkdirSync(runOutputDir, { recursive: true });

    if (bundleDir) {
      const { existsSync } = await import("node:fs");
      const scriptsDir = join(bundleDir, "scripts");
      if (existsSync(scriptsDir)) {
        // Hard 403 verified gate upstream (Phase 3b) ensures only admin-approved
        // versions reach this code path — scripts register unconditionally now.
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

    try {
      for (const mcpServer of agentConfig.mcp_servers) {
        const tempProvider = new McpToolProvider(mcpServer, undefined, allowedHosts);
        const configKey = `${tempProvider.getConfigKey()}:${JSON.stringify(allowedHosts)}`;
        let mcpProvider = mcpCache.get(configKey);
        if (!mcpProvider) {
          mcpProvider = tempProvider;
          // Throws `McpConnectError` on timeout / transport failure. Only
          // cache on success — caching a broken provider would lock the
          // bad state in for the TTL window.
          await mcpProvider.listTools();
          mcpCache.set(configKey, mcpProvider);
        }
        await toolRegistry.addProvider(mcpProvider);
      }
    } catch (err) {
      if (err instanceof McpConnectError) {
        return c.json(
          {
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          502,
        );
      }
      throw err;
    }

    // 8. Track run in database
    const caller = getUser(c);
    let agentId: string | null = null;
    try {
      const agentRecord = await db.getAgent(namespace, name);
      agentId = agentRecord?.id ?? null;
    } catch {
      // Non-critical — run tracking proceeds with null agent_id
    }
    await db.createRun({
      id: runId,
      agent_id: agentId,
      agent_version: `${namespace}/${name}@${resolvedVersion}`,
      model: modelStr,
      user_id: caller.id,
      status: "running",
      input,
    });

    // 9. Create adapter with request-scoped child logger
    const log = logger.child({
      run_id: runId,
      agent: `${namespace}/${name}`,
      agent_version: resolvedVersion,
    });
    // State callbacks: the runtime passes `config.name` (slug-only) as the
    // key. We prefix with the request's namespace so the DB row is scoped to
    // `<namespace>/<slug>`. Two same-slug agents in different namespaces stay
    // isolated.
    const adapter = new LocalAdapter(
      globalRouter,
      toolRegistry,
      createNamespacedStateCallbacks(db, namespace),
      log,
    );
    const runRequest = {
      agentConfig,
      skillContent,
      agentsMdContent,
      input,
      runId,
      callerKeys,
      agent_version: resolvedVersion,
      outputDir: runOutputDir as string | undefined,
      resolvedInputs,
      // environmentId for prompt-cache routing. The API doesn't have
      // persistent env records keyed by ID today; "default" gives stable
      // cache pools per (agent, version). Future feature can hash
      // environmentOverride for per-shape isolation.
      environmentId: "default",
    };

    // Helper: build files array with download URLs from FileInfo[]
    const buildFilesResponse = (files: FileInfo[] | undefined) =>
      (files ?? []).map((f) => ({
        name: f.name,
        size: f.size,
        url: `/api/runs/${runId}/files/${encodeURIComponent(f.name)}`,
        ...(f.file_id && { file_id: f.file_id }),
      }));

    // --- Sanitize helper: strip caller keys from event error messages ---
    const sanitizeEvent = (event: RunEvent): RunEvent => {
      if (event.type === "run_error" && callerKeys) {
        return {
          ...event,
          error: {
            ...event.error,
            message: redactSecretsFromString(event.error.message, Object.values(callerKeys)),
          },
        };
      }
      return event;
    };

    // ==================== SSE MODE ====================
    if (isSSE) {
      return streamSSE(c, async (stream) => {
        try {
          for await (const event of adapter.executeStream(runRequest)) {
            if (event.type === "run_complete") {
              if (runRequest.outputDir) {
                registerOutput(runId, runRequest.outputDir, event.files);
              }
              // Update run in DB (same as sync mode)
              const sseCacheReadTokens = event.usage.cache_read_tokens ?? 0;
              const sseCacheWriteTokens = event.usage.cache_write_tokens ?? 0;
              persistRunCompletion(
                db,
                log,
                runId,
                modelForCostLookup,
                {
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
                "sse",
              );
            } else if (event.type === "run_error") {
              db.updateRun(runId, {
                status: "failed",
                error: event.error.message,
                completed_at: new Date().toISOString(),
              }).catch((err) =>
                log.error(
                  {
                    event: "db_update_failed",
                    run_id: runId,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  "DB updateRun failed (SSE error)",
                ),
              );
            }
            const sanitized = sanitizeEvent(event);
            const { event: eventName, data } = formatSSEEvent(sanitized);
            await stream.writeSSE({ event: eventName, data });
          }
        } finally {
          // MCP disconnect handled by cache eviction
          // Bundle cleanup handled by cache eviction
        }
      });
    }

    // ==================== WEBHOOK MODE ====================
    if (webhookUrl) {
      const targetUrl = webhookUrl;
      // Fire and forget — execute in background
      (async () => {
        try {
          let finalResult: Record<string, unknown> | undefined;
          for await (const event of adapter.executeStream(runRequest)) {
            if (event.type === "run_complete") {
              if (runRequest.outputDir) {
                registerOutput(runId, runRequest.outputDir, event.files);
              }
              // Persist usage to DB — mirrors sync/SSE pattern. This was a
              // latent gap since #3 streaming: webhook-mode runs never wrote
              // usage data, so token counts and savings were silently 0 in
              // stats and run-detail.
              const whCacheReadTokens = event.usage.cache_read_tokens ?? 0;
              const whCacheWriteTokens = event.usage.cache_write_tokens ?? 0;
              const { cacheSavingsUsd: whCacheSavingsUsd } = await persistRunCompletion(
                db,
                log,
                runId,
                modelForCostLookup,
                {
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
                "webhook",
              );
              finalResult = {
                run_id: runId,
                status: "completed",
                agent_version: resolvedVersion,
                output: event.output,
                usage: event.usage,
                ...(warnings.length > 0 && { warnings }),
                cost: {
                  ...(event.cost ?? {}),
                  // Surface cache savings on the webhook payload too
                  ...(whCacheSavingsUsd > 0 && { saved: whCacheSavingsUsd }),
                },
                duration_ms: event.duration_ms,
                files: buildFilesResponse(event.files),
              };
            } else if (event.type === "run_error") {
              const sanitized = sanitizeEvent(event);
              // Persist failure to DB — explicitly omit ALL usage_* fields
              // (mirrors sync fail path L695-702). Cache fields stay at the
              // DB DEFAULT 0 — no partial accounting for failed runs.
              await db
                .updateRun(runId, {
                  status: "failed",
                  error: event.error.message,
                  completed_at: new Date().toISOString(),
                })
                .catch((err) =>
                  log.error(
                    {
                      event: "db_update_failed",
                      run_id: runId,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    "DB updateRun failed (webhook error)",
                  ),
                );
              finalResult = {
                run_id: runId,
                status: "failed",
                agent_version: resolvedVersion,
                error: (sanitized as Extract<RunEvent, { type: "run_error" }>).error,
              };
            }
          }
          if (finalResult) {
            const { deliverWebhook } = await import("../utils/webhook.js");
            await deliverWebhook(targetUrl, finalResult, undefined, log);
          }
        } catch (err) {
          log.error(
            { event: "webhook_bg_error", error: err instanceof Error ? err.message : String(err) },
            "Background execution failed",
          );
        } finally {
          // MCP disconnect handled by cache eviction
          // Bundle cleanup handled by cache eviction
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
      if (result.status === "completed") {
        ({ cacheSavingsUsd } = await persistRunCompletion(
          db,
          log,
          runId,
          modelForCostLookup,
          {
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
          "sync",
        ));
      } else {
        // Failed run — write status=failed + error, omit usage_* (DB DEFAULT 0).
        await db
          .updateRun(runId, {
            status: "failed",
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          })
          .catch((err) =>
            log.error(
              {
                event: "db_update_failed",
                run_id: runId,
                error: err instanceof Error ? err.message : String(err),
              },
              "DB updateRun failed (sync failed-result path)",
            ),
          );
      }

      return c.json({
        run_id: result.runId,
        status: result.status,
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
        ...(result.error && { error: result.error }),
      });
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      let errorMessage = err instanceof Error ? err.message : "Agent execution failed";

      if (callerKeys) {
        errorMessage = redactSecretsFromString(errorMessage, Object.values(callerKeys));
      }

      // Track failed run
      await db
        .updateRun(runId, {
          status: "failed",
          error: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .catch((err) =>
          log.error(
            {
              event: "db_update_failed",
              run_id: runId,
              error: err instanceof Error ? err.message : String(err),
            },
            "DB updateRun failed (sync error path)",
          ),
        );

      return c.json(
        {
          error: {
            code: isTimeout ? "TIMEOUT" : "EXECUTION_FAILED",
            message: errorMessage,
          },
        },
        isTimeout ? 504 : 502,
      );
    }
  });

  return router;
}
