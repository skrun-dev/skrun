import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETION_COUNTED_TABLES, fixtureUsers, runDbContractTests } from "./db-contract.shared.js";
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
runDbContractTests(
  "sqlite",
  async () => {
    const db = new SqliteDb(":memory:");
    seedFixtureUsers(db);
    return db;
  },
  {
    async setRunContentCleared(db, runId, at) {
      rawDb(db as SqliteDb)
        .prepare("UPDATE runs SET content_cleared_at = ? WHERE id = ?")
        .run(at, runId);
    },
    async countRows(db) {
      const sqlite = (db as unknown as { db: Database.Database }).db;
      return Object.fromEntries(
        DELETION_COUNTED_TABLES.map((table) => [
          table,
          (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ]),
      );
    },
    usernameIsUnique: false,
    admission: {
      async setRunChargedMs(db, runId, chargedMs) {
        rawDb(db as SqliteDb)
          .prepare("UPDATE runs SET charged_ms = ? WHERE id = ?")
          .run(chargedMs, runId);
      },
      async analyzeRuns(db) {
        rawDb(db as SqliteDb).exec("ANALYZE runs");
      },
    },
  },
);

// ── SQLite-specific: an admission locks only when a bound applies ────

describe("SqliteDb run admission and its lock", () => {
  type Transaction = Database.Database["transaction"];

  /**
   * Record each transaction an admission opens, and in which mode, by
   * wrapping the connection's `transaction()`: the wrapper runs the real one.
   */
  function spyOnTransactions(db: SqliteDb): string[] {
    const inner = (db as unknown as { db: Database.Database }).db;
    const real = inner.transaction.bind(inner) as Transaction;
    const opened: string[] = [];
    vi.spyOn(inner, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      const tx = real(fn);
      const record =
        (mode: "default" | "deferred" | "immediate" | "exclusive") =>
        (...args: unknown[]) => {
          opened.push(mode);
          return tx[mode](...args);
        };
      return Object.assign(record("default"), {
        default: record("default"),
        deferred: record("deferred"),
        immediate: record("immediate"),
        exclusive: record("exclusive"),
        database: tx.database,
      });
    }) as Transaction);
    return opened;
  }

  function admission(id: string, limits: { concurrentRuns: number | null }) {
    const now = new Date().toISOString();
    return {
      run: { id, agent_id: null, agent_version: "1.0.0", user_id: "u" },
      now,
      deadlineAt: new Date(Date.parse(now) + 600_000).toISOString(),
      windowStart: null,
      limits: {
        concurrentRuns: limits.concurrentRuns,
        computeMs: null,
        fastRunsPerHour: null,
        instanceCap: null,
      },
      poolRunning: false,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with nothing bounding the run, fifty admissions open no transaction; under a bound, one immediate transaction each", async () => {
    const db = new SqliteDb(":memory:");
    try {
      seedTestUsers(db);
      const opened = spyOnTransactions(db);

      const free = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          db.admitRun(admission(`free-${i}`, { concurrentRuns: null })),
        ),
      );
      expect(free.every((result) => result.admitted)).toBe(true);
      expect(opened).toEqual([]);

      // The spy sees the transactions an admission does open.
      const bounded = await db.admitRun(admission("bounded", { concurrentRuns: 100 }));
      expect(bounded.admitted).toBe(true);
      expect(opened).toEqual(["immediate"]);
    } finally {
      db.close();
    }
  });
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

  it("RT-5 (#127): a database without the output purge columns gains them, and their partial index, on open", async () => {
    type Inner = { pragma: (s: string) => unknown };
    const runsSchema = (inner: Inner) => ({
      columns: (inner.pragma("table_info(runs)") as Array<{ name: string }>).map((c) => c.name),
      purgeIndex: (
        inner.pragma("index_list(runs)") as Array<{ name: string; partial: number }>
      ).find((i) => i.name === "runs_output_purge_due_idx"),
    });

    // A database from before the columns: made by SqliteDb with one run in it,
    // then stripped of the index and both columns (the index first — SQLite
    // refuses to drop a column an index names).
    const db1 = new SqliteDb(dbPath);
    await db1.createRun({
      id: "r-pre",
      agent_id: null,
      agent_version: "1.0.0",
      status: "completed",
    });
    db1.close();
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX runs_output_purge_due_idx");
    raw.exec("ALTER TABLE runs DROP COLUMN purge_after");
    raw.exec("ALTER TABLE runs DROP COLUMN outputs_purged_at");
    const stripped = runsSchema(raw as unknown as Inner);
    expect(stripped.columns).not.toContain("purge_after");
    expect(stripped.columns).not.toContain("outputs_purged_at");
    expect(stripped.purgeIndex).toBeUndefined();
    raw.close();

    // Reopened by SqliteDb: migrate() adds the columns, then the partial index.
    const db2 = new SqliteDb(dbPath);
    const reopened = runsSchema((db2 as unknown as { db: Inner }).db);
    expect(reopened.columns).toContain("purge_after");
    expect(reopened.columns).toContain("outputs_purged_at");
    expect(reopened.purgeIndex?.partial).toBe(1);
    // The run from before has no deadline, so the purge never selects it.
    const run = await db2.getRun("r-pre");
    expect(run?.purge_after).toBeNull();
    expect(run?.outputs_purged_at).toBeNull();
    expect(await db2.listRunsDueForOutputPurge(new Date().toISOString(), 10)).toEqual([]);
    db2.close();

    // A second open finds everything in place: no error, the same schema.
    const db3 = new SqliteDb(dbPath);
    expect(runsSchema((db3 as unknown as { db: Inner }).db)).toEqual(reopened);
    db3.close();
  });

  it("a database without the cleared-mark column gains it on open, and its runs read back unmarked", async () => {
    type Inner = { pragma: (s: string) => unknown };
    const runColumns = (inner: Inner) =>
      (
        inner.pragma("table_info(runs)") as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }>
      ).filter((c) => c.name === "content_cleared_at");

    // A database from before the column: made by SqliteDb with one run in it,
    // then stripped of the column.
    const db1 = new SqliteDb(dbPath);
    await db1.createRun({
      id: "r-before-mark",
      agent_id: null,
      agent_version: "1.0.0",
      status: "completed",
    });
    db1.close();
    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE runs DROP COLUMN content_cleared_at");
    expect(runColumns(raw as unknown as Inner)).toEqual([]);
    raw.close();

    // Reopened by SqliteDb: migrate() adds the column — nullable, no default.
    const db2 = new SqliteDb(dbPath);
    const reopened = runColumns((db2 as unknown as { db: Inner }).db);
    expect(reopened).toEqual([
      expect.objectContaining({
        name: "content_cleared_at",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      }),
    ]);
    expect((await db2.getRun("r-before-mark"))?.content_cleared_at).toBeNull();
    db2.close();

    // A second open finds it in place: no error, the same column.
    const db3 = new SqliteDb(dbPath);
    expect(runColumns((db3 as unknown as { db: Inner }).db)).toEqual(reopened);
    db3.close();
  });

  it("a database without the run quota columns gains them, and their two indexes, on open; its runs hold no deadline, no charged time, no right to the pool", async () => {
    type Inner = { pragma: (s: string) => unknown };
    const quotaSchema = (inner: Inner) => ({
      columns: (
        inner.pragma("table_info(runs)") as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }>
      )
        .filter((c) => ["deadline_at", "charged_ms", "pool_entitled"].includes(c.name))
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value })),
      indexes: (inner.pragma("index_list(runs)") as Array<{ name: string; partial: number }>)
        .filter((i) => ["idx_runs_user_created", "idx_runs_running_deadline"].includes(i.name))
        .map((i) => ({ name: i.name, partial: i.partial }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });

    // A database from before the columns: made by SqliteDb with one run in it,
    // then stripped of the two indexes and the three columns (the indexes
    // first — SQLite refuses to drop a column an index names).
    const db1 = new SqliteDb(dbPath);
    await db1.createRun({
      id: "r-before-quotas",
      agent_id: null,
      agent_version: "1.0.0",
      status: "running",
    });
    db1.close();
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX idx_runs_user_created");
    raw.exec("DROP INDEX idx_runs_running_deadline");
    raw.exec("ALTER TABLE runs DROP COLUMN deadline_at");
    raw.exec("ALTER TABLE runs DROP COLUMN charged_ms");
    raw.exec("ALTER TABLE runs DROP COLUMN pool_entitled");
    expect(quotaSchema(raw as unknown as Inner)).toEqual({ columns: [], indexes: [] });
    raw.close();

    // Reopened by SqliteDb: migrate() adds the columns, then the indexes.
    const db2 = new SqliteDb(dbPath);
    const reopened = quotaSchema((db2 as unknown as { db: Inner }).db);
    expect(reopened).toEqual({
      columns: [
        { name: "deadline_at", type: "TEXT", notnull: 0, dflt_value: null },
        { name: "charged_ms", type: "INTEGER", notnull: 0, dflt_value: null },
        { name: "pool_entitled", type: "INTEGER", notnull: 1, dflt_value: "0" },
      ],
      indexes: [
        { name: "idx_runs_running_deadline", partial: 1 },
        { name: "idx_runs_user_created", partial: 0 },
      ],
    });
    expect(await db2.getRun("r-before-quotas")).toMatchObject({
      deadline_at: null,
      charged_ms: null,
      pool_entitled: false,
    });
    db2.close();

    // A second open finds everything in place: no error, the same schema.
    const db3 = new SqliteDb(dbPath);
    expect(quotaSchema((db3 as unknown as { db: Inner }).db)).toEqual(reopened);
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

  it("an open that refuses the database closes the file it opened", () => {
    const raw = new Database(dbPath);
    raw.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(namespace, name));`,
    );
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO agents (id, name, namespace, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("orphan-agent", "orphan", "ns", "ghost-user", now, now);
    raw.close();

    const close = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => new SqliteDb(dbPath)).toThrow(/orphan rows found/);
      // The refused open leaves no handle behind: afterEach can remove the file.
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  /**
   * A database as it was before the foreign keys, built by hand: the tables of
   * that time, none of them with a foreign key, and runs without any column
   * added since. One run, with the user and the agent it points at. Opening it
   * rebuilds each table with its foreign keys — runs from a fixed column list —
   * then adds the later columns. The connection is handed back open, for a case
   * to shape the database further before closing it.
   */
  function openDatabaseFromBeforeTheForeignKeys(path: string): Database.Database {
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = OFF");
    raw.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, key_prefix TEXT NOT NULL, name TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', last_used_at TEXT, expires_at TEXT, created_at TEXT NOT NULL);
       CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, namespace TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(namespace, name));
       CREATE TABLE agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL, bundle_key TEXT NOT NULL, config_snapshot TEXT, notes TEXT, pushed_at TEXT NOT NULL);
       CREATE TABLE environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, agent_version TEXT NOT NULL, model TEXT, environment_id TEXT, user_id TEXT, api_key_id TEXT, status TEXT NOT NULL, input TEXT, output TEXT, error TEXT, usage_prompt_tokens INTEGER NOT NULL DEFAULT 0, usage_completion_tokens INTEGER NOT NULL DEFAULT 0, usage_total_tokens INTEGER NOT NULL DEFAULT 0, usage_estimated_cost REAL NOT NULL DEFAULT 0, duration_ms INTEGER, files TEXT, created_at TEXT NOT NULL, completed_at TEXT);`,
    );
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO users (id, github_id, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("old-user", "gh-old-user", "old-user", now, now);
    raw
      .prepare(
        "INSERT INTO agents (id, name, namespace, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("old-agent", "old", "ns", "old-user", now, now);
    raw
      .prepare(
        "INSERT INTO runs (id, agent_id, agent_version, model, user_id, status, input, output, usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost, duration_ms, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "old-run",
        "old-agent",
        "1.0.0",
        "provider/model",
        "old-user",
        "completed",
        '{"q":1}',
        '{"a":2}',
        30,
        12,
        42,
        0.0042,
        1200,
        now,
        now,
      );
    return raw;
  }

  const OLD_RUN_COLUMNS =
    "id, agent_id, agent_version, model, environment_id, user_id, api_key_id, status, input, output, error, usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost, duration_ms, files, created_at, completed_at";
  const readOldColumns = (conn: { prepare: (s: string) => { get: (id: string) => unknown } }) =>
    conn.prepare(`SELECT ${OLD_RUN_COLUMNS} FROM runs WHERE id = ?`).get("old-run");

  type Connection = {
    pragma: (s: string) => unknown[];
    prepare: (s: string) => { get: (id: string) => unknown; all: () => unknown[] };
  };

  /** Every column of every table, as declared: name, type, NOT NULL, default. */
  function declaredColumns(conn: Connection): Record<string, string[]> {
    const tables = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (
          conn.pragma(`table_info(${name})`) as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
          }>
        )
          .map(
            (c) =>
              `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value === null ? "" : ` DEFAULT ${c.dflt_value}`}`,
          )
          .sort(),
      ]),
    );
  }

  /**
   * Opens the database through SqliteDb, then checks what a rebuilt database
   * is: runs with its four foreign keys, every column declared as a fresh
   * database declares it, the run's original columns as they were (`before`),
   * and every later run column present and empty on it.
   */
  async function expectReopenedIntact(path: string, before: unknown): Promise<void> {
    let db: SqliteDb | undefined;
    try {
      expect(() => {
        db = new SqliteDb(path);
      }).not.toThrow();
      const inner = rawDb(db as SqliteDb) as unknown as Connection;
      // The rebuild ran: runs now has its four foreign keys.
      expect(inner.pragma("foreign_key_list(runs)")).toHaveLength(4);
      // A column the rebuild carries over keeps its name and type only, so a
      // later column added before the rebuild would lose its NOT NULL and its
      // default here, silently. Hence the comparison with a fresh database.
      const freshDb = new SqliteDb(":memory:");
      try {
        expect(declaredColumns(inner)).toEqual(
          declaredColumns(rawDb(freshDb) as unknown as Connection),
        );
      } finally {
        freshDb.close();
      }
      const columns = (inner.pragma("table_info(runs)") as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const column of [
        "machine_id",
        "private_ip",
        "phase_timings",
        "purge_after",
        "outputs_purged_at",
        "content_cleared_at",
        "deadline_at",
        "charged_ms",
        "pool_entitled",
      ]) {
        expect(columns).toContain(column);
      }
      // The run is intact, and the later columns are empty on it (the right to
      // the pool at its default, false).
      expect(readOldColumns(inner)).toEqual(before);
      expect(
        inner
          .prepare(
            "SELECT machine_id, private_ip, phase_timings, purge_after, outputs_purged_at, content_cleared_at, deadline_at, charged_ms, pool_entitled FROM runs WHERE id = ?",
          )
          .get("old-run"),
      ).toEqual({
        machine_id: null,
        private_ip: null,
        phase_timings: null,
        purge_after: null,
        outputs_purged_at: null,
        content_cleared_at: null,
        deadline_at: null,
        charged_ms: null,
        pool_entitled: 0,
      });
      const run = await (db as SqliteDb).getRun("old-run");
      expect(run?.agent_id).toBe("old-agent");
      expect(run?.status).toBe("completed");
    } finally {
      db?.close();
    }
  }

  it("a database from before the foreign keys reopens, its run intact, with every later run column", async () => {
    const raw = openDatabaseFromBeforeTheForeignKeys(dbPath);
    const before = readOldColumns(raw);
    expect(raw.pragma("foreign_key_list(runs)")).toEqual([]);
    raw.close();

    await expectReopenedIntact(dbPath, before);
  });

  it("a database from before the foreign keys that a failed start already altered reopens, its run intact", async () => {
    // The same database, with runs as a start of 1.0.0 to 1.2.1 left it. Those
    // releases added three columns to runs before the rebuild, each committed on
    // its own; the rebuild then recreated runs without them, could not copy them
    // back, and stopped the server. Every operator who met that failure has such
    // a runs table: the rebuild has to carry those columns over. (That start also
    // left the other tables rebuilt; this case models runs alone.)
    const raw = openDatabaseFromBeforeTheForeignKeys(dbPath);
    raw.exec(
      `ALTER TABLE runs ADD COLUMN machine_id TEXT;
       ALTER TABLE runs ADD COLUMN private_ip TEXT;
       ALTER TABLE runs ADD COLUMN phase_timings TEXT;`,
    );
    const before = readOldColumns(raw);
    expect(raw.pragma("foreign_key_list(runs)")).toEqual([]);
    raw.close();

    await expectReopenedIntact(dbPath, before);
    // Opened once more, rebuilt already: nothing left to rebuild or carry over.
    await expectReopenedIntact(dbPath, before);
  });

  it("VT-8 (#124): deleting a user cascades to their sessions", async () => {
    const db = new SqliteDb(dbPath);
    try {
      const user = await db.createUser({ github_id: "gh-sess-cascade", username: "sess-cascade" });
      await db.createSession({
        id_hash: "sess-cascade",
        user_id: user.id,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      expect(await db.getSession("sess-cascade")).not.toBeNull();

      // Delete the user via the raw connection: the adapter exposes no
      // deleteUser, and going through one would tell us nothing about the SQL
      // — it is the ON DELETE CASCADE declaration that is under test here.
      (db as unknown as { db: { prepare: (s: string) => { run: (a: string) => void } } }).db
        .prepare("DELETE FROM users WHERE id = ?")
        .run(user.id);

      expect(await db.getSession("sess-cascade")).toBeNull();
    } finally {
      db.close();
    }
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

  // ── The agent state table: its cascades, its CHECK, its migration ────
  //
  // Each cascade is exercised by a DELETE in raw SQL: the adapter has no way to
  // delete an account, and going through one would tell nothing about the
  // ON DELETE CASCADE declarations, which are what is under test.

  describe("agent state", () => {
    const EXPIRES = "2099-05-06T07:08:09.123Z";
    const STATE_COLUMNS = [
      "agent_id",
      "partition_key",
      "caller_user_id",
      "caller_key_id",
      "state",
      "updated_at",
      "expires_at",
    ];

    function inner(db: SqliteDb): Database.Database {
      return (db as unknown as { db: Database.Database }).db;
    }

    /**
     * Three accounts and what each holds. Bob owns agent X and two keys: K1,
     * delegated to X, and KB, account-wide. Alice holds a reduced key, KA, and
     * has run Bob's agent herself (as an admin may). Carol owns agent Y.
     * Notebooks on X: shared, K1's, Alice's, KA's. On Y: KB's (Bob running
     * Carol's agent), and Carol's own. Every row is written by the adapter.
     */
    async function seedThreeAccounts(db: SqliteDb) {
      const bob = await db.createUser({ github_id: "gh-bob", username: "bob" });
      const alice = await db.createUser({ github_id: "gh-alice", username: "alice" });
      const carol = await db.createUser({ github_id: "gh-carol", username: "carol" });
      const x = await db.createAgent({
        name: "x",
        namespace: "bob",
        description: "",
        owner_id: bob.id,
      });
      const y = await db.createAgent({
        name: "y",
        namespace: "carol",
        description: "",
        owner_id: carol.id,
      });
      const k1 = await db.createApiKey({
        user_id: bob.id,
        key_hash: "hash-k1",
        key_prefix: "skrun_sk_k1",
        name: "k1",
        scopes: ["agent:run"],
        scope_kind: "agents",
        agents: [x.id],
      });
      const kb = await db.createApiKey({
        user_id: bob.id,
        key_hash: "hash-kb",
        key_prefix: "skrun_sk_kb",
        name: "kb",
      });
      const ka = await db.createApiKey({
        user_id: alice.id,
        key_hash: "hash-ka",
        key_prefix: "skrun_sk_ka",
        name: "ka",
        scopes: ["agent:run"],
      });
      await db.setState(x.id, { kind: "shared" }, { on: "x shared" }, EXPIRES);
      await db.setState(x.id, { kind: "key", keyId: k1.id }, { on: "x k1" }, EXPIRES);
      await db.setState(x.id, { kind: "account", userId: alice.id }, { on: "x alice" }, EXPIRES);
      await db.setState(x.id, { kind: "key", keyId: ka.id }, { on: "x ka" }, EXPIRES);
      await db.setState(y.id, { kind: "key", keyId: kb.id }, { on: "y kb" }, EXPIRES);
      await db.setState(y.id, { kind: "account", userId: carol.id }, { on: "y carol" }, EXPIRES);
      return { bob, alice, carol, x, y, k1, kb, ka };
    }

    /** Every notebook left, by what it says it is. */
    function notebooksLeft(db: SqliteDb): string[] {
      return (inner(db).prepare("SELECT state FROM agent_state").all() as Array<{ state: string }>)
        .map((row) => (JSON.parse(row.state) as { on: string }).on)
        .sort();
    }

    it("deleting an account deletes the notebooks written under it and under its keys, and no other", async () => {
      const db = new SqliteDb(dbPath);
      try {
        const { alice } = await seedThreeAccounts(db);

        inner(db).prepare("DELETE FROM users WHERE id = ?").run(alice.id);

        // Alice's own notebook (users → agent_state) and her key's
        // (users → api_keys → agent_state) are gone; Bob's and Carol's stay.
        expect(notebooksLeft(db)).toEqual(["x k1", "x shared", "y carol", "y kb"]);
      } finally {
        db.close();
      }
    });

    it("deleting an agent's owner deletes every notebook of the agent, and those of the owner's keys elsewhere", async () => {
      const db = new SqliteDb(dbPath);
      try {
        const { bob } = await seedThreeAccounts(db);

        inner(db).prepare("DELETE FROM users WHERE id = ?").run(bob.id);

        // Every notebook of X goes with it (users → agents → agent_state),
        // the shared one and other callers' included; on Y, the notebook of
        // Bob's key goes (users → api_keys → agent_state), Carol's stays.
        expect(notebooksLeft(db)).toEqual(["y carol"]);
      } finally {
        db.close();
      }
    });

    describe("the CHECK ties the partition key to the references", () => {
      async function seedEmptyAgent(db: SqliteDb) {
        const owner = await db.createUser({ github_id: "gh-owner", username: "owner" });
        const agent = await db.createAgent({
          name: "z",
          namespace: "owner",
          description: "",
          owner_id: owner.id,
        });
        const key = await db.createApiKey({
          user_id: owner.id,
          key_hash: "hash-z",
          key_prefix: "skrun_sk_z",
          name: "z",
        });
        const otherKey = await db.createApiKey({
          user_id: owner.id,
          key_hash: "hash-z2",
          key_prefix: "skrun_sk_z2",
          name: "z2",
        });
        return { owner, agent, key, otherKey };
      }

      function insertRow(
        db: SqliteDb,
        row: {
          agentId: string;
          partitionKey: string;
          callerUserId: string | null;
          callerKeyId: string | null;
        },
      ): void {
        inner(db)
          .prepare(
            `INSERT INTO agent_state
               (agent_id, partition_key, caller_user_id, caller_key_id, state, updated_at, expires_at)
             VALUES (?, ?, ?, ?, '{}', ?, ?)`,
          )
          .run(row.agentId, row.partitionKey, row.callerUserId, row.callerKeyId, EXPIRES, EXPIRES);
      }

      it("accepts each of the three shapes", async () => {
        const db = new SqliteDb(dbPath);
        try {
          const { owner, agent, key } = await seedEmptyAgent(db);
          const id = agent.id;
          insertRow(db, {
            agentId: id,
            partitionKey: "shared",
            callerUserId: null,
            callerKeyId: null,
          });
          insertRow(db, {
            agentId: id,
            partitionKey: `account:${owner.id}`,
            callerUserId: owner.id,
            callerKeyId: null,
          });
          insertRow(db, {
            agentId: id,
            partitionKey: `key:${key.id}`,
            callerUserId: null,
            callerKeyId: key.id,
          });
          expect(inner(db).prepare("SELECT COUNT(*) AS n FROM agent_state").get()).toEqual({
            n: 3,
          });
        } finally {
          db.close();
        }
      });

      it("refuses a shared row that names an account", async () => {
        const db = new SqliteDb(dbPath);
        try {
          const { owner, agent } = await seedEmptyAgent(db);
          expect(() =>
            insertRow(db, {
              agentId: agent.id,
              partitionKey: "shared",
              callerUserId: owner.id,
              callerKeyId: null,
            }),
          ).toThrow(/CHECK constraint failed/);
        } finally {
          db.close();
        }
      });

      it("refuses an account row that names no account", async () => {
        const db = new SqliteDb(dbPath);
        try {
          const { owner, agent } = await seedEmptyAgent(db);
          expect(() =>
            insertRow(db, {
              agentId: agent.id,
              partitionKey: `account:${owner.id}`,
              callerUserId: null,
              callerKeyId: null,
            }),
          ).toThrow(/CHECK constraint failed/);
        } finally {
          db.close();
        }
      });

      it("refuses an account row that names both an account and a key", async () => {
        const db = new SqliteDb(dbPath);
        try {
          const { owner, agent, key } = await seedEmptyAgent(db);
          expect(() =>
            insertRow(db, {
              agentId: agent.id,
              partitionKey: `account:${owner.id}`,
              callerUserId: owner.id,
              callerKeyId: key.id,
            }),
          ).toThrow(/CHECK constraint failed/);
        } finally {
          db.close();
        }
      });

      it("refuses a key row whose key is not the one its partition names", async () => {
        const db = new SqliteDb(dbPath);
        try {
          const { agent, key, otherKey } = await seedEmptyAgent(db);
          expect(() =>
            insertRow(db, {
              agentId: agent.id,
              partitionKey: `key:${key.id}`,
              callerUserId: null,
              callerKeyId: otherKey.id,
            }),
          ).toThrow(/CHECK constraint failed/);
        } finally {
          db.close();
        }
      });
    });

    /** The tables of a fresh database, and the columns of its agent_state. */
    function freshShape(): { tables: string[]; stateColumns: string[] } {
      const fresh = new SqliteDb(":memory:");
      try {
        const declared = declaredColumns(inner(fresh) as unknown as Connection);
        return { tables: Object.keys(declared).sort(), stateColumns: declared.agent_state };
      } finally {
        fresh.close();
      }
    }

    /**
     * What a database must look like once opened: the same tables as a fresh
     * one — no table left behind holding the earlier rows — and agent_state at
     * the new shape, with its three foreign keys.
     */
    function expectStateTableAtNewShape(db: SqliteDb): void {
      const conn = inner(db);
      const declared = declaredColumns(conn as unknown as Connection);
      const fresh = freshShape();
      expect(Object.keys(declared).sort()).toEqual(fresh.tables);
      expect(declared.agent_state).toEqual(fresh.stateColumns);
      expect(
        (conn.pragma("table_info(agent_state)") as Array<{ name: string }>).map((c) => c.name),
      ).toEqual(STATE_COLUMNS);
      expect(
        (
          conn.pragma("foreign_key_list(agent_state)") as Array<{
            table: string;
            on_delete: string;
          }>
        )
          .map((fk) => `${fk.table} ${fk.on_delete}`)
          .sort(),
      ).toEqual(["agents CASCADE", "api_keys CASCADE", "users CASCADE"]);
    }

    /** The agent state table as releases before this one created it, with two rows. */
    const EARLIER_STATE_TABLE =
      "CREATE TABLE agent_state (agent_name TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)";
    function fillEarlierStateTable(raw: Database.Database): void {
      const now = new Date().toISOString();
      const insert = raw.prepare(
        "INSERT INTO agent_state (agent_name, state, updated_at) VALUES (?, ?, ?)",
      );
      insert.run("dev/notes", '{"secret":"from before"}', now);
      insert.run("dev/gone", '{"n":1}', now);
    }

    it("a database whose state table has the earlier shape opens with that table empty, at the new shape, and a second open keeps what was written since", async () => {
      // A database as the previous release left it: every table current, the
      // state table keyed by the agent's name, with rows.
      new SqliteDb(dbPath).close();
      const raw = new Database(dbPath);
      raw.exec(`DROP TABLE agent_state; ${EARLIER_STATE_TABLE};`);
      fillEarlierStateTable(raw);
      raw.close();

      const db = new SqliteDb(dbPath);
      let agentId: string;
      let userId: string;
      try {
        expectStateTableAtNewShape(db);
        expect(inner(db).prepare("SELECT COUNT(*) AS n FROM agent_state").get()).toEqual({ n: 0 });

        const user = await db.createUser({ github_id: "gh-after", username: "after" });
        const agent = await db.createAgent({
          name: "after",
          namespace: "after",
          description: "",
          owner_id: user.id,
        });
        agentId = agent.id;
        userId = user.id;
        await db.setState(agentId, { kind: "account", userId }, { written: "since" }, EXPIRES);
      } finally {
        db.close();
      }

      // Opened again: the table is already at the new shape, so nothing is
      // dropped — the notebook written since is still there.
      const again = new SqliteDb(dbPath);
      try {
        expectStateTableAtNewShape(again);
        expect(await again.getState(agentId, { kind: "account", userId })).toEqual({
          state: { written: "since" },
          expires_at: EXPIRES,
        });
      } finally {
        again.close();
      }
    });

    it("a database from before the foreign keys, with a state table of the earlier shape, rebuilds its parents and gets a new, empty state table", async () => {
      const raw = openDatabaseFromBeforeTheForeignKeys(dbPath);
      raw.exec(EARLIER_STATE_TABLE);
      fillEarlierStateTable(raw);
      const before = readOldColumns(raw);
      raw.close();

      // The parents (agents, api_keys, users' children) are rebuilt and the
      // run carried over, exactly as without a state table.
      await expectReopenedIntact(dbPath, before);

      const db = new SqliteDb(dbPath);
      try {
        expectStateTableAtNewShape(db);
        expect(inner(db).prepare("SELECT COUNT(*) AS n FROM agent_state").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });
  });
});

// ── An account deletion, read back in SQL, and one that fails half-way ──

describe("SqliteDb account deletion", () => {
  const AT = "2026-03-04T05:06:07.890Z";
  const RUN_COLUMNS =
    "input, output, error, files, agent_version, content_cleared_at, user_id, agent_id, api_key_id";

  function sql(db: SqliteDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db;
  }

  /**
   * Account A ("alice") with an agent, a version, a key and a session; a run
   * of A on its agent through its key, completed with content; a run of B on
   * A's agent, still running.
   */
  async function seed(db: SqliteDb) {
    const a = await db.createUser({ github_id: "gh-raw-a", username: "alice" });
    const b = await db.createUser({ github_id: "gh-raw-b", username: "bob" });
    const agent = await db.createAgent({
      name: "tool",
      namespace: "alice",
      description: "",
      owner_id: a.id,
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 1,
      bundle_key: "alice/tool/1.0.0.agent",
    });
    const key = await db.createApiKey({
      user_id: a.id,
      key_hash: "raw-hash-a",
      key_prefix: "skrun_sk_ra",
      name: "a",
    });
    await db.createSession({
      id_hash: "raw-sess-a",
      user_id: a.id,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const own = "run-raw-own";
    await db.createRun({
      id: own,
      agent_id: agent.id,
      agent_version: "alice/tool@1.0.0",
      user_id: a.id,
      api_key_id: key.id,
      status: "running",
      input: { asked: "own" },
    });
    await db.updateRun(own, {
      status: "failed",
      output: { said: "partial" },
      error: "a failure message",
      files: [{ name: "a.txt", size: 1 }],
    });
    const theirs = "run-raw-theirs";
    await db.createRun({
      id: theirs,
      agent_id: agent.id,
      agent_version: "alice/tool@1.0.0",
      user_id: b.id,
      status: "running",
      input: { asked: "theirs" },
    });
    return { a, b, agent, key, own, theirs };
  }

  function readRun(db: SqliteDb, id: string) {
    return sql(db).prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id);
  }

  it("stores the cleared columns as null, the file list as an empty list, the references as null", async () => {
    const db = new SqliteDb(":memory:");
    try {
      const s = await seed(db);

      await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

      expect(readRun(db, s.own)).toEqual({
        input: null,
        output: null,
        error: null,
        files: "[]",
        agent_version: "@1.0.0",
        content_cleared_at: AT,
        user_id: null,
        agent_id: null,
        api_key_id: null,
      });
      expect(readRun(db, s.theirs)).toEqual({
        input: null,
        output: null,
        error: null,
        files: "[]",
        agent_version: "@1.0.0",
        content_cleared_at: AT,
        user_id: s.b.id,
        agent_id: null,
        api_key_id: null,
      });
      expect(sql(db).prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(s.a.id)).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it("a deletion refused when the account row goes leaves the account and its runs as they were", async () => {
    const db = new SqliteDb(":memory:");
    try {
      const s = await seed(db);
      sql(db).exec(
        "CREATE TRIGGER refuse_account_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;",
      );
      const before = [readRun(db, s.own), readRun(db, s.theirs)];

      await expect(db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT })).rejects.toThrow(
        "refused by the test",
      );

      // Neither cleared nor marked: the clearing ran, and went with the rest.
      expect([readRun(db, s.own), readRun(db, s.theirs)]).toEqual(before);
      expect(before[0]).toMatchObject({ input: '{"asked":"own"}', content_cleared_at: null });
      expect((await db.getUserById(s.a.id))?.username).toBe("alice");
      expect(await db.getSession("raw-sess-a")).not.toBeNull();
      expect((await db.getAgent("alice", "tool"))?.id).toBe(s.agent.id);
    } finally {
      db.close();
    }
  });
});
