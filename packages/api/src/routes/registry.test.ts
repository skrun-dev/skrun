import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import type { VerificationPolicy } from "../services/verification-policy.js";
import { MemoryStorage } from "../storage/memory.js";

// Capture logger.info calls so we can assert the structured-log shape emitted
// by the per-version verify route (AC-9). vi.mock is hoisted to the top of
// the file; vi.hoisted lets the spy be declared in lock-step so it's defined
// when the mock factory runs. We replace only `createLogger`; the rest of
// @skrun-dev/runtime is left intact.
const { logInfoSpy } = vi.hoisted(() => ({ logInfoSpy: vi.fn() }));
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
      child: () => ({ info: logInfoSpy }),
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
  const bundle = Buffer.from("fake-agent-bundle-content");

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
    const v2 = Buffer.from("v2-content");
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
  // sees only their own agents. Two sk_live_* users prove the filter
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
      body: Buffer.from("v2"),
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
    await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
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
    expect(((await toPublic.json()) as { error: { code: string } }).error.code).toBe(
      "PUBLIC_VISIBILITY_DISABLED",
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
      await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from("fake-bundle"),
      });
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

  function push(key: string, ns: string, name: string, version = "1.0.0") {
    return app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
  }

  /** Account-key push that creates the agent; returns its db id. */
  async function createAgent(ownerKey: string, ns: string, name: string): Promise<string> {
    await push(ownerKey, ns, name);
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
      await app.request(`/api/agents/alice/${n}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acct.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from("fake-bundle"),
      });
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
