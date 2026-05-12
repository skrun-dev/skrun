/**
 * Phase 08 — Files API (#12) backward-compat smoke.
 *
 * Asserts every POST /run response carries a `files` array (empty for agents
 * that don't produce artifacts). Full file-id transport scenarios live in
 * the multimodal phase — this is the no-output-files happy-path check.
 */

import { postRun, results } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing files API — response includes files array...");
  {
    // Any agent run should have a `files` field in the response (backward compat)
    try {
      const res = await postRun("dev", "code-review", { code: "const x = 1;" });
      const files = res.files as Array<Record<string, unknown>> | undefined;
      results.push({
        agent: "files-api",
        feature: "POST /run response includes files array (backward compat)",
        passed: Array.isArray(files),
        duration: (res.duration_ms as number) ?? 0,
        cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
        detail: `files=${JSON.stringify(files)}`,
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
