import type { FileInfo, Logger } from "@skrun-dev/runtime";
import { estimateCacheSavings } from "@skrun-dev/runtime";
import type { Context } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import { isMasterCredential } from "../services/key-scope.js";
import { RegistryError } from "../services/registry.js";

/**
 * DRY the 9+ inline `if (err instanceof RegistryError) ...; throw err;` blocks
 * scattered across `registry.ts` and `run.ts`. Every route's catch clause for
 * a RegistryError follows the same shape — fan-in here so the response
 * contract stays consistent (and changes apply in one place).
 *
 * Non-RegistryError exceptions are re-thrown so the surrounding `app.onError`
 * (or default 500 handler) reports them; this helper only handles the
 * domain-error path.
 */
export function dispatchRegistryError(c: Context, err: unknown): Response {
  if (err instanceof RegistryError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  throw err;
}

/**
 * Account-management guard (R2). Returns a 403 `Response` to short-circuit when
 * the caller is NOT a master credential (a session, a dev-token, or an
 * account-wide full-operation key); `null` to proceed. Collapses the
 * previously hand-rolled `KEY_SCOPE_FORBIDDEN` blocks (auth / registry /
 * llm-key routes) into one canonical check + message.
 */
export function requireMasterCredential(c: Context): Response | null {
  if (isMasterCredential(getUser(c))) return null;
  return c.json(
    {
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message: "This action requires an account-wide API key (or a session / dev-token).",
      },
    },
    403,
  );
}

/**
 * DRY the 3 completed-run persistence call sites in routes/run.ts —
 * SSE (`run_complete` SSE event), webhook (background `run_complete` event),
 * and sync (`adapter.run()` result). All three computed `usage_cache_*` +
 * `cache_savings_usd` and called `db.updateRun(..., { status: "completed",
 * ... })` with identical column writes. Single source for that shape.
 *
 * The non-blocking `.catch(err => log.error(...))` pattern is preserved —
 * the response always ships, the run just loses its terminal state row on
 * DB failure, diagnosable via the structured log.
 *
 * Returns `cacheSavingsUsd` so the caller can fold it into its outbound
 * payload (sync response or webhook callback).
 */
export interface RunCompletionFields {
  output: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  durationMs: number | null | undefined;
  files: FileInfo[] | undefined;
}

export async function persistRunCompletion(
  db: DbAdapter,
  log: Logger,
  runId: string,
  modelForCostLookup: string,
  fields: RunCompletionFields,
  mode: "sse" | "webhook" | "sync",
): Promise<{ cacheSavingsUsd: number }> {
  const cacheSavingsUsd = estimateCacheSavings(modelForCostLookup, fields.cacheReadTokens);
  await db
    .updateRun(runId, {
      status: "completed",
      output: fields.output,
      usage_prompt_tokens: fields.promptTokens,
      usage_completion_tokens: fields.completionTokens,
      usage_total_tokens: fields.totalTokens,
      usage_estimated_cost: fields.estimatedCost,
      usage_cache_read_tokens: fields.cacheReadTokens,
      usage_cache_write_tokens: fields.cacheWriteTokens,
      usage_cache_savings_usd: cacheSavingsUsd,
      duration_ms: fields.durationMs ?? null,
      files: fields.files?.map((f) => ({ name: f.name, size: f.size })) ?? null,
      completed_at: new Date().toISOString(),
    })
    .catch((err) =>
      log.error(
        {
          event: "db_update_failed",
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        },
        `DB updateRun failed (${mode} complete) — run may remain in 'running' state`,
      ),
    );
  return { cacheSavingsUsd };
}
