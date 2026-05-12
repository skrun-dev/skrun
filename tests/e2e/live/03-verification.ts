/**
 * Phase 03 — agent verification flag (#10).
 *
 * Default verified=false on push, PATCH /verify flips it, non-dev token on a
 * non-verified agent with scripts/ surfaces an `agent_not_verified_scripts_disabled`
 * warning, dev-token bypasses the check.
 *
 * State cleanup at the end resets pdf-processing.verified=false because the
 * SQLite registry persists across `pnpm test:e2e:live` invocations on dev
 * machines.
 */

import { join } from "node:path";
import {
  patchAgent,
  postRun,
  REGISTRY,
  ROOT,
  restoreAgent,
  results,
  skrun,
  TOKEN,
} from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing verification (default verified=false)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/pdf-processing`);
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "verification",
      feature: "Default verified=false",
      passed: body.verified === false,
      duration: 0,
      cost: 0,
      detail: `verified=${body.verified}`,
    });
  }

  console.log("Testing verification (PATCH /verify → true)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/pdf-processing/verify`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "verification",
      feature: "PATCH /verify → true",
      passed: body.verified === true,
      duration: 0,
      cost: 0,
      detail: `verified=${body.verified}`,
    });
  }

  console.log("Testing verification (non-dev token + non-verified → warning)...");
  {
    // The `agent_not_verified_scripts_disabled` warning only fires when an agent
    // ACTUALLY has a `scripts/` directory. pdf-processing v1.1.0+ is vision-only
    // (no scripts/), so we re-target on `changelog-generator` which has scripts/
    // and a simple single-string input shape.
    const cgDir = join(ROOT, "agents/changelog-generator");
    const cgOriginal = patchAgent(cgDir, "dev", "google", "gemini-2.5-flash");
    try {
      skrun(["build"], cgDir);
      try {
        skrun(["push"], cgDir);
      } catch {
        // 409 already pushed in a prior run — agent is in the registry, proceed.
      }

      // Revoke verification first (default is false anyway, but ensure it).
      await fetch(`${REGISTRY}/api/agents/dev/changelog-generator/verify`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ verified: false }),
      });
      const res = await fetch(`${REGISTRY}/api/agents/dev/changelog-generator/run`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-user-token",
          "Content-Type": "application/json",
          "X-LLM-API-Key": JSON.stringify({ google: "fake" }),
        },
        body: JSON.stringify({ input: { repo_path: "./fixtures/sample-repo.git-log.txt" } }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const warnings = body.warnings as string[] | undefined;
      results.push({
        agent: "verification",
        feature: "Non-dev + non-verified → warning",
        passed: Array.isArray(warnings) && warnings.includes("agent_not_verified_scripts_disabled"),
        duration: 0,
        cost: 0,
        detail: `warnings=${JSON.stringify(warnings)}`,
      });
    } finally {
      restoreAgent(cgDir, cgOriginal);
      // State cleanup: prior test (#2) PATCHes pdf-processing.verified=true.
      // Reset it to false so the next live-test invocation starts the
      // verification block with the expected default (SQLite persists state
      // across `pnpm test:e2e:live` runs on dev machines).
      await fetch(`${REGISTRY}/api/agents/dev/pdf-processing/verify`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ verified: false }),
      });
    }
  }

  console.log("Testing verification (dev-token bypass → no warning)...");
  {
    const res = await postRun("dev", "pdf-processing", { content: "test", task: "summarize" });
    const warnings = res.warnings as string[] | undefined;
    results.push({
      agent: "verification",
      feature: "Dev-token bypass → no warning",
      passed: warnings === undefined,
      duration: 0,
      cost: 0,
      detail: `warnings=${JSON.stringify(warnings)}`,
    });
  }
}
