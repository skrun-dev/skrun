import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDb } from "./sqlite.js";

/**
 * SqliteDb now enforces FKs (CODE-110). Tests that pass literal user IDs like
 * "user-1" / "u" / "u-1" to createAgent / createApiKey / createRun would
 * otherwise fail FK validation. Seed the referenced parents up-front so test
 * data stays referentially valid. Bypasses createUser() (which mints its own
 * UUID) via a raw INSERT.
 */
const TEST_USER_IDS = ["u", "u1", "u2", "u-1", "u-2", "user-1", "user-A", "user-B", "test-user"];

type RawDb = {
  prepare: (sql: string) => { run: (...a: unknown[]) => void };
  exec: (sql: string) => void;
};

function rawDb(db: SqliteDb): RawDb {
  return (db as unknown as { db: RawDb }).db;
}

/**
 * Seeds the users that test fixtures reference as `owner_id` / `user_id`. User
 * rows don't participate in any aggregate the tests assert on, so seeding
 * them globally is safe.
 */
function seedTestUsers(db: SqliteDb): void {
  const stmt = rawDb(db).prepare(
    "INSERT INTO users (id, github_id, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const id of TEST_USER_IDS) {
    stmt.run(id, `gh-${id}`, id, now, now);
  }
}

/**
 * Seeds a single agent row with a known id — used by tests that pass an
 * `agent_id` literal to `createRun` and need the FK to resolve. Per-test
 * opt-in (not global) so aggregation tests are not contaminated.
 */
function seedTestAgent(db: SqliteDb, id: string, ownerId = "u"): void {
  const now = new Date().toISOString();
  rawDb(db)
    .prepare(
      "INSERT INTO agents (id, name, namespace, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, `agent-${id}`, "test-ns", ownerId, now, now);
}

describe("SqliteDb", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new SqliteDb(":memory:");
    seedTestUsers(db);
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

      const page1 = await db.listAgents({ page: 1, limit: 2 });
      expect(page1.agents).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await db.listAgents({ page: 2, limit: 2 });
      expect(page2.agents).toHaveLength(1);
    });

    // VT-2 (#80): listAgents multi-tenant — userId filter isolates rows (SQLite impl)
    it("VT-2: listAgents — userId filter narrows via WHERE owner_id = ? clause", async () => {
      await db.createAgent({ name: "a1", namespace: "userA", description: "", owner_id: "user-A" });
      await db.createAgent({ name: "a2", namespace: "userA", description: "", owner_id: "user-A" });
      await db.createAgent({ name: "b1", namespace: "userB", description: "", owner_id: "user-B" });

      const listA = await db.listAgents({ page: 1, limit: 20, userId: "user-A" });
      expect(listA.agents).toHaveLength(2);
      expect(listA.total).toBe(2);
      expect(listA.agents.every((a) => a.owner_id === "user-A")).toBe(true);

      const listB = await db.listAgents({ page: 1, limit: 20, userId: "user-B" });
      expect(listB.agents).toHaveLength(1);
      expect(listB.total).toBe(1);
      expect(listB.agents[0].owner_id).toBe("user-B");

      // No userId → instance-wide (admin / dev-token)
      const listAll = await db.listAgents({ page: 1, limit: 20 });
      expect(listAll.total).toBe(3);
    });

    // VT-9b (#80): listAgents multi-page accuracy with userId filter — SQLite
    it("VT-9b: listAgents — multi-page filtered total (25 owned by A + 5 by B, page 2 of A)", async () => {
      for (let i = 0; i < 25; i++) {
        await db.createAgent({
          name: `a${i.toString().padStart(2, "0")}`,
          namespace: "userA",
          description: "",
          owner_id: "user-A",
        });
      }
      for (let i = 0; i < 5; i++) {
        await db.createAgent({
          name: `b${i}`,
          namespace: "userB",
          description: "",
          owner_id: "user-B",
        });
      }

      const page1 = await db.listAgents({ page: 1, limit: 20, userId: "user-A" });
      expect(page1.agents).toHaveLength(20);
      expect(page1.total).toBe(25); // filtered COUNT(*), not global 30

      const page2 = await db.listAgents({ page: 2, limit: 20, userId: "user-A" });
      expect(page2.agents).toHaveLength(5);
      expect(page2.total).toBe(25);
      expect(page2.agents.every((a) => a.owner_id === "user-A")).toBe(true);
    });

    it("should set per-version verified flag", async () => {
      const agent = await db.createAgent({
        name: "test",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 0, bundle_key: "k" });

      const updated = await db.setVersionVerified("ns", "test", "1.0.0", true);
      expect(updated?.verified).toBe(true);

      const found = await db.getVersionByNumber(agent.id, "1.0.0");
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

      const { agents } = await db.listAgents({ page: 1, limit: 10 });
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

    // VT-2 (#77): deleteVersion happy path — sqlite impl
    it("deleteVersion removes exactly one row from agent_versions", async () => {
      const agent = await db.createAgent({
        name: "del-v",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
      await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

      const before = (await db.getVersions(agent.id)).length;
      expect(before).toBe(2);

      await db.deleteVersion(agent.id, "1.0.0");

      const remaining = await db.getVersions(agent.id);
      expect(remaining).toHaveLength(before - 1);
      expect(remaining[0].version).toBe("2.0.0");
      // VERSION_NOT_FOUND lookup still works after delete
      expect(await db.getVersionByNumber(agent.id, "1.0.0")).toBeNull();
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

  // ── Cache cost-savings ([005-cache-cost-savings-dashboard]) ──────────

  describe("cache cost-savings", () => {
    beforeEach(() => {
      // Tests below reference agent_id "agent-A" / "ag1" — seed those rows so
      // the run.agent_id FK resolves.
      seedTestAgent(db, "agent-A");
      seedTestAgent(db, "ag1");
    });

    it("RT-5 sqlite: round-trip preserves all 3 cache fields via update→get", async () => {
      await db.createRun({
        id: "r-rt-sqlite",
        agent_id: "agent-A",
        agent_version: "1.0.0",
        status: "running",
      });
      await db.updateRun("r-rt-sqlite", {
        status: "completed",
        usage_cache_read_tokens: 7143,
        usage_cache_write_tokens: 0,
        usage_cache_savings_usd: 0.000964,
      });
      const run = await db.getRun("r-rt-sqlite");
      expect(run?.usage_cache_read_tokens).toBe(7143);
      expect(run?.usage_cache_write_tokens).toBe(0);
      // SQLite stores REAL as IEEE 754 double — use toBeCloseTo for safety
      expect(run?.usage_cache_savings_usd).toBeCloseTo(0.000964, 6);
    });

    it("createRun initializes cache fields to 0 (DEFAULT)", async () => {
      await db.createRun({
        id: "r-default",
        agent_id: "agent-A",
        agent_version: "1.0.0",
        status: "running",
      });
      const run = await db.getRun("r-default");
      expect(run?.usage_cache_read_tokens).toBe(0);
      expect(run?.usage_cache_write_tokens).toBe(0);
      expect(run?.usage_cache_savings_usd).toBe(0);
    });

    it("VT-7 sqlite: multi-tenant userId filter isolates getStats aggregates", async () => {
      // User A: 2 runs × $0.42, User B: 3 runs × $1.00 (all today)
      for (let i = 0; i < 2; i++) {
        const id = `a${i}`;
        await db.createRun({
          id,
          agent_id: "ag1",
          agent_version: "1.0.0",
          user_id: "user-A",
          status: "running",
        });
        await db.updateRun(id, { usage_cache_savings_usd: 0.42 });
      }
      for (let i = 0; i < 3; i++) {
        const id = `b${i}`;
        await db.createRun({
          id,
          agent_id: "ag1",
          agent_version: "1.0.0",
          user_id: "user-B",
          status: "running",
        });
        await db.updateRun(id, { usage_cache_savings_usd: 1.0 });
      }

      const statsA = await db.getStats({ userId: "user-A" });
      expect(statsA.cache_savings_today).toBeCloseTo(0.84, 6);

      const statsB = await db.getStats({ userId: "user-B" });
      expect(statsB.cache_savings_today).toBeCloseTo(3.0, 6);

      // No filter — instance-wide
      const statsAll = await db.getStats();
      expect(statsAll.cache_savings_today).toBeCloseTo(3.84, 6);
    });

    it("getAgentStats: daily_cache_savings.length matches days param", async () => {
      await db.createRun({
        id: "r-days",
        agent_id: "agent-A",
        agent_version: "1.0.0",
        status: "running",
      });
      await db.updateRun("r-days", { usage_cache_savings_usd: 0.5 });

      const stats7 = await db.getAgentStats("agent-A", 7);
      expect(stats7.daily_cache_savings).toHaveLength(7);
      expect(stats7.cache_savings).toBeCloseTo(0.5, 6);

      const stats30 = await db.getAgentStats("agent-A", 30);
      expect(stats30.daily_cache_savings).toHaveLength(30);
      expect(stats30.cache_savings).toBeCloseTo(0.5, 6);
    });
  });
});

// ── Migrations (file-backed so we can close + reopen) ───────────────

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SqliteDb migrations", () => {
  // Unique path per test run avoids EPERM from the WAL file lingering on
  // Windows when consecutive runs reuse the same name.
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `skrun-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = dbPath + ext;
      if (existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore EPERM on Windows when the DB handle hasn't released yet
        }
      }
    }
  });

  it("ALTER TABLE for notes column is idempotent across reopens", async () => {
    // First open — creates schema with notes column via CREATE TABLE.
    const db1 = new SqliteDb(dbPath);
    seedTestUsers(db1);
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

  it("VT-1: migration 004 (cache columns) is idempotent across reopens", async () => {
    // First open — fresh DB; SCHEMA already has the 3 cache columns from
    // migration 004 baked in, AND migrate() PRAGMA hasColumn() check finds
    // them already present so the ALTER blocks short-circuit (no-op).
    const db1 = new SqliteDb(dbPath);
    seedTestUsers(db1);
    seedTestAgent(db1, "a");
    await db1.createRun({
      id: "r-mig",
      agent_id: "a",
      agent_version: "1.0.0",
      status: "running",
    });
    await db1.updateRun("r-mig", { usage_cache_savings_usd: 0.123456 });
    db1.close();

    // Reopen — migrate() should detect all 3 columns exist and skip ALL
    // ALTER blocks. No error, data preserved.
    const db2 = new SqliteDb(dbPath);
    const run = await db2.getRun("r-mig");
    expect(run?.usage_cache_savings_usd).toBeCloseTo(0.123456, 6);

    // Third open — same idempotency check.
    db2.close();
    const db3 = new SqliteDb(dbPath);
    const run3 = await db3.getRun("r-mig");
    expect(run3?.usage_cache_savings_usd).toBeCloseTo(0.123456, 6);
    db3.close();
  });
});

// SqliteDb FK migration (CODE-110, audit/001 task 3.1) ────────────────────────
describe("SqliteDb FOREIGN KEY migration (CODE-110)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `skrun-fk-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = dbPath + ext;
      if (existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore EPERM on Windows
        }
      }
    }
  });

  it("VT-17: fresh DB has FK declarations on agent_versions, agents, api_keys, environments, runs", () => {
    const db = new SqliteDb(dbPath);
    try {
      const inner = (db as unknown as { db: { pragma: (s: string) => unknown[] } }).db;
      expect(
        (inner.pragma("foreign_key_list(agent_versions)") as unknown[]).length,
      ).toBeGreaterThan(0);
      expect((inner.pragma("foreign_key_list(agents)") as unknown[]).length).toBeGreaterThan(0);
      expect((inner.pragma("foreign_key_list(api_keys)") as unknown[]).length).toBeGreaterThan(0);
      expect((inner.pragma("foreign_key_list(environments)") as unknown[]).length).toBeGreaterThan(
        0,
      );
      // runs has 3 FKs: agent_id, environment_id, user_id
      expect((inner.pragma("foreign_key_list(runs)") as unknown[]).length).toBe(3);
    } finally {
      db.close();
    }
  });

  it("VT-18: cascade delete propagates from agents to agent_versions", async () => {
    const db = new SqliteDb(dbPath);
    try {
      seedTestUsers(db);
      const agent = await db.createAgent({
        name: "cascade-target",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 10, bundle_key: "k1" });
      await db.createVersion(agent.id, { version: "1.0.1", size: 10, bundle_key: "k2" });
      await db.createVersion(agent.id, { version: "1.0.2", size: 10, bundle_key: "k3" });

      const inner = (
        db as unknown as {
          db: { prepare: (s: string) => { get: (...a: unknown[]) => { n: number } } };
        }
      ).db;
      const stmt = inner.prepare("SELECT COUNT(*) AS n FROM agent_versions WHERE agent_id = ?");
      expect(stmt.get(agent.id).n).toBe(3);

      // Delete the agent via the raw connection so we bypass any DELETE-cascade
      // workaround in deleteAgent and exercise the SQL FK ON DELETE CASCADE
      // declaration directly. (deleteAgent may issue its own DELETE FROM
      // agent_versions before deleting the parent; that would mask whether
      // the FK cascade actually works.)
      (db as unknown as { db: { prepare: (s: string) => { run: (a: string) => void } } }).db
        .prepare("DELETE FROM agents WHERE id = ?")
        .run(agent.id);
      expect(stmt.get(agent.id).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("VT-17b: orphan pre-check fails loud when a pre-FK DB has dangling refs", () => {
    // Build a pre-migration DB by hand (no FKs declared), insert an orphan row,
    // then re-open via SqliteDb to trigger migrateForeignKeys().
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = OFF");
    raw.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(namespace, name));`,
    );
    const now = new Date().toISOString();
    // No user row, but agent references owner_id "ghost-user" → orphan
    raw
      .prepare(
        "INSERT INTO agents (id, name, namespace, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("orphan-agent", "orphan", "ns", "ghost-user", now, now);
    raw.close();

    // Re-open via SqliteDb — migration should detect orphan and throw.
    expect(() => new SqliteDb(dbPath)).toThrow(/orphan rows found.*before upgrading/);
  });

  // VT-19 (CODE-111)
  it("VT-19: agent_versions enforces UNIQUE(agent_id, version)", async () => {
    const db = new SqliteDb(dbPath);
    try {
      seedTestUsers(db);
      const agent = await db.createAgent({
        name: "uniq",
        namespace: "ns",
        description: "",
        owner_id: "u",
      });
      await db.createVersion(agent.id, { version: "1.0.0", size: 10, bundle_key: "k1" });
      await expect(
        db.createVersion(agent.id, { version: "1.0.0", size: 20, bundle_key: "k2" }),
      ).rejects.toThrow(/UNIQUE|constraint/i);
    } finally {
      db.close();
    }
  });

  it("VT-19b: UNIQUE migration on existing DB fails loud when duplicates exist", () => {
    // Build a pre-UNIQUE DB by hand (no UNIQUE on agent_versions) with two
    // identical (agent_id, version) rows, then re-open via SqliteDb.
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = OFF");
    const now = new Date().toISOString();
    raw.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(namespace, name));
       CREATE TABLE agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, version TEXT NOT NULL, size INTEGER NOT NULL, bundle_key TEXT NOT NULL, config_snapshot TEXT, notes TEXT, pushed_at TEXT NOT NULL);`,
    );
    raw
      .prepare(
        "INSERT INTO users (id, github_id, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("u-dup", "gh-u-dup", "u-dup", now, now);
    raw
      .prepare(
        "INSERT INTO agents (id, name, namespace, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("agt-dup", "dup", "ns", "u-dup", now, now);
    raw
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, version, size, bundle_key, pushed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("v-1", "agt-dup", "1.0.0", 10, "k1", now);
    raw
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, version, size, bundle_key, pushed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("v-2", "agt-dup", "1.0.0", 20, "k2", now);
    raw.close();

    expect(() => new SqliteDb(dbPath)).toThrow(/duplicate.*rows found.*Dedupe/);
  });

  // VT-16: role column added on first upgrade + agents.verified column
  // dropped after migration 009. Build a pre-007 DB by hand with a
  // verified=true row, open through SqliteDb (which runs 007 reset then 009
  // drop), and assert (a) role column exists with default 'user', and (b)
  // the agents.verified column was dropped (post-009 end state). The 007
  // reset happened transiently between 007 and 009 — the only observable
  // outcome is the column's absence.
  it("VT-16: migration 007 + 009 — adds users.role, drops agents.verified", () => {
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = OFF");
    raw.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(namespace, name));
       CREATE TABLE agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, version TEXT NOT NULL, size INTEGER NOT NULL, bundle_key TEXT NOT NULL, config_snapshot TEXT, notes TEXT, pushed_at TEXT NOT NULL, UNIQUE(agent_id, version));`,
    );
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO users (id, github_id, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("legacy-u", "gh-legacy", "legacy", now, now);
    raw
      .prepare(
        "INSERT INTO agents (id, name, namespace, owner_id, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("agt-pre-007", "self-verified", "ns", "legacy-u", 1, now, now);
    raw.close();

    const db = new SqliteDb(dbPath);
    try {
      // role column was added with default 'user'
      const userRow = (
        db as unknown as {
          db: {
            prepare: (s: string) => { get: (a: string) => { role: string } };
          };
        }
      ).db
        .prepare("SELECT role FROM users WHERE id = ?")
        .get("legacy-u");
      expect(userRow.role).toBe("user");

      // Migration 009 dropped agents.verified — column should no longer exist.
      const cols = (
        db as unknown as {
          db: {
            pragma: (s: string) => Array<{ name: string }>;
          };
        }
      ).db.pragma("table_info(agents)");
      const hasVerifiedCol = cols.some((c) => c.name === "verified");
      expect(hasVerifiedCol).toBe(false);
    } finally {
      db.close();
    }
  });

  it("idempotency: migrate is a no-op on a second open", () => {
    const db1 = new SqliteDb(dbPath);
    const inner1 = (db1 as unknown as { db: { pragma: (s: string) => unknown[] } }).db;
    const fkCountBefore = (inner1.pragma("foreign_key_list(runs)") as unknown[]).length;
    db1.close();

    const db2 = new SqliteDb(dbPath);
    const inner2 = (db2 as unknown as { db: { pragma: (s: string) => unknown[] } }).db;
    const fkCountAfter = (inner2.pragma("foreign_key_list(runs)") as unknown[]).length;
    db2.close();

    expect(fkCountAfter).toBe(fkCountBefore);
  });
});
