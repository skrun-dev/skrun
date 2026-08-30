/**
 * Phase 22 — verification policy (#103) live coverage.
 *
 * Live-asserts the operator verification policy surface against the real
 * registry + DB:
 *   VT-22a: GET /api/me exposes `verification_policy` — the dashboard reads it
 *           read-only to render the verify control.
 *   VT-22b: an admin (dev-token) verify round-trip on a freshly-pushed version
 *           returns 200 with `verified:true` — the attestation path works
 *           end-to-end.
 *
 * Scope note: the live registry runs in dev-mode (SKRUN_DEV_AUTH on) where every
 * token maps to admin and no SKRUN_VERIFICATION_POLICY is set, so the policy is
 * the default `admin`. The non-admin `owner`/`disabled` behaviors (owner
 * self-verify, the run-gate matrix, the attestation `kind`) need a non-admin
 * caller and are covered by the in-memory suite (run.test.ts / registry.test.ts),
 * which mints real sk_live keys.
 *
 * Self-bootstrapping: pushes its own fixture under stable version 9.22.1 and
 * DELETEs at the end (dev-token = admin).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "verification-policy-live";
const V1 = "9.22.1";

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-22-${V1}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 22 live fixture used by tests/e2e/live/22-verification-policy.ts to assert the verification policy surface (GET /api/me verification_policy + an admin verify round-trip) against the real registry + DB.
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
  // ── VT-22a: /api/me exposes the active verification policy ─────────────
  {
    const res = await fetch(`${REGISTRY}/api/me`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    let policy: string | undefined;
    try {
      policy = ((await res.json()) as { verification_policy?: string }).verification_policy;
    } catch {
      policy = undefined;
    }
    results.push({
      agent: "verification-policy",
      feature: "VT-22a (#103): GET /api/me exposes verification_policy",
      passed:
        res.status === 200 &&
        typeof policy === "string" &&
        ["admin", "owner", "disabled"].includes(policy),
      duration: 0,
      cost: 0,
      detail: `status=${res.status} verification_policy=${policy}`,
    });
  }

  // ── VT-22b: admin (dev-token) verify round-trip ────────────────────────
  await deleteAgent();
  let dir: string | null = null;
  try {
    dir = buildAndPush();
    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${V1}/verify`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    let verified: boolean | undefined;
    try {
      verified = ((await res.json()) as { verified?: boolean }).verified;
    } catch {
      verified = undefined;
    }
    results.push({
      agent: "verification-policy",
      feature: "VT-22b (#103): admin verify round-trip → 200 verified=true",
      passed: res.status === 200 && verified === true,
      duration: 0,
      cost: 0,
      detail: `status=${res.status} verified=${verified}`,
    });
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
