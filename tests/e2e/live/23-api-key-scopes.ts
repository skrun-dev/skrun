/**
 * Phase 23 — API-key scopes (#65) live coverage.
 *
 * Mints REAL API keys (via `POST /api/keys` with the dev-token = admin)
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
 * Then a run-only key of the whole account (`scope_kind: account`, `agent:run`
 * alone) is refused run history, stats and an agent's source with 403
 * KEY_SCOPE_FORBIDDEN — each PASS line prints the refusal's message — while the
 * dev token reads the same three.
 *
 * Then `skrun keys` through the CLI alone, as a user would drive it:
 * `keys create --expires-in 30` prints the new key's id and its expiry,
 * `keys list` shows that id with that expiry, and `keys revoke <id>` revokes the
 * key by the id create printed. Each PASS line carries the id and the expiry.
 *
 * Self-bootstrapping: pushes its own fixtures under stable versions and DELETEs
 * at the end (dev-token = admin), and revokes every key it minted that is still
 * live, so a persistent database keeps none of them.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_KEY_PREFIX } from "../../../packages/api/src/auth/api-key.js";
import { pushFixture, REGISTRY, ROOT, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT1 = "api-key-scope-live-1";
const AGENT2 = "api-key-scope-live-2";
const V1 = "9.23.1";

const DAY_MS = 86_400_000;
/** The id `skrun keys create` prints on its own line (colour codes, if any, stop the match). */
const PRINTED_ID = /\bid: ([0-9A-Za-z-]+)/;
/** What follows `expires: ` on a line of `skrun keys`: an ISO-8601 instant, or `never`. */
const PRINTED_EXPIRY = /\bexpires: (never|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

async function revokeByApi(id: string): Promise<void> {
  await fetch(`${REGISTRY}/api/keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

/** What a failed CLI call said: its stderr when it wrote one, else the error. */
function cliFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

async function deleteAgent(name: string): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

async function buildAndPush(name: string): Promise<string> {
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
  await pushFixture(dir);
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
  // Every key this phase mints and has not revoked yet; the finally revokes them.
  const unrevoked = new Set<string>();
  try {
    dirs.push(await buildAndPush(AGENT1));
    dirs.push(await buildAndPush(AGENT2));

    // ── VT-23a: mint a run-only key scoped to AGENT1 ─────────────────────
    let scopedKey = "";
    {
      const res = await mintKey({
        name: "live-scoped",
        scope_kind: "agents",
        agents: [`${NS}/${AGENT1}`],
        scopes: ["agent:run"],
      });
      const body = (await res.json()) as {
        id?: string;
        key?: string;
        key_prefix?: string;
        scope_kind?: string;
      };
      if (body.id) unrevoked.add(body.id);
      scopedKey = body.key ?? "";
      record(
        "VT-23a (#65): mint scope_kind=agents → 201 + scope_kind echoed",
        res.status === 201 && body.scope_kind === "agents" && scopedKey.startsWith(API_KEY_PREFIX),
        `status=${res.status} scope_kind=${body.scope_kind} key_prefix=${body.key_prefix}`,
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

    // ── A run-only key of the whole account reads no history, stats or source ──
    // An account-wide key that carries `agent:run` alone — what `skrun keys
    // create --run-only` mints without `--agent` — runs the account's agents
    // but is not full access: run history, stats and an agent's source answer
    // 403. The dev token, a full-access credential, reads the same three.
    {
      const res = await mintKey({ name: "live-run-only-account", scopes: ["agent:run"] });
      const body = (await res.json()) as {
        id?: string;
        key?: string;
        key_prefix?: string;
        scope_kind?: string;
      };
      if (body.id) unrevoked.add(body.id);
      const runOnlyKey = body.key ?? "";
      record(
        "a run-only key of the whole account is minted (scope_kind=account, agent:run)",
        res.status === 201 &&
          body.scope_kind === "account" &&
          runOnlyKey.startsWith(API_KEY_PREFIX),
        `status=${res.status} scope_kind=${body.scope_kind} key_prefix=${body.key_prefix}`,
      );

      const reads = [
        { label: "GET /api/runs", path: "/api/runs" },
        { label: "GET /api/stats", path: "/api/stats" },
        { label: "GET /pull", path: `/api/agents/${NS}/${AGENT1}/pull` },
      ];
      for (const { label, path } of reads) {
        const refused = await fetch(`${REGISTRY}${path}`, {
          headers: { Authorization: `Bearer ${runOnlyKey}` },
        });
        let error: { code?: string; message?: string } | undefined;
        try {
          error = ((await refused.json()) as { error?: { code?: string; message?: string } }).error;
        } catch {
          error = undefined;
        }
        const served = await fetch(`${REGISTRY}${path}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        await served.arrayBuffer();
        record(
          `a run-only account key: ${label} → 403 KEY_SCOPE_FORBIDDEN; the dev token → 200`,
          refused.status === 403 && error?.code === "KEY_SCOPE_FORBIDDEN" && served.status === 200,
          `run-only status=${refused.status} code=${error?.code} message="${error?.message}" | dev-token status=${served.status}`,
        );
      }
    }

    // ── skrun keys through the CLI alone: create, list, revoke by the id ──
    // No inference: the three commands only talk to the key endpoints.
    {
      const CREATE = "skrun keys create --expires-in 30 prints the key's id and its expiry";
      const LIST = "skrun keys list shows that id with that expiry";
      const REVOKE = "skrun keys revoke <id> revokes the key by the id create printed";
      let id = "";
      let expiry = "";
      try {
        const before = Date.now();
        const out = skrun(
          ["keys", "create", "--name", "live-keys-cli", "--expires-in", "30"],
          ROOT,
        );
        const after = Date.now();
        id = out.match(PRINTED_ID)?.[1] ?? "";
        if (id) unrevoked.add(id);
        expiry = out.match(PRINTED_EXPIRY)?.[1] ?? "";
        // The CLI adds 30 days to its own clock, read between these two instants.
        const at = Date.parse(expiry);
        const thirtyDaysOut = at >= before + 30 * DAY_MS && at <= after + 30 * DAY_MS;
        record(
          CREATE,
          id !== "" && thirtyDaysOut,
          `id=${id || "(none printed)"} expires=${expiry || "(none printed)"}`,
        );
      } catch (err) {
        record(CREATE, false, cliFailure(err));
      }

      if (id === "") {
        record(LIST, false, "not run: keys create printed no id");
        record(REVOKE, false, "not run: keys create printed no id");
      } else {
        try {
          const line = skrun(["keys", "list"], ROOT)
            .split("\n")
            .find((l) => l.includes(id));
          const listed = line?.match(PRINTED_EXPIRY)?.[1] ?? "";
          record(
            LIST,
            line !== undefined && listed !== "" && listed === expiry,
            `id=${id} ${line === undefined ? "not listed" : `expires=${listed || "(none)"}`}`,
          );
        } catch (err) {
          record(LIST, false, cliFailure(err));
        }

        try {
          skrun(["keys", "revoke", id], ROOT);
          const stillListed = skrun(["keys", "list"], ROOT).includes(id);
          if (!stillListed) unrevoked.delete(id);
          record(
            REVOKE,
            !stillListed,
            `id=${id} expires=${expiry} listed after revoke=${stillListed}`,
          );
        } catch (err) {
          record(REVOKE, false, cliFailure(err));
        }
      }
    }
  } finally {
    for (const id of unrevoked) {
      try {
        await revokeByApi(id);
      } catch {
        // best effort: an unreachable registry keeps the key, the run still ends
      }
    }
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
