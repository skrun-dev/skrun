import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableDatabaseUrl } from "./disposable-database.shared.js";
import {
  lintAllMigrations,
  lintMigration,
  loadMigrationFiles,
  MIGRATION_LOCK_ID,
  type RunResult,
  runMigrations,
} from "./migrations-runner.js";
import { PostgresDb } from "./postgres.js";

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

  it("the cleared-mark migration is present, idempotency-lint clean, and adds one column only", () => {
    const migrations = loadMigrationFiles(join(import.meta.dirname, "migrations"));
    const m020 = migrations.find((m) => m.name === "020_run_content_cleared.sql");
    expect(m020).toBeDefined();
    expect(lintMigration(m020?.name ?? "", m020?.sql ?? "")).toEqual([]);
    // Comments aside, one statement: no index, no default, no other table.
    const statements = (m020?.sql ?? "")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--") && line.trim() !== "")
      .join(" ")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "ALTER TABLE runs ADD COLUMN IF NOT EXISTS content_cleared_at timestamptz",
    ]);
  });

  it("the run quota migration is present, idempotency-lint clean, and adds three columns and two indexes only", () => {
    const migrations = loadMigrationFiles(join(import.meta.dirname, "migrations"));
    const m021 = migrations.find((m) => m.name === "021_run_quota_columns.sql");
    expect(m021).toBeDefined();
    expect(lintMigration(m021?.name ?? "", m021?.sql ?? "")).toEqual([]);
    // Comments aside, five statements: no backfill, no other table.
    const statements = (m021?.sql ?? "")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--") && line.trim() !== "")
      .join(" ")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "ALTER TABLE runs ADD COLUMN IF NOT EXISTS deadline_at timestamptz",
      "ALTER TABLE runs ADD COLUMN IF NOT EXISTS charged_ms bigint",
      "ALTER TABLE runs ADD COLUMN IF NOT EXISTS pool_entitled boolean NOT NULL DEFAULT false",
      "CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs (user_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_runs_running_deadline ON runs (deadline_at) WHERE status = 'running'",
    ]);
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
// local PG. It creates and drops whole databases on that server: run it only
// against a throwaway container started for the purpose, never one that holds
// anything (a self-hosted stack's `skrun` included) — the container and the
// URL `postgres.test.ts` names (`…@127.0.0.1:55432/skrun_test`), for the one
// command. Any other URL is refused (`disposable-database.shared.ts`).
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
// This block creates and drops whole databases on that server: only a
// throwaway Postgres on this machine, its database ending in _test, may be
// named (`disposable-database.shared.ts`; the suite's global setup judges it too).
if (HAS_PG_INTEGRATION) {
  assertDisposableDatabaseUrl(DATABASE_URL as string, "migrations-runner.test.ts");
}
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
  let ownUrl: string;
  let maintenanceUrl: string;

  beforeAll(async () => {
    const derived = deriveDatabases(DATABASE_URL as string);
    ownName = derived.ownName;
    ownUrl = derived.ownUrl;
    maintenanceUrl = derived.maintenanceUrl;

    const admin = new Pool({ connectionString: maintenanceUrl });
    try {
      await admin.query(`CREATE DATABASE ${quoteIdent(ownName)}`);
    } catch (err) {
      // 42P04 = duplicate_database: a previous run was interrupted before
      // its afterAll could drop it. Reusing it is safe — every test here
      // starts by wiping the public schema.
      if ((err as { code?: string }).code !== "42P04") throw err;
      // A setting of the database itself is not wiped with the schema: the one
      // a case below sets, left behind by an interrupted run, is undone.
      await admin.query(`ALTER DATABASE ${quoteIdent(ownName)} RESET ALL`);
    } finally {
      await admin.end();
    }

    pool = new Pool({ connectionString: ownUrl });
  });

  // The hook's own timeout is raised: DROP DATABASE waits for an immediate
  // checkpoint, which syncs every file the contract in postgres.test.ts has
  // created meanwhile on the same server — measured on a local throwaway
  // container (Docker Desktop): about 8,400 files, 10 s, and up to 40 s, past
  // the 10 s default, with every test of this block green.
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
  }, 120_000);

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

  // ── The migrations' own connection ──────────────────────────────────
  //
  // The adapter's pool bounds each statement it sends; a migration — or the
  // wait for another instance's lock — may rightly run longer. The migrations
  // run on a connection of their own, without the pool's bounds, and the
  // pool's connections keep theirs.

  it("a migration longer than the pool's bound applies, a second run waits for the lock without being cut, and the pool's connections keep their bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-migrations-slow-"));
    const own = new PostgresDb(ownUrl, {}, { statementTimeoutMs: 1_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      }
      // Past the pool's bound and its client's timer (1 s, then 5 s more).
      writeFileSync(join(dir, "999_slow.sql"), "SELECT pg_sleep(7);\n");
      const total = readdirSync(dir).length;
      const timed = async () => {
        const started = Date.now();
        const result = await runMigrations(own.getPool(), dir);
        return { ...result, elapsedMs: Date.now() - started };
      };

      const raced = await Promise.race([
        Promise.allSettled([timed(), timed()]),
        new Promise<"still pending">((resolve) => {
          timer = setTimeout(() => resolve("still pending"), 30_000);
        }),
      ]);
      expect(
        raced === "still pending"
          ? raced
          : raced.map((r) =>
              r.status === "fulfilled" ? r.status : `rejected: ${(r.reason as Error)?.message}`,
            ),
      ).toEqual(["fulfilled", "fulfilled"]);
      const [first, second] = (
        raced as Array<PromiseFulfilledResult<RunResult & { elapsedMs: number }>>
      )
        .map((r) => r.value)
        .sort((a, b) => b.applied - a.applied);
      expect(first).toMatchObject({ applied: total, skipped: 0 });
      // The second waited for the lock — the slow migration included —, and was not cut.
      expect(second).toMatchObject({ applied: 0, skipped: total });
      expect(second.elapsedMs).toBeGreaterThanOrEqual(6_000);

      // A connection of the pool still carries its bound.
      const client = await own.getPool().connect();
      try {
        const shown = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
        expect(shown.rows[0].statement_timeout).toBe("1s");
      } finally {
        client.release();
      }
    } finally {
      clearTimeout(timer);
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  // A session the server ends while the migrations hold their connection —
  // here, while they wait for the lock another instance holds — arrives as an
  // error event of that connection, outside any query's answer: nobody
  // listening, an uncaught exception, the process's end.
  it("a migration run whose session is ended while it waits for the lock rejects, with no uncaught exception", async () => {
    const locker = new Client({ connectionString: ownUrl });
    await locker.connect();
    const query = vi.spyOn(Client.prototype, "query");
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    let pending: Promise<unknown> | undefined;
    try {
      await locker.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID.toString()]);
      pending = runMigrations(pool, MIGRATIONS_DIR).then(
        () => "fulfilled",
        (err: unknown) => err,
      );
      // The migrations' session, waiting for the lock.
      const pid = await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE 'SELECT pg_advisory_lock(%'`,
          );
          expect(waiting.rows).toHaveLength(1);
          return waiting.rows[0].pid;
        },
        { timeout: 5_000, interval: 50 },
      );
      // Meanwhile, the connection it holds listens for its session's end.
      const holder = query.mock.contexts.find(
        (context, i) =>
          context !== locker &&
          String(query.mock.calls[i]?.[0]).startsWith("SELECT pg_advisory_lock("),
      ) as Client | undefined;
      expect(holder?.listenerCount("error")).toBeGreaterThanOrEqual(1);

      const ended = await pool.query<{ ended: boolean }>(
        "SELECT pg_terminate_backend($1) AS ended",
        [pid],
      );
      expect(ended.rows[0]?.ended).toBe(true);
      const outcome = (await pending) as { code?: unknown; message?: unknown };
      expect(
        outcome.code === "57P01" || outcome.message === "Connection terminated unexpectedly",
        `rejected with the session's end: ${String(outcome.code)} ${String(outcome.message)}`,
      ).toBe(true);
      expect(uncaught).toEqual([]);
    } finally {
      await locker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await locker.end();
      await pending;
      process.off("uncaughtException", onUncaught);
      query.mockRestore();
    }
  }, 15_000);

  // A migration whose session the server ends while it runs: its ROLLBACK,
  // sent on a connection already gone, fails too — the run still says which
  // migration failed, and why.
  it("a migration whose session is ended while it runs is still named in the error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-migrations-lost-"));
    let pending: Promise<unknown> | undefined;
    try {
      writeFileSync(join(dir, "001_lost.sql"), "SELECT pg_sleep(30);\n");
      pending = runMigrations(pool, dir).then(
        () => "fulfilled",
        (err: unknown) => err,
      );
      // The migrations' session, running the migration.
      const pid = await vi.waitFor(
        async () => {
          const running = await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND query LIKE 'SELECT pg_sleep(30)%'`,
          );
          expect(running.rows).toHaveLength(1);
          return running.rows[0].pid;
        },
        { timeout: 5_000, interval: 50 },
      );
      const ended = await pool.query<{ ended: boolean }>(
        "SELECT pg_terminate_backend($1) AS ended",
        [pid],
      );
      expect(ended.rows[0]?.ended).toBe(true);

      const outcome = (await pending) as { message?: unknown };
      expect(String(outcome.message)).toMatch(/^Migration 001_lost\.sql failed: /);
    } finally {
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // A host may give every new session of a database — or of a role — a
  // statement bound of its own. The migrations' connection lifts any bound on
  // its statements, a host's included. Set here on this block's database alone
  // (never on its role, which every database of the server shares), and undone
  // at the end of the case.
  it("a migration longer than a statement bound the database gives its sessions applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-migrations-host-bound-"));
    const admin = new Client({ connectionString: maintenanceUrl });
    await admin.connect();
    const target = new Pool({ connectionString: ownUrl });
    try {
      await admin.query(`ALTER DATABASE ${quoteIdent(ownName)} SET statement_timeout = '1s'`);
      // A new session of this database starts with that bound.
      const shown = await target.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(shown.rows[0].statement_timeout).toBe("1s");

      writeFileSync(join(dir, "001_slow.sql"), "SELECT pg_sleep(2);\n");
      const outcome = await runMigrations(target, dir).then(
        (result) => result,
        (err: unknown) => `rejected: ${(err as Error)?.message}`,
      );
      expect(outcome).toEqual({ applied: 1, backfilled: 0, skipped: 0 });
    } finally {
      await admin.query(`ALTER DATABASE ${quoteIdent(ownName)} RESET statement_timeout`);
      await admin.end();
      await target.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // A pool given its settings one by one rather than by a URL holds its
  // password in its options alone, which keep it out of their enumerable keys.
  // The migrations' connection, opened from those options, reads it apart.
  it("a pool given its password apart from a URL runs its migrations", async () => {
    // Nothing in the environment stands in for the password the pool holds.
    expect(process.env.PGPASSWORD).toBeUndefined();
    const url = new URL(ownUrl);
    const byParts = new Pool({
      host: url.hostname,
      port: Number(url.port || "5432"),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: ownName,
    });
    const dir = mkdtempSync(join(tmpdir(), "skrun-migrations-by-parts-"));
    try {
      expect(Object.keys(byParts.options)).not.toContain("password");
      writeFileSync(
        join(dir, "001_marker.sql"),
        "CREATE TABLE IF NOT EXISTS migration_marker (id INT);\n",
      );
      const outcome = await runMigrations(byParts, dir).then(
        (result) => result,
        (err: unknown) => `rejected: ${(err as Error)?.message}`,
      );
      expect(outcome).toEqual({ applied: 1, backfilled: 0, skipped: 0 });
    } finally {
      await byParts.end();
      rmSync(dir, { recursive: true, force: true });
    }
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
    // Build, in a temp directory, the state every instance deployed before the
    // sessions migration boots from: the files that sort before it, in the
    // runner's own order. "Every file but this one" stopped being that state
    // once a later migration existed — no such instance ever ran one, and a
    // later one may need the sessions table. The second run then sees exactly
    // one file on top, so "exactly one more" holds whatever migrations follow.
    const partialDir = mkdtempSync(join(tmpdir(), "skrun-migrations-partial-"));
    try {
      const earlier = readdirSync(MIGRATIONS_DIR).filter(
        (f) => f.endsWith(".sql") && f < SESSIONS_MIGRATION,
      );
      for (const f of earlier) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(partialDir, f));
      }

      const before = await runMigrations(pool, partialDir);
      expect(before.applied).toBe(earlier.length);
      const tablesBefore = await publicTables();
      expect(tablesBefore).not.toContain("sessions");

      copyFileSync(join(MIGRATIONS_DIR, SESSIONS_MIGRATION), join(partialDir, SESSIONS_MIGRATION));
      const result = await runMigrations(pool, partialDir);
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

  // ── The agent state migration ───────────────────────────────────────
  //
  // It empties the state table: a row of the earlier shape names neither the
  // agent's id nor a caller. Run again by hand, it must leave the new table —
  // and what was written to it since — alone.

  const STATE_MIGRATION = "019_agent_state_per_caller.sql";

  async function stateColumns(): Promise<Array<{ column_name: string; is_nullable: string }>> {
    const r = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_state'
        ORDER BY ordinal_position`,
    );
    return r.rows;
  }

  async function stateRowCount(): Promise<number> {
    const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM agent_state");
    return r.rows[0].n;
  }

  it("a database carrying the earlier state table comes out of the state migration with that table empty and at the new shape; run again by hand, it keeps what was written since", async () => {
    const partialDir = mkdtempSync(join(tmpdir(), "skrun-migrations-state-"));
    try {
      const earlier = readdirSync(MIGRATIONS_DIR).filter(
        (f) => f.endsWith(".sql") && f < STATE_MIGRATION,
      );
      for (const f of earlier) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(partialDir, f));
      }
      expect((await runMigrations(pool, partialDir)).applied).toBe(earlier.length);

      // The earlier table: keyed by a text agent id, no caller, no deadline.
      expect((await stateColumns()).map((c) => c.column_name)).toEqual([
        "agent_id",
        "state",
        "updated_at",
      ]);
      const userId = "44444444-4444-4444-4444-444444444444";
      const agentId = "55555555-5555-5555-5555-555555555555";
      await pool.query("INSERT INTO users (id, github_id, username) VALUES ($1, 'st', 'st')", [
        userId,
      ]);
      await pool.query(
        "INSERT INTO agents (id, namespace, name, owner_id) VALUES ($1, 'st', 'notes', $2)",
        [agentId, userId],
      );
      // One row naming a live agent, and one orphan naming none.
      await pool.query(
        `INSERT INTO agent_state (agent_id, state) VALUES
           ($1, '{"secret":"from before"}'::jsonb),
           ('st/gone', '{"n":1}'::jsonb)`,
        [agentId],
      );
      const tablesBefore = await publicTables();

      copyFileSync(join(MIGRATIONS_DIR, STATE_MIGRATION), join(partialDir, STATE_MIGRATION));
      const result = await runMigrations(pool, partialDir);
      expect(result.applied).toBe(1);
      expect(result.backfilled).toBe(0);
      expect(result.skipped).toBe(earlier.length);

      // Empty, at the new shape, and no other table holds the earlier rows.
      expect(await stateRowCount()).toBe(0);
      expect(await stateColumns()).toEqual([
        { column_name: "agent_id", is_nullable: "NO" },
        { column_name: "partition_key", is_nullable: "NO" },
        { column_name: "caller_user_id", is_nullable: "YES" },
        { column_name: "caller_key_id", is_nullable: "YES" },
        { column_name: "state", is_nullable: "NO" },
        { column_name: "updated_at", is_nullable: "NO" },
        { column_name: "expires_at", is_nullable: "NO" },
      ]);
      expect(await publicTables()).toEqual(tablesBefore);
      const foreignKeys = await pool.query<{ refers_to: string; on_delete: string }>(
        `SELECT ccu.table_name AS refers_to, rc.delete_rule AS on_delete
           FROM information_schema.table_constraints tc
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.table_schema = 'public' AND tc.table_name = 'agent_state'
            AND tc.constraint_type = 'FOREIGN KEY'`,
      );
      expect(foreignKeys.rows.map((fk) => `${fk.refers_to} ${fk.on_delete}`).sort()).toEqual([
        "agents CASCADE",
        "api_keys CASCADE",
        "users CASCADE",
      ]);

      // A notebook written at the new shape, then the file run again by hand.
      await pool.query(
        `INSERT INTO agent_state (agent_id, partition_key, caller_user_id, state, expires_at)
         VALUES ($1, 'account:' || $2::uuid::text, $2, '{"written":"since"}'::jsonb, now() + interval '1 day')`,
        [agentId, userId],
      );
      const sql = readFileSync(join(MIGRATIONS_DIR, STATE_MIGRATION), "utf8");
      await expect(pool.query(sql)).resolves.toBeDefined();
      const kept = await pool.query<{ written: string }>(
        "SELECT state->>'written' AS written FROM agent_state",
      );
      expect(kept.rows).toEqual([{ written: "since" }]);
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  // ── The cleared-mark migration ──────────────────────────────────────

  const CLEARED_MIGRATION = "020_run_content_cleared.sql";

  async function clearedColumn(): Promise<
    Array<{ data_type: string; is_nullable: string; column_default: string | null }>
  > {
    const r = await pool.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'content_cleared_at'`,
    );
    return r.rows;
  }

  const CLEARED_SHAPE = [
    { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
  ];

  it("a fresh database gets the cleared-mark column on runs: a timestamp, nullable, no default", async () => {
    await runMigrations(pool, MIGRATIONS_DIR);
    expect(await clearedColumn()).toEqual(CLEARED_SHAPE);
  });

  it("a database at the state migration applies exactly the cleared-mark one, keeps its runs unmarked, and a second run by hand changes nothing", async () => {
    const partialDir = mkdtempSync(join(tmpdir(), "skrun-migrations-cleared-"));
    try {
      const earlier = readdirSync(MIGRATIONS_DIR).filter(
        (f) => f.endsWith(".sql") && f < CLEARED_MIGRATION,
      );
      for (const f of earlier) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(partialDir, f));
      }
      expect(earlier).toContain(STATE_MIGRATION);
      expect((await runMigrations(pool, partialDir)).applied).toBe(earlier.length);
      expect(await clearedColumn()).toEqual([]);
      const runId = "66666666-6666-6666-6666-666666666666";
      await pool.query(
        "INSERT INTO runs (id, agent_version, status) VALUES ($1, '1.0.0', 'completed')",
        [runId],
      );
      const tablesBefore = await publicTables();

      copyFileSync(join(MIGRATIONS_DIR, CLEARED_MIGRATION), join(partialDir, CLEARED_MIGRATION));
      const result = await runMigrations(pool, partialDir);
      expect(result.applied).toBe(1);
      expect(result.backfilled).toBe(0);
      expect(result.skipped).toBe(earlier.length);
      expect(await clearedColumn()).toEqual(CLEARED_SHAPE);
      expect(await publicTables()).toEqual(tablesBefore);
      const before = await pool.query<{ content_cleared_at: unknown }>(
        "SELECT content_cleared_at FROM runs WHERE id = $1",
        [runId],
      );
      expect(before.rows).toEqual([{ content_cleared_at: null }]);

      // Run again by hand, over a marked run: the mark stays.
      await pool.query("UPDATE runs SET content_cleared_at = now() WHERE id = $1", [runId]);
      const sql = readFileSync(join(MIGRATIONS_DIR, CLEARED_MIGRATION), "utf8");
      await expect(pool.query(sql)).resolves.toBeDefined();
      expect(await clearedColumn()).toEqual(CLEARED_SHAPE);
      const kept = await pool.query<{ marked: boolean }>(
        "SELECT content_cleared_at IS NOT NULL AS marked FROM runs WHERE id = $1",
        [runId],
      );
      expect(kept.rows).toEqual([{ marked: true }]);
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  // ── The run quota migration ─────────────────────────────────────────

  const QUOTA_MIGRATION = "021_run_quota_columns.sql";

  async function quotaColumns(): Promise<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  > {
    const r = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runs'
          AND column_name IN ('deadline_at', 'charged_ms', 'pool_entitled')
        ORDER BY column_name`,
    );
    return r.rows;
  }

  async function quotaIndexes(): Promise<Array<{ indexname: string; indexdef: string }>> {
    const r = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'runs'
          AND indexname IN ('idx_runs_user_created', 'idx_runs_running_deadline')
        ORDER BY indexname`,
    );
    return r.rows;
  }

  const QUOTA_COLUMNS = [
    { column_name: "charged_ms", data_type: "bigint", is_nullable: "YES", column_default: null },
    {
      column_name: "deadline_at",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      column_default: null,
    },
    {
      column_name: "pool_entitled",
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    },
  ];

  const QUOTA_INDEXES = [
    {
      indexname: "idx_runs_running_deadline",
      indexdef:
        "CREATE INDEX idx_runs_running_deadline ON public.runs USING btree (deadline_at) WHERE (status = 'running'::text)",
    },
    {
      indexname: "idx_runs_user_created",
      indexdef:
        "CREATE INDEX idx_runs_user_created ON public.runs USING btree (user_id, created_at)",
    },
  ];

  it("a fresh database gets the run quota columns and their two indexes, the deadline one partial on running runs", async () => {
    await runMigrations(pool, MIGRATIONS_DIR);
    expect(await quotaColumns()).toEqual(QUOTA_COLUMNS);
    expect(await quotaIndexes()).toEqual(QUOTA_INDEXES);
  });

  it("a database at the cleared-mark migration applies exactly the quota one: its runs hold no deadline, no charged time, no right to the pool, and a second run by hand changes nothing", async () => {
    const partialDir = mkdtempSync(join(tmpdir(), "skrun-migrations-quota-"));
    try {
      const earlier = readdirSync(MIGRATIONS_DIR).filter(
        (f) => f.endsWith(".sql") && f < QUOTA_MIGRATION,
      );
      for (const f of earlier) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(partialDir, f));
      }
      expect(earlier).toContain(CLEARED_MIGRATION);
      expect((await runMigrations(pool, partialDir)).applied).toBe(earlier.length);
      expect(await quotaColumns()).toEqual([]);
      const runId = "77777777-7777-7777-7777-777777777777";
      await pool.query(
        "INSERT INTO runs (id, agent_version, status) VALUES ($1, '1.0.0', 'running')",
        [runId],
      );
      const tablesBefore = await publicTables();

      copyFileSync(join(MIGRATIONS_DIR, QUOTA_MIGRATION), join(partialDir, QUOTA_MIGRATION));
      const result = await runMigrations(pool, partialDir);
      expect(result.applied).toBe(1);
      expect(result.backfilled).toBe(0);
      expect(result.skipped).toBe(earlier.length);
      expect(await quotaColumns()).toEqual(QUOTA_COLUMNS);
      expect(await quotaIndexes()).toEqual(QUOTA_INDEXES);
      expect(await publicTables()).toEqual(tablesBefore);
      const before = await pool.query(
        "SELECT deadline_at, charged_ms, pool_entitled FROM runs WHERE id = $1",
        [runId],
      );
      expect(before.rows).toEqual([{ deadline_at: null, charged_ms: null, pool_entitled: false }]);

      // Run again by hand, over a run that holds all three: they stay.
      await pool.query(
        "UPDATE runs SET deadline_at = now(), charged_ms = 1500, pool_entitled = true WHERE id = $1",
        [runId],
      );
      const sql = readFileSync(join(MIGRATIONS_DIR, QUOTA_MIGRATION), "utf8");
      await expect(pool.query(sql)).resolves.toBeDefined();
      expect(await quotaColumns()).toEqual(QUOTA_COLUMNS);
      expect(await quotaIndexes()).toEqual(QUOTA_INDEXES);
      const kept = await pool.query(
        "SELECT deadline_at IS NOT NULL AS dated, charged_ms::int AS charged, pool_entitled FROM runs WHERE id = $1",
        [runId],
      );
      expect(kept.rows).toEqual([{ dated: true, charged: 1500, pool_entitled: true }]);
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });
});
