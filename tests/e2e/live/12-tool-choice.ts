/**
 * Phase 12 — tool-choice directives (#58).
 *
 * VT-13/14: forced tool-call on Gemini Flash. changelog-generator and
 * adr-writer used to silently skip write_artifact, returning markdown
 * inline. With `tool_choice: write_artifact` (#58 / agent.yaml v0.2.0),
 * the model must invoke the tool — assert across 3 consecutive runs that
 * the artifact is produced every time.
 *
 * VT-28: xAI Grok 4.3 cross-provider smoke test. Repurposes email-drafter
 * (text-only, minimal) by patching its model to xai/grok-4.3 + a version
 * stamp, pushes, runs, and asserts the run completed with provider=xai.
 *
 * Each scenario is gated on the matching provider API key.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, ROOT, results, skrun, TOKEN } from "./_ctx.js";

/**
 * Best-effort cleanup helper for a single version of `dev/<agentSlug>`. Calls
 * DELETE /api/agents/dev/:slug/versions/:version. 204/404 are both fine. Used
 * as "DELETE-first then push" at scenario start (clean slate after a possible
 * crashed previous run) AND in `finally` (post-test cleanup). Per #77 Q-13.
 *
 * Parametrized by `agentSlug` to be reused across multiple agents in the same
 * file (changelog-generator, adr-writer, email-drafter) per #77 plan C-4.
 */
async function cleanupVersion(agentSlug: string, version: string): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY}/api/agents/dev/${agentSlug}/versions/${version}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status !== 204 && res.status !== 404) {
      console.warn(
        `cleanup: unexpected ${res.status} deleting dev/${agentSlug}/versions/${version}`,
      );
    }
  } catch (err) {
    console.warn(
      `cleanup: error deleting dev/${agentSlug}/versions/${version}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runForcedToolCallScenario(
  agentSlug: string,
  agentDir: string,
  inputBody: Record<string, unknown>,
  expectedFilenameSuffix: string,
  feature: string,
  stableVersion: string,
): Promise<void> {
  const start = Date.now();
  const yamlPath = join(agentDir, "agent.yaml");
  const originalYaml = readFileSync(yamlPath, "utf-8");

  // DELETE-first: clean slate before push (per #77 Q-13, handles crashed previous run)
  await cleanupVersion(agentSlug, stableVersion);

  const patched = originalYaml.replace(/^version: .+$/m, `version: ${stableVersion}`);
  writeFileSync(yamlPath, patched, "utf-8");

  let totalCost = 0;
  try {
    skrun(["build"], agentDir);
    try {
      skrun(["push"], agentDir);
    } catch {
      // already pushed at this version — skip
    }

    const runs = 3;
    let producedCount = 0;
    let lastDetail = "";
    for (let i = 0; i < runs; i++) {
      const runRes = await fetch(`${REGISTRY}/api/agents/dev/${agentSlug}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(inputBody),
      });
      const runBody = (await runRes.json()) as Record<string, unknown>;
      totalCost += ((runBody.cost as Record<string, number>)?.estimated as number) ?? 0;

      const files = (runBody.files as Array<{ name: string }> | undefined) ?? [];
      const hit = files.some((f) => f.name.endsWith(expectedFilenameSuffix));
      if (hit) {
        producedCount++;
      } else {
        lastDetail = `run ${i + 1}: status=${runBody.status}, files=[${files.map((f) => f.name).join(",") || "none"}]`;
      }
    }

    const passed = producedCount === runs;
    const detail = passed
      ? `${producedCount}/${runs} runs produced *${expectedFilenameSuffix}, tool_called=true`
      : `${producedCount}/${runs} runs produced *${expectedFilenameSuffix} — ${lastDetail}`;

    results.push({
      agent: "#58",
      feature,
      passed,
      duration: Date.now() - start,
      cost: totalCost,
      detail,
    });
  } catch (err) {
    results.push({
      agent: "#58",
      feature,
      passed: false,
      duration: Date.now() - start,
      cost: totalCost,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    writeFileSync(yamlPath, originalYaml, "utf-8");
    // Best-effort cleanup of the stable version pushed during this scenario.
    await cleanupVersion(agentSlug, stableVersion);
  }
}

export async function run(): Promise<void> {
  if (process.env.GOOGLE_API_KEY) {
    console.log("Testing VT-13 changelog-generator forced write_artifact (3 runs)...");
    await runForcedToolCallScenario(
      "changelog-generator",
      join(ROOT, "agents/changelog-generator"),
      {
        input: {
          repo_path: "agents/changelog-generator/fixtures/sample-repo.git-log.txt",
          project_name: "skrun",
        },
      },
      "CHANGELOG.md",
      "changelog-generator forced write_artifact (3 consecutive runs)",
      "9.9.7",
    );

    console.log("Testing VT-14 adr-writer forced write_artifact (3 runs)...");
    await runForcedToolCallScenario(
      "adr-writer",
      join(ROOT, "agents/adr-writer"),
      {
        input: {
          adrs_dir: "agents/adr-writer/fixtures/empty-adrs",
          title: "Use TypeScript strict mode everywhere",
          context: "Inconsistent strictness across packages produces avoidable bugs.",
          options: "- Stay loose and add per-file pragmas.\n- Enable strict mode globally.",
          decision: "Enable strict mode globally for all packages.",
        },
      },
      ".md",
      "adr-writer forced write_artifact (3 consecutive runs)",
      "9.9.6",
    );
  } else {
    console.log("Skipping VT-13/14: GOOGLE_API_KEY not set");
  }

  if (process.env.XAI_API_KEY) {
    console.log("Testing VT-28 xAI Grok 4.3 smoke (email-drafter)...");
    const start = Date.now();
    const dir = join(ROOT, "agents/email-drafter");
    const yamlPath = join(dir, "agent.yaml");
    const originalYaml = readFileSync(yamlPath, "utf-8");
    const xaiStableVersion = "9.9.5";

    // DELETE-first: clean slate before push (per #77 Q-13)
    await cleanupVersion("email-drafter", xaiStableVersion);

    // Patch model + version. Drop the fallback to keep the smoke test scoped to xai.
    const patched = originalYaml
      .replace(/^version: .+$/m, `version: ${xaiStableVersion}`)
      .replace(/^model:\n[\s\S]*?(?=\n\S)/m, `model:\n  provider: xai\n  name: grok-4.3\n`);
    writeFileSync(yamlPath, patched, "utf-8");

    let cost = 0;
    try {
      skrun(["build"], dir);
      try {
        skrun(["push"], dir);
      } catch {
        // already pushed at this version
      }

      const runRes = await fetch(`${REGISTRY}/api/agents/dev/email-drafter/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            context: "Quick thank-you note for a colleague who helped debug a tricky bug.",
            tone: "friendly",
            recipient: "a teammate",
          },
        }),
      });
      const runBody = (await runRes.json()) as Record<string, unknown>;
      cost = ((runBody.cost as Record<string, number>)?.estimated as number) ?? 0;
      const status = runBody.status;
      const provider = (runBody.model as Record<string, string> | undefined)?.provider;

      let detail: string;
      let passed = false;
      if (status !== "completed") {
        detail = `status=${status}, error=${(runBody.error as { message?: string })?.message ?? "unknown"}`;
      } else if (provider !== "xai") {
        detail = `expected provider=xai, got provider=${provider}`;
      } else {
        passed = true;
        detail = `provider=xai, cost=$${cost.toFixed(4)}`;
      }

      results.push({
        agent: "#58",
        feature: "xAI Grok 4.3 smoke (email-drafter)",
        passed,
        duration: Date.now() - start,
        cost,
        detail,
      });
    } catch (err) {
      results.push({
        agent: "#58",
        feature: "xAI Grok 4.3 smoke (email-drafter)",
        passed: false,
        duration: Date.now() - start,
        cost,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      writeFileSync(yamlPath, originalYaml, "utf-8");
      await cleanupVersion("email-drafter", xaiStableVersion);
    }
  } else {
    console.log("Skipping VT-28: XAI_API_KEY not set");
  }
}
