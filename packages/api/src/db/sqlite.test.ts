import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureUsers, runDbContractTests } from "./db-contract.shared.js";
import { SqliteDb } from "./sqlite.js";

/**
 * SqliteDb enforces FKs (CODE-110). Tests passing literal user IDs like
 * "user-1" / "u" / "u-1" to createAgent / createApiKey / createRun would
 * otherwise fail FK validation. Seed the referenced parents up-front so
 * test data stays referentially valid. Bypasses createUser() (which mints
 * its own UUID) via a raw INSERT.
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

/**
 * Seeds the #17 uuid fixture users the shared contract references (fx()
 * labels). Distinct from `seedTestUsers` (literal ids) which the SQLite-
 * specific describes below still use.
 */
function seedFixtureUsers(db: SqliteDb): void {
  const stmt = rawDb(db).prepare(
    "INSERT INTO users (id, github_id, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const u of fixtureUsers()) {
    stmt.run(u.id, u.github_id, u.username, now, now);
  }
}

// Shared DbAdapter contract — covers all behavioural assertions shared
// across Memory / Sqlite / Postgres backends. Source of truth lives in
// `db-contract.shared.ts`. Per #007 spec SC-10: zero inline assertions
// here duplicate that contract; SQLite-specific tests (migrations, FK
// migration) live below.
runDbContractTests("sqlite", async () => {
  const db = new SqliteDb(":memory:");
  seedFixtureUsers(db);
  return db;
});

// ── SQLite-specific: schema migrations (file-backed close/reopen) ────

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

// ── SQLite-specific: FK migration (CODE-110, audit/001 task 3.1) ──────

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
      // runs has 4 FKs: agent_id, environment_id, user_id, api_key_id
      expect((inner.pragma("foreign_key_list(runs)") as unknown[]).length).toBe(4);
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
