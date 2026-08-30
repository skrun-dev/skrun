import { describe, expect, it } from "vitest";
import { runDbContractTests } from "./db-contract.shared.js";
import { MemoryDb } from "./memory.js";

// Shared DbAdapter contract — covers all behavioural assertions shared
// across Memory / Sqlite / Postgres backends. Source of truth lives in
// `db-contract.shared.ts`. Per #007 spec SC-10: zero inline assertions
// here duplicate that contract.
runDbContractTests("memory", async () => new MemoryDb());

// ── MemoryDb-specific tests ─────────────────────────────────────────
//
// `clear()` is NOT part of the DbAdapter interface — it's a memory-only
// reset helper used by tests + dev workflows. SqliteDb / PostgresDb don't
// expose an equivalent (they truncate by connecting to a fresh DB).

describe("MemoryDb specifics", () => {
  it("clear() resets all in-memory stores", async () => {
    const db = new MemoryDb();
    await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: "u" });
    await db.setState("ns/a", { x: 1 });
    await db.createUser({ github_id: "gh-1", username: "alice" });
    await db.createRun({
      id: "r1",
      agent_id: "a1",
      agent_version: "1.0.0",
      status: "running",
    });
    await db.createEnvironment({ name: "dev", owner_id: "u-1", config: {} });

    db.clear();

    expect(await db.getAgent("ns", "a")).toBeNull();
    expect(await db.getState("ns/a")).toBeNull();
    expect(await db.getUserByGithubId("gh-1")).toBeNull();
    expect(await db.getRun("r1")).toBeNull();
  });
});
