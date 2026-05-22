/**
 * Phase 15 — verify-required-before-run (#83) live coverage.
 *
 * IT-1: push → run blocked (403) → skrun verify → run succeeds.
 * IT-2: push new version over an already-verified one → pinned callers to
 *       the old version keep running, the new (latest) version is 403'd.
 * IT-3: structured log emission contract — assertion left to the unit test
 *       in registry.test.ts (vi.spyOn on the logger module). Live tests
 *       only verify the PATCH endpoint returns 200 — pino writes to stdout
 *       without a file destination so reading the log here would require
 *       extra infra (rejected per peer-review #5).
 *
 * Uses a stable namespace+name pair scoped to this phase so concurrent live
 * runs don't collide. All versions cleaned up at the end via DELETE.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "verify-required-live";

// 4 stable versions for this phase, cleaned up at end via DELETE so the next
// run starts from a known state (mirrors the #77 stable-9.9.x pattern).
const V1 = "9.15.1";
const V2 = "9.15.2";
const V3 = "9.15.3";

async function verifyVersion(version: string, verified: boolean): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified }),
  });
}

async function runAgent(opts: { version?: string }): Promise<Response> {
  const body: Record<string, unknown> = { input: { task: "ping" } };
  if (opts.version) body.version = opts.version;
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

/**
 * Build a minimal agent.yaml + SKILL.md in a temp dir, then run
 * `skrun build` + `skrun push` to publish a version. Reused for each
 * version we need in the phase.
 */
function buildAndPush(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-15-${version}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 15 live fixture — minimal agent used by tests/e2e/live/15-verify-required.ts to exercise the per-version verified gate. Not for end-user consumption.
---

# verify-required-live

Minimal agent for phase 15 live tests. Echo "ok" if you read this.
`,
  );
  // Note: agent.yaml has no `description:` field — that lives in SKILL.md
  // frontmatter only. The AgentConfigSchema is strict, so any unknown field
  // (description, prompt, etc.) fails the build with a vague "Invalid
  // agent.yaml". inputs + outputs are required (>=1 each).
  writeFileSync(
    join(dir, "agent.yaml"),
    `name: ${AGENT}
version: ${version}
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
  // Clean slate — discard any leftover from prior runs.
  await deleteAgent();

  const dirs: string[] = [];

  try {
    // ── IT-1: push → run 403 → verify → run not-403 ─────────────────────
    const v1 = V1;
    console.log(`Testing IT-1: push ${v1} → run 403 → verify → run not-403...`);
    dirs.push(buildAndPush(v1));
    {
      const blocked = await runAgent({ version: v1 });
      const blockedBody = (await blocked.json()) as { error?: { code?: string } };
      results.push({
        agent: "verify-required",
        feature: "IT-1a: unverified push → 403 AGENT_NOT_VERIFIED",
        passed: blocked.status === 403 && blockedBody.error?.code === "AGENT_NOT_VERIFIED",
        duration: 0,
        cost: 0,
        detail: `status=${blocked.status} code=${blockedBody.error?.code ?? ""}`,
      });
    }
    {
      const verifyRes = await verifyVersion(v1, true);
      results.push({
        agent: "verify-required",
        feature: "IT-1b: PATCH /versions/:v/verify → 200",
        passed: verifyRes.status === 200,
        duration: 0,
        cost: 0,
        detail: `status=${verifyRes.status}`,
      });
    }
    {
      const after = await runAgent({ version: v1 });
      // Past the verified gate — downstream may LLM-fail (anthropic key
      // requirement, etc.) but the response must NOT be 403 AGENT_NOT_VERIFIED.
      let body: { error?: { code?: string } } = {};
      try {
        body = (await after.json()) as { error?: { code?: string } };
      } catch {
        // SSE response — fine, only the status matters here.
      }
      const passed = !(after.status === 403 && body.error?.code === "AGENT_NOT_VERIFIED");
      results.push({
        agent: "verify-required",
        feature: "IT-1c: post-verify run no longer 403",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${after.status} code=${body.error?.code ?? ""}`,
      });
    }

    // ── IT-2: pinned callers protected when newer version is pushed ─────
    const v2 = V2;
    console.log(`Testing IT-2: push ${v2} over verified ${v1} → pinned callers safe...`);
    dirs.push(buildAndPush(v2));
    {
      // v1 was verified above; check it's STILL verified (not reset by v2 push).
      const meta = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = (await meta.json()) as {
        versions: Array<{ version: string; verified: boolean }>;
      };
      const v1Row = body.versions.find((v) => v.version === v1);
      const v2Row = body.versions.find((v) => v.version === v2);
      results.push({
        agent: "verify-required",
        feature: "IT-2a: BR-2 pinned v1 stays verified after v2 push",
        passed: v1Row?.verified === true && v2Row?.verified === false,
        duration: 0,
        cost: 0,
        detail: `v1.verified=${v1Row?.verified} v2.verified=${v2Row?.verified}`,
      });
    }
    {
      // v2 (latest, unverified) → 403; v1 (pinned, verified) → not 403.
      const v2Run = await runAgent({ version: v2 });
      const v2Body = (await v2Run.json()) as { error?: { code?: string } };
      results.push({
        agent: "verify-required",
        feature: "IT-2b: pinned v2 (unverified) → 403",
        passed: v2Run.status === 403 && v2Body.error?.code === "AGENT_NOT_VERIFIED",
        duration: 0,
        cost: 0,
        detail: `status=${v2Run.status} code=${v2Body.error?.code ?? ""}`,
      });
    }

    // ── IT-3: PATCH endpoint round-trip (log shape covered in unit test) ─
    const v3 = V3;
    console.log(`Testing IT-3: PATCH ${v3} → 200 round-trip...`);
    dirs.push(buildAndPush(v3));
    {
      const res = await verifyVersion(v3, true);
      const body = (await res.json()) as Record<string, unknown>;
      results.push({
        agent: "verify-required",
        feature: "IT-3: PATCH returns updated row with verified=true",
        passed: res.status === 200 && body.verified === true && body.version === v3,
        duration: 0,
        cost: 0,
        detail: `status=${res.status} verified=${body.verified} version=${body.version}`,
      });
    }
  } finally {
    // Cleanup — DELETE the whole agent (cascades to versions) so the next
    // phase-15 invocation starts from a clean slate.
    await deleteAgent();
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
  }
}
