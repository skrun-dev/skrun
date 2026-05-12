/**
 * Phase 02 — caller-provided LLM keys.
 *
 * Verifies the `X-LLM-API-Key` header path: valid key → run completes;
 * invalid key → no fallback to operator key (status: failed); malformed
 * header → 400 INVALID_LLM_KEY_HEADER.
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing caller-provided keys (valid key)...");
  {
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) {
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "X-LLM-API-Key": JSON.stringify({ google: googleKey }),
        },
        body: JSON.stringify({ input: { code: "const x = 1;" } }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      results.push({
        agent: "caller-keys",
        feature: "Valid caller key → completed",
        passed: body.status === "completed",
        duration: (body.duration_ms as number) ?? 0,
        cost: ((body.cost as Record<string, number>)?.estimated as number) ?? 0,
        detail: `status=${body.status}`,
      });
    }
  }

  console.log("Testing caller-provided keys (invalid key → no fallback)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "fake-invalid-key" }),
      },
      body: JSON.stringify({ input: { code: "const x = 1;" } }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "caller-keys",
      feature: "Invalid caller key → failed (no fallback)",
      passed: body.status === "failed",
      duration: (body.duration_ms as number) ?? 0,
      cost: 0,
      detail: `status=${body.status}`,
    });
  }

  console.log("Testing caller-provided keys (malformed header → 400)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": "not-json",
      },
      body: JSON.stringify({ input: { code: "x" } }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as Record<string, string> | undefined;
    results.push({
      agent: "caller-keys",
      feature: "Malformed header → 400",
      passed: res.status === 400 && err?.code === "INVALID_LLM_KEY_HEADER",
      duration: 0,
      cost: 0,
      detail: `status=${res.status}, code=${err?.code}`,
    });
  }
}
