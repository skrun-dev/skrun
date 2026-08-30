/**
 * Phase 26 — the `model.base_url` guard (SEC-001, audit/006) live coverage.
 *
 * Two surfaces are new and therefore need a live assertion whose value is
 * printed (Definition of Done D-1): the `X-LLM-Base-URL` request header and the
 * `CALLER_BASE_URL_NOT_CONSENTED` error code.
 *
 * The rule under test: **a credential may only be sent to an endpoint chosen by
 * that credential's owner.** An `agent.yaml` may declare its own
 * `model.base_url`; an `X-LLM-API-Key` belongs to the caller. When those are two
 * different people, the caller must name the destination.
 *
 * Why a real `sk_live` key is minted rather than reusing the dev-token: the
 * exemption is `owner AND master credential`, and a dev-token IS a master
 * credential. Driving this with the dev-token would return 200 and assert
 * nothing — the drafted gate keyed on ownership alone was inert for exactly this
 * reason, and only a DELEGATED (`scope_kind: "agents"`) key exercises the case.
 *
 *   VT-26a: delegated caller + declared base_url + no consent → 403, code + origin printed.
 *   VT-26b: the same call naming the matching origin → past the gate.
 *   VT-26c: naming a DIFFERENT origin → 403 (both origins in the message).
 *   VT-26d: a malformed `X-LLM-Base-URL` → 400 INVALID_LLM_BASE_URL_HEADER.
 *
 * Every assertion fires BEFORE any LLM call, so this phase costs nothing in
 * inference. Self-bootstrapping: pushes its own fixture and DELETEs at the end.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY, results, skrun, TOKEN, verifyLatestVersion } from "./_ctx.js";

const NS = "dev";
const AGENT = "base-url-guard-live";
const V1 = "9.26.1";
/** The endpoint the agent declares — a real third-party OpenAI-compatible host. */
const DECLARED = "https://api.deepseek.com/v1";
const DECLARED_ORIGIN = "https://api.deepseek.com";

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function buildAndPush(): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-26-${AGENT}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 26 live fixture used by tests/e2e/live/26-base-url-guard.ts to assert that a caller's LLM key is not sent to an endpoint the agent's author chose.
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
  provider: openai
  name: deepseek-chat
  base_url: ${DECLARED}
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
  results.push({ agent: "base-url-guard", feature, passed, duration: 0, cost: 0, detail });
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function runAs(key: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ openai: "sk-caller-fake-not-a-real-key" }),
      ...headers,
    },
    body: JSON.stringify({ input: { task: "ping" } }),
  });
}

export async function run(): Promise<void> {
  await deleteAgent();

  let dir = "";
  try {
    dir = buildAndPush();

    // A run needs a verified version under the default `admin` policy.
    await verifyLatestVersion(NS, AGENT);

    // A DELEGATED key — the credential a creator hands a client. It resolves to
    // the owner's account, which is why ownership alone cannot gate this.
    const mint = await fetch(`${REGISTRY}/api/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "live-26-delegated",
        scopes: ["agent:run"],
        scope_kind: "agents",
        agents: [`${NS}/${AGENT}`],
      }),
    });
    const delegated = ((await mint.json()) as { key?: string }).key ?? "";
    if (!delegated.startsWith("sk_live_")) {
      record("VT-26 setup: mint a delegated key", false, `mint status=${mint.status}`);
      return;
    }

    // ── VT-26a: the finding — a caller key bound for the author's endpoint ──
    {
      const res = await runAs(delegated);
      const body = (await res.json()) as ErrorBody;
      const code = body.error?.code ?? "-";
      const namesOrigin = (body.error?.message ?? "").includes(DECLARED_ORIGIN);
      record(
        "VT-26a (SEC-001): delegated caller key + agent base_url, no consent → 403",
        res.status === 403 && code === "CALLER_BASE_URL_NOT_CONSENTED" && namesOrigin,
        `status=${res.status} code=${code} names_origin=${namesOrigin} origin=${DECLARED_ORIGIN}`,
      );
    }

    // ── VT-26b: naming the same origin lets it through ─────────────────────
    {
      // Origin, not exact string — the caller does not echo the agent's path.
      const res = await runAs(delegated, {
        "X-LLM-Base-URL": JSON.stringify({ openai: DECLARED_ORIGIN }),
      });
      const body = (await res.json()) as ErrorBody;
      const code = body.error?.code ?? "none";
      record(
        "VT-26b: consent naming the same origin → past the gate",
        code !== "CALLER_BASE_URL_NOT_CONSENTED",
        `status=${res.status} code=${code} consent=${DECLARED_ORIGIN}`,
      );
    }

    // ── VT-26c: naming a different origin is refused, and says both ────────
    {
      const other = "https://api.moonshot.ai";
      const res = await runAs(delegated, {
        "X-LLM-Base-URL": JSON.stringify({ openai: other }),
      });
      const body = (await res.json()) as ErrorBody;
      const msg = body.error?.message ?? "";
      record(
        "VT-26c: consent naming a DIFFERENT origin → 403 naming both",
        res.status === 403 &&
          body.error?.code === "CALLER_BASE_URL_NOT_CONSENTED" &&
          msg.includes(DECLARED_ORIGIN) &&
          msg.includes(other),
        `status=${res.status} declared=${DECLARED_ORIGIN} consented=${other}`,
      );
    }

    // ── VT-26d: the header contract ────────────────────────────────────────
    {
      const res = await runAs(delegated, { "X-LLM-Base-URL": "not-json" });
      const body = (await res.json()) as ErrorBody;
      const code = body.error?.code ?? "-";
      record(
        "VT-26d: malformed X-LLM-Base-URL → 400 INVALID_LLM_BASE_URL_HEADER",
        res.status === 400 && code === "INVALID_LLM_BASE_URL_HEADER",
        `status=${res.status} code=${code}`,
      );
    }

    // ── VT-26e: the owner with a master credential stays exempt ────────────
    {
      // Same agent, same declared base_url, no consent header — but the
      // dev-token IS a master credential, so this is the same-principal case
      // and must be untouched. This is the control that proves the gate is
      // narrow rather than a blanket refusal.
      const res = await runAs(TOKEN);
      const body = (await res.json()) as ErrorBody;
      const code = body.error?.code ?? "none";
      record(
        "VT-26e: owner + master credential → exempt, no consent header needed",
        code !== "CALLER_BASE_URL_NOT_CONSENTED",
        `status=${res.status} code=${code}`,
      );
    }
  } finally {
    await deleteAgent();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
