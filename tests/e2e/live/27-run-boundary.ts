/**
 * Live assertions for surfaces that are new on the public API and would
 * otherwise only ever be exercised by unit tests: the rate-limit headers on the
 * real push and run routes, the expiry a key can now carry, and the run route's
 * request-body cap.
 *
 * Every request here stops before any model call — the push carries a body
 * that is never extracted (the registry stores it as-is), the run pins a
 * version that does not exist, the oversized run is refused on its declared
 * length — so the phase costs nothing. What it proves is that the limiter sits on the real
 * two-segment routes (where it used to be silently absent: the mount pattern
 * never matched them), that the key endpoint round-trips an expiry, and that a
 * run body over the cap is refused 413 REQUEST_TOO_LARGE by the live server.
 *
 * Each PASS line prints the value it saw, so a green run is a measurement.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFixture, REGISTRY, results, skrun, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "run-boundary-live";
const V1 = "9.27.1";
/** 7 MiB of input: over the run route's body cap, whatever the JSON around it. */
const OVERSIZED_RUN_BYTES = 7 * 1024 * 1024;

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "run-boundary", feature, passed, duration: 0, cost: 0, detail });
}

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

async function buildAndPush(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-27-${AGENT}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${AGENT}
description: Phase 27 live fixture used by tests/e2e/live/27-run-boundary.ts to assert the rate-limit headers on the real push and run routes.
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
  provider: anthropic
  name: claude-sonnet-5-5
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

function rateHeaders(res: Response): string {
  const limit = res.headers.get("x-ratelimit-limit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  return `x-ratelimit-limit=${limit} remaining=${remaining} reset=${reset}`;
}

function hasRateHeaders(res: Response, expectedLimit: string): boolean {
  return (
    res.headers.get("x-ratelimit-limit") === expectedLimit &&
    res.headers.get("x-ratelimit-remaining") !== null &&
    res.headers.get("x-ratelimit-reset") !== null
  );
}

interface KeyBody {
  id?: string;
  key?: string;
  expires_at?: string | null;
  error?: { code?: string; message?: string };
}

export async function run(): Promise<void> {
  await deleteAgent();
  const dir = await buildAndPush();
  try {
    // 1. The push route. These bytes are no bundle, so the handler refuses
    //    them (400 BUNDLE_CORRUPT); what is asserted is the limiter's stamp on
    //    the response, not the handler's verdict.
    const push = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/push?version=9.27.2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("not-a-bundle"),
    });
    record(
      "push route carries the rate-limit headers (10/min)",
      hasRateHeaders(push, "10"),
      `status=${push.status} ${rateHeaders(push)}`,
    );

    // 2. The run route. A version that does not exist is refused by the
    //    handler with a 404 — again after the limiter, and before any model.
    const runRes = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { task: "ping" }, version: "9.99.9" }),
    });
    record(
      "run route carries the rate-limit headers (60/min)",
      hasRateHeaders(runRes, "60"),
      `status=${runRes.status} ${rateHeaders(runRes)}`,
    );

    // 3. A key minted with an explicit expiry returns it — the endpoint accepts
    //    the value and the response projection carries it back.
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const keyRes = await fetch(`${REGISTRY}/api/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "run-boundary-live", expires_at: expiresAt }),
    });
    const key = (await keyRes.json()) as KeyBody;
    const echoed = key.expires_at ?? null;
    const sameInstant =
      echoed !== null && new Date(echoed).getTime() === new Date(expiresAt).getTime();
    record(
      "a key minted with an expiry returns it",
      (keyRes.status === 201 || keyRes.status === 200) && sameInstant,
      `status=${keyRes.status} expires_at=${echoed ?? "null"}${
        key.error?.code ? ` error=${key.error.code}` : ""
      }`,
    );
    if (key.id) {
      await fetch(`${REGISTRY}/api/keys/${key.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
    }

    // 4. The run route's body cap. A 7 MB body — over the cap of about 6.33 MB
    //    that bounds a request's inline files — is refused on its declared
    //    length, before the handler reads it, so before any model.
    const oversized = JSON.stringify({ input: { task: "x".repeat(OVERSIZED_RUN_BYTES) } });
    const tooLarge = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: oversized,
    });
    const refusal = (await tooLarge.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    const refusedCode = refusal.error?.code ?? "none";
    record(
      "a run body over the cap is refused 413 REQUEST_TOO_LARGE",
      tooLarge.status === 413 && refusedCode === "REQUEST_TOO_LARGE",
      `status=${tooLarge.status} code=${refusedCode} sent=${Buffer.byteLength(oversized)} bytes`,
    );
  } finally {
    await deleteAgent();
    rmSync(dir, { recursive: true, force: true });
  }
}
