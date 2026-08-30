import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { Agent, AgentLlmKeyPolicy } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import {
  attachCreatorKey,
  listCreatorKeys,
  removeCreatorKey,
} from "../services/creator-llm-key.js";
import type { KeyProvider } from "../services/secrets/key-provider.js";
import { dispatchRegistryError, requireMasterCredential } from "./_helpers.js";

/** Lowercase-kebab path segments, length ≤64 (mirrors registry.ts). */
const PATH_SEGMENT_REGEX = /^[a-z0-9-]{1,64}$/;

/**
 * Creator-attached LLM key management — all endpoints are WRITE-ONLY: the
 * plaintext key is never returned (GET surfaces provider + last4 only). Every
 * route is gated by a master credential (an account-wide key, a session, or a
 * dev-token) + namespace owner/admin, so a delegated or operation-limited key
 * cannot read or change an agent's keys.
 */
export function createAgentLlmKeyRoutes(
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  keyProvider: KeyProvider,
): Hono {
  const router = new Hono();

  // Shared write-side guard: master credential, then namespace owner/admin, then
  // the loaded agent. A 403 fires BEFORE any agent lookup (no existence oracle);
  // a 404 only when the agent is genuinely absent in the caller's own namespace.
  // Returns the agent, or a Response to short-circuit.
  async function ownedAgent(c: Context): Promise<Agent | Response> {
    const { namespace, name } = c.req.param();
    if (!PATH_SEGMENT_REGEX.test(namespace) || !PATH_SEGMENT_REGEX.test(name)) {
      return c.json(
        {
          error: {
            code: "INVALID_AGENT_NAME",
            message: "namespace and name must be lowercase kebab-case (a-z, 0-9, hyphen, ≤64).",
          },
        },
        400,
      );
    }
    const user = getUser(c);
    const denied = requireMasterCredential(c);
    if (denied) return denied;
    if (namespace !== user.namespace && user.role !== "admin") {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to manage agents in namespace '${namespace}'.`,
          },
        },
        403,
      );
    }
    const agent = await db.getAgent(namespace, name);
    if (!agent) {
      return c.json(
        { error: { code: "AGENT_NOT_FOUND", message: `Agent ${namespace}/${name} not found.` } },
        404,
      );
    }
    return agent;
  }

  // GET — caller-key policy + the presence list (provider + last4 + updated_at).
  router.get("/agents/:namespace/:name/llm-keys", authMiddleware, async (c) => {
    const agent = await ownedAgent(c);
    if (agent instanceof Response) return agent;
    const keys = await listCreatorKeys(db, agent);
    return c.json({ policy: agent.llm_key_policy, keys });
  });

  // PUT — attach (or replace) a provider's key. Body `{ key }`; never echoed back.
  router.put("/agents/:namespace/:name/llm-keys/:provider", authMiddleware, async (c) => {
    const agent = await ownedAgent(c);
    if (agent instanceof Response) return agent;
    let body: { key?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }
    if (typeof body.key !== "string") {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Body must contain { key: string }." } },
        400,
      );
    }
    try {
      const attached = await attachCreatorKey(
        db,
        keyProvider,
        agent,
        c.req.param("provider"),
        body.key,
      );
      return c.json(attached);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // DELETE — remove a provider's key.
  router.delete("/agents/:namespace/:name/llm-keys/:provider", authMiddleware, async (c) => {
    const agent = await ownedAgent(c);
    if (agent instanceof Response) return agent;
    await removeCreatorKey(db, agent, c.req.param("provider"));
    return c.body(null, 204);
  });

  // PUT — set the caller-key policy (`open` | `creator_only`).
  router.put("/agents/:namespace/:name/llm-key-policy", authMiddleware, async (c) => {
    const agent = await ownedAgent(c);
    if (agent instanceof Response) return agent;
    let body: { policy?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }
    if (body.policy !== "open" && body.policy !== "creator_only") {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: 'Body must contain { policy: "open" | "creator_only" }.',
          },
        },
        400,
      );
    }
    const { namespace, name } = c.req.param();
    const updated = await db.setLlmKeyPolicy(namespace, name, body.policy as AgentLlmKeyPolicy);
    const policy = updated?.llm_key_policy ?? body.policy;
    // Non-blocking guard: locking to creator_only without any attached key means
    // runs fail unless the caller or a server key covers the provider.
    if (policy === "creator_only" && (await listCreatorKeys(db, agent)).length === 0) {
      return c.json({
        policy,
        warning:
          "No creator LLM key is attached — runs will fail unless a caller provides a key or a server key is configured.",
      });
    }
    return c.json({ policy });
  });

  return router;
}
