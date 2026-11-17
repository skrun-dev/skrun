import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { Run, RunStatus } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import { assertAgentVisibleOrThrow } from "../services/access.js";
import { assertMasterReadOrThrow } from "../services/key-scope.js";
import { dispatchRegistryError } from "./_helpers.js";

/**
 * Run history and usage are for a full-access credential: a session, the dev
 * token, or an account-wide key that carries every operation. A delegated key
 * keeps its own refusal; a reduced account key — the "run-only" key a creator
 * hands out — is refused too: the runs of an account are those of every caller
 * of its agents. Returns the 403 to short-circuit with, or null to proceed.
 */
function refuseUnlessFullAccess(c: Context): Response | null {
  try {
    assertMasterReadOrThrow(getUser(c));
    return null;
  } catch (err) {
    return dispatchRegistryError(c, err);
  }
}

/** How many runs `GET /api/runs` returns when its `limit` is absent or unreadable, and at most. */
const RUNS_LIST_DEFAULT_LIMIT = 50;
const RUNS_LIST_MAX_LIMIT = 100;

/**
 * The number of runs `GET /api/runs` asks the store for: its `limit` when that
 * is a whole number from 1 to 100; above 100, 100; absent, unreadable or below
 * 1, 50. Never 0 nor a negative: every store reads a limit of 0 as no limit —
 * the listing would carry every run of the account, content included — and a
 * negative one as no limit, or as an error, depending on the store.
 */
function runsListLimit(raw: string | undefined): number {
  const limit = Number(raw);
  if (raw === undefined || !Number.isInteger(limit) || limit < 1) return RUNS_LIST_DEFAULT_LIMIT;
  return Math.min(limit, RUNS_LIST_MAX_LIMIT);
}

/**
 * The fields of a run its owner may read — an inclusion list, on purpose. A run
 * row carries more than the tenant should see, and the Postgres adapter reads it
 * with `SELECT *`: with a list of what to strip, every column later added to
 * `runs` would reach the response by default, internal bookkeeping included.
 * With a list of what to send, a new column stays out until someone names it.
 *
 * Deliberately absent: the runner's machine id and private IP (operator-only
 * telemetry). `phase_timings` (durations, and the pool's indicators — a count
 * among them, never a machine) is in — it is the public cold-start breakdown,
 * also carried by the runner_spawned event.
 */
const RUN_PUBLIC_FIELDS = [
  "id",
  "agent_id",
  "agent_version",
  "model",
  "environment_id",
  "user_id",
  "api_key_id",
  "status",
  "input",
  "output",
  "error",
  "usage_prompt_tokens",
  "usage_completion_tokens",
  "usage_total_tokens",
  "usage_estimated_cost",
  "usage_cache_read_tokens",
  "usage_cache_write_tokens",
  "usage_cache_savings_usd",
  "duration_ms",
  "phase_timings",
  "files",
  "created_at",
  "completed_at",
] as const satisfies readonly (keyof Run)[];

type RunResponse = Pick<Run, (typeof RUN_PUBLIC_FIELDS)[number]>;

/** Copy the named fields of a run, and nothing else. */
function pickRunFields<K extends keyof Run>(run: Run, fields: readonly K[]): Pick<Run, K> {
  const picked = {} as Pick<Run, K>;
  for (const field of fields) picked[field] = run[field];
  return picked;
}

function toRunResponse(run: Run): RunResponse {
  return pickRunFields(run, RUN_PUBLIC_FIELDS);
}

export function createStatsRoutes(db: DbAdapter, authMiddleware: MiddlewareHandler): Hono {
  const router = new Hono();

  router.get("/stats", authMiddleware, async (c) => {
    // Multi-tenancy: filter aggregates by the authenticated user. In dev-token
    // / single-tenant self-host the user id is deterministic so the filter
    // narrows to that user (effectively instance-wide). In cloud / shared
    // instances each user sees only their own runs.
    const user = getUser(c);
    const refused = refuseUnlessFullAccess(c);
    if (refused) return refused;
    const stats = await db.getStats({ userId: user.id });
    return c.json(stats);
  });

  router.get("/runs", authMiddleware, async (c) => {
    const agentId = c.req.query("agent_id");
    const status = c.req.query("status") as RunStatus | undefined;
    const limit = runsListLimit(c.req.query("limit"));
    const user = getUser(c);
    const refused = refuseUnlessFullAccess(c);
    if (refused) return refused;

    const runs = await db.listRuns({
      agent_id: agentId || undefined,
      user_id: user.id,
      status: status || undefined,
      limit,
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
      assertMasterReadOrThrow(getUser(c));
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
    const refused = refuseUnlessFullAccess(c);
    if (refused) return refused;
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
