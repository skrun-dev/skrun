import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  LLMRouter,
  LocalAdapter,
  McpToolProvider,
  MemoryStateStore,
  ScriptToolProvider,
  ToolRegistry,
  redactSecretsFromString,
} from "@skrun-dev/runtime";
import type { RunEvent, StateStore } from "@skrun-dev/runtime";
import { parseAgentYaml } from "@skrun-dev/schema";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth.js";
import type { RegistryService } from "../services/registry.js";
import { RegistryError } from "../services/registry.js";
import { formatSSEEvent } from "../utils/sse.js";

// Shared state store (persists across runs for the same server instance)
const globalStateStore = new MemoryStateStore();
const globalRouter = new LLMRouter();

export function createRunRoutes(service: RegistryService, stateStore?: StateStore): Hono {
  const router = new Hono();
  const state = stateStore ?? globalStateStore;

  router.post("/agents/:namespace/:name/run", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const runId = randomUUID();

    // --- Detect execution mode ---
    const acceptHeader = c.req.header("Accept") ?? "";
    const isSSE = acceptHeader.includes("text/event-stream");

    // 1. Parse request body
    let input: Record<string, unknown>;
    let webhookUrl: string | undefined;
    try {
      const body = await c.req.json();
      input = body.input ?? body;
      webhookUrl = body.webhook_url;
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

    // 3. Load agent from registry
    let bundleBuffer: Buffer;
    try {
      const result = await service.pull(namespace, name);
      bundleBuffer = result.buffer;
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }

    // 4. Extract bundle to disk
    let skillContent = "";
    let agentYamlContent = "";
    let agentsMdContent: string | undefined;
    let bundleDir = "";
    let cleanupBundle = () => {};

    try {
      const { extractBundleToDisk } = await import("../utils/bundle.js");
      const extracted = extractBundleToDisk(bundleBuffer);
      bundleDir = extracted.dir;
      cleanupBundle = extracted.cleanup;
      skillContent = extracted.files["SKILL.md"] ?? "";
      agentYamlContent = extracted.files["agent.yaml"] ?? "";
      agentsMdContent = extracted.files["AGENTS.md"];
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

    // 6. Validate inputs
    for (const field of agentConfig.inputs) {
      if (field.required && !(field.name in input)) {
        return c.json(
          { error: { code: "MISSING_INPUT", message: `Missing required input: ${field.name}` } },
          400,
        );
      }
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

    // 7. Setup tool registry
    const toolRegistry = new ToolRegistry();
    const warnings: string[] = [];

    if (bundleDir) {
      const { existsSync } = await import("node:fs");
      const scriptsDir = join(bundleDir, "scripts");
      if (existsSync(scriptsDir)) {
        const token = c.req.header("Authorization")?.slice(7).trim() ?? "";
        const isDevToken = token === "dev-token";
        let isVerified = false;
        try {
          const metadata = await service.getMetadata(namespace, name);
          isVerified = metadata.verified;
        } catch {
          // Agent not found in registry — treat as unverified
        }

        if (isVerified || isDevToken) {
          const scriptProvider = new ScriptToolProvider(scriptsDir);
          await toolRegistry.addProvider(scriptProvider);
        } else {
          warnings.push("agent_not_verified_scripts_disabled");
        }
      }
    }

    for (const mcpServer of agentConfig.mcp_servers) {
      const mcpProvider = new McpToolProvider(mcpServer);
      await toolRegistry.addProvider(mcpProvider);
    }

    // 8. Create adapter
    const adapter = new LocalAdapter(globalRouter, toolRegistry, state);
    const runRequest = { agentConfig, skillContent, agentsMdContent, input, runId, callerKeys };

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
            const sanitized = sanitizeEvent(event);
            const { event: eventName, data } = formatSSEEvent(sanitized);
            await stream.writeSSE({ event: eventName, data });
          }
        } finally {
          await toolRegistry.disconnectAll();
          cleanupBundle();
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
              finalResult = {
                run_id: runId,
                status: "completed",
                output: event.output,
                usage: event.usage,
                ...(warnings.length > 0 && { warnings }),
                cost: event.cost,
                duration_ms: event.duration_ms,
              };
            } else if (event.type === "run_error") {
              const sanitized = sanitizeEvent(event);
              finalResult = {
                run_id: runId,
                status: "failed",
                error: (sanitized as Extract<RunEvent, { type: "run_error" }>).error,
              };
            }
          }
          if (finalResult) {
            const { deliverWebhook } = await import("../utils/webhook.js");
            await deliverWebhook(targetUrl, finalResult);
          }
        } catch (err) {
          console.error(`[Webhook] Background execution failed for ${namespace}/${name}:`, err);
        } finally {
          await toolRegistry.disconnectAll();
          cleanupBundle();
        }
      })();

      return c.json({ run_id: runId }, 202);
    }

    // ==================== SYNC MODE (default) ====================
    try {
      const result = await adapter.execute(runRequest);

      await toolRegistry.disconnectAll();
      cleanupBundle();

      return c.json({
        run_id: result.runId,
        status: result.status,
        output: result.output,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
        ...(warnings.length > 0 && { warnings }),
        cost: {
          estimated: result.usage.estimatedCost,
        },
        duration_ms: result.durationMs,
        ...(result.error && { error: result.error }),
      });
    } catch (err) {
      await toolRegistry.disconnectAll();
      cleanupBundle();

      const isTimeout = (err as Error).name === "TimeoutError";
      let errorMessage = err instanceof Error ? err.message : "Agent execution failed";

      if (callerKeys) {
        errorMessage = redactSecretsFromString(errorMessage, Object.values(callerKeys));
      }

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
