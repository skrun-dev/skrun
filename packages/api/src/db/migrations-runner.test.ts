import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
//
// This block runs against its OWN database, created here and dropped here
// — never the one `DATABASE_URL` points at. Reason, measured rather than
// assumed: this file and `postgres.test.ts` both do
// `DROP SCHEMA public CASCADE` for a clean slate, vitest runs test files
// in parallel, and nothing serialises them. Sharing one database means one
// file destroys the schema while the other is mid-test, and the pooled
// connections of the second point at relations that no longer exist. The
// failures that produces are real but look random, and they land on tests
// that have nothing to do with the change being made. Running the whole
// `@skrun-dev/api` suite with `DATABASE_URL` set showed it directly: the
// shared-database arrangement failed, the dedicated-database one did not.
//
// Assumption: the `DATABASE_URL` role may create and drop a database. True
// for the `postgres` superuser used in CI and in the local throwaway
// container. A role without that right will see this block fail loudly at
// setup, which is the right outcome — silently falling back to the shared
// database would restore the race.

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_PG_INTEGRATION = !!DATABASE_URL && /^postgres(ql)?:\/\//.test(DATABASE_URL);
const describeIfPg = HAS_PG_INTEGRATION ? describe : describe.skip;

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");
const SESSIONS_MIGRATION = "017_sessions.sql";

/** Quote a Postgres identifier — database names cannot be bound as parameters. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Derive this block's own database from `DATABASE_URL`: same server, same
 * credentials, a `_migrations` suffix on the database name. The maintenance
 * URL points at `postgres`, because `CREATE DATABASE` cannot run from inside
 * the database it creates.
 */
function deriveDatabases(url: string): {
  ownName: string;
  ownUrl: string;
  maintenanceUrl: string;
} {
  const parsed = new URL(url);
  const base = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";
  const ownName = `${base}_migrations`;

  const own = new URL(url);
  own.pathname = `/${encodeURIComponent(ownName)}`;

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";

  return { ownName, ownUrl: own.toString(), maintenanceUrl: maintenance.toString() };
}

describeIfPg("migrations-runner integration: runMigrations against real PG", () => {
  let pool: Pool;
  let ownName: string;
  let maintenanceUrl: string;

  beforeAll(async () => {
    const derived = deriveDatabases(DATABASE_URL as string);
    ownName = derived.ownName;
    maintenanceUrl = derived.maintenanceUrl;

    const admin = new Pool({ connectionString: maintenanceUrl });
    try {
      await admin.query(`CREATE DATABASE ${quoteIdent(ownName)}`);
    } catch (err) {
      // 42P04 = duplicate_database: a previous run was interrupted before
      // its afterAll could drop it. Reusing it is safe — every test here
      // starts by wiping the public schema.
      if ((err as { code?: string }).code !== "42P04") throw err;
    } finally {
      await admin.end();
    }

    pool = new Pool({ connectionString: derived.ownUrl });
  });

  afterAll(async () => {
    await pool.end();
    const admin = new Pool({ connectionString: maintenanceUrl });
    try {
      // WITH (FORCE) terminates any connection left behind, so the drop
      // cannot hang waiting on one (Postgres 13+; CI and local are 16).
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(ownName)} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    // Wipe public schema for a clean slate. Safe by construction: the
    // database this pool points at was created by `beforeAll` above and is
    // dropped by `afterAll` — it never holds anything else.
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

  // ── The sessions migration ──────────────────────────────────────────
  //
  // These three assert on the SHAPE the migration leaves behind, not merely
  // that it ran. In particular they name the index: an absent index breaks
  // nothing at all — it only makes the hourly sweep grow with the user
  // count — so nothing but a named assertion would ever report it missing.

  async function publicTables(): Promise<string[]> {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return r.rows.map((row) => row.table_name);
  }

  it("VT-1 (#124): a fresh DB gets the sessions table, its 4 columns and its index", async () => {
    await runMigrations(pool, MIGRATIONS_DIR);

    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions'
        ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "created_at",
      "expires_at",
      "id_hash",
      "user_id",
    ]);
    expect(cols.rows.every((r) => r.is_nullable === "NO")).toBe(true);

    const idx = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'sessions'",
    );
    expect(idx.rows.map((r) => r.indexname)).toContain("sessions_expires_at_idx");
  });

  it("VT-2 (#124): a DB carrying every earlier migration applies exactly one more", async () => {
    // Build the "everything but the sessions migration" state from a temp
    // directory, so the second run has exactly one file left to do — which
    // is the state every already-deployed instance will boot from.
    const partialDir = mkdtempSync(join(tmpdir(), "skrun-migrations-partial-"));
    try {
      const earlier = readdirSync(MIGRATIONS_DIR).filter(
        (f) => f.endsWith(".sql") && f !== SESSIONS_MIGRATION,
      );
      for (const f of earlier) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(partialDir, f));
      }

      const before = await runMigrations(pool, partialDir);
      expect(before.applied).toBe(earlier.length);
      const tablesBefore = await publicTables();
      expect(tablesBefore).not.toContain("sessions");

      const result = await runMigrations(pool, MIGRATIONS_DIR);
      expect(result.applied).toBe(1);
      expect(result.backfilled).toBe(0);
      expect(result.skipped).toBe(earlier.length);

      // No existing table was touched: the set gained `sessions`, nothing else.
      expect(await publicTables()).toEqual([...tablesBefore, "sessions"].sort());
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  it("VT-3 (#124): a second run after the sessions migration applies nothing", async () => {
    await runMigrations(pool, MIGRATIONS_DIR);
    const second = await runMigrations(pool, MIGRATIONS_DIR);
    expect(second.applied).toBe(0);
    expect(second.backfilled).toBe(0);

    // Recorded exactly once — a re-apply would have thrown before reaching here.
    const r = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM _skrun_migrations WHERE name = $1",
      [SESSIONS_MIGRATION],
    );
    expect(Number(r.rows[0].count)).toBe(1);
  });
});
