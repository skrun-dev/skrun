/**
 * E2E: Per-version verification — the runtime gate on POST /run, the
 * per-version PATCH endpoint, the latest_version_verified computed field,
 * and the pinned-caller protection that per-version trust enables.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEV_TOKEN,
  devAuth,
  pushAgent,
  runAgent,
  createTestApp as setup,
  verifyVersion,
} from "./setup.js";

describe("E2E: Per-version verification", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await pushAgent(ctx.app, { name: "test-agent" });
  });

  // ── Default + happy path ───────────────────────────────────────────────

  it("new agent has latest_version_verified=false by default", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent", { headers: devAuth });
    const body = await res.json();
    expect(body.latest_version_verified).toBe(false);
  });

  it("PATCH .../versions/:v/verify sets verified=true on that version", async () => {
    const res = await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.version).toBe("1.0.0");
  });

  it("PATCH .../versions/:v/verify can revoke (set false)", async () => {
    await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    const res = await verifyVersion(ctx.app, { version: "1.0.0", verified: false });
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("latest_version_verified flips to true after verify", async () => {
    await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    const res = await ctx.app.request("/api/agents/dev/test-agent", { headers: devAuth });
    const body = await res.json();
    expect(body.latest_version_verified).toBe(true);
  });

  // ── Error paths ────────────────────────────────────────────────────────

  it("PATCH .../versions/:v/verify returns 404 for non-existent agent", async () => {
    const res = await verifyVersion(ctx.app, { name: "nonexistent", version: "1.0.0" });
    expect(res.status).toBe(404);
  });

  it("PATCH .../versions/:v/verify returns 404 for non-existent version", async () => {
    const res = await verifyVersion(ctx.app, { version: "9.9.9" });
    expect(res.status).toBe(404);
  });

  it("PATCH .../versions/:v/verify returns 401 without auth", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(401);
  });

  // ── Runtime gate (POST /run early 403) ─────────────────────────────────

  it("POST /run on unverified version returns 403 AGENT_NOT_VERIFIED", async () => {
    const res = await runAgent(ctx.app, {
      name: "test-agent",
      input: { text: "hello" },
      token: DEV_TOKEN,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("AGENT_NOT_VERIFIED");
    expect(body.error.message).toContain("1.0.0");
  });

  it("POST /run on verified version passes the gate (downstream behaviour normal)", async () => {
    await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    const res = await runAgent(ctx.app, {
      name: "test-agent",
      input: { text: "hello" },
      token: DEV_TOKEN,
    });
    // Past the gate — downstream may fail at bundle extraction (fake bundle
    // in test fixture), but the response must NOT be 403.
    expect(res.status).not.toBe(403);
  });

  // ── Per-version isolation: pinned callers protected when newer pushes land ─

  it("BR-2: push of newer version does NOT touch verified state of prior versions", async () => {
    // Push v1.0.0 (already pushed in beforeEach), verify it
    await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    // Push v2.0.0
    await pushAgent(ctx.app, { name: "test-agent", version: "2.0.0" });

    const res = await ctx.app.request("/api/agents/dev/test-agent/versions", {
      headers: devAuth,
    });
    const body = await res.json();
    const v1 = body.versions.find((v: { version: string }) => v.version === "1.0.0");
    const v2 = body.versions.find((v: { version: string }) => v.version === "2.0.0");
    expect(v1?.verified).toBe(true); // pinned-caller protection
    expect(v2?.verified).toBe(false); // new version starts unverified
  });

  it("BR-6: POST /run without pin resolves to latest, which is the new unverified version", async () => {
    // v1.0.0 verified, v2.0.0 pushed (unverified)
    await verifyVersion(ctx.app, { version: "1.0.0", verified: true });
    await pushAgent(ctx.app, { name: "test-agent", version: "2.0.0" });

    // No version pin → resolves to latest = v2.0.0 → 403
    const res = await runAgent(ctx.app, {
      name: "test-agent",
      input: { text: "hello" },
      token: DEV_TOKEN,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("AGENT_NOT_VERIFIED");
    expect(body.error.message).toContain("2.0.0");
  });

  // ── Edge cases (Phase 8.14) ────────────────────────────────────────────

  it("EC-1: 404 (agent missing) pre-empts 403 (unverified)", async () => {
    const res = await runAgent(ctx.app, {
      name: "ghost",
      input: {},
      token: DEV_TOKEN,
    });
    // Agent lookup happens before the verified check; missing agent is 404
    // before we ever evaluate the unverified-version branch.
    expect(res.status).toBe(404);
  });

  it("EC-3: concurrent verify is idempotent (last write wins, no race-induced 5xx)", async () => {
    // Fire two parallel verify calls and assert both 200 + final state.
    const [a, b] = await Promise.all([
      verifyVersion(ctx.app, { version: "1.0.0", verified: true }),
      verifyVersion(ctx.app, { version: "1.0.0", verified: true }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const res = await ctx.app.request("/api/agents/dev/test-agent/versions", {
      headers: devAuth,
    });
    const body = await res.json();
    expect(body.versions[0].verified).toBe(true);
  });

  it("Legacy PATCH .../verify is gone (returns 404)", async () => {
    // Phase 7.7 cleanup removed the legacy endpoint. Any consumer still
    // hitting it gets a clean 404 — no silent flag-flip on a column that
    // no longer exists.
    const res = await ctx.app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(404);
  });
});
