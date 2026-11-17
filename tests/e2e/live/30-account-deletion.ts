/**
 * Live coverage of deleting an account, on the registry's own database.
 *
 * Three dev tokens of its own — never the suite's `dev-token`: the registry
 * may run on a shared database, and deleting the `dev` account would delete
 * the agents every other phase pushed. A dev token `<ns>-token` signs in as the
 * account `<ns>` and is an administrator.
 *
 * 1. `delself` pushes an agent (two versions), mints a key, runs the agent,
 *    then deletes its own account (`DELETE /api/account`). In the database: no
 *    account, agent or key row left for it; its run is still there, cleared,
 *    marked and detached, with the version it names reduced to `@<version>`.
 *    The agent is not found any more.
 * 2. `deltgt` pushes an agent; `deladm` reads its id and deletes it by the
 *    admin route (`DELETE /api/admin/accounts/:id`). The same reads.
 *
 * After a deletion, the deleted account's token is never sent again: a dev
 * token's next request creates a new, empty account under the same name.
 *
 * Pushes go over HTTP, with the bundle `skrun build` writes: the CLI holds one
 * session for the registry, the suite's (`dev-token`, signed in in the suite's
 * own profile), and signing it in as another account would replace that session
 * for every phase after this one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun } from "./_ctx.js";
import { openRegistryDb, queryFailure, type RegistryDb } from "./registry-db.js";

const SELF = "delself";
const TARGET = "deltgt";
const ADMIN = "deladm";
const AGENT = "account-deletion-live";
const V1 = "9.30.1";
const V2 = "9.30.2";

const tokenOf = (ns: string) => `${ns}-token`;
const bearer = (ns: string) => ({ Authorization: `Bearer ${tokenOf(ns)}` });

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "account-deletion", feature, passed, duration: 0, cost: 0, detail });
}

/** The window a 429 names (`Limit: 10 per 60s.`), in seconds. */
const RATE_LIMIT_WINDOW = /Limit: \d+ per (\d+)s\b/;

/** Build `version` of the fixture in a fresh directory; returns the bundle's bytes. */
function build(version: string, dirs: string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-30-${version}-`));
  dirs.push(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Live fixture used by tests/e2e/live/30-account-deletion.ts — pushed by an account that is then deleted. Not for end-user consumption.
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
  return readFileSync(join(dir, `${AGENT}-${version}.agent`));
}

/**
 * Push `bundle` as `<ns>/<AGENT>@<version>` and verify it (a dev token is an
 * administrator). The push route's rate limit is shared by the whole suite:
 * a 429 waits for its window, three times at most. Returns the push status.
 */
async function pushAndVerify(ns: string, version: string, bundle: Buffer): Promise<number> {
  let res: Response;
  for (let waits = 0; ; waits++) {
    res = await fetch(`${REGISTRY}/api/agents/${ns}/${AGENT}/push?version=${version}`, {
      method: "POST",
      headers: { ...bearer(ns), "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    if (res.status !== 429 || waits === 3) break;
    const text = await res.text();
    const seconds = Number(RATE_LIMIT_WINDOW.exec(text)?.[1] ?? 60) + 5;
    console.log(`  push rate-limited (429): waiting ${seconds}s (${waits + 1}/3)`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  if (res.status !== 200) return res.status;
  await fetch(`${REGISTRY}/api/agents/${ns}/${AGENT}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { ...bearer(ns), "Content-Type": "application/json" },
    body: JSON.stringify({ verified: true }),
  });
  return res.status;
}

/** The account id the registry gives the token of `ns` (it creates the account if needed). */
async function accountId(ns: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/api/me`, { headers: bearer(ns) });
  if (!res.ok) return null;
  return ((await res.json()) as { id?: string }).id ?? null;
}

/** `DELETE /api/account` as `ns`, confirmed with its own name. */
function deleteOwnAccount(ns: string): Promise<Response> {
  return fetch(`${REGISTRY}/api/account`, {
    method: "DELETE",
    headers: { ...bearer(ns), "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: ns }),
  });
}

/** The status of `GET` on the deleted account's agent, read by the administrator. */
async function agentStatus(ns: string): Promise<number> {
  const res = await fetch(`${REGISTRY}/api/agents/${ns}/${AGENT}`, { headers: bearer(ADMIN) });
  return res.status;
}

/** How many rows the deleted account still has, per table. */
async function rowsLeft(db: RegistryDb, id: string, ns: string) {
  const count = async (sql: string, params: unknown[]) => Number((await db.all(sql, params))[0]?.c);
  return {
    users: await count("SELECT COUNT(*) AS c FROM users WHERE id = ?", [id]),
    agents: await count("SELECT COUNT(*) AS c FROM agents WHERE owner_id = ? OR namespace = ?", [
      id,
      ns,
    ]),
    api_keys: await count("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?", [id]),
  };
}

const noneLeft = (rows: { users: number; agents: number; api_keys: number }) =>
  rows.users === 0 && rows.agents === 0 && rows.api_keys === 0;

/** A column that holds a JSON array: Postgres hands it parsed, SQLite as text. */
const isEmptyList = (value: unknown) =>
  Array.isArray(value) ? value.length === 0 : value === "[]";

export async function run(): Promise<void> {
  const dirs: string[] = [];
  const db = openRegistryDb();
  try {
    if (!db) {
      record(
        "the registry's database is readable (DATABASE_URL, or skrun.db at the root)",
        false,
        "no database to read",
      );
      return;
    }

    // A clean slate: an account left by an interrupted run is deleted first.
    // (Each token's first request creates its account if it has none.)
    for (const ns of [SELF, TARGET]) await deleteOwnAccount(ns);

    // ── 1. An account deletes itself ────────────────────────────────────
    try {
      const v1 = build(V1, dirs);
      const v2 = build(V2, dirs);
      const pushes = [await pushAndVerify(SELF, V1, v1), await pushAndVerify(SELF, V2, v2)];
      const keyRes = await fetch(`${REGISTRY}/api/keys`, {
        method: "POST",
        headers: { ...bearer(SELF), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "account-deletion-live" }),
      });
      const selfId = await accountId(SELF);
      const ran = await fetch(`${REGISTRY}/api/agents/${SELF}/${AGENT}/run`, {
        method: "POST",
        headers: { ...bearer(SELF), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { task: "ping" } }),
      });
      const runId = ((await ran.json().catch(() => ({}))) as { run_id?: string }).run_id ?? null;
      const before = selfId ? await rowsLeft(db, selfId, SELF) : null;
      record(
        "self: the account has its agent, its key and its run before the deletion",
        pushes.every((s) => s === 200) &&
          keyRes.status === 201 &&
          runId !== null &&
          before !== null &&
          before.users === 1 &&
          before.agents === 1 &&
          before.api_keys === 1,
        `db=${db.kind} pushes=${pushes.join(",")} key=${keyRes.status} run=${ran.status} run_id=${runId ? "yes" : "no"} rows=${JSON.stringify(before)}`,
      );

      const deleted = await deleteOwnAccount(SELF);
      const body = (await deleted.json().catch(() => null)) as { deleted?: boolean } | null;
      record(
        "self: DELETE /api/account with the account's own name → 200",
        deleted.status === 200 && body?.deleted === true,
        `status=${deleted.status} body=${JSON.stringify(body)}`,
      );

      // The token of the deleted account is not sent again from here on.
      const after = selfId ? await rowsLeft(db, selfId, SELF) : null;
      record(
        "self: no account, agent or key row is left for it",
        after !== null && noneLeft(after),
        `db=${db.kind} rows=${JSON.stringify(after)}`,
      );

      const [row] = runId
        ? await db.all(
            "SELECT content_cleared_at, input, output, error, files, user_id, agent_id, agent_version FROM runs WHERE id = ?",
            [runId],
          )
        : [];
      const cleared =
        row !== undefined &&
        row.content_cleared_at !== null &&
        row.input === null &&
        row.output === null &&
        row.error === null &&
        isEmptyList(row.files) &&
        row.user_id === null &&
        row.agent_id === null &&
        row.agent_version === `@${V2}`;
      record(
        "self: its run is still there, cleared, marked and detached, naming only its version",
        cleared,
        row
          ? `db=${db.kind} marked=${row.content_cleared_at !== null} input=${row.input === null ? "null" : "set"} output=${row.output === null ? "null" : "set"} error=${row.error === null ? "null" : "set"} files_empty=${isEmptyList(row.files)} user_id=${row.user_id === null ? "null" : "set"} agent_id=${row.agent_id === null ? "null" : "set"} agent_version=${String(row.agent_version)}`
          : `db=${db.kind} no run row (run status=${ran.status})`,
      );

      const status = await agentStatus(SELF);
      record("self: its agent is not found", status === 404, `status=${status}`);
    } catch (err) {
      record(
        "self: the deletion of an account by itself",
        false,
        err instanceof Error ? queryFailure(err) : String(err),
      );
    }

    // ── 2. An administrator deletes another account ─────────────────────
    try {
      const pushed = await pushAndVerify(TARGET, V1, build(V1, dirs));
      const targetId = await accountId(TARGET);
      const before = targetId ? await rowsLeft(db, targetId, TARGET) : null;
      record(
        "admin: the target account has its agent before the deletion",
        pushed === 200 && before !== null && before.users === 1 && before.agents === 1,
        `db=${db.kind} push=${pushed} rows=${JSON.stringify(before)}`,
      );

      const deleted = await fetch(`${REGISTRY}/api/admin/accounts/${targetId}`, {
        method: "DELETE",
        headers: { ...bearer(ADMIN), "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: TARGET }),
      });
      const body = (await deleted.json().catch(() => null)) as { deleted?: boolean } | null;
      record(
        "admin: DELETE /api/admin/accounts/:id with the target's name → 200",
        deleted.status === 200 && body?.deleted === true,
        `status=${deleted.status} body=${JSON.stringify(body)}`,
      );

      const after = targetId ? await rowsLeft(db, targetId, TARGET) : null;
      record(
        "admin: no account, agent or key row is left for the target",
        after !== null && noneLeft(after),
        `db=${db.kind} rows=${JSON.stringify(after)}`,
      );
      const status = await agentStatus(TARGET);
      record("admin: the target's agent is not found", status === 404, `status=${status}`);
    } catch (err) {
      record(
        "admin: the deletion of another account",
        false,
        err instanceof Error ? queryFailure(err) : String(err),
      );
    }
  } finally {
    // The administrator's own account goes too: the phase leaves no account behind.
    await deleteOwnAccount(ADMIN).catch(() => {});
    await db?.close().catch(() => {});
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
  }
}
