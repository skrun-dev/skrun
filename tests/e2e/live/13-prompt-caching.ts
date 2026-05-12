/**
 * Phase 13 — prompt-caching.
 *
 * Two cross-provider scenarios, each independently gated on its API key:
 *
 *   - Anthropic (Sonnet 4.6, threshold 2048 tokens) — exercises explicit
 *     `cache_control` injection AND extraction. Skipped without ANTHROPIC_API_KEY.
 *   - Gemini Flash (2.5, threshold 1024 tokens) — exercises implicit caching
 *     extraction (`usageMetadata.cachedContentTokenCount`) end-to-end. The
 *     adapter doesn't inject anything for Gemini (caching is automatic on
 *     stable prefixes), so this verifies the runtime extraction + gross→net
 *     normalization pipeline. Skipped without GOOGLE_API_KEY.
 *
 * Both scenarios follow the same shape:
 *   1. Patch `email-drafter` (model + version + SKILL.md filler) so the
 *      system prompt exceeds the model's caching threshold
 *   2. Push, run twice with identical input
 *   3. VT-11: assert `cache_read_tokens > 0` on the 2nd call (PASS line
 *      detail prints the exact value per D-1 gate)
 *   4. Re-patch SKILL.md with different filler, run a 3rd time
 *   5. VT-14 (invalidation regression): assert `cache_read_tokens === 0`
 *      on the 3rd call (system content change → no cache hit)
 *
 * Cost per provider scenario:
 *   - Anthropic: ~$0.02 (3 calls × ~3000 tokens × $3/M Sonnet)
 *   - Gemini Flash: ~$0.005 (3 calls × ~2000 tokens × $0.15/M Flash)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, ROOT, results, skrun, TOKEN } from "./_ctx.js";

/**
 * Make a stable filler block of approximately N paragraphs of `seed`-tagged
 * style guide. Length is controlled to exceed the target threshold.
 */
function makeFiller(seed: string, paragraphs: number): string {
  const block = `\n\n## Detailed style guide (${seed})\n\n`;
  const para = "Write clear, concise emails. ".repeat(40);
  return block + Array.from({ length: paragraphs }, () => para).join("\n\n");
}

async function callAgent(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${REGISTRY}/api/agents/dev/email-drafter/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * GET /api/runs/:id — fetch the persisted Run shape. Used by the round-trip
 * assertion to verify cache fields survive POST → DB write → GET read-back
 * (D-1 gate for cache-cost-savings dashboard work).
 */
async function fetchRunDetail(runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${REGISTRY}/api/runs/${runId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

interface ScenarioConfig {
  /** Display name for results table (provider) */
  provider: string;
  /** Model patch (yaml block) */
  modelYaml: string;
  /** Number of paragraphs in the filler block — calibrated to exceed model threshold */
  fillerParagraphs: number;
  /** Whether this provider reports `cache_write_tokens` (Anthropic only) */
  expectsWriteTokens: boolean;
  /** Cost-per-test estimate for the results detail (informational) */
  costEstimate: string;
  /**
   * Number of cache-hit attempts after the initial miss/write call. PASS if
   * AT LEAST ONE attempt shows cache_read_tokens > 0. Anthropic explicit
   * cache_control is deterministic (1 attempt suffices); Gemini implicit
   * caching is best-effort (~67% hit rate observed empirically over 3 runs)
   * so 3 attempts give ~96% P(PASS) when the wire-up is correct.
   */
  cacheAttempts: number;
  /**
   * Stable versions for this scenario (alpha = first push with filler "alpha";
   * beta = re-push for VT-14 invalidation with filler "beta"). Stable versions
   * + DELETE-first idempotent cleanup (per #77) replace the legacy
   * `9.9.${Date.now() % 1_000_000}` stamp pattern that leaked artifacts.
   */
  stableVersions: { alpha: string; beta: string };
}

/**
 * Best-effort cleanup helper for a single version of `dev/email-drafter`.
 * Calls DELETE /api/agents/dev/email-drafter/versions/:version. 204 = deleted,
 * 404 = already gone — both fine. Anything else logs a warning. Used as
 * "DELETE-first then push" at scenario start (clean slate after a possible
 * crashed previous run) AND in `finally` (post-test cleanup).
 */
async function cleanupVersion(version: string): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY}/api/agents/dev/email-drafter/versions/${version}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status !== 204 && res.status !== 404) {
      console.warn(`cleanup: unexpected ${res.status} deleting version ${version}`);
    }
  } catch (err) {
    console.warn(
      `cleanup: error deleting version ${version}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runScenario(cfg: ScenarioConfig): Promise<void> {
  console.log(`Testing prompt-caching: ${cfg.provider} 2nd-call cache hit...`);
  const start = Date.now();
  const dir = join(ROOT, "agents/email-drafter");
  const yamlPath = join(dir, "agent.yaml");
  const skillPath = join(dir, "SKILL.md");
  const originalYaml = readFileSync(yamlPath, "utf-8");
  const originalSkill = readFileSync(skillPath, "utf-8");

  // DELETE-first (per #77 Q-13): clean slate before push, in case a previous
  // run crashed between push and teardown. Naive "push, ignore 409" would
  // silently keep stale content.
  await cleanupVersion(cfg.stableVersions.alpha);
  await cleanupVersion(cfg.stableVersions.beta);

  const stamp = cfg.stableVersions.alpha;
  const patchedYaml = originalYaml
    .replace(/^version: .+$/m, `version: ${stamp}`)
    .replace(/^model:\n[\s\S]*?(?=\n\S)/m, cfg.modelYaml);
  const patchedSkill = originalSkill + makeFiller("alpha", cfg.fillerParagraphs);

  writeFileSync(yamlPath, patchedYaml, "utf-8");
  writeFileSync(skillPath, patchedSkill, "utf-8");

  let totalCost = 0;
  let vt11Detail = "";
  let vt11Passed = false;
  let vt14Detail = "";
  let vt14Passed = false;

  try {
    skrun(["build"], dir);
    try {
      skrun(["push"], dir);
    } catch {
      // already pushed at this version
    }

    const input = {
      context: "Quick thank-you note for a colleague who helped debug a tricky bug.",
      tone: "friendly",
      recipient: "a teammate",
    };

    // Call 1 (initial): cache miss + cache write (Anthropic) or implicit
    // cache write (Gemini).
    const r1 = await callAgent(input);
    totalCost += ((r1.cost as Record<string, number>)?.estimated as number) ?? 0;
    const r1Usage = r1.usage as {
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      prompt_tokens: number;
    };
    const r1ReadTokens = r1Usage?.cache_read_tokens ?? 0;
    const r1WriteTokens = r1Usage?.cache_write_tokens ?? 0;

    // Cache-hit attempts: N back-to-back calls. PASS if at least one shows
    // cache_read_tokens > 0. Anthropic uses 1 (deterministic); Gemini uses 3
    // (best-effort — Google's implicit cache infra is non-deterministic at
    // ~67% hit rate empirical, so 3 attempts give ~96% confidence the
    // wire-up works when at least one hits).
    const attempts: Array<{
      readTokens: number;
      promptTokens: number;
      cost: number;
      runId: string;
      costSaved: number;
    }> = [];
    for (let i = 0; i < cfg.cacheAttempts; i++) {
      const ri = await callAgent(input);
      const cost = ((ri.cost as Record<string, number>)?.estimated as number) ?? 0;
      const costSaved = ((ri.cost as Record<string, number>)?.saved as number) ?? 0;
      totalCost += cost;
      const usage = ri.usage as { cache_read_tokens?: number; prompt_tokens: number };
      attempts.push({
        readTokens: usage?.cache_read_tokens ?? 0,
        promptTokens: usage?.prompt_tokens ?? 0,
        cost,
        runId: (ri.run_id as string) ?? "",
        costSaved,
      });
    }

    const maxRead = Math.max(...attempts.map((a) => a.readTokens));
    const winningAttempt = attempts.find((a) => a.readTokens === maxRead);
    vt11Passed = maxRead > 0;
    const writeNote = cfg.expectsWriteTokens ? `, write=${r1WriteTokens}` : "";
    const attemptsSummary = attempts.map((a, i) => `attempt${i + 1}=${a.readTokens}`).join(",");

    // Round-trip assertion: cache fields survive POST → DB → GET /api/runs/:id.
    // D-1 gate for cache-cost-savings work — proves the 3-mode wire-up
    // (sync/SSE/webhook in routes/run.ts) actually persists the values.
    let roundTripDetail = "";
    if (vt11Passed && winningAttempt?.runId) {
      try {
        const persisted = await fetchRunDetail(winningAttempt.runId);
        const dbRead = (persisted.usage_cache_read_tokens as number) ?? 0;
        const dbSavings = (persisted.usage_cache_savings_usd as number) ?? 0;
        const roundTripOk = dbRead > 0 && dbSavings > 0;
        roundTripDetail = roundTripOk
          ? `; round-trip OK (db: read=${dbRead}, saved=$${dbSavings.toFixed(6)})`
          : `; round-trip FAIL (db: read=${dbRead}, saved=$${dbSavings.toFixed(6)} — expected both > 0)`;
        if (!roundTripOk) vt11Passed = false;
      } catch (err) {
        roundTripDetail = `; round-trip ERROR (${err instanceof Error ? err.message : String(err)})`;
        vt11Passed = false;
      }
    }

    vt11Detail = vt11Passed
      ? `cache_read_tokens=${maxRead} on ${attempts.length === 1 ? "2nd call" : `attempt ${attempts.findIndex((a) => a.readTokens === maxRead) + 1}/${attempts.length} (${attemptsSummary})`} (1st: read=${r1ReadTokens}${writeNote}); residual prompt_tokens=${winningAttempt?.promptTokens ?? 0}; live cost.saved=$${(winningAttempt?.costSaved ?? 0).toFixed(6)}${roundTripDetail}`
      : `no cache hit across ${attempts.length} attempts (${attemptsSummary}); 1st: read=${r1ReadTokens}${writeNote}; residual prompt_tokens=${attempts[0]?.promptTokens ?? 0}${roundTripDetail}`;

    // VT-14: invalidate by changing the SKILL.md filler. Bump version so
    // the bundle is re-pushed and the registry serves the new system prompt.
    const stamp2 = cfg.stableVersions.beta;
    const reYaml = patchedYaml.replace(/^version: .+$/m, `version: ${stamp2}`);
    const reSkill = originalSkill + makeFiller("beta", cfg.fillerParagraphs);
    writeFileSync(yamlPath, reYaml, "utf-8");
    writeFileSync(skillPath, reSkill, "utf-8");

    skrun(["build"], dir);
    try {
      skrun(["push"], dir);
    } catch {
      // already pushed
    }

    const r3 = await callAgent(input);
    totalCost += ((r3.cost as Record<string, number>)?.estimated as number) ?? 0;
    const r3Usage = r3.usage as { cache_read_tokens?: number };
    const r3ReadTokens = r3Usage?.cache_read_tokens ?? 0;

    vt14Passed = r3ReadTokens === 0;
    vt14Detail = vt14Passed
      ? `system content changed → cache_read_tokens=0 (correctly invalidated)`
      : `system content changed but cache_read_tokens=${r3ReadTokens} (expected 0)`;
  } catch (err) {
    vt11Detail = err instanceof Error ? err.message : String(err);
    vt14Detail = `skipped due to VT-11 ${cfg.provider} failure`;
  } finally {
    writeFileSync(yamlPath, originalYaml, "utf-8");
    writeFileSync(skillPath, originalSkill, "utf-8");
    // Best-effort cleanup of the 2 stable versions pushed during this scenario.
    // Ignored if delete fails (e.g., the test crashed before push); only logs warning.
    await cleanupVersion(cfg.stableVersions.alpha);
    await cleanupVersion(cfg.stableVersions.beta);
  }

  const duration = Date.now() - start;
  results.push({
    agent: "#68",
    feature: `VT-11 ${cfg.provider} 2nd-call cache hit (${cfg.costEstimate})`,
    passed: vt11Passed,
    duration,
    cost: totalCost,
    detail: vt11Detail,
  });
  results.push({
    agent: "#68",
    feature: `VT-14 ${cfg.provider} invalidation (system change → no cache hit)`,
    passed: vt14Passed,
    duration: 0,
    cost: 0,
    detail: vt14Detail,
  });
}

export async function run(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    await runScenario({
      provider: "Anthropic Sonnet 4.6",
      modelYaml: "model:\n  provider: anthropic\n  name: claude-sonnet-4-6\n",
      fillerParagraphs: 12, // ~12_000 chars → ~3000 token estimate > 2048 threshold
      expectsWriteTokens: true,
      costEstimate: "~$0.02",
      // Anthropic explicit cache_control is deterministic — 1 attempt suffices.
      cacheAttempts: 1,
      stableVersions: { alpha: "9.9.1", beta: "9.9.2" },
    });
  } else {
    console.log("Skipping Anthropic VT-11/VT-14: ANTHROPIC_API_KEY not set");
  }

  if (process.env.GOOGLE_API_KEY) {
    await runScenario({
      provider: "Gemini 2.5 Flash",
      modelYaml: "model:\n  provider: google\n  name: gemini-2.5-flash\n",
      // 30 paragraphs → ~30_000 chars → ~7500-token estimate. Well above the
      // documented 1024-token implicit threshold.
      fillerParagraphs: 30,
      expectsWriteTokens: false, // Gemini implicit caching has no separate write surcharge
      costEstimate: "~$0.015",
      // Gemini implicit caching is best-effort — empirically ~67% hit rate per
      // call. 3 attempts give ~96% confidence the wire-up works when at least
      // one hits. PASS = at least one attempt shows cache_read_tokens > 0.
      cacheAttempts: 3,
      stableVersions: { alpha: "9.9.3", beta: "9.9.4" },
    });
  } else {
    console.log("Skipping Gemini VT-11/VT-14: GOOGLE_API_KEY not set");
  }
}
