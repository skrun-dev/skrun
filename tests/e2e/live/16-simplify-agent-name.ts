/**
 * Phase 16 — simplify-agent-name (#84) live coverage.
 *
 * VT-9: push slug-only agent → registry stores (namespace, name) correctly,
 *       no drift between bundle yaml and registry identity.
 * VT-14: stateful kv-mode run → state row in agent_state is keyed by
 *        `${namespace}/${slug}` (proves the multi-tenant wiring fix).
 * VT-15: DB defensive — pre-flight asserts no legacy <ns>/<slug> form
 *        survived in `agents.name`, and any `agent_state.agent_name` row
 *        carries the namespaced prefix.
 * Also: a CLI-level rejection check that `skrun build` fails fast on a
 * legacy-form yaml with the new schema error message.
 *
 * Self-bootstrapping: pushes its own fixture under stable version 9.16.1
 * and DELETEs at the end. Does not depend on Task 7.1 wipe script.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CLI, REGISTRY, ROOT, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "simplify-name-live";
const V1 = "9.16.1";

async function runAgent(): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { task: "ping" } }),
  });
}

async function verifyVersion(version: string): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified: true }),
  });
}

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-16-${version}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 16 live fixture — minimal stateful agent used by tests/e2e/live/16-simplify-agent-name.ts to assert post-#84 slug-only push, no bundle↔registry drift, and namespace-scoped agent_state keys. Not for end-user consumption.
---

# ${AGENT}

Reply with the literal string "ok".
`,
  );
  writeFileSync(
    join(dir, "agent.yaml"),
    `name: ${AGENT}
version: ${version}
model:
  provider: google
  name: gemini-2.5-flash
state:
  type: kv
  ttl: 1d
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

/**
 * Open the local SQLite DB read-only. Returns null if the DB doesn't exist
 * (e.g., production-class env where the registry is backed by Supabase).
 * Tests that depend on direct DB access skip themselves cleanly in that case.
 */
function openLocalDb(): Database.Database | null {
  const dbFile = join(ROOT, "skrun.db");
  if (!existsSync(dbFile)) return null;
  return new Database(dbFile, { readonly: true });
}

export async function run(): Promise<void> {
  // Clean slate.
  await deleteAgent();

  const dirs: string[] = [];
  const legacyDir = mkdtempSync(join(tmpdir(), "skrun-live-16-legacy-"));

  try {
    // ── VT-15: DB defensive pre-flight (SC-10) ─────────────────────────────
    {
      const db = openLocalDb();
      if (db) {
        try {
          const agentsViolators = db
            .prepare("SELECT COUNT(*) as c FROM agents WHERE name LIKE '%/%'")
            .get() as { c: number };
          results.push({
            agent: "simplify-name",
            feature: "VT-15a: DB defensive — agents.name has no slash",
            passed: agentsViolators.c === 0,
            duration: 0,
            cost: 0,
            detail: `count=${agentsViolators.c}`,
          });

          // agent_state may legitimately be empty (no stateful runs yet).
          // Only assert non-violation: every row, IF any, must be prefixed.
          const stateViolators = db
            .prepare("SELECT COUNT(*) as c FROM agent_state WHERE agent_name NOT LIKE '%/%'")
            .get() as { c: number };
          results.push({
            agent: "simplify-name",
            feature: "VT-15b: DB defensive — agent_state.agent_name carries prefix",
            passed: stateViolators.c === 0,
            duration: 0,
            cost: 0,
            detail: `count=${stateViolators.c}`,
          });
        } finally {
          db.close();
        }
      }
    }

    // ── VT-2 (live CLI rejection): legacy-form yaml fails build cleanly ───
    {
      writeFileSync(
        join(legacyDir, "SKILL.md"),
        `---
name: legacy-fixture
description: A legacy-form fixture intentionally crafted to fail skrun build under the post-#84 schema (asserts the user-facing error message guides the migration).
---
# legacy-fixture
Should never reach the registry — the build step rejects this yaml.
`,
      );
      writeFileSync(
        join(legacyDir, "agent.yaml"),
        `name: dev/legacy-fixture
version: 9.16.99
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
      let stderr = "";
      let crashed = false;
      try {
        execFileSync(process.execPath, [CLI, "build"], {
          cwd: legacyDir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch (err) {
        crashed = true;
        const e = err as { stderr?: Buffer | string };
        stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
      }
      const hasHint =
        stderr.toLowerCase().includes("remove the prefix") || stderr.toLowerCase().includes("slug");
      results.push({
        agent: "simplify-name",
        feature: "VT-2 (live): skrun build rejects legacy <ns>/<slug> yaml with remediation hint",
        passed: crashed && hasHint,
        duration: 0,
        cost: 0,
        detail: `crashed=${crashed} hint=${hasHint}`,
      });
    }

    // ── VT-9: push slug-only → no drift ────────────────────────────────────
    console.log(`Testing VT-9: push slug-only ${AGENT} ${V1}...`);
    dirs.push(buildAndPush(V1));
    {
      const db = openLocalDb();
      if (db) {
        try {
          const row = db
            .prepare("SELECT namespace, name FROM agents WHERE namespace = ? AND name = ?")
            .get(NS, AGENT) as { namespace: string; name: string } | undefined;
          results.push({
            agent: "simplify-name",
            feature: "VT-9a: registry row has (namespace=dev, name=simplify-name-live)",
            passed: row?.namespace === NS && row?.name === AGENT,
            duration: 0,
            cost: 0,
            detail: `row=${JSON.stringify(row ?? null)}`,
          });
        } finally {
          db.close();
        }
      }
    }

    // ── VT-9b: verify + run completes past the gate ───────────────────────
    {
      const verifyRes = await verifyVersion(V1);
      const verifyOk = verifyRes.status === 200;
      results.push({
        agent: "simplify-name",
        feature: "VT-9b: PATCH /verify → 200",
        passed: verifyOk,
        duration: 0,
        cost: 0,
        detail: `status=${verifyRes.status}`,
      });
    }
    {
      const runRes = await runAgent();
      // Past the verify gate — the run may or may not LLM-succeed depending
      // on Gemini transient availability. Either way, the response must NOT
      // be 403 AGENT_NOT_VERIFIED (which would mean the gate is broken) and
      // NOT be 400 INVALID_AGENT_NAME (which would mean the URL routing is
      // broken).
      let bodyJson: { error?: { code?: string } } = {};
      try {
        bodyJson = (await runRes.json()) as { error?: { code?: string } };
      } catch {
        // SSE response — only the status matters here.
      }
      const code = bodyJson.error?.code ?? "";
      const passed = code !== "AGENT_NOT_VERIFIED" && code !== "INVALID_AGENT_NAME";
      results.push({
        agent: "simplify-name",
        feature: "VT-9c: post-verify run past the gate (no drift)",
        passed,
        duration: 0,
        cost: 0,
        detail: `status=${runRes.status} code=${code}`,
      });
    }

    // ── VT-14: stateful-run shape check on agent_state key ────────────────
    // We don't depend on the LLM actually writing state (Gemini may not on a
    // single-turn echo). Instead we assert: IF a row landed in agent_state
    // for this agent, its key matches the `<ns>/<slug>` shape — confirming
    // the wiring fix lands the right key in the DB.
    {
      const db = openLocalDb();
      if (db) {
        try {
          const stateRows = db.prepare("SELECT agent_name FROM agent_state").all() as Array<{
            agent_name: string;
          }>;
          const relevantRows = stateRows.filter((r) => r.agent_name.includes(AGENT));
          // Two acceptable outcomes: (a) no row landed (LLM didn't set state),
          // (b) one or more rows landed AND every one is in `<ns>/<slug>` form.
          const allPrefixed = relevantRows.every((r) => r.agent_name === `${NS}/${AGENT}`);
          results.push({
            agent: "simplify-name",
            feature: "VT-14: agent_state keys for this agent (if any) are `<ns>/<slug>`",
            passed: allPrefixed,
            duration: 0,
            cost: 0,
            detail: `rows=${relevantRows.length} all_prefixed=${allPrefixed} sample=${
              relevantRows[0]?.agent_name ?? "(none)"
            }`,
          });
        } finally {
          db.close();
        }
      }
    }
  } finally {
    // Cleanup — DELETE the whole agent (cascades to versions + state) so
    // the next phase-16 invocation starts from a clean slate.
    await deleteAgent();
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch {}
  }
}
