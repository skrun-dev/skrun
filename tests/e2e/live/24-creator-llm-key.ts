/**
 * Phase 24 — creator-attached LLM keys (#102) live coverage.
 *
 * Drives the creator-key surface against the dev-mode registry (dev-token =
 * master credential). The headline path attaches a REAL provider key as the
 * agent's creator key and runs the agent KEYLESS — proving a caller can run it
 * without supplying a key (the creator pays). The gate cases (caller-key policy,
 * delegated-key denial) fire BEFORE any inference, so they cost nothing:
 *
 *   VT-24a: attach a creator key → 200 { provider, last4 } (or, when the registry
 *           has no SKRUN_SECRETS_ENCRYPTION_KEY, 500 ENCRYPTION_NOT_CONFIGURED —
 *           the inference-dependent steps are then skipped, not failed).
 *   VT-24b: GET …/llm-keys round-trips { policy, keys:[{provider,last4}] } and
 *           never the key.
 *   VT-24c: a keyless run succeeds on the creator key (real inference).
 *   VT-24d: under creator_only, a run carrying X-LLM-API-Key → 403 CALLER_KEY_NOT_ALLOWED.
 *   VT-24e: a delegated (scope_kind=agents) key attaching a creator key → 403 KEY_SCOPE_FORBIDDEN.
 *
 * Self-bootstrapping: pushes its own fixture and DELETEs it at the end.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "creator-llm-key-live";
const V1 = "9.24.1";
const PROVIDER = "google";

async function deleteAgent(name: string): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-24-${name}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: Phase 24 live fixture used by tests/e2e/live/24-creator-llm-key.ts to assert creator-attached LLM key resolution (keyless run on the creator key) and the caller-key policy gate.
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
  provider: ${PROVIDER}
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

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "creator-llm-key", feature, passed, duration: 0, cost: 0, detail });
}

function authJson(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function run(): Promise<void> {
  await deleteAgent(AGENT);
  const dirs: string[] = [];
  try {
    dirs.push(buildAndPush(AGENT));
    // Verify the version (dev-token = admin) so the keyless run (VT-24c) clears the
    // verification gate under the default `admin` policy. That gate sits AFTER the
    // caller-key policy gate, so the 403 cases (VT-24d/e) don't need it.
    await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${V1}/verify`, {
      method: "PATCH",
      headers: authJson(TOKEN),
      body: JSON.stringify({ verified: true }),
    });

    const realKey = process.env.GOOGLE_API_KEY ?? "";

    // ── VT-24a: attach a creator key ─────────────────────────────────────
    let encryptionConfigured = true;
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/llm-keys/${PROVIDER}`, {
        method: "PUT",
        headers: authJson(TOKEN),
        body: JSON.stringify({ key: realKey || "AIza-placeholder-0000000000000000" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        provider?: string;
        last4?: string;
        error?: { code?: string };
      };
      if (res.status === 500 && body.error?.code === "ENCRYPTION_NOT_CONFIGURED") {
        encryptionConfigured = false;
        record(
          "VT-24a (#102): attach skipped — registry has no SKRUN_SECRETS_ENCRYPTION_KEY",
          true,
          "set SKRUN_SECRETS_ENCRYPTION_KEY to exercise attach/keyless-run",
        );
      } else {
        record(
          "VT-24a (#102): attach creator key → 200 { provider, last4 }",
          res.status === 200 && body.provider === PROVIDER && typeof body.last4 === "string",
          `status=${res.status} provider=${body.provider} last4=${body.last4}`,
        );
      }
    }

    // ── VT-24b: GET round-trips presence, never the key ──────────────────
    if (encryptionConfigured) {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/llm-keys`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const text = await res.text();
      const body = JSON.parse(text) as {
        policy?: string;
        keys?: Array<{ provider?: string; last4?: string }>;
      };
      const hasGoogle = (body.keys ?? []).some((k) => k.provider === PROVIDER);
      const leaksKey = realKey.length > 0 && text.includes(realKey);
      record(
        "VT-24b (#102): GET /llm-keys → policy + presence, never the key",
        res.status === 200 && body.policy === "open" && hasGoogle && !leaksKey,
        `status=${res.status} policy=${body.policy} hasGoogle=${hasGoogle} leaksKey=${leaksKey}`,
      );
    }

    // ── VT-24c: a keyless run succeeds on the creator key (real inference) ─
    if (encryptionConfigured && realKey) {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
        method: "POST",
        headers: authJson(TOKEN), // NO X-LLM-API-Key — relies on the creator key
        body: JSON.stringify({ input: { task: "say ok" } }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      record(
        "VT-24c (#102): keyless run succeeds on the creator key",
        res.status === 200 && body.status === "completed",
        `status=${res.status} run_status=${body.status}`,
      );
    }

    // ── VT-24d: creator_only rejects a run carrying X-LLM-API-Key ─────────
    {
      await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/llm-key-policy`, {
        method: "PUT",
        headers: authJson(TOKEN),
        body: JSON.stringify({ policy: "creator_only" }),
      });
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
        method: "POST",
        headers: { ...authJson(TOKEN), "X-LLM-API-Key": JSON.stringify({ google: "AIza-caller" }) },
        body: JSON.stringify({ input: { task: "x" } }),
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      record(
        "VT-24d (#102): creator_only + X-LLM-API-Key → 403 CALLER_KEY_NOT_ALLOWED",
        res.status === 403 && code === "CALLER_KEY_NOT_ALLOWED",
        `status=${res.status} code=${code}`,
      );
      // Restore open so the cleanup + reruns aren't affected.
      await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/llm-key-policy`, {
        method: "PUT",
        headers: authJson(TOKEN),
        body: JSON.stringify({ policy: "open" }),
      });
    }

    // ── VT-24e: a delegated key cannot attach a creator key ──────────────
    {
      const mint = await fetch(`${REGISTRY}/api/keys`, {
        method: "POST",
        headers: authJson(TOKEN),
        body: JSON.stringify({
          name: "live-24-delegated",
          scope_kind: "agents",
          agents: [`${NS}/${AGENT}`],
          scopes: ["agent:run"],
        }),
      });
      const delegated = ((await mint.json()) as { key?: string }).key ?? "";
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/llm-keys/${PROVIDER}`, {
        method: "PUT",
        headers: authJson(delegated),
        body: JSON.stringify({ key: "AIza-delegated-should-fail" }),
      });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      record(
        "VT-24e (#102): delegated key attaching a creator key → 403 KEY_SCOPE_FORBIDDEN",
        res.status === 403 && code === "KEY_SCOPE_FORBIDDEN",
        `status=${res.status} code=${code}`,
      );
    }
  } finally {
    await deleteAgent(AGENT);
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
  }
}
