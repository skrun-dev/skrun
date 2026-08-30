import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileInfo, RunEvent, RuntimeAdapter } from "@skrun-dev/runtime";
import {
  createLogger,
  FlyioAdapter,
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
import type { Agent } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import type { FlyioRuntimeDeps, RuntimeMode } from "../runtime/adapter-selection.js";
import { assertAgentRunnableOrThrow } from "../services/access.js";
import { resolveCreatorKeys } from "../services/creator-llm-key.js";
import { assertKeyScopeOrThrow, isMasterCredential } from "../services/key-scope.js";
import type { RegistryService } from "../services/registry.js";
import { RegistryError } from "../services/registry.js";
import type { KeyProvider } from "../services/secrets/key-provider.js";
import {
  isRunGatedByVerification,
  type VerificationPolicy,
} from "../services/verification-policy.js";
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

export function createRunRoutes(
  service: RegistryService,
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  opts: CreateRunRoutesOptions = {},
): Hono {
  const router = new Hono();
  const runtimeMode: RuntimeMode = opts.runtimeMode ?? "local";
  const flyioDeps = opts.flyioDeps;
  if (runtimeMode === "flyio" && !flyioDeps) {
    throw new Error(
      "createRunRoutes: runtimeMode=flyio requires flyioDeps — set both via createApp.",
    );
  }

  // POST /run is run-authorized (see assertAgentRunnableOrThrow): public agents
  // run for any authenticated caller; private agents only for their owner/admin.
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
    // by the credential's owner, checked against the agent's declared base_url
    // once the bundle is parsed (see the caller gate below). Absent stays
    // `undefined` rather than `{}`: the distinction carries meaning in the gate.
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
    // agents are owner/admin-only; a non-owner gets a 404 byte-identical to a
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

    // 2d. Environment-override authorization: only the owner/admin may override
    // the creator's declared environment (e.g. widen allowed_hosts, swap
    // secrets). Checked BEFORE the bundle pull so an unauthorized override
    // fails fast; the actual shallow merge happens at step 5b.
    if (environmentOverride && !(agent?.owner_id === user.id || user.role === "admin")) {
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

    // 2e. Caller-key policy + creator-key resolution. AFTER the #65 scope gate and
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
      try {
        creatorKeys = await resolveCreatorKeys(db, opts.keyProvider, agent.id);
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

    // 3. Load agent from registry (optionally pinned to `requestedVersion`)
    let bundleBuffer: Buffer;
    let resolvedVersion: string;
    let resolvedVerified: boolean;
    try {
      const result = await service.pull(namespace, name, requestedVersion, {
        preloadedAgent: agent ?? undefined,
      });
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

    // 3b. Verified gate, governed by the operator verification policy. Under the
    // `admin` policy a version must be approved before it can run (the legacy
    // behavior); under `owner`/`disabled` the owner is the trust authority and
    // private agents run without this gate (sandbox isolation + reactive abuse).
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

    // 4. Extract bundle to disk (cached by namespace/name/version)
    let skillContent = "";
    let agentYamlContent = "";
    let agentsMdContent: string | undefined;
    let bundleDir = "";

    try {
      const cacheKey = `${namespace}/${name}/${resolvedVersion}`;
      const entry = await getOrExtract(bundleCache, cacheKey, bundleBuffer);
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

    // 5b. Caller gate — layer 3 of the credential-destination rule.
    //
    // The rule the whole finding reduces to: a credential may only be sent to an
    // endpoint chosen by the credential's OWNER. `model.base_url` is chosen by
    // the agent's author; an `X-LLM-API-Key` belongs to the caller. When those
    // are different people, the caller must have named the destination.
    //
    // This is the earliest possible point: `base_url` lives inside the versioned
    // bundle, so it is not knowable before `parseAgentYaml` above — unlike the
    // `creator_only` reject, which fires pre-pull. It still precedes every LLM
    // allocation, which is what matters.
    //
    // The exemption is `owner AND master credential`, not `owner` alone: a
    // delegated `scope_kind:"agents"` key carries the OWNER's `user.id` by
    // construction (auth.ts builds the context from the key's owner, and such a
    // key can only be minted over agents the minter owns), so `owner_id ===
    // user.id` is true for the very party this gate exists to protect against.
    // An admin is deliberately NOT exempt — unlike the env-override gate above —
    // because an admin does not own the caller's LLM key either.
    if (callerKeys !== undefined && agent) {
      const isSamePrincipal = agent.owner_id === user.id && isMasterCredential(user);
      if (!isSamePrincipal) {
        const declared = agentConfig.model?.base_url;
        const provider = agentConfig.model?.provider;
        const consented = provider ? callerBaseUrls?.[provider] : undefined;
        const sameOrigin = (a: string, b: string): boolean => {
          try {
            return new URL(a).origin === new URL(b).origin;
          } catch {
            return false;
          }
        };
        // Compared by ORIGIN, not exact string: legitimate paths differ
        // ("/v1" vs "/api/paas/v4/") and the exfiltration risk is the host.
        const mismatch =
          declared && consented
            ? !sameOrigin(declared, consented)
            : Boolean(declared) !== Boolean(consented);
        if (mismatch) {
          return c.json(
            {
              error: {
                code: "CALLER_BASE_URL_NOT_CONSENTED",
                message: declared
                  ? `This agent sends model requests to ${new URL(declared).origin}, which you did not choose. ` +
                    "Your X-LLM-API-Key would be sent there. To proceed, declare that origin in the " +
                    `X-LLM-Base-URL header, e.g. {"${provider}": "${new URL(declared).origin}"}.` +
                    (consented
                      ? ` You declared ${new URL(consented).origin}, which does not match.`
                      : "")
                  : "You declared an X-LLM-Base-URL, but this agent does not use a custom endpoint — " +
                    "your key would go to the provider's default. Omit the header to proceed.",
              },
            },
            403,
          );
        }
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

    // 5b. Merge environment override (owner/admin-only — authorized at step 2c).
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
    const runOutputDir = join(tmpdir(), `skrun-outputs-${runId}`);
    mkdirSync(runOutputDir, { recursive: true });

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

    // 8. Track run in database (reuse the agent + user loaded at run-auth)
    await db.createRun({
      id: runId,
      agent_id: agent?.id ?? null,
      agent_version: `${namespace}/${name}@${resolvedVersion}`,
      model: modelStr,
      user_id: user.id,
      api_key_id: user.key?.id ?? null,
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
    const stateCallbacks = createNamespacedStateCallbacks(db, namespace);
    let adapter: RuntimeAdapter;
    if (runtimeMode === "flyio") {
      const deps = flyioDeps as FlyioRuntimeDeps; // ctor-validated; cast is safe
      adapter = new FlyioAdapter(
        deps.flyApi,
        deps.storage,
        globalRouter,
        toolRegistry,
        stateCallbacks,
        {
          runtimeImage: deps.runtimeImageTag,
          // Absent unless the operator configured one; then a run wakes a
          // pre-created machine instead of creating its own.
          pool: deps.pool,
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
                {
                  event: "db_update_failed",
                  run_id: runId,
                  error: err instanceof Error ? err.message : String(err),
                },
                "DB updateRun failed (runner_spawned telemetry)",
              ),
            );
          },
        },
        log,
      );
    } else {
      adapter = new LocalAdapter(globalRouter, toolRegistry, stateCallbacks, log);
    }

    // Bundle key follows the registry's storage convention (see
    // RegistryService.pull). FlyioAdapter reads it to generate the
    // presigned download URL handed to the spawned runner — LocalAdapter
    // ignores it (bundle is already on the harness filesystem).
    const bundleKey = `${namespace}/${name}/${resolvedVersion}.agent`;

    const runRequest = {
      agentConfig,
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
      // Caller-disconnect / harness-shutdown safety: the cloud adapter
      // listens on this to guarantee a spawned machine is destroyed even
      // when the SSE stream closes mid-run.
      abortSignal: c.req.raw.signal,
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
    // (sanitizeError, used in all three failure paths — B-3). A provider 4xx can
    // echo a key fragment; without this it would land in runs.error + GET /runs/:id. ---
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
                error: sanitizeError(event.error.message),
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
                  error: sanitizeError(event.error.message),
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
      errorMessage = sanitizeError(errorMessage);

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
