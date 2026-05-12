/**
 * Phase 10 — version notes via `skrun push -m` (#14c).
 *
 * Push a stable version with a `--message` and assert the API returns the
 * note attached to the version. Per #77 pattern: DELETE-first idempotent
 * cleanup at scenario start (handles previous-run-crash) + finally cleanup.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchAgent, REGISTRY, ROOT, restoreAgent, results, skrun, TOKEN } from "./_ctx.js";

/** Best-effort delete of dev/<slug>@<version>. 204/404 OK; anything else logs warn. */
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

export async function run(): Promise<void> {
  const start = Date.now();
  const featureName = "skrun push -m 'note' → notes in versions API (#14c)";
  const stableVersion = "9.9.8";
  try {
    const dir = join(ROOT, "agents/code-review");
    const original = patchAgent(dir, "dev", "google", "gemini-2.5-flash");

    // DELETE-first per #77: clean slate before push (handles previous-run crash)
    await cleanupVersion("code-review", stableVersion);

    const yamlPath = join(dir, "agent.yaml");
    const originalYaml = readFileSync(yamlPath, "utf-8");
    const bumpedYaml = originalYaml.replace(/version: \d+\.\d+\.\d+/, `version: ${stableVersion}`);
    writeFileSync(yamlPath, bumpedYaml, "utf-8");

    try {
      skrun(["build"], dir);
      const noteText = "Automated live test note 🚀";
      skrun(["push", "-m", noteText], dir);

      // Fetch versions and assert the latest one has our note
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/versions`);
      const body = (await res.json()) as {
        versions: Array<{ version: string; notes: string | null }>;
      };
      const pushed = body.versions.find((v) => v.version === stableVersion);
      const match = pushed?.notes === noteText;

      results.push({
        agent: "#14c",
        feature: featureName,
        passed: match,
        duration: Date.now() - start,
        cost: 0,
        detail: match
          ? `version=${stableVersion}, notes="${pushed?.notes}"`
          : `expected notes="${noteText}" but got notes="${pushed?.notes ?? "null"}"`,
      });
    } finally {
      // Restore version + restore provider/namespace, then cleanup the stable version
      writeFileSync(yamlPath, originalYaml, "utf-8");
      restoreAgent(dir, original);
      await cleanupVersion("code-review", stableVersion);
    }
  } catch (err) {
    results.push({
      agent: "#14c",
      feature: featureName,
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
