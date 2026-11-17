import { describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter.js";
import { fixtureUsers, runDbContractTests } from "./db-contract.shared.js";
import { MemoryDb } from "./memory.js";
import type { Run, User } from "./schema.js";

/**
 * Seeds the fixture users the shared contract references, under their fx()
 * ids — as the SQL factories do with a raw INSERT. `createUser` mints its own
 * id, so the rows go straight into the store; the store refuses a run naming
 * an account it does not hold, as the SQL backends' foreign keys do.
 */
function seedFixtureUsers(db: MemoryDb): void {
  const store = db as unknown as {
    users: Map<string, User>;
    usersByGithubId: Map<string, string>;
  };
  const now = new Date().toISOString();
  for (const u of fixtureUsers()) {
    store.users.set(u.id, {
      ...u,
      email: "",
      avatar_url: "",
      plan: "free",
      role: "user",
      created_at: now,
      updated_at: now,
    });
    store.usersByGithubId.set(u.github_id, u.id);
  }
}

// Shared DbAdapter contract — covers all behavioural assertions shared
// across Memory / Sqlite / Postgres backends. Source of truth lives in
// `db-contract.shared.ts`. Per #007 spec SC-10: zero inline assertions
// here duplicate that contract.
runDbContractTests(
  "memory",
  async () => {
    const db = new MemoryDb();
    seedFixtureUsers(db);
    return db;
  },
  {
    async setRunContentCleared(db: DbAdapter, runId: string, at: string) {
      const run = (db as unknown as { runs: Map<string, Run> }).runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      run.content_cleared_at = at;
    },
    async countRows(db: DbAdapter) {
      const store = db as unknown as Record<string, Map<string, unknown>>;
      const size = (name: string) => store[name].size;
      /** A map whose values are lists holds one row per element. */
      const rows = (name: string) =>
        [...store[name].values()].reduce<number>((n, list) => n + (list as unknown[]).length, 0);
      return {
        users: size("users"),
        api_keys: size("apiKeys"),
        api_key_agents: rows("apiKeyAgents"),
        agents: size("agents"),
        agent_versions: rows("versions"),
        agent_llm_keys: rows("agentLlmKeys"),
        agent_state: size("states"),
        environments: size("environments"),
        device_codes: size("deviceCodes"),
        sessions: size("sessions"),
        runs: size("runs"),
      };
    },
    usernameIsUnique: false,
    admission: {
      async setRunChargedMs(db: DbAdapter, runId: string, chargedMs: number) {
        const run = (db as unknown as { runs: Map<string, Run> }).runs.get(runId);
        if (!run) throw new Error(`no run ${runId}`);
        run.charged_ms = chargedMs;
      },
      async analyzeRuns() {},
    },
  },
);

// ── MemoryDb-specific tests ─────────────────────────────────────────
//
// `clear()` is NOT part of the DbAdapter interface — it's a memory-only
// reset helper used by tests + dev workflows. SqliteDb / PostgresDb don't
// expose an equivalent (they truncate by connecting to a fresh DB).

describe("MemoryDb specifics", () => {
  it("clear() resets all in-memory stores", async () => {
    const db = new MemoryDb();
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });
    await db.setState(agent.id, { kind: "shared" }, { x: 1 }, "2099-01-01T00:00:00.000Z");
    await db.createUser({ github_id: "gh-1", username: "alice" });
    await db.createRun({
      id: "r1",
      agent_id: agent.id,
      agent_version: "1.0.0",
      status: "running",
    });
    await db.createEnvironment({ name: "dev", owner_id: "u-1", config: {} });

    db.clear();

    expect(await db.getAgent("ns", "a")).toBeNull();
    expect(await db.getState(agent.id, { kind: "shared" })).toBeNull();
    expect(await db.getUserByGithubId("gh-1")).toBeNull();
    expect(await db.getRun("r1")).toBeNull();
  });
});
