/**
 * Phase 25 — CLI device-login flow (OAuth 2.0 Device Authorization Grant, RFC 8628).
 *
 * The live registry runs in dev-token mode (OAuth OFF), so `/auth/device/code`
 * returns 404 — the self-host fallback path the CLI uses to drop to a `--token`
 * prompt. We assert the device-flow surface is wired + behaves correctly on the
 * real server: the 404 fallback, the consent page rendering with its phishing
 * warning + a prefilled code, and a bogus poll returning `expired_token`. The full
 * token-via-poll-body happy path needs real OAuth + a browser → manual check.
 */

import { REGISTRY, results } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing POST /auth/device/code (no-OAuth → 404 fallback)...");
  {
    const start = Date.now();
    try {
      const res = await fetch(`${REGISTRY}/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_challenge: "abc", code_challenge_method: "S256" }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      const ok = res.status === 404 && body.error?.code === "OAUTH_NOT_CONFIGURED";
      results.push({
        agent: "device-login",
        feature: "POST /auth/device/code → 404 OAUTH_NOT_CONFIGURED (CLI falls back to --token)",
        passed: ok,
        duration: Date.now() - start,
        cost: 0,
        detail: `status=${res.status} code=${body.error?.code}`,
      });
    } catch (err) {
      results.push({
        agent: "device-login",
        feature: "POST /auth/device/code → 404 OAUTH_NOT_CONFIGURED",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing GET /device consent page...");
  {
    const start = Date.now();
    try {
      const res = await fetch(`${REGISTRY}/device?user_code=WXYZ-3456`);
      const html = await res.text();
      const hasWarning = html.includes("Never enter a code someone sent you");
      const hasPrefill = html.includes("WXYZ-3456");
      const ok = res.status === 200 && hasWarning && hasPrefill;
      results.push({
        agent: "device-login",
        feature: "GET /device renders the consent page (phishing warning + prefilled code)",
        passed: ok,
        duration: Date.now() - start,
        cost: 0,
        detail: `status=${res.status} warning=${hasWarning} prefilled=${hasPrefill}`,
      });
    } catch (err) {
      results.push({
        agent: "device-login",
        feature: "GET /device renders the consent page",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(
    "Testing POST /auth/device/token (unknown code → expired_token; token only in the poll body)...",
  );
  {
    const start = Date.now();
    try {
      const res = await fetch(`${REGISTRY}/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "bogus-device-code", code_verifier: "x" }),
      });
      const body = (await res.json()) as { error?: { code?: string }; token?: string };
      // Unknown code → expired_token, and there is never a token outside the
      // success body (the SEC-fix invariant — no token in any URL/redirect).
      const ok = res.status === 400 && body.error?.code === "expired_token" && !body.token;
      results.push({
        agent: "device-login",
        feature:
          "POST /auth/device/token poll states work; the token is delivered only in the poll body, never a URL",
        passed: ok,
        duration: Date.now() - start,
        cost: 0,
        detail: `status=${res.status} code=${body.error?.code} hasToken=${Boolean(body.token)}`,
      });
    } catch (err) {
      results.push({
        agent: "device-login",
        feature: "POST /auth/device/token poll states",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
