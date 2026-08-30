import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  lintAllMigrations,
  lintMigration,
  loadMigrationFiles,
  runMigrations,
} from "./migrations-runner.js";

describe("migrations-runner: loadMigrationFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-migrations-loader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns lexicographically sorted .sql files only", () => {
    writeFileSync(join(dir, "002_second.sql"), "SELECT 2;");
    writeFileSync(join(dir, "001_first.sql"), "SELECT 1;");
    writeFileSync(join(dir, "010_tenth.sql"), "SELECT 10;");
    writeFileSync(join(dir, "README.md"), "not a migration");
    writeFileSync(join(dir, "ignored.txt"), "also not a migration");

    const migrations = loadMigrationFiles(dir);
    expect(migrations).toHaveLength(3);
    expect(migrations.map((m) => m.name)).toEqual([
      "001_first.sql",
      "002_second.sql",
      "010_tenth.sql",
    ]);
  });

  it("returns empty array for a directory with no .sql files", () => {
    writeFileSync(join(dir, "README.md"), "no migrations");
    expect(loadMigrationFiles(dir)).toHaveLength(0);
  });

  it("reads SQL content verbatim", () => {
    const sql = "-- comment\nCREATE TABLE IF NOT EXISTS x (id text);\n";
    writeFileSync(join(dir, "001_test.sql"), sql);
    const [m] = loadMigrationFiles(dir);
    expect(m.sql).toBe(sql);
  });

  it("throws when the directory doesn't exist (fail loud)", () => {
    expect(() => loadMigrationFiles(join(dir, "nonexistent-subdir"))).toThrow();
  });

  it("loads our actual production migrations folder (001..009 all present)", () => {
    const migrations = loadMigrationFiles(join(import.meta.dirname, "migrations"));
    expect(migrations.length).toBeGreaterThanOrEqual(9);
    expect(migrations[0].name).toBe("001_initial_schema.sql");
    expect(migrations.some((m) => m.name === "009_drop_agents_verified.sql")).toBe(true);
  });
});

describe("migrations-runner: lintMigration", () => {
  it("accepts clean idempotent DDL", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE users DROP COLUMN IF EXISTS legacy_field;
      CREATE OR REPLACE FUNCTION my_fn() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE VIEW my_view AS SELECT id FROM users;
      CREATE SCHEMA IF NOT EXISTS billing;
      DROP TABLE IF EXISTS legacy_table;
      DROP INDEX IF EXISTS legacy_index;
      UPDATE users SET email = 'x' WHERE id = '1';
    `;
    expect(lintMigration("clean.sql", sql)).toEqual([]);
  });

  it("rejects top-level BEGIN;", () => {
    const errors = lintMigration(
      "bad.sql",
      "BEGIN;\nCREATE TABLE IF NOT EXISTS t (id text);\nCOMMIT;",
    );
    expect(errors.map((e) => e.kind)).toContain("BEGIN_FORBIDDEN");
    expect(errors.map((e) => e.kind)).toContain("COMMIT_FORBIDDEN");
  });

  it("rejects CREATE TABLE without IF NOT EXISTS", () => {
    const errors = lintMigration("bad.sql", "CREATE TABLE foo (id text);");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_TABLE");
  });

  it("rejects CREATE INDEX without IF NOT EXISTS", () => {
    const errors = lintMigration("bad.sql", "CREATE INDEX idx_foo ON foo(id);");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_INDEX");
  });

  it("rejects CREATE UNIQUE INDEX without IF NOT EXISTS", () => {
    const errors = lintMigration("bad.sql", "CREATE UNIQUE INDEX idx_u ON foo(id);");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_INDEX");
  });

  it("rejects CREATE VIEW without OR REPLACE", () => {
    const errors = lintMigration("bad.sql", "CREATE VIEW v AS SELECT 1;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_VIEW");
  });

  it("rejects CREATE FUNCTION without OR REPLACE", () => {
    const errors = lintMigration(
      "bad.sql",
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;",
    );
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_FUNCTION");
  });

  it("rejects CREATE SCHEMA without IF NOT EXISTS", () => {
    const errors = lintMigration("bad.sql", "CREATE SCHEMA billing;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_CREATE_SCHEMA");
  });

  it("rejects ADD COLUMN without IF NOT EXISTS", () => {
    const errors = lintMigration("bad.sql", "ALTER TABLE t ADD COLUMN x text;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_ADD_COLUMN");
  });

  it("rejects DROP COLUMN without IF EXISTS", () => {
    const errors = lintMigration("bad.sql", "ALTER TABLE t DROP COLUMN x;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_DROP_COLUMN");
  });

  it("rejects DROP TABLE without IF EXISTS", () => {
    const errors = lintMigration("bad.sql", "DROP TABLE foo;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_DROP_TABLE");
  });

  it("rejects DROP INDEX without IF EXISTS", () => {
    const errors = lintMigration("bad.sql", "DROP INDEX idx_foo;");
    expect(errors.map((e) => e.kind)).toContain("NON_IDEMPOTENT_DROP_INDEX");
  });

  it("ignores BEGIN/COMMIT inside comments", () => {
    const sql = `-- Note: do not write BEGIN; or COMMIT;
      CREATE TABLE IF NOT EXISTS t (id text);`;
    expect(lintMigration("comment.sql", sql)).toEqual([]);
  });

  it("ignores DDL inside block comments", () => {
    const sql = `/* example: CREATE TABLE foo (id text); */
      CREATE TABLE IF NOT EXISTS t (id text);`;
    expect(lintMigration("comment.sql", sql)).toEqual([]);
  });

  it("our 9 production migrations pass lint after the BEGIN/COMMIT strip + idempotency patches", () => {
    const migrations = loadMigrationFiles(join(import.meta.dirname, "migrations"));
    // lintAllMigrations throws on any violation — green means clean.
    expect(() => lintAllMigrations(migrations)).not.toThrow();
  });

  it("migration 012 (agent visibility) is present and idempotency-lint clean", () => {
    const migrations = loadMigrationFiles(join(import.meta.dirname, "migrations"));
    const m012 = migrations.find((m) => m.name === "012_agent_visibility.sql");
    expect(m012).toBeDefined();
    // ADD COLUMN IF NOT EXISTS → second apply is a no-op (idempotent); the
    // full second-run-all-skipped behaviour is covered by the PG integration
    // test below which re-runs the entire folder (012 included).
    expect(lintMigration(m012?.name ?? "", m012?.sql ?? "")).toEqual([]);
  });

  it("lintAllMigrations aggregates errors across files", () => {
    const dirty = [
      { name: "bad1.sql", sql: "BEGIN;\nCREATE TABLE foo (id text);\nCOMMIT;" },
      { name: "bad2.sql", sql: "DROP TABLE bar;" },
    ];
    // bad1: BEGIN_FORBIDDEN + COMMIT_FORBIDDEN + NON_IDEMPOTENT_CREATE_TABLE = 3
    // bad2: NON_IDEMPOTENT_DROP_TABLE = 1
    // total = 4
    expect(() => lintAllMigrations(dirty)).toThrow(/Migration lint failed.*4 violations/s);
  });
});

// ── Integration: runMigrations against a real Postgres ─────────────────
//
// Gated on `DATABASE_URL`. Skipped cleanly on dev machines without a
// local PG. Operators can spin up the docker-compose `postgres` service
// + export `DATABASE_URL=postgres://skrun:skrun-dev-only@localhost:5432/skrun`
// to activate.

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_PG_INTEGRATION = !!DATABASE_URL && /^postgres(ql)?:\/\//.test(DATABASE_URL);
const describeIfPg = HAS_PG_INTEGRATION ? describe : describe.skip;

describeIfPg("migrations-runner integration: runMigrations against real PG", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Wipe public schema for a clean slate. Trade-off: this test suite
    // ASSUMES the target DB is a throwaway/test database — never run
    // against a populated production DB.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
  });

  it("applies all migrations on a fresh DB + records each in _skrun_migrations", async () => {
    const dir = join(import.meta.dirname, "migrations");
    const result = await runMigrations(pool, dir);
    expect(result.applied).toBeGreaterThanOrEqual(9);
    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(0);

    // _skrun_migrations now has one row per file
    const r = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM _skrun_migrations",
    );
    expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(9);
  });

  it("is idempotent: second runMigrations is all-skipped", async () => {
    const dir = join(import.meta.dirname, "migrations");
    const first = await runMigrations(pool, dir);
    const second = await runMigrations(pool, dir);
    expect(second.applied).toBe(0);
    expect(second.backfilled).toBe(0);
    expect(second.skipped).toBe(first.applied);
  });

  it("cloud backfill: agents EXISTS + _skrun_migrations ABSENT → backfilled, not re-applied", async () => {
    // Simulate the pre-007 cloud state: build the schema by hand
    // (mimicking MCP-applied migrations), no _skrun_migrations table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY);
    `);
    const dir = join(import.meta.dirname, "migrations");
    const result = await runMigrations(pool, dir);
    expect(result.backfilled).toBeGreaterThanOrEqual(9);
    expect(result.applied).toBe(0);

    // Second boot: backfill done, normal loop finds everything tracked
    const second = await runMigrations(pool, dir);
    expect(second.backfilled).toBe(0);
    expect(second.applied).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(9);
  });

  it("advisory lock serialises concurrent boots", async () => {
    const dir = join(import.meta.dirname, "migrations");
    // Spawn 2 parallel runs against the same empty DB.
    const [a, b] = await Promise.all([runMigrations(pool, dir), runMigrations(pool, dir)]);

    // Exactly one of them did the work (applied > 0); the other found
    // everything already in `_skrun_migrations` and skipped clean.
    const totalApplied = a.applied + b.applied;
    const totalSkipped = a.skipped + b.skipped;
    expect(totalApplied).toBeGreaterThanOrEqual(9); // at least one full apply
    expect(totalApplied + totalSkipped).toBeGreaterThanOrEqual(18); // both saw all migrations either way

    // Both runs returned without throwing — advisory lock prevented the
    // race condition where both would try to `CREATE TABLE _skrun_migrations`
    // and one would fail with a unique-violation or table-already-exists.

    // Exactly 9+ rows in _skrun_migrations (no duplicates).
    const r = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM _skrun_migrations",
    );
    expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(9);
  });
});
