/**
 * Phase 21 — agent visibility (#81) live coverage.
 *
 * Live-asserts that the per-agent `visibility` field round-trips through the
 * real registry + DB stack:
 *   VT-21a: a freshly-pushed agent surfaces `visibility:"private"` (the default)
 *           in GET metadata — the new column is serialised end-to-end.
 *   VT-21b: PATCH /api/agents/:ns/:name/visibility {public} → 200 echoing the
 *           new value.
 *   VT-21c: a subsequent GET metadata shows `visibility:"public"` — the change
 *           persisted through the real DB.
 *
 * Scope note: the live registry runs in dev-mode where every token maps to
 * admin, so the run-authorization 404 (non-owner on a private agent) and the
 * 403 ENV_OVERRIDE_FORBIDDEN (non-owner override) cannot be exercised here —
 * they require a non-admin caller and are covered by the in-memory integration
 * suite (run.test.ts / registry.test.ts / tests/e2e/visibility.test.ts), which
 * mints real sk_live keys for non-admin users.
 *
 * Self-bootstrapping: pushes its own fixture under stable version 9.21.1 and
 * DELETEs at the end (dev-token = admin).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "agent-visibility-live";
const V1 = "9.21.1";

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-21-${V1}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 21 live fixture used by tests/e2e/live/21-agent-visibility.ts to assert the per-agent visibility field round-trips through the real registry + DB (default private, PATCH to public, persisted across reads).
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

async function getVisibility(): Promise<string | undefined> {
  const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  try {
    return ((await res.json()) as { visibility?: string }).visibility;
  } catch {
    return undefined;
  }
}

export async function run(): Promise<void> {
  await deleteAgent();

  let dir: string | null = null;
  try {
    dir = buildAndPush();

    // ── VT-21a: default visibility surfaces in metadata ──────────────────
    {
      const vis = await getVisibility();
      results.push({
        agent: "agent-visibility",
        feature: 'VT-21a (#81): pushed agent metadata visibility="private" (default)',
        passed: vis === "private",
        duration: 0,
        cost: 0,
        detail: `visibility=${vis}`,
      });
    }

    // ── VT-21b: PATCH visibility public is rejected (private-only hosting) ─
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/visibility`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      results.push({
        agent: "agent-visibility",
        feature: "VT-21b (#103): PATCH /visibility public → 400 PUBLIC_VISIBILITY_DISABLED",
        passed: res.status === 400 && code === "PUBLIC_VISIBILITY_DISABLED",
        duration: 0,
        cost: 0,
        detail: `status=${res.status} code=${code}`,
      });
    }
  } finally {
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
