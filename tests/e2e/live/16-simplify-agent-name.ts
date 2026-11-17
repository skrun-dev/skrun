/**
 * Phase 16 — simplify-agent-name (#84) live coverage.
 *
 * VT-9: push slug-only agent → registry stores (namespace, name) correctly,
 *       no drift between bundle yaml and registry identity.
 * State, per caller: the fixture keeps one notebook per caller
 *        (`scope: per_caller`). A dev-token run writes under the account's
 *        partition (`account:<id>`), and deleting the agent deletes every
 *        notebook it had — read in the registry's own database.
 * Database pre-flight: no legacy <ns>/<slug> form survived in `agents.name`,
 *        and every state row names an agent that exists.
 * Also: a CLI-level rejection check that `skrun build` fails fast on a
 * legacy-form yaml with the new schema error message.
 *
 * Self-bootstrapping: pushes its own fixture under stable version 9.16.1
 * and DELETEs at the end. Does not depend on the demo wipe script.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cliEnv, pushFixture, REGISTRY, results, skrun, TOKEN } from "./_ctx.js";
import { openRegistryDb, queryFailure } from "./registry-db.js";

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

/** DELETE the agent; resolves to the HTTP status (204 when it was deleted). */
async function deleteAgent(): Promise<number> {
  const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return res.status;
}

async function buildAndPush(version: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-16-${version}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 16 live fixture — minimal stateful agent used by tests/e2e/live/16-simplify-agent-name.ts to assert slug-only push, no bundle↔registry drift, and one state notebook per caller. Not for end-user consumption.
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
  name: gemini-3.8-flash
state:
  type: kv
  scope: per_caller
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
  await pushFixture(dir);
  return dir;
}

/** The id of the dev-token's account, as the registry knows it. */
async function devAccountId(): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/api/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  const me = (await res.json()) as { id?: string };
  return me.id ?? null;
}

/** The `state.scope` the registry parsed from the pushed version. */
async function pushedScope(version: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    versions?: Array<{ version: string; config_snapshot?: { state?: { scope?: string } } }>;
  };
  const v = body.versions?.find((x) => x.version === version);
  return v?.config_snapshot?.state?.scope ?? null;
}

export async function run(): Promise<void> {
  // Clean slate.
  await deleteAgent();

  const dirs: string[] = [];
  const legacyDir = mkdtempSync(join(tmpdir(), "skrun-live-16-legacy-"));
  const db = openRegistryDb();

  try {
    if (!db) {
      results.push({
        agent: "simplify-name",
        feature: "the registry's database is readable (DATABASE_URL, or skrun.db at the root)",
        passed: false,
        duration: 0,
        cost: 0,
        detail: "no database to read",
      });
    }

    // ── Database pre-flight ───────────────────────────────────────────────
    if (db) {
      try {
        const [agentsRow] = await db.all("SELECT COUNT(*) AS c FROM agents WHERE name LIKE '%/%'");
        const agentsViolators = Number(agentsRow?.c);
        results.push({
          agent: "simplify-name",
          feature: "database pre-flight: agents.name has no slash",
          passed: agentsViolators === 0,
          duration: 0,
          cost: 0,
          detail: `db=${db.kind} count=${agentsViolators}`,
        });

        // agent_state may legitimately be empty (no stateful runs yet).
        // Only assert non-violation: every row, if any, names an agent that exists.
        const [orphanRow] = await db.all(
          "SELECT COUNT(*) AS c FROM agent_state s LEFT JOIN agents a ON a.id = s.agent_id WHERE a.id IS NULL",
        );
        const orphans = Number(orphanRow?.c);
        results.push({
          agent: "simplify-name",
          feature: "database pre-flight: every agent_state row names an existing agent",
          passed: orphans === 0,
          duration: 0,
          cost: 0,
          detail: `db=${db.kind} orphans=${orphans}`,
        });
      } catch (err) {
        results.push({
          agent: "simplify-name",
          feature: "database pre-flight",
          passed: false,
          duration: 0,
          cost: 0,
          detail: `db=${db.kind} ${queryFailure(err)}`,
        });
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
  name: gemini-3.8-flash
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
          env: cliEnv(),
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
    dirs.push(await buildAndPush(V1));
    {
      // VT-9a: assert the registry stored identity (namespace, name) with no
      // drift from the bundle yaml. Queried via the API — backend-agnostic, so
      // it works against both a local SQLite and a cloud Postgres registry. (The
      // old direct better-sqlite3 read of skrun.db was absent in cloud mode and,
      // worse, returned a STALE row from a leftover local skrun.db → false fail.)
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const meta = res.ok ? ((await res.json()) as { namespace?: string; name?: string }) : null;
      results.push({
        agent: "simplify-name",
        feature: "VT-9a: registry stored identity is (namespace=dev, name=simplify-name-live)",
        passed: res.ok && meta?.namespace === NS && meta?.name === AGENT,
        duration: 0,
        cost: 0,
        detail: `status=${res.status} meta=${JSON.stringify(meta ?? null)}`,
      });
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

    // ── State, per caller: the run's partition, then the agent's deletion ──
    // We don't depend on the LLM actually writing state (Gemini may not on a
    // single-turn echo). Two acceptable outcomes for the run: (a) no row
    // landed, (b) every row of this agent is the dev-token account's
    // partition. Then, unconditionally: the agent's DELETE answers 204, and no
    // state row is left for its id. With no row written, "none left" proves
    // nothing about the cascade: the detail line says so (cascade=vacuous)
    // rather than passing it off as evidence.
    if (db) {
      try {
        const scope = await pushedScope(V1);
        const accountId = await devAccountId();
        const [agentRow] = await db.all("SELECT id FROM agents WHERE namespace = ? AND name = ?", [
          NS,
          AGENT,
        ]);
        const agentId = agentRow ? String(agentRow.id) : null;
        const stateRows = agentId
          ? await db.all("SELECT partition_key FROM agent_state WHERE agent_id = ?", [agentId])
          : [];
        const partitions = stateRows.map((r) => String(r.partition_key));
        const allAccount =
          accountId !== null && partitions.every((p) => p === `account:${accountId}`);
        const kinds = [...new Set(partitions.map((p) => p.split(":")[0]))].join(",") || "(none)";

        const deleteStatus = await deleteAgent();
        const [afterRow] = agentId
          ? await db.all("SELECT COUNT(*) AS c FROM agent_state WHERE agent_id = ?", [agentId])
          : [];
        const afterDelete = afterRow ? Number(afterRow.c) : Number.NaN;

        results.push({
          agent: "simplify-name",
          feature:
            "state per caller: a dev-token run writes the account's notebook, and the agent's deletion leaves none",
          passed:
            scope === "per_caller" &&
            agentId !== null &&
            allAccount &&
            deleteStatus === 204 &&
            afterDelete === 0,
          duration: 0,
          cost: 0,
          detail: `scope=${scope} rows=${partitions.length} partitions=${kinds} delete=${deleteStatus} after_delete=${afterDelete} cascade=${partitions.length > 0 ? "proven" : "vacuous"}`,
        });
      } catch (err) {
        results.push({
          agent: "simplify-name",
          feature: "state per caller",
          passed: false,
          duration: 0,
          cost: 0,
          detail: `db=${db.kind} ${queryFailure(err)}`,
        });
      }
    }
  } finally {
    await db?.close().catch(() => {});
    // Cleanup — DELETE the whole agent (with its versions and its state) so
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
