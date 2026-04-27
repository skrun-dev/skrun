import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDb } from "./sqlite.js";

describe("SqliteDb", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new SqliteDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ── Agents ──────────────────────────────────────────────────────────

  describe("Agents", () => {
    it("should create and get an agent", async () => {
      const agent = await db.createAgent({
        name: "seo-audit",
        namespace: "acme",
        description: "SEO audit agent",
        owner_id: "user-1",
      });
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe("seo-audit");
      expect(agent.verified).toBe(false);

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

    it("should set verified flag", async () => {
      const agent = await db.createAgent({
        name: "test",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      expect(agent.verified).toBe(false);

      const updated = await db.setVerified("ns", "test", true);
      expect(updated?.verified).toBe(true);

      const found = await db.getAgent("ns", "test");
      expect(found?.verified).toBe(true);
    });

    it("should delete agent and its versions", async () => {
      const agent = await db.createAgent({
        name: "del",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, {
        version: "1.0.0",
        size: 100,
        bundle_key: "k",
      });

      expect(await db.deleteAgent("ns", "del")).toBe(true);
      expect(await db.getAgent("ns", "del")).toBeNull();
      expect(await db.getVersions(agent.id)).toHaveLength(0);
    });

    it("should return run_count and token_count in listAgents", async () => {
      const agent = await db.createAgent({
        name: "counted",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createRun({
        id: "r1",
        agent_id: agent.id,
        agent_version: "ns/counted@1.0.0",
        status: "completed",
      });
      await db.createRun({
        id: "r2",
        agent_id: agent.id,
        agent_version: "ns/counted@1.0.0",
        status: "completed",
      });
      // Add some tokens
      await db.updateRun("r1", { usage_total_tokens: 100 });
      await db.updateRun("r2", { usage_total_tokens: 200 });

      const { agents } = await db.listAgents(1, 10);
      const a = agents.find((x) => x.name === "counted");
      expect(a?.run_count).toBe(2);
      expect(a?.token_count).toBe(300);
    });
  });

  // ── Versions ────────────────────────────────────────────────────────

  describe("Versions", () => {
    it("should create and list versions", async () => {
      const agent = await db.createAgent({
        name: "v",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
      await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

      const versions = await db.getVersions(agent.id);
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe("1.0.0");
      expect(versions[1].version).toBe("2.0.0");
    });

    it("should get latest version", async () => {
      const agent = await db.createAgent({
        name: "v",
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
        name: "v",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });

      expect((await db.getVersionByNumber(agent.id, "1.0.0"))?.size).toBe(100);
      expect(await db.getVersionByNumber(agent.id, "9.9.9")).toBeNull();
    });

    it("should round-trip config_snapshot as JSON", async () => {
      const agent = await db.createAgent({
        name: "cfg",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      const snapshot = {
        model: { provider: "google", name: "gemini-2.5-flash" },
        inputs: [{ name: "q", type: "string" }],
      };
      await db.createVersion(agent.id, {
        version: "1.0.0",
        size: 100,
        bundle_key: "k",
        config_snapshot: snapshot,
      });

      const v = await db.getLatestVersion(agent.id);
      expect(v?.config_snapshot).toEqual(snapshot);
    });

    it("should store notes and default to null when absent", async () => {
      const agent = await db.createAgent({
        name: "notes-test",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, {
        version: "1.0.0",
        size: 100,
        bundle_key: "k1",
        notes: "Added retry logic",
      });
      await db.createVersion(agent.id, {
        version: "2.0.0",
        size: 200,
        bundle_key: "k2",
      });

      const versions = await db.getVersions(agent.id);
      expect(versions[0].notes).toBe("Added retry logic");
      expect(versions[1].notes).toBeNull();
    });

    it("should round-trip notes with emoji and multibyte UTF-8", async () => {
      const agent = await db.createAgent({
        name: "emoji",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      const note = "🚀 Amélioration 日本語";
      await db.createVersion(agent.id, {
        version: "1.0.0",
        size: 100,
        bundle_key: "k",
        notes: note,
      });
      const v = await db.getLatestVersion(agent.id);
      expect(v?.notes).toBe(note);
    });
  });

  // ── State ───────────────────────────────────────────────────────────

  describe("State", () => {
    it("should set, get, and delete state", async () => {
      expect(await db.getState("agent-1")).toBeNull();

      await db.setState("agent-1", { score: 85 });
      expect(await db.getState("agent-1")).toEqual({ score: 85 });

      await db.setState("agent-1", { score: 90, prev: 85 });
      expect(await db.getState("agent-1")).toEqual({ score: 90, prev: 85 });

      await db.deleteState("agent-1");
      expect(await db.getState("agent-1")).toBeNull();
    });
  });

  // ── Users ───────────────────────────────────────────────────────────

  describe("Users", () => {
    it("should create and get user by ID and GitHub ID", async () => {
      const user = await db.createUser({
        github_id: "gh-123",
        username: "alice",
        email: "alice@test.com",
        avatar_url: "https://img.test/a.png",
      });
      expect(user.id).toBeTruthy();
      expect(user.plan).toBe("free");

      const byId = await db.getUserById(user.id);
      expect(byId?.username).toBe("alice");

      const byGh = await db.getUserByGithubId("gh-123");
      expect(byGh?.id).toBe(user.id);
    });

    it("should return null for missing user", async () => {
      expect(await db.getUserById("nope")).toBeNull();
      expect(await db.getUserByGithubId("nope")).toBeNull();
    });

    it("should update user fields", async () => {
      const user = await db.createUser({ github_id: "gh-1", username: "bob" });
      const updated = await db.updateUser(user.id, { email: "bob@new.com", plan: "pro" });
      expect(updated?.email).toBe("bob@new.com");
      expect(updated?.plan).toBe("pro");
    });
  });

  // ── API Keys ────────────────────────────────────────────────────────

  describe("API Keys", () => {
    it("should create, find by hash, list, and delete", async () => {
      const user = await db.createUser({ github_id: "gh-1", username: "u" });
      const key = await db.createApiKey({
        user_id: user.id,
        key_hash: "hash-abc",
        key_prefix: "sk_live_abc",
        name: "test key",
        scopes: ["read", "write"],
      });
      expect(key.id).toBeTruthy();
      expect(key.scopes).toEqual(["read", "write"]);

      const found = await db.getApiKeyByHash("hash-abc");
      expect(found?.id).toBe(key.id);
      expect(found?.scopes).toEqual(["read", "write"]);

      const list = await db.listApiKeys(user.id);
      expect(list).toHaveLength(1);

      expect(await db.deleteApiKey(key.id)).toBe(true);
      expect(await db.listApiKeys(user.id)).toHaveLength(0);
    });

    it("should delete by owner only", async () => {
      const u1 = await db.createUser({ github_id: "g1", username: "u1" });
      const u2 = await db.createUser({ github_id: "g2", username: "u2" });
      const key = await db.createApiKey({
        user_id: u1.id,
        key_hash: "h1",
        key_prefix: "sk_",
        name: "k",
      });

      expect(await db.deleteApiKeyByOwner(key.id, u2.id)).toBe(false);
      expect(await db.deleteApiKeyByOwner(key.id, u1.id)).toBe(true);
    });

    it("should update last_used_at", async () => {
      const user = await db.createUser({ github_id: "gh-1", username: "u" });
      const key = await db.createApiKey({
        user_id: user.id,
        key_hash: "h",
        key_prefix: "sk_",
        name: "k",
      });
      expect(key.last_used_at).toBeNull();

      await db.updateApiKeyLastUsed(key.id);
      const updated = await db.getApiKeyByHash("h");
      expect(updated?.last_used_at).toBeTruthy();
    });
  });

  // ── Runs ────────────────────────────────────────────────────────────

  describe("Runs", () => {
    it("should create, get, update, and list runs", async () => {
      const agent = await db.createAgent({
        name: "r",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      const run = await db.createRun({
        id: "run-1",
        agent_id: agent.id,
        agent_version: "ns/r@1.0.0",
        model: "google/gemini-2.5-flash",
        status: "running",
        input: { query: "test" },
      });
      expect(run.id).toBe("run-1");
      expect(run.status).toBe("running");
      expect(run.input).toEqual({ query: "test" });

      const updated = await db.updateRun("run-1", {
        status: "completed",
        output: { result: "ok" },
        usage_total_tokens: 500,
        duration_ms: 1234,
        completed_at: new Date().toISOString(),
      });
      expect(updated?.status).toBe("completed");
      expect(updated?.output).toEqual({ result: "ok" });
      expect(updated?.usage_total_tokens).toBe(500);

      const found = await db.getRun("run-1");
      expect(found?.duration_ms).toBe(1234);
    });

    it("should filter runs by agent_id, status, and limit", async () => {
      const a1 = await db.createAgent({
        name: "a1",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      const a2 = await db.createAgent({
        name: "a2",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });

      await db.createRun({ id: "r1", agent_id: a1.id, agent_version: "v", status: "completed" });
      await db.createRun({ id: "r2", agent_id: a1.id, agent_version: "v", status: "failed" });
      await db.createRun({ id: "r3", agent_id: a2.id, agent_version: "v", status: "completed" });

      const byAgent = await db.listRuns({ agent_id: a1.id });
      expect(byAgent).toHaveLength(2);

      const byStatus = await db.listRuns({ status: "failed" });
      expect(byStatus).toHaveLength(1);

      const limited = await db.listRuns({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("should round-trip JSON columns (input, output, files)", async () => {
      const input = { nested: { data: [1, 2, 3] } };
      const output = { items: ["a", "b"] };
      const files = [{ name: "report.pdf", size: 1024 }];

      await db.createRun({
        id: "json-run",
        agent_id: null,
        agent_version: "v",
        status: "running",
        input,
      });
      await db.updateRun("json-run", { output, files });

      const run = await db.getRun("json-run");
      expect(run?.input).toEqual(input);
      expect(run?.output).toEqual(output);
      expect(run?.files).toEqual(files);
    });
  });

  // ── Environments ────────────────────────────────────────────────────

  describe("Environments", () => {
    it("should create, get, and list environments", async () => {
      const env = await db.createEnvironment({
        name: "prod",
        owner_id: "u1",
        config: { timeout: 30, networking: { allowed_hosts: ["*"] } },
      });
      expect(env.id).toBeTruthy();

      const found = await db.getEnvironment(env.id);
      expect(found?.name).toBe("prod");
      expect(found?.config).toEqual({ timeout: 30, networking: { allowed_hosts: ["*"] } });

      const list = await db.listEnvironments("u1");
      expect(list).toHaveLength(1);

      const empty = await db.listEnvironments("other");
      expect(empty).toHaveLength(0);
    });
  });

  // ── Stats ───────────────────────────────────────────────────────────

  describe("Stats", () => {
    it("should return correct getStats aggregation", async () => {
      const agent = await db.createAgent({
        name: "s",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });

      // Create runs "today"
      await db.createRun({ id: "t1", agent_id: agent.id, agent_version: "v", status: "completed" });
      await db.createRun({ id: "t2", agent_id: agent.id, agent_version: "v", status: "failed" });
      await db.updateRun("t1", { usage_total_tokens: 100 });
      await db.updateRun("t2", { usage_total_tokens: 50 });

      const stats = await db.getStats();
      expect(stats.agents_count).toBe(1);
      expect(stats.runs_today).toBe(2);
      expect(stats.tokens_today).toBe(150);
      expect(stats.failed_today).toBe(1);
      expect(stats.daily_runs).toHaveLength(7);
      expect(stats.daily_tokens).toHaveLength(7);
      expect(stats.daily_failed).toHaveLength(7);
    });

    it("should return correct getAgentStats aggregation", async () => {
      const agent = await db.createAgent({
        name: "as",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });

      await db.createRun({
        id: "as1",
        agent_id: agent.id,
        agent_version: "v",
        status: "completed",
      });
      await db.updateRun("as1", { usage_total_tokens: 200, duration_ms: 1000 });

      const stats = await db.getAgentStats(agent.id);
      expect(stats.runs).toBe(1);
      expect(stats.tokens).toBe(200);
      expect(stats.failed).toBe(0);
      expect(stats.avg_duration_ms).toBe(1000);
      expect(stats.daily_runs).toHaveLength(7);
      expect(stats.daily_tokens).toHaveLength(7);
      expect(stats.daily_failed).toHaveLength(7);
      expect(stats.daily_avg_duration_ms).toHaveLength(7);
    });
  });
});

// ── Migrations (file-backed so we can close + reopen) ───────────────

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SqliteDb migrations", () => {
  const dbPath = join(tmpdir(), `skrun-migrate-test-${Date.now()}.db`);

  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("ALTER TABLE for notes column is idempotent across reopens", async () => {
    // First open — creates schema with notes column via CREATE TABLE.
    const db1 = new SqliteDb(dbPath);
    const agent = await db1.createAgent({
      name: "m",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    await db1.createVersion(agent.id, {
      version: "1.0.0",
      size: 10,
      bundle_key: "k",
      notes: "before close",
    });
    db1.close();

    // Reopen — migrate() should be a no-op (column already exists), no error.
    const db2 = new SqliteDb(dbPath);
    const v = await db2.getLatestVersion(agent.id);
    expect(v?.notes).toBe("before close");

    // Third open just to be sure migration stays idempotent.
    db2.close();
    const db3 = new SqliteDb(dbPath);
    const v2 = await db3.getLatestVersion(agent.id);
    expect(v2?.notes).toBe("before close");
    db3.close();
  });
});
