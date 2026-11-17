/**
 * Phase 08 — Files API backward-compat smoke.
 *
 * Asserts every POST /run response carries a `files` array (empty for agents
 * that don't produce artifacts), and the count of output files left out,
 * `files_excluded` — an object, `{}` when nothing was left out. Full file-id
 * transport scenarios live in the multimodal phase — this is the
 * no-output-files happy-path check.
 */

import { postRun, results } from "./_ctx.js";

/** A plain object whose every value is a positive whole number: the shape of `files_excluded`. */
function isExclusionCounts(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((count) => Number.isInteger(count) && (count as number) > 0);
}

export async function run(): Promise<void> {
  console.log("Testing files API — response includes files array and files_excluded...");
  {
    // Any agent run should have a `files` field in the response (backward compat)
    try {
      const res = await postRun("dev", "code-review", { code: "const x = 1;" });
      const files = res.files as Array<Record<string, unknown>> | undefined;
      const duration = (res.duration_ms as number) ?? 0;
      const cost = ((res.cost as Record<string, number>)?.estimated as number) ?? 0;
      results.push({
        agent: "files-api",
        feature: "POST /run response includes files array (backward compat)",
        passed: Array.isArray(files),
        duration,
        cost,
        detail: `files=${JSON.stringify(files)}`,
      });
      // The count of output files left out, by reason: always present.
      results.push({
        agent: "files-api",
        feature: "POST /run response includes files_excluded counts",
        passed: "files_excluded" in res && isExclusionCounts(res.files_excluded),
        duration: 0,
        cost: 0,
        detail: `files_excluded=${JSON.stringify(res.files_excluded)}`,
      });
    } catch (err) {
      results.push({
        agent: "files-api",
        feature: "POST /run response includes files array (backward compat)",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
