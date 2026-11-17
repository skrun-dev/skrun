import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import type { VerificationPolicy } from "../services/verification-policy.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  agentYamlOfSize,
  minimalAgentYaml,
  validBundle,
  validBundleOfSize,
} from "./agent-bundle.shared.js";

// Capture logger.info calls so we can assert the structured-log shape emitted
// by the per-version verify route (AC-9). vi.mock is hoisted to the top of
// the file; vi.hoisted lets the spy be declared in lock-step so it's defined
// when the mock factory runs. We replace only `createLogger`; the rest of
// @skrun-dev/runtime is left intact.
const { logInfoSpy, logWarnSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logWarnSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return {
    ...actual,
    createLogger: () => ({
      info: logInfoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      level: "info",
      child: () => ({ info: logInfoSpy, warn: logWarnSpy }),
    }),
  };
});

describe("Registry Routes", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
    logInfoSpy.mockClear();
  });

  const authHeader = { Authorization: "Bearer dev-token" };
  let bundle: Buffer;
  beforeAll(async () => {
    bundle = await validBundle("test-agent");
  });

  async function pushAgent(ns = "dev", name = "test-agent", version = "1.0.0") {
    return app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
  }

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("POST /push succeeds with auth", async () => {
    const res = await pushAgent();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-agent");
    expect(body.namespace).toBe("dev");
    expect(body.latest_version).toBe("1.0.0");
  });

  it("POST /push returns 401 without auth", async () => {
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      body: bundle,
    });
    expect(res.status).toBe(401);
  });

  // The version names the bundle's object key: a path, a NUL or a keyword in
  // it is refused before anything is stored — no agent, no object.
  it.each([
    ["a path out of the namespace", "..%2F..%2Fvictim%2Fagent%2F1.0.0"],
    ["a NUL character", "1.0.0%00"],
    ["a keyword", "latest"],
    ["two numbers", "1.0"],
  ])("POST /push refuses a version with %s: 400 INVALID_VERSION_FORMAT, nothing stored", async (_label, version) => {
    const res = await pushAgent("dev", "test-agent", version);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_VERSION_FORMAT",
        message:
          'version must be strict semver (e.g. "1.0.0"): three whole numbers separated by dots. Nothing was stored.',
      },
    });
    expect(await db.getAgent("dev", "test-agent")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
    expect(await storage.list("victim/")).toEqual([]);
  });

  it("POST /push without a version is still 400 MISSING_VERSION", async () => {
    const res = await app.request("/api/agents/dev/test-agent/push", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MISSING_VERSION");
  });

  it("VT-12: GET /pull returns 500 BUNDLE_INTEGRITY_FAILED on a tampered bundle", async () => {
    // SEC-020 universal verification: the download endpoint shares pull() with
    // the run path, so a tampered storage object is refused at GET /pull too.
    await pushAgent("dev", "tamper-dl", "1.0.0");
    await storage.put("dev/tamper-dl/1.0.0.agent", Buffer.from("evil-payload"));
    const res = await app.request("/api/agents/dev/tamper-dl/pull", { headers: authHeader });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe("BUNDLE_INTEGRITY_FAILED");
  });

  it("POST /push returns 403 for wrong namespace", async () => {
    const res = await app.request("/api/agents/other/agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    expect(res.status).toBe(403);
  });

  it("POST /push returns 409 for duplicate version", async () => {
    await pushAgent();
    const res = await pushAgent();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_EXISTS");
  });

  it("POST /push returns 400 without version param", async () => {
    const res = await app.request("/api/agents/dev/agent/push", {
      method: "POST",
      headers: authHeader,
      body: bundle,
    });
    expect(res.status).toBe(400);
  });

  it("GET /pull returns the pushed bundle", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/pull", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bundle);
    expect(res.headers.get("X-Agent-Version")).toBe("1.0.0");
  });

  it("GET /pull/:version returns specific version", async () => {
    await pushAgent("dev", "agent", "1.0.0");
    const v2 = await validBundle("agent-v2");
    await app.request("/api/agents/dev/agent/push?version=2.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: v2,
    });

    const res = await app.request("/api/agents/dev/agent/pull/1.0.0", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bundle);
  });

  it("GET /pull returns 401 without auth", async () => {
    const res = await app.request("/api/agents/dev/agent/pull");
    expect(res.status).toBe(401);
  });

  it("GET /pull returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/dev/nonexistent/pull", {
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });

  it("GET /agents lists agents (auth required, dev-token admin sees all)", async () => {
    await pushAgent("dev", "a", "1.0.0");
    await pushAgent("dev", "b", "1.0.0");

    const res = await app.request("/api/agents", { headers: authHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  // ── #80 multi-tenant filter on GET /agents ───────────────────────────

  // VT-8 (#80): anonymous → 401 (auth-required gate)
  it("VT-8 (#80): GET /agents returns 401 without Authorization header", async () => {
    const res = await app.request("/api/agents");
    expect(res.status).toBe(401);
  });

  // VT-4 + VT-5 (#80): cross-tenant isolation — each non-admin OAuth user
  // sees only their own agents. Two API-key users prove the filter
  // narrows correctly across owners.
  it("VT-4 + VT-5 (#80): GET /agents — non-admin users see only own agents (cross-tenant isolated)", async () => {
    // Seed user A + 2 agents
    const userA = await db.createUser({ github_id: "gh-A", username: "user-a" });
    const a = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: a.keyHash,
      key_prefix: a.keyPrefix,
      name: "key-a",
    });
    await app.request("/api/agents/user-a/agent-1/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });
    await app.request("/api/agents/user-a/agent-2/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // Seed user B + 1 agent
    const userB = await db.createUser({ github_id: "gh-B", username: "user-b" });
    const b = generateApiKey();
    await db.createApiKey({
      user_id: userB.id,
      key_hash: b.keyHash,
      key_prefix: b.keyPrefix,
      name: "key-b",
    });
    await app.request("/api/agents/user-b/agent-x/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // VT-4: User A sees only their 2 agents
    const resA = await app.request("/api/agents", {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { agents: { namespace: string }[]; total: number };
    expect(bodyA.agents).toHaveLength(2);
    expect(bodyA.total).toBe(2);
    expect(bodyA.agents.every((ag) => ag.namespace === "user-a")).toBe(true);

    // VT-5: User B sees only their 1 agent (NOT A's)
    const resB = await app.request("/api/agents", {
      headers: { Authorization: `Bearer ${b.key}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as { agents: { namespace: string }[]; total: number };
    expect(bodyB.agents).toHaveLength(1);
    expect(bodyB.total).toBe(1);
    expect(bodyB.agents[0].namespace).toBe("user-b");
  });

  // VT-6 (#80): dev-token mode → role='admin' → instance-wide visibility.
  // Combined with VT-7 (any-mode admin sees all) since the underlying code
  // path is the same — `user.role === 'admin'` triggers the bypass
  // regardless of which auth chain set the role.
  it("VT-6 + VT-7 (#80): GET /agents with admin token returns all agents across namespaces", async () => {
    // Seed an agent under a different namespace (api-key user)
    const owner = await db.createUser({ github_id: "gh-owner", username: "owner-x" });
    const k = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "owner-key",
    });
    await app.request("/api/agents/owner-x/their-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });
    // Plus a dev/ agent
    await pushAgent("dev", "my-agent", "1.0.0");

    // dev-token call → role='admin' → sees BOTH namespaces
    const res = await app.request("/api/agents", { headers: authHeader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { namespace: string }[]; total: number };
    expect(body.agents).toHaveLength(2);
    expect(body.total).toBe(2);
    const namespaces = body.agents.map((a) => a.namespace).sort();
    expect(namespaces).toEqual(["dev", "owner-x"]);
  });

  // VT-9 (#80): pagination total reflects the FILTERED count when userId is
  // applied — not the global count. Without this, the dashboard would show
  // "1 of 10 pages" with only 5 visible rows.
  it("VT-9 (#80): pagination total reflects filtered count when userId narrows", async () => {
    // 5 agents owned by A
    const userA = await db.createUser({ github_id: "gh-pag-A", username: "pag-a" });
    const a = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: a.keyHash,
      key_prefix: a.keyPrefix,
      name: "key-pag-a",
    });
    for (let i = 0; i < 5; i++) {
      await app.request(`/api/agents/pag-a/agent-${i}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${a.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundle,
      });
    }
    // 5 agents owned by B (must NOT count toward A's total)
    const userB = await db.createUser({ github_id: "gh-pag-B", username: "pag-b" });
    const b = generateApiKey();
    await db.createApiKey({
      user_id: userB.id,
      key_hash: b.keyHash,
      key_prefix: b.keyPrefix,
      name: "key-pag-b",
    });
    for (let i = 0; i < 5; i++) {
      await app.request(`/api/agents/pag-b/agent-${i}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${b.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundle,
      });
    }

    // A queries with limit 20 → sees 5 + total 5 (filtered, NOT 10)
    const res = await app.request("/api/agents?page=1&limit=20", {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[]; total: number };
    expect(body.agents).toHaveLength(5);
    expect(body.total).toBe(5); // NOT 10
  });

  it("GET /agents/:ns/:name returns metadata (public)", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent", { headers: authHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-agent");
    expect(body.versions).toEqual(["1.0.0"]);
  });

  it("GET /agents/:ns/:name metadata includes latest_version_verified=false by default", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent", { headers: authHeader });
    const body = await res.json();
    expect(body.latest_version_verified).toBe(false);
  });

  // ── #80 multi-tenant filter on GET /agents/:ns/:name + /versions ─────

  // VT-10 + VT-10b (#80): metadata GET — non-owner non-admin gets 404 opaque,
  // response body byte-identical to a genuine 404 (no client-side discriminator).
  it("VT-10 + VT-10b (#80): metadata GET — non-owner gets 404 with byte-identical body to genuine 404", async () => {
    // Seed user B + their agent
    const userB = await db.createUser({ github_id: "gh-B-meta", username: "user-b" });
    const b = generateApiKey();
    await db.createApiKey({
      user_id: userB.id,
      key_hash: b.keyHash,
      key_prefix: b.keyPrefix,
      name: "key-b-meta",
    });
    await app.request("/api/agents/user-b/private-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // Seed user A (no agents owned)
    const userA = await db.createUser({ github_id: "gh-A-meta", username: "user-a" });
    const a = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: a.keyHash,
      key_prefix: a.keyPrefix,
      name: "key-a-meta",
    });

    // VT-10: user A queries B's agent → 404 NOT_FOUND
    const ownershipRes = await app.request("/api/agents/user-b/private-agent", {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(ownershipRes.status).toBe(404);
    const ownershipBody = await ownershipRes.json();
    expect(ownershipBody.error.code).toBe("NOT_FOUND");
    expect(ownershipBody.error.message).toBe("Agent user-b/private-agent not found");

    // VT-10b: byte-identical body to a genuine-404 (user A queries a name that
    // does not exist anywhere). The two response shapes MUST be indistinguishable.
    const genuineRes = await app.request("/api/agents/user-b/ghost-agent", {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(genuineRes.status).toBe(404);
    const genuineBody = await genuineRes.json();
    // Same code, same message shape — no `forbidden` flag, no `code: "FORBIDDEN"`,
    // no differential payload. The opacity invariant.
    expect(genuineBody.error.code).toBe(ownershipBody.error.code);
    expect(JSON.stringify(genuineBody)).toBe(
      JSON.stringify({
        error: { code: "NOT_FOUND", message: "Agent user-b/ghost-agent not found" },
      }),
    );
    // And the ownership-404 body has the EXACT same JSON shape (different name
    // segment only). No extra fields, no role hint, no permission hint.
    expect(JSON.stringify(ownershipBody)).toBe(
      JSON.stringify({
        error: { code: "NOT_FOUND", message: "Agent user-b/private-agent not found" },
      }),
    );
  });

  // VT-11 + VT-12 (#80): metadata GET — owner sees own (200), admin sees any (200).
  it("VT-11 + VT-12 (#80): metadata GET — owner reads own + admin reads cross-namespace", async () => {
    const owner = await db.createUser({ github_id: "gh-owner-meta", username: "owner-y" });
    const k = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "owner-key-meta",
    });
    await app.request("/api/agents/owner-y/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // VT-11: owner reads own → 200 with metadata
    const ownerRes = await app.request("/api/agents/owner-y/my-agent", {
      headers: { Authorization: `Bearer ${k.key}` },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = await ownerRes.json();
    expect(ownerBody.name).toBe("my-agent");
    expect(ownerBody.namespace).toBe("owner-y");

    // VT-12: admin (dev-token) reads cross-namespace → 200
    const adminRes = await app.request("/api/agents/owner-y/my-agent", { headers: authHeader });
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.name).toBe("my-agent");
  });

  // VT-13 (#80): versions GET — non-owner non-admin → 404 opaque.
  it("VT-13 (#80): versions GET — non-owner gets 404 NOT_FOUND (opaque)", async () => {
    const userB = await db.createUser({ github_id: "gh-B-vers", username: "user-b" });
    const b = generateApiKey();
    await db.createApiKey({
      user_id: userB.id,
      key_hash: b.keyHash,
      key_prefix: b.keyPrefix,
      name: "key-b-vers",
    });
    await app.request("/api/agents/user-b/agent-with-versions/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });
    await app.request("/api/agents/user-b/agent-with-versions/push?version=2.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    const userA = await db.createUser({ github_id: "gh-A-vers", username: "user-a" });
    const a = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: a.keyHash,
      key_prefix: a.keyPrefix,
      name: "key-a-vers",
    });

    const res = await app.request("/api/agents/user-b/agent-with-versions/versions", {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Agent user-b/agent-with-versions not found");
    // No `versions` array leaked
    expect(body.versions).toBeUndefined();
  });

  // VT-15 + VT-15b (#80): pull cross-tenant → 404 opaque + zero storage reads.
  // The ordering constraint (SC-8b) is the critical part — `storage.get` MUST
  // not be called when the ownership check throws. Otherwise a timing oracle
  // would let attackers distinguish "agent exists (storage hit)" from "agent
  // doesn't exist (no storage hit)" via latency.
  it("VT-15 + VT-15b (#80): pull non-owner → 404 + no octet-stream headers + storage.get not called", async () => {
    // Seed user B + agent
    const userB = await db.createUser({ github_id: "gh-B-pull", username: "user-b" });
    const b = generateApiKey();
    await db.createApiKey({
      user_id: userB.id,
      key_hash: b.keyHash,
      key_prefix: b.keyPrefix,
      name: "key-b-pull",
    });
    await app.request("/api/agents/user-b/protected-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // Seed user A (no agents)
    const userA = await db.createUser({ github_id: "gh-A-pull", username: "user-a" });
    const a = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: a.keyHash,
      key_prefix: a.keyPrefix,
      name: "key-a-pull",
    });

    // VT-15b: spy on MemoryStorage.get BEFORE the request so we can count
    // calls. The route's ownership check fires before service.pull, which
    // is the only caller of storage.get for the pull path. Zero calls
    // means the bundle bytes never reached the route handler.
    const storageGetSpy = vi.spyOn(MemoryStorage.prototype, "get");
    storageGetSpy.mockClear();

    try {
      // VT-15: pull as user A → 404
      const res = await app.request("/api/agents/user-b/protected-agent/pull", {
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(404);

      // VT-15: response is JSON error, NOT octet-stream
      expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
      // VT-15: no bundle download headers
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(res.headers.get("X-Agent-Version")).toBeNull();

      // VT-15: body is identical to genuine NOT_FOUND shape
      const body = await res.json();
      expect(body).toEqual({
        error: { code: "NOT_FOUND", message: "Agent user-b/protected-agent not found" },
      });

      // VT-15b: storage.get was NEVER called — ownership check short-
      // circuited before any storage read. This is the constant-time
      // ordering invariant from SC-8b.
      expect(storageGetSpy).not.toHaveBeenCalled();
    } finally {
      storageGetSpy.mockRestore();
    }
  });

  // VT-16 + VT-17 (#80): pull as owner returns full bundle bytes; admin
  // (dev-token) can pull cross-namespace.
  it("VT-16 + VT-17 (#80): pull — owner reads own bundle + admin reads cross-namespace", async () => {
    const owner = await db.createUser({ github_id: "gh-owner-pull", username: "owner-z" });
    const k = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "owner-key-pull",
    });
    await app.request("/api/agents/owner-z/their-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k.key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    // VT-16: owner pulls own bundle → 200 with bytes + headers
    const ownerRes = await app.request("/api/agents/owner-z/their-agent/pull", {
      headers: { Authorization: `Bearer ${k.key}` },
    });
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get("X-Agent-Version")).toBe("1.0.0");
    expect(ownerRes.headers.get("Content-Disposition")).toContain("their-agent-1.0.0.agent");
    const ownerBytes = Buffer.from(await ownerRes.arrayBuffer());
    expect(ownerBytes).toEqual(bundle);

    // VT-17: admin (dev-token) pulls cross-namespace → 200 with bytes
    const adminRes = await app.request("/api/agents/owner-z/their-agent/pull", {
      headers: authHeader,
    });
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("X-Agent-Version")).toBe("1.0.0");
    const adminBytes = Buffer.from(await adminRes.arrayBuffer());
    expect(adminBytes).toEqual(bundle);
  });

  it("PATCH /versions/:v/verify sets verified=true on that version", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.version).toBe("1.0.0");
  });

  it("PATCH /versions/:v/verify sets verified=false (revoke)", async () => {
    await pushAgent();
    await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    const res = await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("PATCH /versions/:v/verify returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/dev/nonexistent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /versions/:v/verify returns 404 for non-existent version", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/versions/9.9.9/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /versions/:v/verify returns 401 without auth", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(401);
  });

  // VT-6: non-admin caller is refused even when calling on their own
  // namespace. The audit's headline finding — pre-fix, any namespace owner
  // could mint verified=true on their own agent. Per-version endpoint
  // preserves the admin gate.
  it("VT-6: PATCH /versions/:v/verify returns 403 for non-admin caller (api-key role='user')", async () => {
    const user = await db.createUser({ github_id: "gh-vt6", username: "regular" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "vt6-key",
    });
    await app.request("/api/agents/regular/owned-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    const res = await app.request("/api/agents/regular/owned-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(/admin/i);
  });

  // VT-7: admin caller can verify any agent's version, including across
  // namespaces. dev-token grants admin per Q-11; this test exercises the
  // cross-namespace flow on the per-version endpoint.
  it("VT-7: PATCH /versions/:v/verify succeeds for admin caller across namespaces", async () => {
    const owner = await db.createUser({ github_id: "gh-other", username: "owner-x" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "owner-key",
    });
    await app.request("/api/agents/owner-x/their-agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    const res = await app.request("/api/agents/owner-x/their-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  // ── Structured log emission on verify/unverify (AC-9) ────────────────
  // The deferred audit-log UI on agent-detail will surface these events; until
  // then, operators grep pino logs for `event:agent_version_verify`. These
  // tests pin the shape so two devs can't independently produce slightly
  // different field names (actor.userId vs actor.user_id, etc.) per
  // peer-review #9.

  it("emits structured log on successful verify with the expected shape", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(200);

    const verifyCall = logInfoSpy.mock.calls.find(
      ([obj]) => (obj as { event?: string })?.event === "agent_version_verify",
    );
    expect(verifyCall).toBeDefined();
    const [logObj] = verifyCall as [Record<string, unknown>, string];
    expect(logObj.event).toBe("agent_version_verify");
    expect(logObj.action).toBe("verify");
    expect(logObj.target).toEqual({ namespace: "dev", name: "test-agent", version: "1.0.0" });
    expect(logObj.actor).toMatchObject({
      role: "admin",
      namespace: "dev",
    });
    expect(typeof logObj.timestamp).toBe("string");
    // ISO-8601 sanity check
    expect(new Date(logObj.timestamp as string).toString()).not.toBe("Invalid Date");
  });

  it("emits structured log with action:'unverify' on revoke", async () => {
    await pushAgent();
    // Verify first
    await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    logInfoSpy.mockClear();
    // Then revoke
    await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: false }),
    });
    const unverifyCall = logInfoSpy.mock.calls.find(
      ([obj]) => (obj as { event?: string })?.event === "agent_version_verify",
    );
    expect(unverifyCall).toBeDefined();
    const [logObj] = unverifyCall as [Record<string, unknown>, string];
    expect(logObj.action).toBe("unverify");
  });

  it("does NOT emit the structured log on 403 (non-admin)", async () => {
    const user = await db.createUser({ github_id: "gh-nolog", username: "regular" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "nolog-key",
    });
    await app.request("/api/agents/regular/x/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    logInfoSpy.mockClear();
    const res = await app.request("/api/agents/regular/x/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(403);
    const verifyCall = logInfoSpy.mock.calls.find(
      ([obj]) => (obj as { event?: string })?.event === "agent_version_verify",
    );
    expect(verifyCall).toBeUndefined();
  });

  // ── DELETE admin override (Phase 8.5) ────────────────────────────────

  it("DELETE /agents/:ns/:name allows admin across namespaces", async () => {
    // Push agent in "other" namespace using an api-key user, then admin
    // (dev-token) deletes it from a foreign namespace.
    const owner = await db.createUser({ github_id: "gh-del", username: "other" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "owner-del-key",
    });
    await app.request("/api/agents/other/squatter/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    const res = await app.request("/api/agents/other/squatter", {
      method: "DELETE",
      headers: authHeader,
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /agents/:ns/:name 403s non-admin from foreign namespace", async () => {
    // Push as dev (auto-admin), but attempt the delete as a regular user from
    // a different namespace.
    await pushAgent("dev", "owned", "1.0.0");
    const user = await db.createUser({ github_id: "gh-foreign", username: "regular" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "foreign-key",
    });

    const res = await app.request("/api/agents/dev/owned", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("DELETE /agents/:ns/:name/versions/:v allows admin across namespaces", async () => {
    const owner = await db.createUser({ github_id: "gh-del-v", username: "other" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: owner.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "owner-del-v-key",
    });
    await app.request("/api/agents/other/multi/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    await app.request("/api/agents/other/multi/push?version=2.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    // Admin deletes the older version across namespaces
    const res = await app.request("/api/agents/other/multi/versions/1.0.0", {
      method: "DELETE",
      headers: authHeader,
    });
    expect(res.status).toBe(204);
  });

  it("Push of new version preserves verified flag on prior versions", async () => {
    // Push v1.0.0 and verify it
    await pushAgent();
    await app.request("/api/agents/dev/test-agent/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    // Push a newer version
    await pushAgent("dev", "test-agent", "2.0.0");
    // v1.0.0's verified flag must remain true (pinned callers are protected)
    const versionsRes = await app.request("/api/agents/dev/test-agent/versions", {
      headers: authHeader,
    });
    const versions = (await versionsRes.json()).versions as Array<{
      version: string;
      verified: boolean;
    }>;
    const v1 = versions.find((v) => v.version === "1.0.0");
    const v2 = versions.find((v) => v.version === "2.0.0");
    expect(v1?.verified).toBe(true);
    expect(v2?.verified).toBe(false);
  });

  it("GET /agents/:ns/:name/versions returns versions (public)", async () => {
    await pushAgent("dev", "agent", "1.0.0");
    await app.request("/api/agents/dev/agent/push?version=2.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("agent-v2")),
    });

    const res = await app.request("/api/agents/dev/agent/versions", { headers: authHeader });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(2);
  });

  // ── Version notes (#14c) ─────────────────────────────────────────

  it("POST /push accepts X-Skrun-Version-Notes header", async () => {
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": encodeURIComponent("Initial release"),
      },
      body: bundle,
    });
    expect(res.status).toBe(200);

    const versionsRes = await app.request("/api/agents/dev/agent/versions", {
      headers: authHeader,
    });
    const { versions } = await versionsRes.json();
    expect(versions[0].notes).toBe("Initial release");
  });

  it("POST /push without notes header stores null", async () => {
    await pushAgent();
    const versionsRes = await app.request("/api/agents/dev/test-agent/versions", {
      headers: authHeader,
    });
    const { versions } = await versionsRes.json();
    expect(versions[0].notes).toBeNull();
  });

  it("POST /push accepts notes containing emoji and non-ASCII (UTF-8 via percent-encoding)", async () => {
    const note = "🚀 Amélioration 日本語";
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": encodeURIComponent(note),
      },
      body: bundle,
    });
    expect(res.status).toBe(200);
    const versionsRes = await app.request("/api/agents/dev/agent/versions", {
      headers: authHeader,
    });
    const { versions } = await versionsRes.json();
    expect(versions[0].notes).toBe(note);
  });

  it("POST /push rejects notes longer than 500 chars with 400 INVALID_NOTES", async () => {
    const tooLong = "a".repeat(501);
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": encodeURIComponent(tooLong),
      },
      body: bundle,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_NOTES");
  });

  it("POST /push rejects notes containing null bytes with 400 INVALID_NOTES", async () => {
    const withNull = "hello\x00world";
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": encodeURIComponent(withNull),
      },
      body: bundle,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_NOTES");
  });

  it("POST /push with malformed percent-encoded notes returns 400 INVALID_NOTES", async () => {
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": "%GG",
      },
      body: bundle,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_NOTES");
  });

  it("POST /push with empty notes header treats as null", async () => {
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": "",
      },
      body: bundle,
    });
    expect(res.status).toBe(200);
    const versionsRes = await app.request("/api/agents/dev/agent/versions", {
      headers: authHeader,
    });
    const { versions } = await versionsRes.json();
    expect(versions[0].notes).toBeNull();
  });

  it("GET /versions returns notes field on every version", async () => {
    await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/octet-stream",
        "X-Skrun-Version-Notes": encodeURIComponent("v1 note"),
      },
      body: bundle,
    });
    await app.request("/api/agents/dev/agent/push?version=2.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    const res = await app.request("/api/agents/dev/agent/versions", { headers: authHeader });
    const { versions } = await res.json();
    expect(versions).toHaveLength(2);
    // Versions sorted by pushed_at ascending
    expect(versions[0].notes).toBe("v1 note");
    expect(versions[1].notes).toBeNull();
  });

  // ── DELETE /api/agents/:ns/:name/versions/:version (#77) ───────────────

  describe("DELETE /versions/:version (#77)", () => {
    // VT-4 403 wrong namespace. dev-token is admin (Q-11) and now bypasses the
    // namespace gate via the admin override (task 4.4), so the test uses a
    // regular role=user api-key caller instead — the gate must still block
    // non-admin cross-namespace deletes.
    it("returns 403 FORBIDDEN when caller's namespace differs from path namespace (non-admin)", async () => {
      const user = await db.createUser({ github_id: "gh-vt4", username: "regular" });
      const { key, keyHash, keyPrefix } = generateApiKey();
      await db.createApiKey({
        user_id: user.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: "vt4-key",
      });
      await pushAgent("dev", "owned", "1.0.0");
      await pushAgent("dev", "owned", "2.0.0");

      const res = await app.request("/api/agents/dev/owned/versions/1.0.0", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    // VT-5 404 NOT_FOUND (agent missing)
    it("returns 404 NOT_FOUND when agent does not exist", async () => {
      const res = await app.request("/api/agents/dev/missing-agent/versions/1.0.0", {
        method: "DELETE",
        headers: authHeader,
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    // VT-6 404 VERSION_NOT_FOUND (agent OK, version missing)
    it("returns 404 VERSION_NOT_FOUND when version does not exist", async () => {
      await pushAgent("dev", "foo", "1.0.0");
      await pushAgent("dev", "foo", "2.0.0");

      const res = await app.request("/api/agents/dev/foo/versions/9.9.9", {
        method: "DELETE",
        headers: authHeader,
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("VERSION_NOT_FOUND");

      // Both existing versions still present
      const versionsRes = await app.request("/api/agents/dev/foo/versions", {
        headers: authHeader,
      });
      const { versions } = await versionsRes.json();
      expect(versions).toHaveLength(2);
    });

    // VT-8 204 + bundle removed end-to-end
    it("returns 204 on success and the deleted version's bundle becomes unpullable", async () => {
      await pushAgent("dev", "foo", "1.0.0");
      await pushAgent("dev", "foo", "2.0.0");

      // Pre-condition: pulling 1.0.0 returns the bundle
      const prePull = await app.request("/api/agents/dev/foo/pull/1.0.0", {
        headers: authHeader,
      });
      expect(prePull.status).toBe(200);

      const delRes = await app.request("/api/agents/dev/foo/versions/1.0.0", {
        method: "DELETE",
        headers: authHeader,
      });
      expect(delRes.status).toBe(204);
      // Body is empty
      const text = await delRes.text();
      expect(text).toBe("");

      // Post-condition: pulling 1.0.0 now 404s (bundle removed from storage AND db row gone)
      const postPull = await app.request("/api/agents/dev/foo/pull/1.0.0", {
        headers: authHeader,
      });
      expect(postPull.status).toBe(404);

      // Other version still works
      const otherPull = await app.request("/api/agents/dev/foo/pull/2.0.0", {
        headers: authHeader,
      });
      expect(otherPull.status).toBe(200);

      // Versions list reflects the delete
      const versionsRes = await app.request("/api/agents/dev/foo/versions", {
        headers: authHeader,
      });
      const { versions } = await versionsRes.json();
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe("2.0.0");
    });

    // 409 LAST_VERSION (single-version agent)
    it("returns 409 LAST_VERSION when deleting would leave the agent with no versions", async () => {
      await pushAgent("dev", "solo", "1.0.0");

      const res = await app.request("/api/agents/dev/solo/versions/1.0.0", {
        method: "DELETE",
        headers: authHeader,
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("LAST_VERSION");
    });

    // 401 auth missing
    it("returns 401 when auth is missing", async () => {
      const res = await app.request("/api/agents/dev/foo/versions/1.0.0", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    // Route-order static guard (B-1): the new route must appear BEFORE the wildcard
    it("source registers /versions/:version DELETE before whole-agent DELETE (B-1 guard)", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const src = readFileSync(resolve(import.meta.dirname, "registry.ts"), "utf-8");

      const versionDeleteIdx = src.indexOf(
        'router.delete("/agents/:namespace/:name/versions/:version"',
      );
      const wholeAgentDeleteIdx = src.indexOf('router.delete("/agents/:namespace/:name"');

      expect(versionDeleteIdx).toBeGreaterThan(-1);
      expect(wholeAgentDeleteIdx).toBeGreaterThan(-1);
      // Specific path must be registered first to guarantee Hono first-match-wins safety
      expect(versionDeleteIdx).toBeLessThan(wholeAgentDeleteIdx);
    });
  });

  // SEC-013: route-level namespace/name regex.
  describe("agent name validation (SEC-013)", () => {
    it("VT-20a: rejects namespace containing `..`", async () => {
      // Percent-encoded `..` keeps it as a literal path segment value rather
      // than a URL traversal; without the route-level regex it would reach
      // the storage layer.
      const res = await app.request("/api/agents/..%2F/legit", {
        method: "GET",
        headers: authHeader,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_AGENT_NAME");
    });

    it("VT-20b: rejects name with uppercase letters", async () => {
      const res = await app.request("/api/agents/dev/My-Agent", {
        method: "GET",
        headers: authHeader,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_AGENT_NAME");
    });

    it("VT-20c: accepts kebab-case lowercase namespace/name (404, not 400)", async () => {
      // Agent doesn't exist → 404 NOT_FOUND from the service, but NOT
      // 400 INVALID_AGENT_NAME from the route gate.
      const res = await app.request("/api/agents/dev/my-agent", { headers: authHeader });
      if (res.status === 400) {
        const body = await res.json();
        expect(body.error.code).not.toBe("INVALID_AGENT_NAME");
      }
    });
  });

  // VT-23 (CODE-118): mechanical grep — every inline `err.status as ...` cast
  // in routes/* should have been replaced by `dispatchRegistryError`. This
  // test guards against the refactor regressing later.
  describe("CODE-118 dispatchRegistryError helper", () => {
    it("VT-23: no `err.status as` casts remain in routes/*", async () => {
      const { readFileSync, readdirSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");
      const routesDir = resolve(import.meta.dirname);
      const files = readdirSync(routesDir).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_helpers"),
      );
      const offending: Array<{ file: string; line: number; content: string }> = [];
      for (const f of files) {
        const src = readFileSync(join(routesDir, f), "utf-8");
        src.split("\n").forEach((line, idx) => {
          if (line.includes("err.status as")) {
            offending.push({ file: f, line: idx + 1, content: line.trim() });
          }
        });
      }
      expect(offending).toEqual([]);
    });
  });
});

describe("PATCH visibility + reads (#81)", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  async function seedUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const k = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "k",
    });
    return { id: user.id, key: k.key };
  }

  async function pushAgent(key: string, ns: string, name: string): Promise<void> {
    const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
    if (pushed.status !== 200) throw new Error(`push answered ${pushed.status}`);
  }

  function patchVisibility(key: string, ns: string, name: string, body: unknown) {
    return app.request(`/api/agents/${ns}/${name}/visibility`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // VT-11: the public set-path is disabled (private-only hosting). Setting
  // public is rejected; setting private is still accepted.
  it("VT-11: owner setting public -> 400 PUBLIC_VISIBILITY_DISABLED; private -> 200", async () => {
    const a = await seedUser("alice");
    await pushAgent(a.key, "alice", "agent1");
    const toPublic = await patchVisibility(a.key, "alice", "agent1", { visibility: "public" });
    expect(toPublic.status).toBe(400);
    // Disabled for now, and nothing promised in its place.
    expect(((await toPublic.json()) as { error: { code: string; message: string } }).error).toEqual(
      {
        code: "PUBLIC_VISIBILITY_DISABLED",
        message: "Public visibility is not available for now; agents are private-only.",
      },
    );
    expect((await db.getAgent("alice", "agent1"))?.visibility).toBe("private");
    const toPrivate = await patchVisibility(a.key, "alice", "agent1", { visibility: "private" });
    expect(toPrivate.status).toBe(200);
    expect((await db.getAgent("alice", "agent1"))?.visibility).toBe("private");
  });

  it("VT-9/11b: non-owner+public -> 403 (precedes the public-disabled 400, no oracle); absent -> 404; bad enum -> 400", async () => {
    const a = await seedUser("alice");
    const b = await seedUser("bob");
    await pushAgent(a.key, "alice", "agent1");
    // Non-owner sends public: the ownership check fires first → 403 FORBIDDEN,
    // NOT 400 PUBLIC_VISIBILITY_DISABLED (no oracle that public is disabled).
    const denied = await patchVisibility(b.key, "alice", "agent1", { visibility: "public" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    // Absent agent: public would 400 before reaching the 404, so probe with
    // private to exercise the genuine not-found path.
    const absent = await patchVisibility(a.key, "alice", "ghost", { visibility: "private" });
    expect(absent.status).toBe(404);
    const bad = await patchVisibility(a.key, "alice", "agent1", { visibility: "secret" });
    expect(bad.status).toBe(400);
  });

  it("RT-2: a public agent is still 404 on GET/pull for a non-owner (reads unchanged)", async () => {
    const a = await seedUser("alice");
    const b = await seedUser("bob");
    await pushAgent(a.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const bobAuth = { headers: { Authorization: `Bearer ${b.key}` } };
    const meta = await app.request("/api/agents/alice/agent1", bobAuth);
    const vers = await app.request("/api/agents/alice/agent1/versions", bobAuth);
    const pull = await app.request("/api/agents/alice/agent1/pull", bobAuth);
    expect(meta.status).toBe(404);
    expect(vers.status).toBe(404);
    expect(pull.status).toBe(404);
  });
});

describe("PATCH /verify — verification policy", () => {
  function setup(verificationPolicy: VerificationPolicy) {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const app = createApp(storage, db, { verificationPolicy });

    async function makeUser(username: string): Promise<{ id: string; key: string }> {
      const user = await db.createUser({ github_id: `gh-${username}`, username });
      const { key, keyHash, keyPrefix } = generateApiKey();
      await db.createApiKey({
        user_id: user.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: "test-key",
      });
      return { id: user.id, key };
    }

    async function push(ownerKey: string, ns: string, name: string): Promise<void> {
      const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(await validBundle(name)),
      });
      if (pushed.status !== 200) throw new Error(`push answered ${pushed.status}`);
    }

    function verifyAs(key: string, ns: string, name: string, verified = true) {
      return app.request(`/api/agents/${ns}/${name}/versions/1.0.0/verify`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ verified }),
      });
    }

    function verifyAsDevToken(ns: string, name: string) {
      return app.request(`/api/agents/${ns}/${name}/versions/1.0.0/verify`, {
        method: "PATCH",
        headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true }),
      });
    }

    return { app, db, makeUser, push, verifyAs, verifyAsDevToken };
  }

  /** The `kind` field of the most recent agent_version_verify structured log. */
  function lastVerifyLogKind(): string | undefined {
    const call = logInfoSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "agent_version_verify",
    );
    return (call?.[0] as { kind?: string })?.kind;
  }

  it("VT-5: owner policy — an owner self-verifies their own agent (200)", async () => {
    const { makeUser, push, verifyAs } = setup("owner");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1");
    const res = await verifyAs(alice.key, "alice", "agent1");
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);
  });

  it("VT-6: owner policy — a stranger cannot verify another's agent (403)", async () => {
    const { makeUser, push, verifyAs } = setup("owner");
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await push(alice.key, "alice", "agent1");
    const res = await verifyAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(403);
  });

  it("VT-8: attestation kind — owner self = owner_self, admin = admin", async () => {
    const { makeUser, push, verifyAs, verifyAsDevToken } = setup("owner");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1");

    logInfoSpy.mockClear();
    await verifyAs(alice.key, "alice", "agent1");
    expect(lastVerifyLogKind()).toBe("owner_self");

    logInfoSpy.mockClear();
    await verifyAsDevToken("alice", "agent1");
    expect(lastVerifyLogKind()).toBe("admin");
  });

  it("RT-2: admin policy (default) — a non-admin owner cannot verify (403)", async () => {
    const { makeUser, push, verifyAs } = setup("admin");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1");
    const res = await verifyAs(alice.key, "alice", "agent1");
    expect(res.status).toBe(403);
  });

  it("RT-3: admin policy — an admin (dev-token) verifies (200)", async () => {
    const { makeUser, push, verifyAsDevToken } = setup("admin");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1");
    const res = await verifyAsDevToken("alice", "agent1");
    expect(res.status).toBe(200);
  });
});

describe("push — API-key scope (#65)", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
  });

  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "acct",
    });
    return { id: user.id, key };
  }

  async function scopedKey(
    userId: string,
    opts: { scope_kind?: "account" | "agents"; operations: string[]; agents?: string[] },
  ): Promise<string> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "scoped",
      scopes: opts.operations,
      scope_kind: opts.scope_kind ?? "agents",
      agents: opts.agents ?? [],
    });
    return key;
  }

  async function push(key: string, ns: string, name: string, version = "1.0.0") {
    return app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
  }

  /** Account-key push that creates the agent; returns its db id. */
  async function createAgent(ownerKey: string, ns: string, name: string): Promise<string> {
    const pushed = await push(ownerKey, ns, name);
    if (pushed.status !== 200) throw new Error(`push answered ${pushed.status}`);
    const agent = await db.getAgent(ns, name);
    if (!agent) throw new Error("agent missing after push");
    return agent.id;
  }

  it("VT-14: a key scoped to its agent (with agent:push) pushes a new version", async () => {
    const alice = await makeUser("alice");
    const agentId = await createAgent(alice.key, "alice", "agent1");
    const sk = await scopedKey(alice.id, { operations: ["agent:push"], agents: [agentId] });
    const res = await push(sk, "alice", "agent1", "2.0.0");
    expect(res.status).not.toBe(403);
  });

  it("VT-15: a scoped key cannot create a NEW agent → 403 KEY_SCOPE_FORBIDDEN", async () => {
    const alice = await makeUser("alice");
    const agentId = await createAgent(alice.key, "alice", "agent1");
    const sk = await scopedKey(alice.id, { operations: ["agent:push"], agents: [agentId] });
    const res = await push(sk, "alice", "brand-new");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
  });

  it("VT-15: a scoped key cannot push to another OWNED agent → 403", async () => {
    const alice = await makeUser("alice");
    const agent1Id = await createAgent(alice.key, "alice", "agent1");
    await createAgent(alice.key, "alice", "agent2");
    const sk = await scopedKey(alice.id, { operations: ["agent:push"], agents: [agent1Id] });
    const res = await push(sk, "alice", "agent2", "2.0.0");
    expect(res.status).toBe(403);
  });

  it("a run-only account key cannot push → 403 KEY_SCOPE_FORBIDDEN", async () => {
    const alice = await makeUser("alice");
    const runOnly = await scopedKey(alice.id, { scope_kind: "account", operations: ["agent:run"] });
    const res = await push(runOnly, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
  });

  function get(key: string, path: string) {
    return app.request(path, { headers: { Authorization: `Bearer ${key}` } });
  }

  it("VT-19/20: a delegated key reads in-scope metadata only; pull/versions/list denied", async () => {
    const alice = await makeUser("alice");
    const agent1Id = await createAgent(alice.key, "alice", "agent1");
    await createAgent(alice.key, "alice", "agent2");
    const sk = await scopedKey(alice.id, { operations: ["agent:run"], agents: [agent1Id] });

    expect((await get(sk, "/api/agents/alice/agent1")).status).toBe(200); // in-scope metadata
    expect((await get(sk, "/api/agents/alice/agent2")).status).toBe(403); // out-of-scope (VT-20)
    expect((await get(sk, "/api/agents/alice/agent1/pull")).status).toBe(403); // source denied
    expect((await get(sk, "/api/agents/alice/agent1/versions")).status).toBe(403);
    expect((await get(sk, "/api/agents")).status).toBe(403); // inventory denied
  });

  it("an account-full key reads metadata/versions/list as today (no regression)", async () => {
    const alice = await makeUser("alice");
    await createAgent(alice.key, "alice", "agent1");
    expect((await get(alice.key, "/api/agents/alice/agent1")).status).toBe(200);
    expect((await get(alice.key, "/api/agents/alice/agent1/versions")).status).toBe(200);
    expect((await get(alice.key, "/api/agents")).status).toBe(200);
    expect((await get(alice.key, "/api/agents/alice/agent1/pull")).status).not.toBe(403);
  });

  it("VT-18: a delegated key whose granted agent was deleted is deny-all (fail-closed)", async () => {
    const alice = await makeUser("alice");
    const agent1Id = await createAgent(alice.key, "alice", "agent1");
    const sk = await scopedKey(alice.id, { operations: ["agent:run"], agents: [agent1Id] });
    await db.deleteAgent("alice", "agent1"); // cascade → 0 grants
    await createAgent(alice.key, "alice", "agent1"); // re-created with a NEW id
    expect((await get(sk, "/api/agents/alice/agent1")).status).toBe(403);
  });
});

describe("verify — API-key scope (#65)", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;

  beforeEach(() => {
    db = new MemoryDb();
    // `owner` policy so a non-admin owner can verify → we exercise the key-scope
    // gate, not the #103 policy gate.
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner" });
  });

  async function setup(): Promise<{ userId: string; agent1Id: string; ownerKey: string }> {
    const user = await db.createUser({ github_id: "gh-alice", username: "alice" });
    const acct = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: acct.keyHash,
      key_prefix: acct.keyPrefix,
      name: "acct",
    });
    for (const n of ["agent1", "agent2"]) {
      const pushed = await app.request(`/api/agents/alice/${n}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acct.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(await validBundle(n)),
      });
      if (pushed.status !== 200) throw new Error(`push answered ${pushed.status}`);
    }
    const a1 = await db.getAgent("alice", "agent1");
    if (!a1) throw new Error("agent1 missing");
    return { userId: user.id, agent1Id: a1.id, ownerKey: acct.key };
  }

  async function mintKey(
    userId: string,
    operations: string[],
    agents: string[] | null,
  ): Promise<string> {
    const k = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind: agents ? "agents" : "account",
      agents: agents ?? [],
    });
    return k.key;
  }

  function verify(key: string, ns: string, name: string) {
    return app.request(`/api/agents/${ns}/${name}/versions/1.0.0/verify`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
  }

  it("VT-16: agent:verify scoped to its agent verifies it; another agent → 403", async () => {
    const { userId, agent1Id } = await setup();
    const sk = await mintKey(userId, ["agent:verify"], [agent1Id]);
    expect((await verify(sk, "alice", "agent1")).status).toBe(200);
    expect((await verify(sk, "alice", "agent2")).status).toBe(403);
  });

  it("VT-16: a key lacking agent:verify → 403", async () => {
    const { userId } = await setup();
    const runOnly = await mintKey(userId, ["agent:run"], null);
    expect((await verify(runOnly, "alice", "agent1")).status).toBe(403);
  });

  it("RT-4: an account-full key still verifies under owner policy (no regression)", async () => {
    const { userId } = await setup();
    const full = await mintKey(userId, ["agent:run", "agent:push", "agent:verify"], null);
    expect((await verify(full, "alice", "agent1")).status).toBe(200);
  });

  it("VT-17: a delegated key (even full-op) cannot delete or change visibility → 403", async () => {
    const { userId, agent1Id } = await setup();
    // Full operations but resource-scoped → not a master credential.
    const sk = await mintKey(userId, ["agent:run", "agent:push", "agent:verify"], [agent1Id]);
    const del = await app.request("/api/agents/alice/agent1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sk}` },
    });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
    const vis = await app.request("/api/agents/alice/agent1/visibility", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(vis.status).toBe(403);
  });
});

describe("push rate limiting (#116)", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  const authHeader = { Authorization: "Bearer dev-token" };

  async function pushReq(version: string, name = "rl-agent") {
    return app.request(`/api/agents/dev/${name}/push?version=${version}`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
  }

  it("VT-1 + RT-3: the real two-segment push route traverses the limiter, metadata unchanged", async () => {
    const res = await pushReq("1.0.0");
    // The limiter is on the path: every response carries the X-RateLimit contract.
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    // RT-3 — the nominal push still returns the same metadata shape.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("rl-agent");
    expect(body.namespace).toBe("dev");
    expect(body.latest_version).toBe("1.0.0");
  });

  it("VT-2: the 11th push in the window is refused 429 RATE_LIMITED", async () => {
    for (let i = 1; i <= 10; i++) {
      expect((await pushReq(`1.0.${i}`)).status).toBe(200);
    }
    const res = await pushReq("1.0.11");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("VT-22: the local-directory push path shares the push counter", async () => {
    // The scan push route matches the same mount pattern (`:namespace` binds to
    // the literal "scan"), so it shares this window's counter. The handler's
    // own SKRUN_AGENTS_DIR gate is irrelevant here: the limiter runs first,
    // which is exactly what this test pins down.
    for (let i = 1; i <= 10; i++) {
      expect((await pushReq(`1.0.${i}`)).status).toBe(200);
    }
    const res = await app.request("/api/agents/scan/rl-agent/push", {
      method: "POST",
      headers: authHeader,
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });
});

describe("push body cap (#116)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.stubEnv("SKRUN_PUSH_MAX_BODY_MB", "0.001"); // ~1 KB cap for the tests
    app = createApp(new MemoryStorage(), new MemoryDb());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const authHeader = { Authorization: "Bearer dev-token" };

  function pushBody(body: Buffer, extraHeaders: Record<string, string> = {}) {
    return app.request("/api/agents/dev/cap-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream", ...extraHeaders },
      body,
    });
  }

  it("an oversized push without Content-Length is refused 413, read no further than the cap", async () => {
    // A body with no content-length — the one self-made clients send — is
    // counted as the route reads it, after its authentication: the read stops
    // at the first chunk past the cap, and the rest is never pulled.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 64 * 1024) return controller.close();
        controller.enqueue(new Uint8Array(1024).fill(1));
        pulled += 1024;
      },
    });
    const res = await app.request("/api/agents/dev/cap-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("BUNDLE_TOO_LARGE");
    expect(pulled).toBeLessThanOrEqual(4 * 1024);
  });

  it("VT-4b: an oversized push is refused 413 on the Content-Length fast path", async () => {
    // In production @hono/node-server forwards the real Content-Length, so the
    // fast path (header short-circuit, body never read) is the one actually
    // taken — it must be exercised explicitly, since the test client strips it.
    const spy = vi.spyOn(Request.prototype, "arrayBuffer");
    const res = await pushBody(Buffer.alloc(64 * 1024, 1), {
      "Content-Length": String(64 * 1024),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("BUNDLE_TOO_LARGE");
    expect(spy).not.toHaveBeenCalled();
  });

  it("VT-5: a body just under the cap passes, path unchanged", async () => {
    const res = await pushBody(await validBundleOfSize(512, "cap-agent")); // under the ~1 KB cap
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest_version).toBe("1.0.0");
  });
});

// The server's longest timeout and the account's bundle storage are checked
// at the push, before anything is stored: a refused push leaves no agent and
// no object. The account's numbers go to a master credential only.
describe("push — the server's longest timeout and the account's storage", () => {
  const MIB = 1024 * 1024;
  const devAuth = { Authorization: "Bearer dev-token" };
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    db = new MemoryDb();
    storage = new MemoryStorage();
    logInfoSpy.mockClear();
    logWarnSpy.mockClear();
  });

  function appWith(env: Record<string, string>) {
    return createApp(storage, db, { quotaConfig: parseQuotaEnv(env) });
  }

  /** A bundle whose agent.yaml declares `timeout`. */
  function agentBundle(name: string, timeout: string): Promise<Buffer> {
    const yaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      `  timeout: ${timeout}`,
    ].join("\n");
    return packAgentTar([{ name: "agent.yaml", content: Buffer.from(yaml) }]);
  }

  async function push(
    app: ReturnType<typeof createApp>,
    headers: Record<string, string>,
    path: string,
    body: Buffer,
  ) {
    const res = await app.request(`/api/agents/${path}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body,
    });
    return {
      status: res.status,
      body: (await res.json()) as { error?: { code: string; message: string } },
    };
  }

  /** An account with `plan`, and a key on it: every operation unless `operations` says otherwise. */
  async function account(username: string, plan: string, operations?: string[]) {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    await db.updateUser(user.id, { plan });
    const k = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: k.keyHash,
      key_prefix: k.keyPrefix,
      name: "k",
      ...(operations ? { scopes: operations, scope_kind: "account" as const } : {}),
    });
    return { id: user.id, headers: { Authorization: `Bearer ${k.key}` } };
  }

  const refusals = () =>
    logInfoSpy.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "quota_refused");

  it("an agent declaring more than the maximum is refused 400 TIMEOUT_ABOVE_LIMIT; no agent, no object, one line", async () => {
    const app = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "900" });
    const res = await push(app, devAuth, "dev/slow", await agentBundle("slow", "1800s"));
    expect(res).toEqual({
      status: 400,
      body: {
        error: {
          code: "TIMEOUT_ABOVE_LIMIT",
          message: "This agent declares 1800 s; this server accepts at most 900 s.",
        },
      },
    });
    expect(await db.getAgent("dev", "slow")).toBeNull();
    expect(await storage.get("dev/slow/1.0.0.agent")).toBeNull();
    expect(refusals()).toEqual([
      expect.objectContaining({ bound: "max_timeout", plan: "free", user_id: expect.any(String) }),
    ]);

    const within = await push(app, devAuth, "dev/slow", await agentBundle("slow", "900s"));
    expect(within.status).toBe(200);
  });

  it("a push past the account's storage is refused 413 STORAGE_QUOTA_EXCEEDED with the account's numbers; up to the cap, stored", async () => {
    const app = appWith({ SKRUN_QUOTA_STORAGE_MB: "1" });
    const over = await push(app, devAuth, "dev/big", await validBundleOfSize(MIB + 1));
    expect(over.status).toBe(413);
    expect(over.body.error?.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(over.body.error?.message).toBe(
      "This account's agents hold 0 B of the 1,048,576 B of bundle storage its plan allows; this bundle (1,048,577 B) does not fit. Delete a version no longer needed (DELETE /api/agents/:namespace/:name/versions/:version) to make room — or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name), which deletes its state and its model keys too, and removes it from the keys restricted to it.",
    );
    expect(await db.getAgent("dev", "big")).toBeNull();
    expect(await storage.get("dev/big/1.0.0.agent")).toBeNull();
    expect(refusals()).toEqual([
      expect.objectContaining({ bound: "storage", plan: "free", user_id: expect.any(String) }),
    ]);

    expect((await push(app, devAuth, "dev/big", await validBundleOfSize(MIB))).status).toBe(200);
    const full = await push(app, devAuth, "dev/small", await validBundleOfSize(500));
    expect(full.status).toBe(413);
    expect(full.body.error?.message).toContain("hold 1 MB of the 1 MB");
  });

  it("an account key reduced to pushing is told the bound, never the account's numbers", async () => {
    const app = appWith({ SKRUN_QUOTA_STORAGE_MB: "1" });
    const pusher = await account("pusher", "free", ["agent:push"]);
    const res = await push(app, pusher.headers, "pusher/big", await validBundleOfSize(MIB + 1));
    expect(res).toEqual({
      status: 413,
      body: {
        error: {
          code: "STORAGE_QUOTA_EXCEEDED",
          message:
            "This push would take this account past the bundle storage its plan allows; a version deleted from the account makes room — or, for an agent's last version, the agent, which deletes its state and its model keys too, and removes it from the keys restricted to it.",
        },
      },
    });
    expect(refusals()).toEqual([
      expect.objectContaining({ bound: "storage", plan: "free", user_id: pusher.id }),
    ]);
  });

  it("the storage of the caller's plan applies: its own value, free's when the setting does not name it, free's for a plan no setting names", async () => {
    const app = appWith({
      SKRUN_QUOTA_STORAGE_MB: "free=1,team=2",
      SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5",
    });
    const team = await account("team-account", "team");
    const pro = await account("pro-account", "pro");
    const ghost = await account("ghost-account", "ghost");

    expect(
      (await push(app, team.headers, "team-account/a", await validBundleOfSize(MIB + 1))).status,
    ).toBe(200);
    // A known plan the storage setting does not name gets free's value, silently.
    const proRes = await push(app, pro.headers, "pro-account/a", await validBundleOfSize(MIB + 1));
    expect(proRes.status).toBe(413);
    // To the byte: rounded, 0 B and a bundle of 1 MB would seem to fit in 1 MB.
    expect(proRes.body.error?.message).toContain("of the 1,048,576 B");
    expect(logWarnSpy).not.toHaveBeenCalled();
    // A plan no setting names gets free's value too, with one line naming it.
    const ghostRes = await push(
      app,
      ghost.headers,
      "ghost-account/a",
      await validBundleOfSize(MIB + 1),
    );
    expect(ghostRes.status).toBe(413);
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "quota_plan_unknown", plan: "ghost" }),
      expect.any(String),
    );
  });

  it("pushing the same version twice is refused 409 VERSION_EXISTS, the account at its storage too", async () => {
    const app = appWith({ SKRUN_QUOTA_STORAGE_MB: "1" });
    // Pushed again, it would take the account past its storage, were it stored.
    const version = await validBundleOfSize(600 * 1024);
    expect((await push(app, devAuth, "dev/twice", version)).status).toBe(200);
    const again = await push(app, devAuth, "dev/twice", version);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("VERSION_EXISTS");
    expect(refusals()).toEqual([]);
  });

  it("a push from the registry and one from the agents directory, of one account at once: one stored, the other refused 413", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-push-turns-"));
    const savedDir = process.env.SKRUN_AGENTS_DIR;
    try {
      mkdirSync(join(dir, "from-dir"));
      writeFileSync(join(dir, "from-dir", "agent.yaml"), minimalAgentYaml("from-dir"));
      // Random bytes do not compress: the bundle built from the directory stays near 600 KiB.
      writeFileSync(join(dir, "from-dir", "data.bin"), randomBytes(600 * 1024));
      process.env.SKRUN_AGENTS_DIR = dir;
      const app = appWith({ SKRUN_QUOTA_STORAGE_MB: "1" });
      // The dev token's account recorded first: two first requests at once
      // could each record one.
      expect((await app.request("/api/me", { headers: devAuth })).status).toBe(200);

      // Each write waits until both pushes have read what the account holds, or
      // a moment: pushes not taken one at a time would both have read 0 by then.
      const sum = vi.spyOn(db, "sumBundleBytesByOwner");
      const put = storage.put.bind(storage);
      vi.spyOn(storage, "put").mockImplementation(async (key, data, opts) => {
        const until = Date.now() + 200;
        while (sum.mock.calls.length < 2 && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return put(key, data, opts);
      });

      const fromRegistryBundle = await validBundleOfSize(600 * 1024, "from-registry");
      const [fromRegistry, fromDir] = await Promise.all([
        push(app, devAuth, "dev/from-registry", fromRegistryBundle),
        app.request("/api/agents/scan/from-dir/push", { method: "POST", headers: devAuth }),
      ]);
      const statuses = [fromRegistry.status, fromDir.status].sort();
      expect(statuses).toEqual([200, 413]);
      expect(await storage.list("dev/")).toHaveLength(1);
    } finally {
      if (savedDir === undefined) delete process.env.SKRUN_AGENTS_DIR;
      else process.env.SKRUN_AGENTS_DIR = savedDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["no setting", {}],
    ["the server's longest timeout set", { SKRUN_RUN_MAX_TIMEOUT_S: "900" }],
  ])("with %s, an agent.yaml naming a secret is refused 400 UNSUPPORTED_FIELD, by name; no agent, no object, no version, no quota line", async (_label, env) => {
    const app = appWith(env);
    const createVersion = vi.spyOn(db, "createVersion");
    const yaml = [
      "name: secretive",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      "  secrets: [X]",
    ].join("\n");
    const bundle = await packAgentTar([{ name: "agent.yaml", content: Buffer.from(yaml) }]);
    const res = await push(app, devAuth, "dev/secretive", bundle);
    expect(res).toEqual({
      status: 400,
      body: {
        error: {
          code: "UNSUPPORTED_FIELD",
          message:
            "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.",
        },
      },
    });
    expect(await db.getAgent("dev", "secretive")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
    expect(createVersion).not.toHaveBeenCalled();
    expect(refusals()).toEqual([]);
  });

  it("with no setting, a push is stored whatever its size or its timeout, and nothing of the account is read", async () => {
    const app = appWith({});
    const sum = vi.spyOn(db, "sumBundleBytesByOwner");
    expect((await push(app, devAuth, "dev/open", await agentBundle("open", "99999s"))).status).toBe(
      200,
    );
    expect(sum).not.toHaveBeenCalled();
    expect(refusals()).toEqual([]);
  });
});

// An agent's source belongs to a full-access credential. A key that carries
// fewer than every operation — the "run-only" key a creator hands out — pulls
// nothing; a session, the dev token and a full account key pull as before.
describe("agent source — reads that take full access", () => {
  const FULL_ACCESS_MESSAGE =
    "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.";
  const DELEGATED_MESSAGE = "This endpoint is not available to a resource-scoped API key.";
  let SOURCE: Buffer;
  beforeAll(async () => {
    SOURCE = await validBundle("agent1");
  });

  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let owner: { id: string; fullKey: string };

  beforeEach(async () => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    const user = await db.createUser({ github_id: "gh-alice", username: "alice" });
    const fullKey = await mintKey(user.id, "account", ["agent:run", "agent:push", "agent:verify"]);
    owner = { id: user.id, fullKey };
    const pushed = await app.request("/api/agents/alice/agent1/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/octet-stream" },
      body: SOURCE,
    });
    expect(pushed.status).toBe(200);
  });

  async function mintKey(
    userId: string,
    scope_kind: "account" | "agents",
    operations: string[],
  ): Promise<string> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const agent = await db.getAgent("alice", "agent1");
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind,
      agents: scope_kind === "agents" && agent ? [agent.id] : [],
    });
    return key;
  }

  type Header = Record<string, string>;
  const reduced: Array<[string, () => Promise<Header>]> = [
    [
      "an account key that may only run agents",
      async () => ({
        Authorization: `Bearer ${await mintKey(owner.id, "account", ["agent:run"])}`,
      }),
    ],
    [
      "an account key with no operation",
      async () => ({ Authorization: `Bearer ${await mintKey(owner.id, "account", [])}` }),
    ],
  ];
  const master: Array<[string, () => Promise<Header>]> = [
    [
      "a session",
      async () => ({ Cookie: `${sessionCookieName()}=${await createSession(db, owner.id)}` }),
    ],
    ["the dev token", async () => ({ Authorization: "Bearer dev-token" })],
    ["a full account key", async () => ({ Authorization: `Bearer ${owner.fullKey}` })],
  ];

  for (const path of ["/api/agents/alice/agent1/pull", "/api/agents/alice/agent1/pull/1.0.0"]) {
    describe(`GET ${path.replace("/api/agents/alice/agent1", "…")}`, () => {
      it.each(reduced)("refuses %s", async (_label, headers) => {
        const res = await app.request(path, { headers: await headers() });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: { code: "KEY_SCOPE_FORBIDDEN", message: FULL_ACCESS_MESSAGE },
        });
      });

      it.each(master)("hands the source to %s", async (_label, headers) => {
        const res = await app.request(path, { headers: await headers() });
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer())).toEqual(SOURCE);
        expect(res.headers.get("X-Agent-Version")).toBe("1.0.0");
      });

      it("keeps the delegated key's own refusal", async () => {
        const delegated = await mintKey(owner.id, "agents", ["agent:run", "agent:push"]);
        const res = await app.request(path, { headers: { Authorization: `Bearer ${delegated}` } });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: { code: "KEY_SCOPE_FORBIDDEN", message: DELEGATED_MESSAGE },
        });
      });
    });
  }
});

// The versions list stays readable by any key that is not delegated, but the
// parsed configuration of each version (model, tools, MCP servers, whose URLs
// may carry a credential) is for a full-access credential only.
describe("versions list — the configuration takes full access", () => {
  const CONFIG = {
    name: "agent1",
    version: "1.0.0",
    model: { provider: "anthropic", name: "a-model" },
    mcp_servers: [{ name: "crm", url: "https://mcp.example/?token=secret" }],
  };

  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let ownerId: string;

  beforeEach(async () => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    const user = await db.createUser({ github_id: "gh-alice", username: "alice" });
    ownerId = user.id;
    const agent = await db.createAgent({
      namespace: "alice",
      name: "agent1",
      description: "",
      owner_id: ownerId,
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 10,
      bundle_key: "alice/agent1/1.0.0.agent",
      config_snapshot: CONFIG,
    });
  });

  async function keyHeader(scope_kind: "account" | "agents", operations: string[]) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const agent = await db.getAgent("alice", "agent1");
    await db.createApiKey({
      user_id: ownerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind,
      agents: scope_kind === "agents" && agent ? [agent.id] : [],
    });
    return { Authorization: `Bearer ${key}` };
  }

  async function versions(headers: Record<string, string>) {
    const res = await app.request("/api/agents/alice/agent1/versions", { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it.each([
    ["an account key that may only run agents", ["agent:run"]],
    ["an account key with no operation", []],
  ])("lists the versions to %s, without their configuration", async (_label, operations) => {
    const { status, body } = await versions(await keyHeader("account", operations));
    expect(status).toBe(200);
    const list = body.versions as Array<Record<string, unknown>>;
    expect(list.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(list[0]).not.toHaveProperty("config_snapshot");
    expect(JSON.stringify(body)).not.toContain("token=secret");
  });

  it.each([
    [
      "a session",
      async () => ({ Cookie: `${sessionCookieName()}=${await createSession(db, ownerId)}` }),
    ],
    ["the dev token", async () => ({ Authorization: "Bearer dev-token" })],
    ["a full account key", () => keyHeader("account", ["agent:run", "agent:push", "agent:verify"])],
  ])("lists the versions to %s, with their configuration", async (_label, headers) => {
    const { status, body } = await versions(await headers());
    expect(status).toBe(200);
    const list = body.versions as Array<Record<string, unknown>>;
    expect(list.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(list[0]?.config_snapshot).toEqual(CONFIG);
  });

  it("keeps the delegated key's own refusal", async () => {
    const { status, body } = await versions(await keyHeader("agents", ["agent:run"]));
    expect(status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message: "This endpoint is not available to a resource-scoped API key.",
      },
    });
  });
});

// Setting the flag answers with the version: its configuration is for a
// full-access credential only, like the versions list. Setting the flag to the
// value it already has would otherwise be a plain read of the configuration.
describe("verify — the configuration in the answer takes full access", () => {
  const CONFIG = {
    name: "agent1",
    version: "1.0.0",
    model: { provider: "anthropic", name: "a-model" },
    mcp_servers: [{ name: "crm", url: "https://mcp.example/?token=secret" }],
  };

  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let ownerId: string;

  beforeEach(async () => {
    db = new MemoryDb();
    // `owner` policy: the agent's owner may set the flag with any key that
    // carries `agent:verify`, which is where the answer reaches a reduced key.
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner" });
    const user = await db.createUser({ github_id: "gh-alice", username: "alice" });
    ownerId = user.id;
    const agent = await db.createAgent({
      namespace: "alice",
      name: "agent1",
      description: "",
      owner_id: ownerId,
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 10,
      bundle_key: "alice/agent1/1.0.0.agent",
      config_snapshot: CONFIG,
    });
  });

  async function keyHeader(scope_kind: "account" | "agents", operations: string[]) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const agent = await db.getAgent("alice", "agent1");
    await db.createApiKey({
      user_id: ownerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind,
      agents: scope_kind === "agents" && agent ? [agent.id] : [],
    });
    return { Authorization: `Bearer ${key}` };
  }

  async function verify(headers: Record<string, string>) {
    const res = await app.request("/api/agents/alice/agent1/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const FULL_OPERATIONS = ["agent:run", "agent:push", "agent:verify"];

  it.each([
    ["a delegated key that carries every operation", () => keyHeader("agents", FULL_OPERATIONS)],
    [
      "an account key that may run and verify only",
      () => keyHeader("account", ["agent:run", "agent:verify"]),
    ],
  ])("sets the flag for %s, and answers without the configuration", async (_label, headers) => {
    const { status, body } = await verify(await headers());
    expect(status).toBe(200);
    expect(body.version).toBe("1.0.0");
    expect(body.verified).toBe(true);
    expect(body).not.toHaveProperty("config_snapshot");
    expect(JSON.stringify(body)).not.toContain("token=secret");
  });

  it.each([
    [
      "a session",
      async () => ({
        Cookie: `${sessionCookieName()}=${await createSession(db, ownerId)}`,
        Origin: "http://localhost",
      }),
    ],
    ["a full account key", () => keyHeader("account", FULL_OPERATIONS)],
  ])("sets the flag for %s, and answers with the configuration", async (_label, headers) => {
    const { status, body } = await verify(await headers());
    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.config_snapshot).toEqual(CONFIG);
  });
});

// A bundle no run could read is refused at the push, by the name the run
// answers a stored one with — before anything is stored, whatever the server
// bounds. The dashboard's upload sends its file to this route as it is.
describe("push — a bundle that does not load is refused", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let storage: MemoryStorage;
  const devAuth = { Authorization: "Bearer dev-token" };
  /** A tool whose input schema holds an !!omap, where the schema takes any value: valid but for the tag. */
  const OMAP_TOOL = [
    "tools:",
    "  - name: first",
    "    description: Looks things up.",
    "    input_schema:",
    "      type: object",
    "      properties:",
    "        p: !!omap [a: 1, b: 2]",
  ];

  beforeEach(() => {
    // A cap of 1 MB, so a bundle past it stays small to build.
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1");
    db = new MemoryDb();
    storage = new MemoryStorage();
    app = createApp(storage, db, {
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_STORAGE_MB: "1", SKRUN_RUN_MAX_TIMEOUT_S: "900" }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A bundle of `agentYaml` — and, `big`, of about 2 MB of text, past the cap once unpacked. */
  function bundleOf(agentYaml: string, big = false): Promise<Buffer> {
    return packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      ...(big
        ? [{ name: "data/blob.txt", content: Buffer.from("lorem ipsum\n".repeat(180_000)) }]
        : []),
    ]);
  }

  it.each([
    [
      "past the decompression cap",
      413,
      "BUNDLE_DECOMPRESSED_TOO_LARGE",
      () => bundleOf(minimalAgentYaml("unloadable"), true),
    ],
    ["not a gzip-compressed tar", 400, "BUNDLE_CORRUPT", async () => Buffer.from("not-a-bundle")],
    [
      "with entries that contradict each other",
      400,
      "BUNDLE_CORRUPT",
      () =>
        packAgentTar([
          { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
          { name: "x", content: Buffer.from("a file") },
          { name: "x/y", content: Buffer.from("a file under it") },
        ]),
    ],
    [
      "without agent.yaml",
      400,
      "MISSING_CONFIG",
      () => packAgentTar([{ name: "SKILL.md", content: Buffer.from("# unloadable\n") }]),
    ],
    [
      "with an agent.yaml that is not valid",
      400,
      "INVALID_CONFIG",
      () => bundleOf("name: unloadable"),
    ],
    [
      "with an agent.yaml that holds a YAML alias",
      400,
      "INVALID_CONFIG",
      () =>
        bundleOf(
          minimalAgentYaml("unloadable", [
            "tools:",
            "  - name: first",
            "    description: &same Looks things up.",
            "    input_schema: { type: object }",
            "  - name: second",
            "    description: *same",
            "    input_schema: { type: object }",
          ]),
        ),
    ],
    [
      "with an agent.yaml that declares %YAML 1.1",
      400,
      "INVALID_CONFIG",
      () => bundleOf(`%YAML 1.1\n---\n${minimalAgentYaml("unloadable")}`),
    ],
    [
      "with an agent.yaml that holds the tag !!omap",
      400,
      "INVALID_CONFIG",
      () => bundleOf(minimalAgentYaml("unloadable", OMAP_TOOL)),
    ],
  ] as const)("%s: %s %s — no agent, no object, the account's storage unchanged", async (_case, status, code, bundle) => {
    // The dev token's account recorded first, to read what it holds after.
    const me = (await (await app.request("/api/me", { headers: devAuth })).json()) as {
      id: string;
    };
    const res = await app.request("/api/agents/dev/unloadable/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await bundle()),
    });
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(await db.getAgent("dev", "unloadable")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
    expect(await db.sumBundleBytesByOwner(me.id)).toBe(0);
  });

  it("past the cap, the message says more than the cap, names the setting, and what to do", async () => {
    const res = await app.request("/api/agents/dev/unloadable/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await bundleOf(minimalAgentYaml("unloadable"), true)),
    });
    expect(await res.json()).toEqual({
      error: {
        code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
        message:
          "This bundle decompresses to more than 1 MB, the most this server unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Make the agent smaller — leave out the files it does not need when it runs — and push it again; the server's operator can raise BUNDLE_MAX_DECOMPRESSED_MB.",
      },
    });
  });

  // An alias repeats the value its anchor names: a file under the limit
  // could record a configuration a hundred times its size.
  it("an alias, the message names it and says to write the value out", async () => {
    const res = await app.request("/api/agents/dev/unloadable/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(
        await bundleOf(
          minimalAgentYaml("unloadable", ["environment: &env", "  timeout: 60s", "x_copy: *env"]),
        ),
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_CONFIG",
        message:
          "agent.yaml is not valid: YAML aliases are not accepted in agent.yaml: *env repeats the value anchored as &env. Write the value out in full wherever it is used.",
      },
    });
  });

  // agent.yaml is read as YAML 1.2: under %YAML 1.1, the yaml library's
  // !!omap held the event loop 5.4 s for a file of 1 MB.
  it("%YAML 1.1, the message says agent.yaml is read as YAML 1.2 and to remove the line", async () => {
    const res = await app.request("/api/agents/dev/unloadable/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await bundleOf(`%YAML 1.1\n---\n${minimalAgentYaml("unloadable")}`)),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_CONFIG",
        message:
          "agent.yaml is not valid: agent.yaml is read as YAML 1.2: the directive %YAML 1.1 is not accepted. Remove that line.",
      },
    });
  });

  // The library resolves !!omap in a YAML 1.2 document too, and its check of
  // the entries held the event loop 5 s for a file of 1 MB.
  it("!!omap, the message names the tag and says to write a mapping", async () => {
    const res = await app.request("/api/agents/dev/unloadable/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await bundleOf(minimalAgentYaml("unloadable", OMAP_TOOL))),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_CONFIG",
        message:
          "agent.yaml is not valid: The YAML tag !!omap is not accepted in agent.yaml. Remove it, and write the entries as a mapping.",
      },
    });
  });
});

// agent.yaml holds the agent's configuration: past 128 KB — a fixed limit, no
// setting — the push is refused, the file never parsed, nothing stored.
describe("push — an agent.yaml past 128 KB is refused 413 CONFIG_TOO_LARGE", () => {
  /** The limit: 128 KB. */
  const LIMIT = 128 * 1024;
  const devAuth = { Authorization: "Bearer dev-token" };
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", undefined); // the default cap, 50 MB
    db = new MemoryDb();
    storage = new MemoryStorage();
    app = createApp(storage, db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function push(agentYaml: string): Promise<Response> {
    return app.request("/api/agents/dev/wordy/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("wordy", agentYaml)),
    });
  }

  it("at 128 KB, stored", async () => {
    const res = await push(agentYamlOfSize(LIMIT, minimalAgentYaml("wordy")));
    expect(res.status).toBe(200);
    expect(await storage.list("dev/")).toEqual(["dev/wordy/1.0.0.agent"]);
  });

  it("one byte more: its size, the limit, where long content goes — no agent, no object", async () => {
    const res = await push(agentYamlOfSize(LIMIT + 1, minimalAgentYaml("wordy")));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: "CONFIG_TOO_LARGE",
        message:
          "This bundle's agent.yaml is 131,073 B, more than the 128 KB (131,072 B) an agent.yaml may weigh. agent.yaml holds the agent's configuration: put long content — instructions, context, data — in SKILL.md, AGENTS.md or other files of the bundle, and push it again.",
      },
    });
    expect(await db.getAgent("dev", "wordy")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
  });

  it("past 128 KB and not YAML: refused for its size, never parsed", async () => {
    const res = await push(agentYamlOfSize(LIMIT + 1, "name: [unclosed"));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIG_TOO_LARGE");
  });
});
