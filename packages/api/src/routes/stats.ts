import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { RunStatus } from "../db/schema.js";

export function createStatsRoutes(db: DbAdapter, authMiddleware: MiddlewareHandler): Hono {
  const router = new Hono();

  router.get("/stats", authMiddleware, async (c) => {
    const stats = await db.getStats();
    return c.json(stats);
  });

  router.get("/runs", authMiddleware, async (c) => {
    const agentId = c.req.query("agent_id");
    const status = c.req.query("status") as RunStatus | undefined;
    const limit = Number(c.req.query("limit") ?? "50");

    const runs = await db.listRuns({
      agent_id: agentId || undefined,
      status: status || undefined,
      limit: Math.min(limit, 100),
    });
    return c.json(runs);
  });

  router.get("/agents/:namespace/:name/stats", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const agent = await db.getAgent(namespace, name);
    if (!agent) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Agent ${namespace}/${name} not found` } },
        404,
      );
    }
    const days = Number(c.req.query("days") ?? "7");
    const stats = await db.getAgentStats(agent.id, Math.min(Math.max(days, 1), 30));
    return c.json(stats);
  });

  router.get("/runs/:id", authMiddleware, async (c) => {
    const { id } = c.req.param();
    const run = await db.getRun(id);
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: `Run ${id} not found` } }, 404);
    }
    return c.json(run);
  });

  return router;
}
