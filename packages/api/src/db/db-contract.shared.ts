/**
 * Shared DbAdapter contract test — single source of truth for behavioral
 * contract across all `DbAdapter` implementations (MemoryDb, SqliteDb,
 * PostgresDb). Each backend test file calls this function with its factory.
 *
 * Created for the Postgres-agnostic DbAdapter work. Mandated
 * by the spec: zero inline assertions duplicating this contract.
 * Backend-specific tests (e.g., SqliteDb FK cascade, SqliteDb migrations,
 * PostgresDb advisory lock) live in their own files, NOT here.
 *
 * Factory contract — `makeDb()` returns a fresh DbAdapter instance with
 * empty tables BUT with the fixture user rows (`fixtureUsers()`) pre-seeded.
 * SqliteDb / PostgresDb enforce FK and need this; MemoryDb doesn't but
 * accepts the same calls as no-ops.
 *
 * UUID-safety: Postgres uuid columns (users.id,
 * agents.owner_id, runs.id, runs.user_id, api_keys.id, environments.owner_id)
 * reject arbitrary strings — so EVERY identifier the contract passes to a uuid
 * column must be a real uuid, including the intentionally-absent ones (the
 * "missing" lookups would otherwise throw `invalid input syntax for type uuid`
 * instead of returning null). `fx(label)` maps a stable label → a stable uuid
 * (create + read agree). Text columns (namespace, name, github_id, key_hash,
 * agent_version, state keys, env names) stay plain strings. This is why the
 * PostgresDb contract never ran green before this (literal `owner_id:"u"` +
 * string run ids errored against uuid columns).
 *
 * Each test gets its own DB via `beforeEach` so tests are isolated.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter.js";

const _fxCache = new Map<string, string>();
/** Stable label → stable uuid, so create + read of the same label agree. */
export function fx(label: string): string {
  let u = _fxCache.get(label);
  if (!u) {
    u = randomUUID();
    _fxCache.set(label, u);
  }
  return u;
}

/** User labels the contract references as FK parents — seeded by each factory. */
export const FIXTURE_USER_LABELS = ["u", "user-1", "user-A", "user-B", "u1", "u2"] as const;

/** Fixture user rows (uuid id + unique github_id/username) for factory seeding. */
export function fixtureUsers(): Array<{ id: string; github_id: string; username: string }> {
  return FIXTURE_USER_LABELS.map((l) => ({
    id: fx(l),
    github_id: `gh-fixture-${l}`,
    username: `fixture-${l}`,
  }));
}

export function runDbContractTests(label: string, makeDb: () => Promise<DbAdapter>): void {
  describe(`DbAdapter contract: ${label}`, () => {
    let db: DbAdapter;
    beforeEach(async () => {
      db = await makeDb();
    });

    // ── Agents ──────────────────────────────────────────────────────────

    describe("agents", () => {
      it("creates and gets an agent", async () => {
        const agent = await db.createAgent({
          name: "seo-audit",
          namespace: "acme",
          description: "SEO audit agent",
          owner_id: fx("user-1"),
        });
        expect(agent.id).toBeTruthy();
        expect(agent.name).toBe("seo-audit");

        const found = await db.getAgent("acme", "seo-audit");
        expect(found?.id).toBe(agent.id);
      });

      it("returns null for missing agent", async () => {
        expect(await db.getAgent("x", "y")).toBeNull();
      });

      it("defaults visibility to private when unspecified", async () => {
        const agent = await db.createAgent({
          name: "vis-default",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
        });
        expect(agent.visibility).toBe("private");
        expect((await db.getAgent("acme", "vis-default"))?.visibility).toBe("private");
      });

      it("honours an explicit public visibility at create", async () => {
        const agent = await db.createAgent({
          name: "vis-public",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
          visibility: "public",
        });
        expect(agent.visibility).toBe("public");
        expect((await db.getAgent("acme", "vis-public"))?.visibility).toBe("public");
      });

      it("setVisibility flips private <-> public", async () => {
        await db.createAgent({
          name: "vis-flip",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
        });
        const toPublic = await db.setVisibility("acme", "vis-flip", "public");
        expect(toPublic?.visibility).toBe("public");
        expect((await db.getAgent("acme", "vis-flip"))?.visibility).toBe("public");
        const toPrivate = await db.setVisibility("acme", "vis-flip", "private");
        expect(toPrivate?.visibility).toBe("private");
      });

      it("setVisibility on a missing agent returns null", async () => {
        expect(await db.setVisibility("acme", "ghost", "public")).toBeNull();
      });

      it("lists agents with pagination", async () => {
        await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: fx("u") });
        await db.createAgent({ name: "b", namespace: "ns", description: "", owner_id: fx("u") });
        await db.createAgent({ name: "c", namespace: "ns", description: "", owner_id: fx("u") });

        const page1 = await db.listAgents({ page: 1, limit: 2 });
        expect(page1.agents).toHaveLength(2);
        expect(page1.total).toBe(3);

        const page2 = await db.listAgents({ page: 2, limit: 2 });
        expect(page2.agents).toHaveLength(1);
      });

      it("listAgents — userId filter narrows to owner's agents only", async () => {
        await db.createAgent({
          name: "a1",
          namespace: "userA",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "a2",
          namespace: "userA",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "b1",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "b2",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "b3",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });

        const listA = await db.listAgents({ page: 1, limit: 20, userId: fx("user-A") });
        expect(listA.agents).toHaveLength(2);
        expect(listA.total).toBe(2);
        expect(listA.agents.every((a) => a.owner_id === fx("user-A"))).toBe(true);

        const listB = await db.listAgents({ page: 1, limit: 20, userId: fx("user-B") });
        expect(listB.agents).toHaveLength(3);
        expect(listB.total).toBe(3);
        expect(listB.agents.every((a) => a.owner_id === fx("user-B"))).toBe(true);

        // No userId → instance-wide (admin / dev-token)
        const listAll = await db.listAgents({ page: 1, limit: 20 });
        expect(listAll.agents).toHaveLength(5);
        expect(listAll.total).toBe(5);
      });

      it("VT-9b: listAgents — userId filter multi-page accuracy (25 + 5 = 30; page 2 of A)", async () => {
        for (let i = 0; i < 25; i++) {
          await db.createAgent({
            name: `a${i.toString().padStart(2, "0")}`,
            namespace: "userA",
            description: "",
            owner_id: fx("user-A"),
          });
        }
        for (let i = 0; i < 5; i++) {
          await db.createAgent({
            name: `b${i}`,
            namespace: "userB",
            description: "",
            owner_id: fx("user-B"),
          });
        }

        const page1 = await db.listAgents({ page: 1, limit: 20, userId: fx("user-A") });
        expect(page1.agents).toHaveLength(20);
        expect(page1.total).toBe(25);

        const page2 = await db.listAgents({ page: 2, limit: 20, userId: fx("user-A") });
        expect(page2.agents).toHaveLength(5);
        expect(page2.total).toBe(25);
        expect(page2.agents.every((a) => a.owner_id === fx("user-A"))).toBe(true);
      });

      it("sets per-version verified flag", async () => {
        const agent = await db.createAgent({
          name: "verif",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 0, bundle_key: "k" });

        const updated = await db.setVersionVerified("ns", "verif", "1.0.0", true);
        expect(updated?.verified).toBe(true);

        const found = await db.getVersionByNumber(agent.id, "1.0.0");
        expect(found?.verified).toBe(true);
      });

      it("deletes agent and cascades to its versions", async () => {
        const agent = await db.createAgent({
          name: "del",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k" });

        expect(await db.deleteAgent("ns", "del")).toBe(true);
        expect(await db.getAgent("ns", "del")).toBeNull();
        expect(await db.getVersions(agent.id)).toHaveLength(0);
      });

      it("returns run_count and token_count in listAgents", async () => {
        const agent = await db.createAgent({
          name: "counted",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("r1"),
          agent_id: agent.id,
          agent_version: "ns/counted@1.0.0",
          status: "completed",
        });
        await db.createRun({
          id: fx("r2"),
          agent_id: agent.id,
          agent_version: "ns/counted@1.0.0",
          status: "completed",
        });
        await db.updateRun(fx("r1"), { usage_total_tokens: 100 });
        await db.updateRun(fx("r2"), { usage_total_tokens: 200 });

        const { agents } = await db.listAgents({ page: 1, limit: 10 });
        const a = agents.find((x) => x.name === "counted");
        expect(a?.run_count).toBe(2);
        expect(a?.token_count).toBe(300);
      });
    });

    // ── Versions ────────────────────────────────────────────────────────

    describe("versions", () => {
      it("creates and lists versions", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
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

      it("gets latest version", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        const latest = await db.getLatestVersion(agent.id);
        expect(latest?.version).toBe("2.0.0");
      });

      it("returns null for latest version on empty agent", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        expect(await db.getLatestVersion(agent.id)).toBeNull();
      });

      it("gets version by number; returns null for missing", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        const v = await db.getVersionByNumber(agent.id, "1.0.0");
        expect(v?.size).toBe(100);
        expect(await db.getVersionByNumber(agent.id, "9.9.9")).toBeNull();
      });

      it("deleteVersion removes the row and preserves listAgents aggregates", async () => {
        const agent = await db.createAgent({
          name: "del-version",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        // Pre-condition: listAgents aggregates capture run_count etc.
        const before = await db.listAgents({ page: 1, limit: 10 });
        const beforeStats = before.agents.find((a) => a.id === agent.id);
        expect(beforeStats).toBeDefined();

        await db.deleteVersion(agent.id, "1.0.0");

        const versions = await db.getVersions(agent.id);
        expect(versions).toHaveLength(1);
        expect(versions[0].version).toBe("2.0.0");

        // run_count / token_count / cost_total are unchanged — they join on
        // `runs`, not `agent_versions`.
        const after = await db.listAgents({ page: 1, limit: 10 });
        const afterStats = after.agents.find((a) => a.id === agent.id);
        expect(afterStats?.run_count).toBe(beforeStats?.run_count);
        expect(afterStats?.token_count).toBe(beforeStats?.token_count);
        expect(afterStats?.cost_total).toBe(beforeStats?.cost_total);
      });

      it("round-trips config_snapshot as structured object", async () => {
        const agent = await db.createAgent({
          name: "cfg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
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

      it("stores notes and defaults to null when absent", async () => {
        const agent = await db.createAgent({
          name: "notes-test",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
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
        // Ordering: implementations may sort by version or pushed_at. Index by version.
        const v1 = versions.find((v) => v.version === "1.0.0");
        const v2 = versions.find((v) => v.version === "2.0.0");
        expect(v1?.notes).toBe("Added retry logic");
        expect(v2?.notes).toBeNull();
      });

      it("round-trips notes with emoji and multibyte UTF-8", async () => {
        const agent = await db.createAgent({
          name: "emoji",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
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

      it("hashes and round-trips bundle_sha256; defaults to null when absent", async () => {
        // createVersion persists the bundle's SHA-256; the column
        // is nullable (legacy/backfill valve), the always-set invariant lives
        // in RegistryService.push(). Runs on all 3 backends incl. PostgresDb
        // in CI.
        const agent = await db.createAgent({
          name: "hashed",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const sha = "a".repeat(64);
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "k1",
          bundle_sha256: sha,
        });
        await db.createVersion(agent.id, {
          version: "2.0.0",
          size: 200,
          bundle_key: "k2",
        });

        const v1 = await db.getVersionByNumber(agent.id, "1.0.0");
        const v2 = await db.getVersionByNumber(agent.id, "2.0.0");
        expect(v1?.bundle_sha256).toBe(sha);
        expect(v2?.bundle_sha256).toBeNull();
      });

      it("listVersionsMissingHash returns only null-hash rows (id + bundle_key)", async () => {
        // The backfill enumerates versions with no stored hash.
        const agent = await db.createAgent({
          name: "missing-hash",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "kn",
        });
        await db.createVersion(agent.id, {
          version: "2.0.0",
          size: 200,
          bundle_key: "kh",
          bundle_sha256: "b".repeat(64),
        });

        const missing = await db.listVersionsMissingHash();
        expect(missing.some((m) => m.bundle_key === "kn")).toBe(true);
        expect(missing.some((m) => m.bundle_key === "kh")).toBe(false);
        for (const m of missing) {
          expect(m.id).toBeTruthy();
          expect(typeof m.bundle_key).toBe("string");
        }

        // setVersionBundleHash (backfill writer) populates the row → it leaves
        // the missing list. Covers all 3 backends incl. PostgresDb in CI.
        const target = missing.find((m) => m.bundle_key === "kn");
        expect(target).toBeDefined();
        if (target) {
          await db.setVersionBundleHash(target.id, "d".repeat(64));
          const after = await db.listVersionsMissingHash();
          expect(after.some((m) => m.bundle_key === "kn")).toBe(false);
          const updated = await db.getVersionByNumber(agent.id, "1.0.0");
          expect(updated?.bundle_sha256).toBe("d".repeat(64));
        }
      });
    });

    // ── Agent State ─────────────────────────────────────────────────────

    describe("state", () => {
      it("get/set/delete agent state", async () => {
        expect(await db.getState("ns/agent")).toBeNull();

        await db.setState("ns/agent", { score: 75, history: [1, 2] });
        const state = await db.getState("ns/agent");
        expect(state).toEqual({ score: 75, history: [1, 2] });

        await db.deleteState("ns/agent");
        expect(await db.getState("ns/agent")).toBeNull();
      });

      it("returns deep copy — mutating the input does not affect stored state", async () => {
        const original = { counter: 1 };
        await db.setState("ns/agent", original);
        const retrieved = await db.getState("ns/agent");
        expect(retrieved).toEqual({ counter: 1 });

        // Mutating the original object should not affect stored state.
        // SqliteDb/PostgresDb satisfy this via JSON serialization (deserialize
        // returns a fresh object). MemoryDb must explicitly structuredClone.
        original.counter = 999;
        const again = await db.getState("ns/agent");
        expect(again).toEqual({ counter: 1 });
      });
    });

    // ── Users ───────────────────────────────────────────────────────────

    describe("users", () => {
      it("creates and finds user by github_id + by id", async () => {
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

      it("returns null for missing user (both lookups)", async () => {
        expect(await db.getUserById(fx("nope"))).toBeNull();
        expect(await db.getUserByGithubId("nope")).toBeNull();
      });

      it("updates user fields (email + plan)", async () => {
        const user = await db.createUser({ github_id: "gh-1", username: "bob" });
        const updated = await db.updateUser(user.id, { email: "bob@new.com", plan: "pro" });
        expect(updated?.email).toBe("bob@new.com");
        expect(updated?.plan).toBe("pro");
      });
    });

    // ── API Keys ────────────────────────────────────────────────────────

    describe("api keys", () => {
      it("creates, looks up by hash, lists, and deletes", async () => {
        const user = await db.createUser({ github_id: "ak-1", username: "ak-u" });
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

      it("returns false for deleteApiKey on nonexistent id", async () => {
        expect(await db.deleteApiKey(fx("nonexistent-key"))).toBe(false);
      });

      it("deletes only when owned by the user", async () => {
        const u1 = await db.createUser({ github_id: "ak-o1", username: "o1" });
        const u2 = await db.createUser({ github_id: "ak-o2", username: "o2" });
        const key = await db.createApiKey({
          user_id: u1.id,
          key_hash: "h-owned",
          key_prefix: "sk_",
          name: "mine",
        });

        // Wrong owner → false, key still there
        expect(await db.deleteApiKeyByOwner(key.id, u2.id)).toBe(false);
        expect(await db.getApiKeyByHash("h-owned")).toBeTruthy();

        // Correct owner → true, key gone
        expect(await db.deleteApiKeyByOwner(key.id, u1.id)).toBe(true);
        expect(await db.getApiKeyByHash("h-owned")).toBeNull();
      });

      it("returns false for deleteApiKeyByOwner on nonexistent key", async () => {
        const u = await db.createUser({ github_id: "ak-x", username: "x" });
        expect(await db.deleteApiKeyByOwner(fx("nonexistent-key"), u.id)).toBe(false);
      });

      it("updates last_used_at", async () => {
        const user = await db.createUser({ github_id: "ak-lu", username: "lu" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-lu",
          key_prefix: "sk_",
          name: "k",
        });
        expect(key.last_used_at).toBeNull();

        await db.updateApiKeyLastUsed(key.id);
        const updated = await db.getApiKeyByHash("h-lu");
        expect(updated?.last_used_at).toBeTruthy();
      });

      it("defaults scope_kind to 'account' with no grants", async () => {
        const user = await db.createUser({ github_id: "ak-sk", username: "ak-sk" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-sk-default",
          key_prefix: "sk_",
          name: "default",
        });
        expect(key.scope_kind).toBe("account");
        expect((await db.getApiKeyByHash("h-sk-default"))?.scope_kind).toBe("account");
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([]);
      });

      it("persists scope_kind 'agents' + grant rows (round-trip)", async () => {
        const user = await db.createUser({ github_id: "ak-ag", username: "ak-ag" });
        const a1 = await db.createAgent({
          name: "ag1",
          namespace: "ak-ag",
          description: "",
          owner_id: user.id,
        });
        const a2 = await db.createAgent({
          name: "ag2",
          namespace: "ak-ag",
          description: "",
          owner_id: user.id,
        });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-scoped",
          key_prefix: "sk_",
          name: "scoped",
          scopes: ["agent:run"],
          scope_kind: "agents",
          agents: [a1.id, a2.id],
        });
        expect(key.scope_kind).toBe("agents");
        expect([...(await db.getApiKeyAgentIds(key.id))].sort()).toEqual([a1.id, a2.id].sort());
      });

      it("cascades grant rows when a granted agent is deleted (fail-closed)", async () => {
        const user = await db.createUser({ github_id: "ak-cz", username: "ak-cz" });
        const a1 = await db.createAgent({
          name: "cz1",
          namespace: "ak-cz",
          description: "",
          owner_id: user.id,
        });
        const a2 = await db.createAgent({
          name: "cz2",
          namespace: "ak-cz",
          description: "",
          owner_id: user.id,
        });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-cz",
          key_prefix: "sk_",
          name: "cz",
          scope_kind: "agents",
          agents: [a1.id, a2.id],
        });
        await db.deleteAgent("ak-cz", "cz1");
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([a2.id]);
        await db.deleteAgent("ak-cz", "cz2");
        // 0 grants left → the key is deny-all at the enforcement layer (never fail-open).
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([]);
      });
    });

    // ── Agent LLM keys (creator-attached, encrypted) ──────────────────────

    describe("agent llm keys", () => {
      it("defaults llm_key_policy to 'open' and setLlmKeyPolicy round-trips", async () => {
        const user = await db.createUser({ github_id: "lk-pol", username: "lk-pol" });
        const agent = await db.createAgent({
          name: "pol",
          namespace: "lk-pol",
          description: "",
          owner_id: user.id,
        });
        expect(agent.llm_key_policy).toBe("open");
        expect((await db.getAgent("lk-pol", "pol"))?.llm_key_policy).toBe("open");

        const locked = await db.setLlmKeyPolicy("lk-pol", "pol", "creator_only");
        expect(locked?.llm_key_policy).toBe("creator_only");
        expect((await db.getAgent("lk-pol", "pol"))?.llm_key_policy).toBe("creator_only");
      });

      it("setLlmKeyPolicy on a missing agent returns null", async () => {
        expect(await db.setLlmKeyPolicy("lk-pol", "ghost", "creator_only")).toBeNull();
      });

      it("upserts a key (replace on same provider), lists presence (no ciphertext), reads secrets", async () => {
        const user = await db.createUser({ github_id: "lk-up", username: "lk-up" });
        const agent = await db.createAgent({
          name: "up",
          namespace: "lk-up",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "cipher-v1", "••1234", 1);
        await db.setAgentLlmKey(agent.id, "openai", "cipher-o", "••abcd", 1);
        // Replace anthropic (same provider) — must NOT create a duplicate row.
        await db.setAgentLlmKey(agent.id, "anthropic", "cipher-v2", "••5678", 1);

        const presence = await db.listAgentLlmKeys(agent.id);
        expect(presence).toHaveLength(2);
        const anthropic = presence.find((p) => p.provider === "anthropic");
        expect(anthropic?.last4).toBe("••5678");
        expect(anthropic?.updated_at).toBeTruthy();
        // Presence view exposes ONLY provider/last4/updated_at — never the ciphertext.
        expect(Object.keys(anthropic ?? {}).sort()).toEqual(["last4", "provider", "updated_at"]);

        const secrets = await db.getAgentLlmKeySecrets(agent.id);
        expect(secrets).toHaveLength(2);
        const aSecret = secrets.find((s) => s.provider === "anthropic");
        expect(aSecret?.ciphertext).toBe("cipher-v2");
        expect(aSecret?.agent_id).toBe(agent.id);
        expect(aSecret?.key_version).toBe(1);
      });

      it("deleteAgentLlmKey removes a single provider", async () => {
        const user = await db.createUser({ github_id: "lk-del", username: "lk-del" });
        const agent = await db.createAgent({
          name: "del",
          namespace: "lk-del",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "c-a", "••1111", 1);
        await db.setAgentLlmKey(agent.id, "openai", "c-o", "••2222", 1);
        await db.deleteAgentLlmKey(agent.id, "anthropic");
        const presence = await db.listAgentLlmKeys(agent.id);
        expect(presence.map((p) => p.provider)).toEqual(["openai"]);
      });

      it("cascades keys when the agent is deleted", async () => {
        const user = await db.createUser({ github_id: "lk-cz", username: "lk-cz" });
        const agent = await db.createAgent({
          name: "cz",
          namespace: "lk-cz",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "c-a", "••3333", 1);
        await db.setAgentLlmKey(agent.id, "openai", "c-o", "••4444", 1);
        await db.deleteAgent("lk-cz", "cz");
        expect(await db.getAgentLlmKeySecrets(agent.id)).toEqual([]);
        expect(await db.listAgentLlmKeys(agent.id)).toEqual([]);
      });
    });

    // ── Device codes (CLI device-login, RFC 8628) ───────────────────────

    describe("device codes", () => {
      const future = () => new Date(Date.now() + 600_000).toISOString();

      it("creates a pending code and looks it up by device-hash and user-hash", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-1",
          user_code_hash: "uch-1",
          code_challenge: "chal-1",
          expires_at: future(),
        });
        const byDevice = await db.getDeviceCodeByDeviceHash("dch-1");
        expect(byDevice?.user_code_hash).toBe("uch-1");
        expect(byDevice?.code_challenge).toBe("chal-1");
        expect(byDevice?.status).toBe("pending");
        expect(byDevice?.user_id).toBeNull();
        expect(byDevice?.current_interval).toBe(5);
        expect(byDevice?.attempt_count).toBe(0);
        const byUser = await db.getDeviceCodeByUserHash("uch-1");
        expect(byUser?.device_code_hash).toBe("dch-1");
      });

      it("returns null for missing device/user hashes", async () => {
        expect(await db.getDeviceCodeByDeviceHash("nope")).toBeNull();
        expect(await db.getDeviceCodeByUserHash("nope")).toBeNull();
      });

      it("authorizes a pending code once (binds user_id); re-authorize is a no-op", async () => {
        const user = await db.createUser({ github_id: "dc-auth", username: "dc-auth" });
        await db.createDeviceCode({
          device_code_hash: "dch-2",
          user_code_hash: "uch-2",
          code_challenge: "chal-2",
          expires_at: future(),
        });
        expect(await db.authorizeDeviceCode("uch-2", user.id)).toBe(true);
        const authed = await db.getDeviceCodeByDeviceHash("dch-2");
        expect(authed?.status).toBe("authorized");
        expect(authed?.user_id).toBe(user.id);
        // Already authorized → not pending → false.
        expect(await db.authorizeDeviceCode("uch-2", user.id)).toBe(false);
      });

      it("records a poll (last_polled_at) and bumps current_interval on slow_down", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-3",
          user_code_hash: "uch-3",
          code_challenge: "chal-3",
          expires_at: future(),
        });
        await db.recordDeviceCodePoll("dch-3", false);
        let dc = await db.getDeviceCodeByDeviceHash("dch-3");
        expect(dc?.last_polled_at).not.toBeNull();
        expect(dc?.current_interval).toBe(5);
        await db.recordDeviceCodePoll("dch-3", true);
        dc = await db.getDeviceCodeByDeviceHash("dch-3");
        expect(dc?.current_interval).toBe(10);
      });

      it("increments the PKCE attempt counter", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-4",
          user_code_hash: "uch-4",
          code_challenge: "chal-4",
          expires_at: future(),
        });
        expect(await db.incrementDeviceCodeAttempts("dch-4")).toBe(1);
        expect(await db.incrementDeviceCodeAttempts("dch-4")).toBe(2);
      });

      it("consumes (deletes) a code", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-5",
          user_code_hash: "uch-5",
          code_challenge: "chal-5",
          expires_at: future(),
        });
        await db.consumeDeviceCode("dch-5");
        expect(await db.getDeviceCodeByDeviceHash("dch-5")).toBeNull();
      });

      it("purges expired codes and keeps fresh ones", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-old",
          user_code_hash: "uch-old",
          code_challenge: "chal-old",
          expires_at: new Date(Date.now() - 10_000).toISOString(),
        });
        await db.createDeviceCode({
          device_code_hash: "dch-fresh",
          user_code_hash: "uch-fresh",
          code_challenge: "chal-fresh",
          expires_at: future(),
        });
        await db.purgeExpiredDeviceCodes();
        expect(await db.getDeviceCodeByDeviceHash("dch-old")).toBeNull();
        expect(await db.getDeviceCodeByDeviceHash("dch-fresh")).not.toBeNull();
      });
    });

    // ── Runs ────────────────────────────────────────────────────────────

    describe("runs", () => {
      it("creates, updates, and gets a completed run", async () => {
        const run = await db.createRun({
          id: fx("run-completed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
          input: { url: "https://example.com" },
        });
        expect(run.status).toBe("running");
        expect(run.completed_at).toBeNull();

        const updated = await db.updateRun(fx("run-completed"), {
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

      it("round-trips runner cold-start telemetry across all backends", async () => {
        const created = await db.createRun({
          id: fx("run-telemetry"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        // Fresh runs default the operator-only telemetry to null.
        expect(created.machine_id).toBeNull();
        expect(created.private_ip).toBeNull();
        expect(created.phase_timings).toBeNull();

        const phases = { create_api_ms: 12, host_schedule_pull_ms: 4800, vm_boot_ms: 3200 };
        const updated = await db.updateRun(fx("run-telemetry"), {
          machine_id: "9185707b71308e",
          private_ip: "fdaa:0:1:a7b:1:2:3:4",
          phase_timings: phases,
        });
        expect(updated?.machine_id).toBe("9185707b71308e");
        expect(updated?.private_ip).toBe("fdaa:0:1:a7b:1:2:3:4");
        expect(updated?.phase_timings).toEqual(phases);

        // Round-trips through getRun (SELECT *) — the jsonb/TEXT column survives.
        const fetched = await db.getRun(fx("run-telemetry"));
        expect(fetched?.phase_timings).toEqual(phases);
        expect(fetched?.machine_id).toBe("9185707b71308e");
      });

      it("creates and updates a failed run", async () => {
        await db.createRun({
          id: fx("run-failed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        const updated = await db.updateRun(fx("run-failed"), {
          status: "failed",
          error: "Model not available",
          completed_at: new Date().toISOString(),
        });
        expect(updated?.status).toBe("failed");
        expect(updated?.error).toBe("Model not available");
      });

      it("getRun returns null for nonexistent", async () => {
        expect(await db.getRun(fx("nonexistent-run"))).toBeNull();
      });

      it("filters listRuns by agent_id / status / limit", async () => {
        const a1 = await db.createAgent({
          name: "ra1",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const a2 = await db.createAgent({
          name: "ra2",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });

        await db.createRun({
          id: fx("lr1"),
          agent_id: a1.id,
          agent_version: "v",
          status: "completed",
        });
        await db.createRun({
          id: fx("lr2"),
          agent_id: a1.id,
          agent_version: "v",
          status: "failed",
        });
        await db.createRun({
          id: fx("lr3"),
          agent_id: a2.id,
          agent_version: "v",
          status: "completed",
        });

        const byAgent = await db.listRuns({ agent_id: a1.id });
        expect(byAgent).toHaveLength(2);

        const byStatus = await db.listRuns({ status: "completed" });
        expect(byStatus.length).toBeGreaterThanOrEqual(2);

        const limited = await db.listRuns({ limit: 1 });
        expect(limited).toHaveLength(1);
      });

      it("round-trips JSON columns (input, output, files)", async () => {
        const input = { nested: { data: [1, 2, 3] } };
        const output = { items: ["a", "b"] };
        const files = [{ name: "report.pdf", size: 1024 }];

        await db.createRun({
          id: fx("json-run"),
          agent_id: null,
          agent_version: "v",
          status: "running",
          input,
        });
        await db.updateRun(fx("json-run"), { output, files });

        const run = await db.getRun(fx("json-run"));
        expect(run?.input).toEqual(input);
        expect(run?.output).toEqual(output);
        expect(run?.files).toEqual(files);
      });

      it("records api_key_id and nulls it when the key is revoked (SET NULL)", async () => {
        const user = await db.createUser({ github_id: "rk-1", username: "rk-1" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-run-key",
          key_prefix: "sk_",
          name: "runner",
          scopes: ["agent:run"],
        });
        await db.createRun({
          id: fx("run-keyed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
          user_id: user.id,
          api_key_id: key.id,
        });
        expect((await db.getRun(fx("run-keyed")))?.api_key_id).toBe(key.id);

        // A session/dev-token run carries no key.
        await db.createRun({
          id: fx("run-nokey"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        expect((await db.getRun(fx("run-nokey")))?.api_key_id).toBeNull();

        // Revoking the key preserves the run row but drops the link.
        await db.deleteApiKey(key.id);
        expect((await db.getRun(fx("run-keyed")))?.api_key_id).toBeNull();
      });
    });

    // ── Environments ────────────────────────────────────────────────────

    describe("environments", () => {
      it("creates and gets an environment", async () => {
        const env = await db.createEnvironment({
          name: "prod",
          owner_id: fx("u1"),
          config: { timeout: 30, networking: { allowed_hosts: ["*"] } },
        });
        expect(env.id).toBeTruthy();

        const found = await db.getEnvironment(env.id);
        expect(found?.name).toBe("prod");
        expect(found?.config).toEqual({ timeout: 30, networking: { allowed_hosts: ["*"] } });
      });

      it("lists environments by owner", async () => {
        await db.createEnvironment({ name: "dev", owner_id: fx("u1"), config: {} });
        await db.createEnvironment({ name: "prod", owner_id: fx("u1"), config: {} });
        await db.createEnvironment({ name: "other", owner_id: fx("u2"), config: {} });

        const envs = await db.listEnvironments(fx("u1"));
        expect(envs).toHaveLength(2);

        const empty = await db.listEnvironments(fx("nobody"));
        expect(empty).toHaveLength(0);
      });
    });

    // ── Stats ───────────────────────────────────────────────────────────

    describe("stats", () => {
      it("getStats aggregates count + tokens + failed (today)", async () => {
        const agent = await db.createAgent({
          name: "s-agg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("sa-t1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "completed",
        });
        await db.createRun({
          id: fx("sa-t2"),
          agent_id: agent.id,
          agent_version: "v",
          status: "failed",
        });
        await db.updateRun(fx("sa-t1"), { usage_total_tokens: 100 });
        await db.updateRun(fx("sa-t2"), { usage_total_tokens: 50 });

        const stats = await db.getStats();
        expect(stats.agents_count).toBe(1);
        expect(stats.runs_today).toBe(2);
        expect(stats.tokens_today).toBe(150);
        expect(stats.failed_today).toBe(1);
        expect(stats.daily_runs).toHaveLength(7);
        expect(stats.daily_tokens).toHaveLength(7);
        expect(stats.daily_failed).toHaveLength(7);
        // Today is the last bucket (index 6) — assert VALUES, not just length.
        // A length-only check let the PostgresDb `::date`→Date bucketing bug
        // ship all-zero daily arrays (see the multi-day + rolling tests below).
        expect(stats.daily_runs[6]).toBe(2);
        expect(stats.daily_tokens[6]).toBe(150);
        expect(stats.daily_failed[6]).toBe(1);
      });

      it("getStats daily_* buckets honour created_at across multiple days", async () => {
        // Regression for the PostgresDb daily-bucketing bug: a length-7 array
        // isn't enough — buckets must be POPULATED. Backdate one run 2 days ago
        // and create one now; assert they land in distinct buckets.
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        await db.createRun({
          id: fx("dd-old"),
          agent_id: null,
          agent_version: "v",
          status: "failed",
          created_at: twoDaysAgo,
        });
        await db.createRun({
          id: fx("dd-now"),
          agent_id: null,
          agent_version: "v",
          status: "completed",
        });

        const stats = await db.getStats();
        // 7-day window ends today (index 6); 2 days ago = index 4.
        expect(stats.daily_runs[6]).toBe(1);
        expect(stats.daily_runs[4]).toBe(1);
        expect(stats.daily_failed[4]).toBe(1);
        expect(stats.daily_failed[6]).toBe(0);
        expect(stats.daily_runs.reduce((a, b) => a + b, 0)).toBe(2);
      });

      it("getStats today/yesterday tiles are ROLLING 24h windows (not UTC calendar days)", async () => {
        // A run from ~21h ago must count in the 24h tile even across the
        // UTC-midnight boundary; a run from ~25h ago must not.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await db.createRun({
          id: fx("rw-recent"),
          agent_id: null,
          agent_version: "v",
          status: "completed",
          created_at: oneHourAgo,
        });
        await db.createRun({
          id: fx("rw-old"),
          agent_id: null,
          agent_version: "v",
          status: "failed",
          created_at: twentyFiveHoursAgo,
        });

        const stats = await db.getStats();
        // Trailing 24h → only the 1h-ago run.
        expect(stats.runs_today).toBe(1);
        expect(stats.failed_today).toBe(0);
        // Preceding 24h window [now-48h, now-24h) → the 25h-ago run.
        expect(stats.runs_yesterday).toBe(1);
        expect(stats.failed_yesterday).toBe(1);
      });

      it("getStats agents_count is filtered by owner when userId is provided", async () => {
        await db.createAgent({
          name: "own-a",
          namespace: "na",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "own-b1",
          namespace: "nb1",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "own-b2",
          namespace: "nb2",
          description: "",
          owner_id: fx("user-B"),
        });

        expect((await db.getStats({ userId: fx("user-A") })).agents_count).toBe(1);
        expect((await db.getStats({ userId: fx("user-B") })).agents_count).toBe(2);
        // No filter → instance-wide total.
        expect((await db.getStats()).agents_count).toBe(3);
      });

      it("getAgentStats aggregates runs/tokens/failed/avg_duration (period)", async () => {
        const agent = await db.createAgent({
          name: "as-agg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("as-1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "completed",
        });
        await db.updateRun(fx("as-1"), { usage_total_tokens: 200, duration_ms: 1000 });

        const stats = await db.getAgentStats(agent.id);
        expect(stats.runs).toBe(1);
        expect(stats.tokens).toBe(200);
        expect(stats.failed).toBe(0);
        expect(stats.avg_duration_ms).toBe(1000);
        expect(stats.daily_runs).toHaveLength(7);
      });

      it("getAgentStats: daily_cache_savings / daily_cost length matches `days` argument (daily_runs/tokens/failed/avg_duration stay at 7 for sparkline UX)", async () => {
        const agent = await db.createAgent({
          name: "as-days",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("asd-1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("asd-1"), { usage_cache_savings_usd: 0.5 });

        const stats7 = await db.getAgentStats(agent.id, 7);
        // Original sparkline fields hardcoded to 7 (home page UX consistency,
        // documented in memory.ts:489-491 + sqlite.ts).
        expect(stats7.daily_runs).toHaveLength(7);
        expect(stats7.daily_tokens).toHaveLength(7);
        expect(stats7.daily_failed).toHaveLength(7);
        expect(stats7.daily_avg_duration_ms).toHaveLength(7);
        // Cache + cost honour the `days` parameter.
        expect(stats7.daily_cache_savings).toHaveLength(7);
        expect(stats7.daily_cost).toHaveLength(7);

        const stats30 = await db.getAgentStats(agent.id, 30);
        // Sparkline fields still 7 — they ignore `days` by design.
        expect(stats30.daily_runs).toHaveLength(7);
        expect(stats30.daily_tokens).toHaveLength(7);
        // Cache + cost grow to match `days`.
        expect(stats30.daily_cache_savings).toHaveLength(30);
        expect(stats30.daily_cost).toHaveLength(30);
      });
    });

    // ── Cache cost-savings ──────────────────────────────────────────────

    describe("cache cost-savings", () => {
      it("getStats sums cache_savings_today across runs", async () => {
        const today = new Date().toISOString();
        await db.createRun({
          id: fx("cs-r1"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r1"), { usage_cache_savings_usd: 0.42, completed_at: today });
        await db.createRun({
          id: fx("cs-r2"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r2"), { usage_cache_savings_usd: 0.42, completed_at: today });
        await db.createRun({
          id: fx("cs-r3"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r3"), { usage_cache_savings_usd: 0, completed_at: today });

        const stats = await db.getStats();
        expect(stats.cache_savings_today).toBeCloseTo(0.84, 6);
        expect(stats.daily_cache_savings).toHaveLength(7);
        // Today is the last bucket (index 6) — sum should be 0.84
        expect(stats.daily_cache_savings[6]).toBeCloseTo(0.84, 6);
      });

      it("getStats multi-tenant userId filter isolates cache_savings", async () => {
        for (let i = 0; i < 2; i++) {
          const id = fx(`cst-a${i}`);
          await db.createRun({
            id,
            agent_id: null,
            agent_version: "v",
            user_id: fx("user-A"),
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 0.42 });
        }
        for (let i = 0; i < 3; i++) {
          const id = fx(`cst-b${i}`);
          await db.createRun({
            id,
            agent_id: null,
            agent_version: "v",
            user_id: fx("user-B"),
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 1.0 });
        }

        const statsA = await db.getStats({ userId: fx("user-A") });
        expect(statsA.cache_savings_today).toBeCloseTo(0.84, 6);

        const statsB = await db.getStats({ userId: fx("user-B") });
        expect(statsB.cache_savings_today).toBeCloseTo(3.0, 6);

        // No filter — instance-wide
        const statsAll = await db.getStats();
        expect(statsAll.cache_savings_today).toBeCloseTo(3.84, 6);
      });

      it("getAgentStats sums cache_savings over period", async () => {
        const agent = await db.createAgent({
          name: "csg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        for (let i = 0; i < 5; i++) {
          const id = fx(`csg${i}`);
          await db.createRun({
            id,
            agent_id: agent.id,
            agent_version: "v",
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 1.0 });
        }

        const stats = await db.getAgentStats(agent.id, 7);
        expect(stats.cache_savings).toBeCloseTo(5.0, 6);
        expect(stats.daily_cache_savings).toHaveLength(7);
        expect(stats.daily_cache_savings.reduce((s, v) => s + v, 0)).toBeCloseTo(5.0, 6);
      });

      it("failed run keeps cache_savings_usd = 0", async () => {
        await db.createRun({
          id: fx("cs-fail"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-fail"), {
          status: "failed",
          error: "boom",
          completed_at: new Date().toISOString(),
        });
        const run = await db.getRun(fx("cs-fail"));
        expect(run?.status).toBe("failed");
        expect(run?.usage_cache_savings_usd).toBe(0);
        expect(run?.usage_cache_read_tokens).toBe(0);
        expect(run?.usage_cache_write_tokens).toBe(0);
      });

      it("CRUD column completeness — 3 cache fields preserved across update→get", async () => {
        await db.createRun({
          id: fx("cs-rt"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-rt"), {
          status: "completed",
          usage_cache_read_tokens: 7143,
          usage_cache_write_tokens: 0,
          usage_cache_savings_usd: 0.000964,
        });
        const run = await db.getRun(fx("cs-rt"));
        expect(run?.usage_cache_read_tokens).toBe(7143);
        expect(run?.usage_cache_write_tokens).toBe(0);
        expect(run?.usage_cache_savings_usd).toBeCloseTo(0.000964, 6);
      });

      it("createRun initializes cache fields to 0 by default", async () => {
        await db.createRun({
          id: fx("cs-default"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        const run = await db.getRun(fx("cs-default"));
        expect(run?.usage_cache_read_tokens).toBe(0);
        expect(run?.usage_cache_write_tokens).toBe(0);
        expect(run?.usage_cache_savings_usd).toBe(0);
      });
    });
  });
}
