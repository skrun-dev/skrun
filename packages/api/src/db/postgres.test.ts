import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureUsers, runDbContractTests } from "./db-contract.shared.js";
import { runMigrations } from "./migrations-runner.js";
import { PostgresDb } from "./postgres.js";

/**
 * PostgresDb test wrapper — gated on `DATABASE_URL`. Skipped cleanly on
 * dev machines without a local Postgres. Operators can spin up the
 * docker-compose `postgres` service + export
 * `DATABASE_URL=postgres://skrun:skrun-dev-only@localhost:5432/skrun`
 * to activate.
 *
 * Per #007 spec SC-10 (amended): this file contains ZERO inline
 * assertions duplicating the shared contract. PG-specific smoke
 * (advisory lock, real-conn round-trip, transaction rollback, VT-12
 * query counter) lives in the `postgres-specific` describe.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_PG = !!DATABASE_URL && /^postgres(ql)?:\/\//.test(DATABASE_URL);
const describeIfPg = HAS_PG ? describe : describe.skip;

// ── Shared DbAdapter contract — runs against PostgresDb ──────────────

if (HAS_PG) {
  let sharedPool: Pool | null = null;

  beforeAll(async () => {
    sharedPool = new Pool({ connectionString: DATABASE_URL });
    // Apply migrations once before contract tests run. The factory below
    // wipes + re-creates `public` for each test, so we need a separate
    // step to seed the schema. We do this via runMigrations against the
    // shared pool after the initial wipe.
  });

  afterAll(async () => {
    if (sharedPool) await sharedPool.end();
  });

  runDbContractTests("postgres", async () => {
    if (!sharedPool) throw new Error("test pool not initialised");
    // Wipe the public schema + re-apply migrations for a clean fixture
    // each test. Expensive (~100ms/test on local PG) but isolates tests.
    await sharedPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await sharedPool.query("CREATE SCHEMA public");
    await runMigrations(sharedPool, join(import.meta.dirname, "migrations"));
    // Seed the FK parent users the shared contract references as
    // owner_id / user_id (factory contract). Mirrors the SQLite factory's
    // seedFixtureUsers — a raw INSERT (not createUser, which mints its own
    // uuid) so the ids match the fx() labels the contract passes.
    for (const u of fixtureUsers()) {
      await sharedPool.query("INSERT INTO users (id, github_id, username) VALUES ($1, $2, $3)", [
        u.id,
        u.github_id,
        u.username,
      ]);
    }
    return new PostgresDb(DATABASE_URL as string);
  });
}

// ── PG-specific smoke (advisory lock, tx rollback, VT-12 query counter) ──

describeIfPg("PostgresDb postgres-specific", () => {
  let db: PostgresDb;

  beforeAll(async () => {
    db = new PostgresDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.getPool().query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
    await runMigrations(db.getPool(), join(import.meta.dirname, "migrations"));
  });

  it("SELECT NOW() round-trip via the pool", async () => {
    const result = await db.getPool().query<{ now: Date }>("SELECT NOW() AS now");
    expect(result.rows[0].now).toBeInstanceOf(Date);
  });

  it("transaction rollback discards changes", async () => {
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO users (id, github_id, username) VALUES ('11111111-1111-1111-1111-111111111111', 'tx-test', 'tx-test')",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await db
      .getPool()
      .query<{ cnt: string }>(
        "SELECT COUNT(*)::bigint AS cnt FROM users WHERE username = 'tx-test'",
      );
    expect(Number(after.rows[0].cnt)).toBe(0);
  });

  it("advisory lock acquire + release", async () => {
    const client = await db.getPool().connect();
    try {
      const got = await client.query<{ pg_try_advisory_lock: boolean }>(
        "SELECT pg_try_advisory_lock(424242)",
      );
      expect(got.rows[0].pg_try_advisory_lock).toBe(true);
      await client.query("SELECT pg_advisory_unlock(424242)");
    } finally {
      client.release();
    }
  });

  /**
   * VT-12 (SC-12): `listAgents` MUST use a single LEFT JOIN, NOT N+1.
   * Wrap `pool.query` via a spy, populate fixtures, call listAgents
   * against 50 agents + runs, assert spy was invoked ≤ 2 times
   * (1 LEFT JOIN query + 1 COUNT for pagination).
   */
  it("VT-12: listAgents uses LEFT JOIN, not N+1 (≤ 2 queries for 50 agents)", async () => {
    // Seed a user the agents will reference (FK).
    const userId = "22222222-2222-2222-2222-222222222222";
    await db
      .getPool()
      .query("INSERT INTO users (id, github_id, username) VALUES ($1, 'vt12', 'vt12')", [userId]);
    // 50 agents + 1 run each (so the LEFT JOIN has work to do).
    for (let i = 0; i < 50; i++) {
      const agent = await db.createAgent({
        name: `n${i.toString().padStart(2, "0")}`,
        namespace: "vt12",
        description: "",
        owner_id: userId,
      });
      await db.createRun({
        id: randomUUID(),
        agent_id: agent.id,
        agent_version: "1.0.0",
        status: "completed",
      });
    }

    const spy = vi.spyOn(db.getPool(), "query");
    await db.listAgents({ page: 1, limit: 50, userId });
    const callCount = spy.mock.calls.length;
    spy.mockRestore();

    // 1 query for the LEFT JOIN + 1 query for the filtered COUNT = 2.
    // Anything > 2 means we regressed to N+1.
    expect(callCount).toBeLessThanOrEqual(2);
  });
});

// ── SC-16: shared contract `it()` count ≥ 30 (always runs, no PG needed) ──

describe("DbAdapter shared contract: it() count meets SC-16 floor", () => {
  it("db-contract.shared.ts exposes ≥ 30 it() blocks", () => {
    const source = readFileSync(join(import.meta.dirname, "db-contract.shared.ts"), "utf8");
    // Count `it(` calls, excluding comments (strip first to avoid the
    // /^.*?it\(.*?\*\//s false-positive from JSDoc).
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const matches = stripped.match(/\bit\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(30);
  });
});

// ── VT-17 (SC-16): CI-wiring meta-test. Turns a future workflow refactor that
// drops the postgres service / DATABASE_URL — which would silently re-skip the
// pg contract (the exact blind spot follow-up #6 closed) — into a RED CI. ──
if (process.env.CI) {
  describe("PostgresDb CI wiring", () => {
    it("DATABASE_URL is set in CI so the pg contract does not silently skip", () => {
      expect(process.env.DATABASE_URL).toBeTruthy();
    });
  });
}
