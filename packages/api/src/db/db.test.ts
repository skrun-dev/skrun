import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "./memory.js";

describe("MemoryDb", () => {
  let db: MemoryDb;

  beforeEach(() => {
    db = new MemoryDb();
  });

  // --- Agents (existing tests, updated to async) ---

  it("should create and get an agent", async () => {
    const agent = await db.createAgent({
      name: "seo-audit",
      namespace: "acme",
      description: "SEO audit agent",
      owner_id: "user-1",
    });
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("seo-audit");

    const found = await db.getAgent("acme", "seo-audit");
    expect(found?.id).toBe(agent.id);
  });

  it("should return null for missing agent", async () => {
    expect(await db.getAgent("x", "y")).toBeNull();
  });

  it("should list agents with pagination", async () => {
    await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: "u" });
    await db.createAgent({ name: "b", namespace: "ns", description: "", owner_id: "u" });
    await db.createAgent({ name: "c", namespace: "ns", description: "", owner_id: "u" });

    const page1 = await db.listAgents(1, 2);
    expect(page1.agents).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await db.listAgents(2, 2);
    expect(page2.agents).toHaveLength(1);
  });

  it("should create and get versions", async () => {
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 100,
      bundle_key: "ns/a/1.0.0.agent",
    });
    await db.createVersion(agent.id, {
      version: "1.1.0",
      size: 200,
      bundle_key: "ns/a/1.1.0.agent",
    });

    const versions = await db.getVersions(agent.id);
    expect(versions).toHaveLength(2);
  });

  it("should get latest version", async () => {
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
    await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

    const latest = await db.getLatestVersion(agent.id);
    expect(latest?.version).toBe("2.0.0");
  });

  it("should get version by number", async () => {
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
    await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

    const v = await db.getVersionByNumber(agent.id, "1.0.0");
    expect(v?.size).toBe(100);
    expect(await db.getVersionByNumber(agent.id, "3.0.0")).toBeNull();
  });

  it("should return null for latest version on empty agent", async () => {
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    expect(await db.getLatestVersion(agent.id)).toBeNull();
  });

  it("should set and get verified status", async () => {
    await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: "u" });
    const updated = await db.setVerified("ns", "a", true);
    expect(updated?.verified).toBe(true);

    const agent = await db.getAgent("ns", "a");
    expect(agent?.verified).toBe(true);
  });

  // --- Agent State (VT-2) ---

  describe("state", () => {
    it("should get/set/delete agent state", async () => {
      expect(await db.getState("ns/agent")).toBeNull();

      await db.setState("ns/agent", { score: 75, history: [1, 2] });
      const state = await db.getState("ns/agent");
      expect(state).toEqual({ score: 75, history: [1, 2] });

      await db.deleteState("ns/agent");
      expect(await db.getState("ns/agent")).toBeNull();
    });

    it("should return deep copy (no shared references)", async () => {
      const original = { counter: 1 };
      await db.setState("ns/agent", original);
      const retrieved = await db.getState("ns/agent");
      expect(retrieved).toEqual({ counter: 1 });

      // Mutating original should not affect stored state
      original.counter = 999;
      const again = await db.getState("ns/agent");
      expect(again).toEqual({ counter: 1 });
    });
  });

  // --- Users (VT-5) ---

  describe("users", () => {
    it("should create and find user by github_id", async () => {
      const user = await db.createUser({
        github_id: "gh-123",
        username: "alice",
        email: "alice@example.com",
        avatar_url: "https://github.com/alice.png",
      });
      expect(user.id).toBeTruthy();
      expect(user.plan).toBe("free");

      const found = await db.getUserByGithubId("gh-123");
      expect(found?.username).toBe("alice");
    });

    it("should find user by id", async () => {
      const user = await db.createUser({ github_id: "gh-1", username: "bob" });
      const found = await db.getUserById(user.id);
      expect(found?.username).toBe("bob");
    });

    it("should return null for missing user", async () => {
      expect(await db.getUserByGithubId("nope")).toBeNull();
      expect(await db.getUserById("nope")).toBeNull();
    });

    it("should update user fields", async () => {
      const user = await db.createUser({ github_id: "gh-1", username: "bob" });
      const updated = await db.updateUser(user.id, { plan: "pro", email: "bob@co.com" });
      expect(updated?.plan).toBe("pro");
      expect(updated?.email).toBe("bob@co.com");
    });
  });

  // --- API Keys (VT-6) ---

  describe("api keys", () => {
    it("should create and lookup by hash", async () => {
      const key = await db.createApiKey({
        user_id: "u-1",
        key_hash: "sha256-abc",
        key_prefix: "sk_live_",
        name: "My key",
        scopes: ["run", "push"],
      });
      expect(key.id).toBeTruthy();
      expect(key.scopes).toEqual(["run", "push"]);

      const found = await db.getApiKeyByHash("sha256-abc");
      expect(found?.name).toBe("My key");
    });

    it("should delete key", async () => {
      const key = await db.createApiKey({
        user_id: "u-1",
        key_hash: "hash-1",
        key_prefix: "sk_",
        name: "temp",
      });
      expect(await db.deleteApiKey(key.id)).toBe(true);
      expect(await db.getApiKeyByHash("hash-1")).toBeNull();
      expect(await db.deleteApiKey("nonexistent")).toBe(false);
    });

    it("should list keys by user", async () => {
      await db.createApiKey({ user_id: "u-1", key_hash: "h1", key_prefix: "sk_", name: "key-1" });
      await db.createApiKey({ user_id: "u-1", key_hash: "h2", key_prefix: "sk_", name: "key-2" });
      await db.createApiKey({ user_id: "u-2", key_hash: "h3", key_prefix: "sk_", name: "other" });

      const keys = await db.listApiKeys("u-1");
      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.name).sort()).toEqual(["key-1", "key-2"]);
    });

    it("should delete key only if owned by user", async () => {
      const key = await db.createApiKey({
        user_id: "u-1",
        key_hash: "h-owned",
        key_prefix: "sk_",
        name: "mine",
      });

      // Wrong owner → false
      expect(await db.deleteApiKeyByOwner(key.id, "u-2")).toBe(false);
      expect(await db.getApiKeyByHash("h-owned")).toBeTruthy();

      // Correct owner → true
      expect(await db.deleteApiKeyByOwner(key.id, "u-1")).toBe(true);
      expect(await db.getApiKeyByHash("h-owned")).toBeNull();
    });

    it("should return false for deleteApiKeyByOwner on nonexistent key", async () => {
      expect(await db.deleteApiKeyByOwner("nonexistent", "u-1")).toBe(false);
    });

    it("should update last_used_at", async () => {
      const key = await db.createApiKey({
        user_id: "u-1",
        key_hash: "hash-2",
        key_prefix: "sk_",
        name: "test",
      });
      expect(key.last_used_at).toBeNull();

      await db.updateApiKeyLastUsed(key.id);
      const found = await db.getApiKeyByHash("hash-2");
      expect(found?.last_used_at).toBeTruthy();
    });
  });

  // --- Runs (VT-3, VT-4) ---

  describe("runs", () => {
    it("should create and update a completed run", async () => {
      const run = await db.createRun({
        id: "run-1",
        agent_id: "agent-1",
        agent_version: "1.0.0",
        status: "running",
        input: { url: "https://example.com" },
      });
      expect(run.status).toBe("running");
      expect(run.completed_at).toBeNull();

      const updated = await db.updateRun("run-1", {
        status: "completed",
        output: { score: 85 },
        usage_prompt_tokens: 100,
        usage_completion_tokens: 50,
        usage_total_tokens: 150,
        usage_estimated_cost: 0.001,
        duration_ms: 2500,
        completed_at: new Date().toISOString(),
      });
      expect(updated?.status).toBe("completed");
      expect(updated?.output).toEqual({ score: 85 });
      expect(updated?.duration_ms).toBe(2500);
    });

    it("should create a failed run", async () => {
      await db.createRun({
        id: "run-2",
        agent_id: "agent-1",
        agent_version: "1.0.0",
        status: "running",
      });
      const updated = await db.updateRun("run-2", {
        status: "failed",
        error: "Model not available",
        completed_at: new Date().toISOString(),
      });
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Model not available");
    });

    it("should get and list runs with filters", async () => {
      await db.createRun({ id: "r1", agent_id: "a1", agent_version: "1.0.0", status: "completed" });
      await db.createRun({ id: "r2", agent_id: "a1", agent_version: "1.0.0", status: "failed" });
      await db.createRun({ id: "r3", agent_id: "a2", agent_version: "1.0.0", status: "completed" });

      expect(await db.getRun("r1")).toBeTruthy();
      expect(await db.getRun("nonexistent")).toBeNull();

      const byAgent = await db.listRuns({ agent_id: "a1" });
      expect(byAgent).toHaveLength(2);

      const byStatus = await db.listRuns({ status: "completed" });
      expect(byStatus).toHaveLength(2);

      const limited = await db.listRuns({ limit: 1 });
      expect(limited).toHaveLength(1);
    });
  });

  // --- Environments (VT-7) ---

  describe("environments", () => {
    it("should create and get environment", async () => {
      const env = await db.createEnvironment({
        name: "production",
        owner_id: "u-1",
        config: { networking: { allowed_hosts: ["*"] }, timeout: "600s" },
      });
      expect(env.id).toBeTruthy();

      const found = await db.getEnvironment(env.id);
      expect(found?.name).toBe("production");
      expect(found?.config).toEqual({ networking: { allowed_hosts: ["*"] }, timeout: "600s" });
    });

    it("should list environments by owner", async () => {
      await db.createEnvironment({ name: "dev", owner_id: "u-1", config: {} });
      await db.createEnvironment({ name: "prod", owner_id: "u-1", config: {} });
      await db.createEnvironment({ name: "other", owner_id: "u-2", config: {} });

      const envs = await db.listEnvironments("u-1");
      expect(envs).toHaveLength(2);
    });
  });

  // --- Clear (VT-10 cascade simulation) ---

  describe("clear", () => {
    it("should reset all stores", async () => {
      await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: "u" });
      await db.setState("ns/a", { x: 1 });
      await db.createUser({ github_id: "gh-1", username: "alice" });
      await db.createRun({ id: "r1", agent_id: "a1", agent_version: "1.0.0", status: "running" });
      await db.createEnvironment({ name: "dev", owner_id: "u-1", config: {} });

      db.clear();

      expect(await db.getAgent("ns", "a")).toBeNull();
      expect(await db.getState("ns/a")).toBeNull();
      expect(await db.getUserByGithubId("gh-1")).toBeNull();
      expect(await db.getRun("r1")).toBeNull();
    });
  });
});
