/**
 * Phase 23 — API-key scopes (#65) live coverage.
 *
 * Mints REAL `sk_live` keys (via `POST /api/keys` with the dev-token = admin)
 * and drives the scope matrix with them. The #65 gates are **key-based, not
 * role-based** — a restricted key restricts even the admin dev-token owner — so
 * the full matrix is exercisable against the dev-mode registry, and every 403
 * fires BEFORE the bundle pull / LLM call (zero inference cost):
 *
 *   VT-23a: minting a scoped key round-trips `scope_kind:"agents"` (201).
 *   VT-23b: `GET /api/keys` surfaces `scope_kind` (new response key, asserted live).
 *   VT-23c: a key scoped to agent-1 running agent-2 → 403 KEY_SCOPE_FORBIDDEN.
 *   VT-23d: a delegated key `GET …/pull` (source) → 403 KEY_SCOPE_FORBIDDEN.
 *   VT-23e: a delegated key `POST /api/keys` (key mgmt) → 403 KEY_SCOPE_FORBIDDEN.
 *
 * Self-bootstrapping: pushes its own fixtures under stable versions and DELETEs
 * at the end (dev-token = admin).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT1 = "api-key-scope-live-1";
const AGENT2 = "api-key-scope-live-2";
const V1 = "9.23.1";

async function deleteAgent(name: string): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-23-${name}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: Phase 23 live fixture used by tests/e2e/live/23-api-key-scopes.ts to assert API-key scope enforcement (run/pull/key-management) for resource-scoped keys.
---

# ${name}

Reply with the literal string "ok".
`,
  );
  writeFileSync(
    join(dir, "agent.yaml"),
    `name: ${name}
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

async function mintKey(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${REGISTRY}/api/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "api-key-scopes", feature, passed, duration: 0, cost: 0, detail });
}

export async function run(): Promise<void> {
  await deleteAgent(AGENT1);
  await deleteAgent(AGENT2);

  const dirs: string[] = [];
  try {
    dirs.push(buildAndPush(AGENT1));
    dirs.push(buildAndPush(AGENT2));

    // ── VT-23a: mint a run-only key scoped to AGENT1 ─────────────────────
    let scopedKey = "";
    {
      const res = await mintKey({
        name: "live-scoped",
        scope_kind: "agents",
        agents: [`${NS}/${AGENT1}`],
        scopes: ["agent:run"],
      });
      const body = (await res.json()) as { key?: string; scope_kind?: string };
      scopedKey = body.key ?? "";
      record(
        "VT-23a (#65): mint scope_kind=agents → 201 + scope_kind echoed",
        res.status === 201 && body.scope_kind === "agents" && scopedKey.startsWith("sk_live_"),
        `status=${res.status} scope_kind=${body.scope_kind}`,
      );
    }

    // ── VT-23b: GET /api/keys surfaces scope_kind ────────────────────────
    {
      const res = await fetch(`${REGISTRY}/api/keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const list = (await res.json()) as Array<{ scope_kind?: string }>;
      const hasScoped = Array.isArray(list) && list.some((k) => k.scope_kind === "agents");
      record(
        "VT-23b (#65): GET /api/keys round-trips scope_kind",
        res.status === 200 && hasScoped,
        `status=${res.status} hasScoped=${hasScoped}`,
      );
    }

    // ── VT-23c: scoped key running an OUT-of-scope agent → 403 ───────────
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT2}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${scopedKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: { task: "x" } }),
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      record(
        "VT-23c (#65): scoped key runs out-of-scope agent → 403 KEY_SCOPE_FORBIDDEN",
        res.status === 403 && code === "KEY_SCOPE_FORBIDDEN",
        `status=${res.status} code=${code}`,
      );
    }

    // ── VT-23d: delegated key GET …/pull (source) → 403 ──────────────────
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT1}/pull`, {
        headers: { Authorization: `Bearer ${scopedKey}` },
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      record(
        "VT-23d (#65): delegated key GET /pull → 403 KEY_SCOPE_FORBIDDEN",
        res.status === 403 && code === "KEY_SCOPE_FORBIDDEN",
        `status=${res.status} code=${code}`,
      );
    }

    // ── VT-23e: delegated key POST /api/keys (key mgmt) → 403 ────────────
    {
      const res = await fetch(`${REGISTRY}/api/keys`, {
        method: "POST",
        headers: { Authorization: `Bearer ${scopedKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "should-fail" }),
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      record(
        "VT-23e (#65): delegated key POST /api/keys → 403 KEY_SCOPE_FORBIDDEN",
        res.status === 403 && code === "KEY_SCOPE_FORBIDDEN",
        `status=${res.status} code=${code}`,
      );
    }
  } finally {
    await deleteAgent(AGENT1);
    await deleteAgent(AGENT2);
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
  }
}
