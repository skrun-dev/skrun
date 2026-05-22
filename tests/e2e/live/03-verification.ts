/**
 * Phase 03 — per-version verification (#83).
 *
 * Default `agent_versions.verified = false` on push, PATCH per-version
 * endpoint flips it, POST /run on an unverified version returns 403
 * AGENT_NOT_VERIFIED, POST /run on a verified version reaches the gate-
 * passed path. Cleans up by revoking the verification at the end so the
 * SQLite registry's persisted state matches the default for the next
 * `pnpm test:e2e:live` run.
 */

import { postRun, REGISTRY, results, TOKEN } from "./_ctx.js";

const NS = "dev";
const AGENT = "pdf-processing";
// The live test catalog is pushed before phase 03 runs; we lookup the latest
// version dynamically rather than hardcoding.
async function getLatestVersion(): Promise<string> {
  const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await res.json()) as { latest_version: string };
  return body.latest_version;
}

async function verifyVersion(version: string, verified: boolean): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified }),
  });
}

export async function run(): Promise<void> {
  const version = await getLatestVersion();

  // Reset to a known state — the SQLite registry persists across runs.
  await verifyVersion(version, false);

  console.log("Testing verification (default latest_version_verified=false)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "verification",
      feature: "Default latest_version_verified=false",
      passed: body.latest_version_verified === false,
      duration: 0,
      cost: 0,
      detail: `latest_version_verified=${body.latest_version_verified}`,
    });
  }

  console.log("Testing verification (POST /run on unverified → 403 AGENT_NOT_VERIFIED)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { task: "summarize" } }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    const passed = res.status === 403 && body.error?.code === "AGENT_NOT_VERIFIED";
    results.push({
      agent: "verification",
      feature: "Unverified → 403 AGENT_NOT_VERIFIED",
      passed,
      duration: 0,
      cost: 0,
      detail: `status=${res.status} code=${body.error?.code ?? ""} version=${version}`,
    });
  }

  console.log("Testing verification (PATCH .../versions/:v/verify → true)...");
  {
    const res = await verifyVersion(version, true);
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "verification",
      feature: "PATCH /versions/:v/verify → true",
      passed: body.verified === true && body.version === version,
      duration: 0,
      cost: 0,
      detail: `verified=${body.verified} version=${body.version}`,
    });
  }

  console.log("Testing verification (verified version reaches gate-passed path)...");
  {
    // After verify, POST /run no longer returns 403 — exercises the runtime
    // gate flip. We use postRun which does the JSON LLM call; here we only
    // assert it doesn't return 403 AGENT_NOT_VERIFIED. Downstream LLM errors
    // are tolerated (this phase is the gate test, not the full run).
    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { task: "summarize" } }),
    });
    // Drain body so the response is consumed (avoids unhandled-rejection warnings).
    let body: { error?: { code?: string } } = {};
    try {
      body = (await res.json()) as { error?: { code?: string } };
    } catch {
      // SSE / non-JSON response — fine, the assertion only cares about status.
    }
    const passed = res.status !== 403 || body.error?.code !== "AGENT_NOT_VERIFIED";
    results.push({
      agent: "verification",
      feature: "Verified → past 403 gate",
      passed,
      duration: 0,
      cost: 0,
      detail: `status=${res.status} code=${body.error?.code ?? ""}`,
    });
    void postRun;
  }

  // State cleanup: revert to the pristine default so the next run starts at
  // verified=false (SQLite persists across `pnpm test:e2e:live` runs).
  await verifyVersion(version, false);
}
