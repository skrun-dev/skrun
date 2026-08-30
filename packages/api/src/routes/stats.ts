import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { Run, RunStatus } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { assertAgentVisibleOrThrow } from "../services/access.js";
import { assertNotDelegatedOrThrow, isDelegatedKey } from "../services/key-scope.js";
import { dispatchRegistryError } from "./_helpers.js";

/** Run history / usage is not available to a resource-scoped (delegated) key. */
function denyDelegated(c: Context) {
  return c.json(
    {
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message: "This endpoint is not available to a resource-scoped API key.",
      },
    },
    403,
  );
}

/**
 * Strip operator-only telemetry (the runner's machine id + private IP) from a
 * tenant-facing run response. `phase_timings` (durations) stays — it is the
 * public cold-start breakdown, also carried by the runner_spawned event.
 */
function toRunResponse(run: Run): Omit<Run, "machine_id" | "private_ip"> {
  const { machine_id: _machineId, private_ip: _privateIp, ...rest } = run;
  return rest;
}

export function createStatsRoutes(db: DbAdapter, authMiddleware: MiddlewareHandler): Hono {
  const router = new Hono();

  router.get("/stats", authMiddleware, async (c) => {
    // Multi-tenancy: filter aggregates by the authenticated user. In dev-token
    // / single-tenant self-host the user id is deterministic so the filter
    // narrows to that user (effectively instance-wide). In cloud / shared
    // instances each user sees only their own runs.
    const user = getUser(c);
    if (isDelegatedKey(user)) return denyDelegated(c);
    const stats = await db.getStats({ userId: user.id });
    return c.json(stats);
  });

  router.get("/runs", authMiddleware, async (c) => {
    const agentId = c.req.query("agent_id");
    const status = c.req.query("status") as RunStatus | undefined;
    const limit = Number(c.req.query("limit") ?? "50");
    const user = getUser(c);
    if (isDelegatedKey(user)) return denyDelegated(c);

    const runs = await db.listRuns({
      agent_id: agentId || undefined,
      user_id: user.id,
      status: status || undefined,
      limit: Math.min(limit, 100),
    });
    return c.json(runs.map(toRunResponse));
  });

  // Per-agent stats — auth required, 404 opaque for non-owner non-admin.
  // Same multi-tenant gate as the registry GET routes.
  router.get("/agents/:namespace/:name/stats", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    try {
      const agent = await db.getAgent(namespace, name);
      assertAgentVisibleOrThrow(agent, getUser(c), namespace, name);
      assertNotDelegatedOrThrow(getUser(c));
      const days = Number(c.req.query("days") ?? "7");
      const stats = await db.getAgentStats(agent.id, Math.min(Math.max(days, 1), 30));
      return c.json(stats);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  router.get("/runs/:id", authMiddleware, async (c) => {
    const { id } = c.req.param();
    const user = getUser(c);
    if (isDelegatedKey(user)) return denyDelegated(c);
    const run = await db.getRun(id);
    // Opaque 404: a non-owner gets the same "not found" as a non-existent run,
    // so they cannot tell "exists but not yours" from "does not exist" (aligns
    // run reads with the registry's 404-opaque reads).
    if (!run || run.user_id !== user.id) {
      return c.json({ error: { code: "NOT_FOUND", message: `Run ${id} not found` } }, 404);
    }
    return c.json(toRunResponse(run));
  });

  return router;
}
