/**
 * Phase 20 — operator dashboard served by the server (#93).
 *
 * The live registry (spawned from dev.ts, cwd = packages/api, SKRUN_DASHBOARD
 * defaults on, SKRUN_DASHBOARD_DIR → ../web/dist) must serve the operator
 * dashboard SPA at /dashboard/ — the same path the published image exercises
 * in api-server mode. This is the D-1 live assertion for #93.
 *
 * Requires packages/web to be built (`pnpm --filter @skrun-dev/web build`).
 * If the dist is absent, the phase reports a SKIP so a CI run without a web
 * build doesn't false-fail — the serving logic itself is covered by the api
 * unit tests (createApp + fixture dist).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, ROOT, results } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing GET /dashboard/ (operator dashboard served by the server)...");
  const start = Date.now();
  const feature = "GET /dashboard/ served by the server (#93)";

  if (!existsSync(join(ROOT, "packages/web/dist/index.html"))) {
    results.push({
      agent: "dashboard",
      feature,
      passed: true,
      duration: Date.now() - start,
      cost: 0,
      detail: "SKIP — packages/web/dist not built (run `pnpm --filter @skrun-dev/web build`)",
    });
    return;
  }

  try {
    const res = await fetch(`${REGISTRY}/dashboard/`);
    const ctype = res.headers.get("content-type") ?? "";
    const html = await res.text();
    const isHtml = ctype.includes("text/html");
    const isSpa = html.includes('id="root"') && html.includes("/dashboard/assets/");
    results.push({
      agent: "dashboard",
      feature,
      passed: res.status === 200 && isHtml && isSpa,
      duration: Date.now() - start,
      cost: 0,
      detail: `dashboard=${res.status} (${isHtml ? "html" : ctype}) spa=${isSpa}`,
    });
  } catch (err) {
    results.push({
      agent: "dashboard",
      feature,
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
