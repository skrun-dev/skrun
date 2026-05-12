/**
 * Phase 09 — auth surface (#14a/b).
 *
 * GET /api/me returns user info under dev-token mode; GET /login renders
 * the dev-mode login page (no OAuth dance).
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing GET /api/me...");
  {
    const start = Date.now();
    try {
      const res = await fetch(`${REGISTRY}/api/me`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const data = (await res.json()) as {
        id: string;
        username: string;
        namespace: string;
        plan: string;
      };
      const ok = res.status === 200 && data.namespace === "dev" && data.username === "dev";
      results.push({
        agent: "auth",
        feature: "GET /api/me returns user info (dev-token mode)",
        passed: ok,
        duration: Date.now() - start,
        cost: 0,
        detail: `status=${res.status} namespace=${data.namespace} username=${data.username} plan=${data.plan}`,
      });
    } catch (err) {
      results.push({
        agent: "auth",
        feature: "GET /api/me returns user info (dev-token mode)",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing GET /login...");
  {
    const start = Date.now();
    try {
      const res = await fetch(`${REGISTRY}/login`);
      const html = await res.text();
      const hasSkrun = html.includes("Skrun");
      const hasDevToken = html.includes("dev-token");
      results.push({
        agent: "auth",
        feature: "GET /login renders page (dev mode — no OAuth)",
        passed: res.status === 200 && hasSkrun && hasDevToken,
        duration: Date.now() - start,
        cost: 0,
        detail: `status=${res.status} hasSkrun=${hasSkrun} hasDevToken=${hasDevToken}`,
      });
    } catch (err) {
      results.push({
        agent: "auth",
        feature: "GET /login renders page (dev mode — no OAuth)",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
