import type { RunnerPool } from "@skrun-dev/runtime";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getUser } from "../middleware/auth.js";
import { isDelegatedKey } from "../services/key-scope.js";

/**
 * Operator view of the pre-warm pool.
 *
 * WHY A ROUTE AT ALL
 * The pool's state lives in this process's memory: there is no table behind it
 * (the platform is the source of truth for which machines exist, and the local map
 * is a cache), so nothing else can read it. Structured logs carry the same
 * information as it happens, but a pool that quietly stopped serving is exactly the
 * failure nobody notices, and "grep the platform's logs" is not an answer an
 * operator should have to reach for.
 *
 * Instance-wide numbers, so it is restricted to an instance administrator rather
 * than scoped per tenant like the usage endpoints — a tenant has no business
 * knowing the shape of the fleet, and no way to act on it either.
 */
export function createAdminPoolRoutes(authMiddleware: MiddlewareHandler, pool?: RunnerPool): Hono {
  const router = new Hono();

  router.get("/admin/pool", authMiddleware, async (c) => {
    const user = getUser(c);
    // Opaque 404 rather than 403, matching how the rest of the API answers a
    // caller who may not know the resource exists: an unprivileged caller learns
    // nothing about whether this deployment runs a pool.
    if (isDelegatedKey(user) || user.role !== "admin") {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    if (!pool?.enabled) {
      // Configured off is a legitimate, useful answer — it distinguishes "no pool
      // here" from "a pool that is failing", which the counters alone cannot.
      return c.json({ enabled: false });
    }
    return c.json({ enabled: true, ...pool.stats() });
  });

  return router;
}
