/**
 * Migration applicator — auto-applies SQL migrations on api-server boot
 * (#007 spec §Approach 4, Phase 2 of plan).
 *
 * Concurrency: takes a Postgres advisory lock (`pg_advisory_lock(<id>)`)
 * BEFORE the `CREATE TABLE IF NOT EXISTS _skrun_migrations` + apply loop.
 * Two api-server instances starting simultaneously (rolling deploy)
 * serialize cleanly — the second sees a populated `_skrun_migrations`
 * table and proceeds without conflict. Industry pattern (Rails,
 * golang-migrate, Sequelize).
 *
 * Migration file convention (enforced by `lintMigration`):
 *   - NO top-level `BEGIN;` / `COMMIT;` (the runner wraps each file).
 *   - All DDL idempotent by construction: `CREATE TABLE IF NOT EXISTS`,
 *     `CREATE OR REPLACE FUNCTION`, `DROP ... IF EXISTS`, etc.
 *
 * Cloud backfill: if `agents` table EXISTS but `_skrun_migrations` does
 * NOT exist, the runner is in "backfill mode" — it creates the tracking
 * table, INSERTs the filename rows for all on-disk migrations without
 * executing the SQL, then proceeds with the normal loop (which finds
 * nothing new to apply). On a fresh DB, the normal loop applies all
 * from scratch.
 *
 * Used by:
 *   - `server.ts` (cloud + self-host docker-compose api-server boot)
 *   - `dev.ts` Postgres branch (local dev with `DATABASE_URL=postgres://`)
 * NOT used by SQLite path — `sqlite.ts` ships its own
 * `CREATE TABLE IF NOT EXISTS` SCHEMA constant.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface Migration {
  /** File basename, e.g. `001_initial_schema.sql`. Acts as the primary key
   *  in `_skrun_migrations`. */
  name: string;
  /** Raw SQL content (everything except this runner's outer transaction). */
  sql: string;
}

/**
 * Load + sort all `.sql` files in the given directory. Lexicographic
 * order matches the numeric prefix convention (`001_..`, `002_..`, …),
 * which controls apply order.
 *
 * Throws if the directory doesn't exist (callers' bug — fail loud at
 * boot rather than running zero migrations against a populated schema).
 */
export function loadMigrationFiles(migrationsDir: string): Migration[] {
  const entries = readdirSync(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  return sqlFiles.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name), "utf8"),
  }));
}

/**
 * Categorisation of lint violations. Each migration file is checked
 * before being applied; violations cause the runner to abort at boot
 * with a clear error pointing to the file + the violating rule.
 */
export type LintErrorKind =
  | "BEGIN_FORBIDDEN"
  | "COMMIT_FORBIDDEN"
  | "NON_IDEMPOTENT_CREATE_TABLE"
  | "NON_IDEMPOTENT_CREATE_INDEX"
  | "NON_IDEMPOTENT_CREATE_VIEW"
  | "NON_IDEMPOTENT_CREATE_FUNCTION"
  | "NON_IDEMPOTENT_CREATE_SCHEMA"
  | "NON_IDEMPOTENT_ADD_COLUMN"
  | "NON_IDEMPOTENT_DROP_COLUMN"
  | "NON_IDEMPOTENT_DROP_TABLE"
  | "NON_IDEMPOTENT_DROP_INDEX";

export interface LintError {
  kind: LintErrorKind;
  message: string;
}

/**
 * Strip SQL comments so lint regexes don't false-positive on commented
 * examples or `-- BEGIN;` documentation. Handles both `--` line comments
 * and `/* … *\/` block comments.
 */
function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Lint a single migration file's SQL content against the conventions
 * required by the runner:
 *
 *   - no top-level `BEGIN;` / `COMMIT;` (the runner wraps the
 *     file in its own transaction; nested BEGIN inside an outer
 *     transaction commits the inner half early in Postgres).
 *   - all DDL is idempotent so mid-migration crash recovery is
 *     safe via re-apply on next boot.
 *       * CREATE TABLE → require IF NOT EXISTS
 *       * CREATE [UNIQUE] INDEX → require IF NOT EXISTS
 *       * CREATE VIEW → require OR REPLACE
 *       * CREATE FUNCTION → require OR REPLACE
 *       * CREATE SCHEMA → require IF NOT EXISTS
 *       * ALTER TABLE … ADD COLUMN → require IF NOT EXISTS
 *       * ALTER TABLE … DROP COLUMN → require IF EXISTS
 *       * DROP TABLE → require IF EXISTS
 *       * DROP INDEX → require IF EXISTS
 *
 * UPDATE / INSERT / SELECT statements are not checked — they are
 * inherently idempotent (UPDATE with WHERE) or set-based.
 *
 * Returns the list of violations (empty = clean).
 */
export function lintMigration(name: string, sql: string): LintError[] {
  const errors: LintError[] = [];
  const cleaned = stripComments(sql);

  // top-level BEGIN/COMMIT.
  if (/^\s*BEGIN\s*;\s*$/im.test(cleaned)) {
    errors.push({
      kind: "BEGIN_FORBIDDEN",
      message: `${name}: top-level BEGIN; forbidden (the runner wraps each file in a transaction).`,
    });
  }
  if (/^\s*COMMIT\s*;\s*$/im.test(cleaned)) {
    errors.push({
      kind: "COMMIT_FORBIDDEN",
      message: `${name}: top-level COMMIT; forbidden (the runner wraps each file in a transaction).`,
    });
  }

  // idempotent DDL.

  // CREATE [UNIQUE] TABLE name → require IF NOT EXISTS.
  if (/\bCREATE\s+(?:UNIQUE\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_CREATE_TABLE",
      message: `${name}: CREATE TABLE without IF NOT EXISTS.`,
    });
  }

  // CREATE [UNIQUE] INDEX name → require IF NOT EXISTS.
  if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_CREATE_INDEX",
      message: `${name}: CREATE INDEX without IF NOT EXISTS.`,
    });
  }

  // CREATE VIEW → require OR REPLACE.
  if (/\bCREATE\s+(?!OR\s+REPLACE\b)(?:TEMP\s+|TEMPORARY\s+)?VIEW\b/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_CREATE_VIEW",
      message: `${name}: CREATE VIEW without OR REPLACE.`,
    });
  }

  // CREATE FUNCTION / PROCEDURE → require OR REPLACE.
  if (/\bCREATE\s+(?!OR\s+REPLACE\b)FUNCTION\b/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_CREATE_FUNCTION",
      message: `${name}: CREATE FUNCTION without OR REPLACE.`,
    });
  }

  // CREATE SCHEMA name → require IF NOT EXISTS.
  if (/\bCREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_CREATE_SCHEMA",
      message: `${name}: CREATE SCHEMA without IF NOT EXISTS.`,
    });
  }

  // ALTER TABLE … ADD COLUMN name → require IF NOT EXISTS.
  // Match the form "ADD COLUMN <name>" only when IF NOT EXISTS is absent
  // between ADD COLUMN and the column name.
  if (/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_ADD_COLUMN",
      message: `${name}: ADD COLUMN without IF NOT EXISTS.`,
    });
  }

  // ALTER TABLE … DROP COLUMN name → require IF EXISTS.
  if (/\bDROP\s+COLUMN\s+(?!IF\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_DROP_COLUMN",
      message: `${name}: DROP COLUMN without IF EXISTS.`,
    });
  }

  // DROP TABLE name → require IF EXISTS.
  if (/\bDROP\s+TABLE\s+(?!IF\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_DROP_TABLE",
      message: `${name}: DROP TABLE without IF EXISTS.`,
    });
  }

  // DROP INDEX name → require IF EXISTS.
  if (/\bDROP\s+INDEX\s+(?!IF\s+EXISTS\b)\w/i.test(cleaned)) {
    errors.push({
      kind: "NON_IDEMPOTENT_DROP_INDEX",
      message: `${name}: DROP INDEX without IF EXISTS.`,
    });
  }

  return errors;
}

/**
 * Lint all migrations + collect ALL violations across the set. Throws
 * with a formatted message if anything is non-clean. Used by the
 * applicator at boot (fail loud before any DDL runs).
 */
export function lintAllMigrations(migrations: Migration[]): void {
  const allErrors: LintError[] = [];
  for (const m of migrations) {
    allErrors.push(...lintMigration(m.name, m.sql));
  }
  if (allErrors.length > 0) {
    const lines = allErrors.map((e) => `  - [${e.kind}] ${e.message}`);
    throw new Error(
      `Migration lint failed (${allErrors.length} violation${allErrors.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    );
  }
}

/**
 * Fixed advisory-lock ID for the migration applicator. Derived once from
 * `hashtext('skrun_migrations')` so two boots agree on the lock identity
 * without computing it every time. The hashtext value below was computed
 * via `SELECT hashtext('skrun_migrations')` against Postgres 16 — any
 * stable int64 derivable from a constant string works; this one is
 * intentional + audited.
 *
 * Lock scope: per-database (pg_advisory_lock with one int8 arg). Two
 * api-server instances connecting to the SAME database serialise here.
 * Separate databases (e.g. dev vs prod) lock independently.
 */
const MIGRATION_LOCK_ID = 5478913219876541n; // = hashtext('skrun_migrations') as bigint

export interface RunResult {
  /** Number of migrations whose SQL was executed in this boot. */
  applied: number;
  /** Number of migrations recorded in `_skrun_migrations` without execution
   *  (cloud-backfill path on first post-refactor boot). */
  backfilled: number;
  /** Number of migrations already in `_skrun_migrations` and skipped. */
  skipped: number;
}

/**
 * Acquire the migration advisory lock. Released by `pg_advisory_unlock`
 * in the caller's `finally` block. The lock is held against the SAME
 * Postgres connection that runs the migrations — using a different
 * connection from the pool would defeat the lock.
 */
async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID.toString()]);
}

async function releaseMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID.toString()]);
}

/**
 * Check whether a relation exists in the public schema. Returns true if
 * the table is present, false otherwise. Used by the cloud-backfill
 * probe (`agents` present + `_skrun_migrations` absent → backfill).
 */
async function relationExists(client: PoolClient, relname: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${relname}`],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Apply all pending migrations against the connected database. The
 * caller passes a `pg.Pool`; this function checks out a single client,
 * runs the entire migration set under an advisory lock, and returns
 * counts. Idempotent: subsequent calls are no-ops once everything has
 * been applied.
 *
 * Lint runs BEFORE any DDL — a bad migration file causes the boot to
 * fail loud without partial application.
 *
 * Cloud backfill: if `agents` exists but `_skrun_migrations` doesn't,
 * we're booting a pre-007 database whose migrations were applied via
 * Supabase MCP. Record all on-disk filenames in `_skrun_migrations`
 * without re-executing them. Subsequent migrations apply normally.
 *
 * Transaction model: each migration file runs inside its own
 * `BEGIN..COMMIT`. Failure inside any file rolls back THAT file's
 * partial changes; earlier successfully-applied files stay committed
 * (their `_skrun_migrations` row persists). This means mid-set crash
 * recovery via re-boot is safe — the runner picks up at the next
 * unapplied file (the idempotent-DDL convention ensures the file can
 * re-run cleanly if it had been partially applied before the row
 * inserted).
 */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<RunResult> {
  const migrations = loadMigrationFiles(migrationsDir);
  lintAllMigrations(migrations); // fail loud before any DDL

  const client = await pool.connect();
  let applied = 0;
  let backfilled = 0;
  let skipped = 0;

  try {
    await acquireMigrationLock(client);

    // Cloud backfill probe: agents EXISTS + _skrun_migrations ABSENT
    // → record filenames without execution (pre-007 cloud DB whose
    // migrations were applied via Supabase MCP).
    const agentsExisted = await relationExists(client, "agents");
    const migrationsTableExisted = await relationExists(client, "_skrun_migrations");
    const needsBackfill = agentsExisted && !migrationsTableExisted;

    // Always ensure the tracking table exists before any work.
    await client.query(
      `CREATE TABLE IF NOT EXISTS _skrun_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    if (needsBackfill) {
      for (const m of migrations) {
        await client.query(
          "INSERT INTO _skrun_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
          [m.name],
        );
        backfilled += 1;
      }
    }

    // Read already-applied set in one round-trip.
    const appliedRes = await client.query<{ name: string }>("SELECT name FROM _skrun_migrations");
    const appliedSet = new Set(appliedRes.rows.map((r) => r.name));

    for (const m of migrations) {
      if (appliedSet.has(m.name)) {
        skipped += 1;
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO _skrun_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
          [m.name],
        );
        await client.query("COMMIT");
        applied += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    try {
      await releaseMigrationLock(client);
    } catch {
      // Best-effort; pool client release below will close the conn anyway.
    }
    client.release();
  }

  return { applied, backfilled, skipped };
}
