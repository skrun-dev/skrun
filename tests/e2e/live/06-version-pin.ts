/**
 * Phase 06 — agent version pinning (#7).
 *
 * SDK can pin a specific version via `run({version})`; unknown version
 * surfaces 404 VERSION_NOT_FOUND with an `available[]` list; semver ranges
 * (`^1.0.0`) are rejected as 400 INVALID_VERSION_FORMAT.
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

export async function run(): Promise<void> {
  const { SkrunClient } = await import("../../../packages/sdk/src/index.js");
  const sdkClient = new SkrunClient({ baseUrl: REGISTRY, token: TOKEN });

  console.log("Testing version pinning (SDK run({version}) against latest)...");
  {
    try {
      // Discover the current latest version of dev/code-review
      const versions = await sdkClient.getVersions("dev/code-review");
      const pinnedVersion = versions[versions.length - 1]; // latest pushed

      const result = await sdkClient.run(
        "dev/code-review",
        { code: "const z = 3;" },
        { version: pinnedVersion },
      );

      const pinMatch = result.agent_version === pinnedVersion;
      results.push({
        agent: "version-pinning",
        feature: "SDK run({version}) → agent_version echoes pinned version",
        passed: result.status === "completed" && pinMatch,
        duration: result.duration_ms ?? 0,
        cost: result.cost?.estimated ?? 0,
        detail: `pinned=${pinnedVersion}, echoed=${result.agent_version}, match=${pinMatch}`,
      });
    } catch (err) {
      results.push({
        agent: "version-pinning",
        feature: "SDK run({version}) → agent_version echoes pinned version",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing version pinning — 404 VERSION_NOT_FOUND with `available`...");
  {
    try {
      // Direct fetch to inspect the 404 body
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: { code: "x" }, version: "99.99.99" }),
      });
      const body = (await res.json()) as {
        error?: { code?: string; available?: string[] };
      };
      const passed =
        res.status === 404 &&
        body.error?.code === "VERSION_NOT_FOUND" &&
        Array.isArray(body.error?.available) &&
        body.error.available.length > 0;
      results.push({
        agent: "version-pinning",
        feature: "POST /run with unknown version → 404 VERSION_NOT_FOUND + available[]",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${res.status}, code=${body.error?.code}, available=[${body.error?.available?.join(",")}]`,
      });
    } catch (err) {
      results.push({
        agent: "version-pinning",
        feature: "POST /run with unknown version → 404 VERSION_NOT_FOUND + available[]",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing version pinning — 400 INVALID_VERSION_FORMAT on semver range...");
  {
    try {
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: { code: "x" }, version: "^1.0.0" }),
      });
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      const passed = res.status === 400 && body.error?.code === "INVALID_VERSION_FORMAT";
      results.push({
        agent: "version-pinning",
        feature: 'POST /run with "^1.0.0" → 400 INVALID_VERSION_FORMAT',
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${res.status}, code=${body.error?.code}`,
      });
    } catch (err) {
      results.push({
        agent: "version-pinning",
        feature: 'POST /run with "^1.0.0" → 400 INVALID_VERSION_FORMAT',
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
