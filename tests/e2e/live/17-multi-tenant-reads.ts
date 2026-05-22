/**
 * Phase 17 — multi-tenant reads (#80) live coverage.
 *
 * VT-20a: GET /api/agents/dev/<fixture> WITHOUT Authorization → 401.
 *         Proves the auth gate is wired end-to-end (metadata route was
 *         public pre-#80).
 * VT-20b: GET /api/agents/dev/nonexistent WITH dev-token → 404 with body
 *         shape `{error:{code:"NOT_FOUND",message:"Agent dev/nonexistent
 *         not found"}}`. Establishes the genuine-404 baseline so future
 *         regression tests can compare ownership-404 against it (the
 *         byte-identical body invariant from SC-8b).
 * VT-20c: GET /api/agents/dev/<fixture>/pull WITHOUT Authorization → 401.
 *         No bundle bytes leak on unauth — `Content-Type` is JSON, not
 *         `application/octet-stream`.
 * VT-20d: GET /api/agents WITH dev-token → returns the fixture in the
 *         result + total >= 1. The CRITICAL D-1 mandate — the filter
 *         behavior is asserted end-to-end against a live registry, not
 *         just in unit tests. PASS detail line prints `total=N
 *         fixture_present=true`.
 *
 * Self-bootstrapping: pushes its own fixture under stable version 9.17.1
 * and DELETEs at the end. dev-token grants admin role, so the live
 * registry's filter narrows to "all agents" — VT-20d uses delta
 * (count-before vs count-after-push) to avoid being fragile to whatever
 * other phases left in the DB.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "multi-tenant-reads-live";
const V1 = "9.17.1";

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-17-${V1}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 17 live fixture — minimal agent used by tests/e2e/live/17-multi-tenant-reads.ts to assert the registry's multi-tenant filter gates the GET endpoints. Pushed under dev-token (admin), then probed with and without Authorization to verify the auth + filter contract end-to-end.
---

# ${AGENT}

Reply with the literal string "ok".
`,
  );
  writeFileSync(
    join(dir, "agent.yaml"),
    `name: ${AGENT}
version: ${V1}
model:
  provider: google
  name: gemini-2.5-flash
inputs:
  - name: task
    type: string
    required: true
outputs:
  - name: result
    type: string
`,
  );
  skrun(["build"], dir);
  try {
    skrun(["push"], dir);
  } catch {
    // 409 if the version was already pushed in a prior run — proceed.
  }
  return dir;
}

export async function run(): Promise<void> {
  // Clean slate: drop any leftover from prior crashed runs.
  await deleteAgent();

  let dir: string | null = null;
  try {
    // ── VT-20d setup: record baseline count, push fixture, record after ──
    const beforeRes = await fetch(`${REGISTRY}/api/agents`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const beforeBody = (await beforeRes.json()) as { total?: number; agents?: unknown[] };
    const totalBefore = beforeBody.total ?? 0;

    dir = buildAndPush();

    const afterRes = await fetch(`${REGISTRY}/api/agents`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const afterBody = (await afterRes.json()) as {
      total?: number;
      agents?: Array<{ namespace?: string; name?: string }>;
    };
    const totalAfter = afterBody.total ?? 0;
    const fixturePresent = (afterBody.agents ?? []).some(
      (a) => a.namespace === NS && a.name === AGENT,
    );

    // ── VT-20d: filter behavior visible in live response ──────────────────
    {
      // Robust assertion: the count went up by 1 AND the fixture is in the
      // returned list. We don't assert total === 1 because the live DB may
      // hold leftovers from other phases. The principle the test enforces
      // is "the filter pipes the new agent into the dev-token admin view".
      const passed = totalAfter === totalBefore + 1 && fixturePresent;
      results.push({
        agent: "multi-tenant-reads",
        feature: "VT-20d (#80): GET /api/agents — filter pipes fixture into dev-token admin view",
        passed,
        duration: 0,
        cost: 0,
        detail: `total_before=${totalBefore} total_after=${totalAfter} fixture_present=${fixturePresent}`,
      });
    }

    // ── VT-20a: anonymous metadata → 401 ─────────────────────────────────
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`);
      const passed = res.status === 401;
      results.push({
        agent: "multi-tenant-reads",
        feature: "VT-20a (#80): GET /api/agents/dev/<fixture> anonymous → 401",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${res.status}`,
      });
    }

    // ── VT-20b: dev-token GET nonexistent → genuine 404 with expected body ─
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/nonexistent-fixture-1234`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      let bodyShapeOk = false;
      let bodyDetail = "";
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        bodyShapeOk =
          body.error?.code === "NOT_FOUND" &&
          body.error?.message === `Agent ${NS}/nonexistent-fixture-1234 not found`;
        bodyDetail = `code=${body.error?.code ?? "?"} message="${body.error?.message ?? "?"}"`;
      } catch {
        bodyDetail = "(non-JSON body)";
      }
      const passed = res.status === 404 && bodyShapeOk;
      results.push({
        agent: "multi-tenant-reads",
        feature: "VT-20b (#80): dev-token GET nonexistent → 404 baseline body shape",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${res.status} ${bodyDetail}`,
      });
    }

    // ── VT-20c: anonymous pull → 401 + no octet-stream content ───────────
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/pull`);
      const contentType = res.headers.get("Content-Type") ?? "";
      const noBundleHeaders =
        !res.headers.get("Content-Disposition") && !res.headers.get("X-Agent-Version");
      const passed = res.status === 401 && !contentType.includes("octet-stream") && noBundleHeaders;
      results.push({
        agent: "multi-tenant-reads",
        feature: "VT-20c (#80): anonymous pull → 401 + no bundle headers",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${res.status} content_type="${contentType}" no_bundle_headers=${noBundleHeaders}`,
      });
    }
  } finally {
    // Cleanup — DELETE the fixture (cascades to versions) so the next
    // phase-17 invocation starts clean.
    await deleteAgent();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
  }
}
