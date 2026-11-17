import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  type AccountUsage,
  admissionIsBounded,
  admissionVerdict,
  type DbAdapter,
  type FinalRunWrite,
  fastRunsSince,
  RUN_CONTENT_FIELDS,
  type RunAdmission,
  type RunAdmissionResult,
  type RunWrite,
  releasingFastRunOffset,
  SHUTDOWN_RUN_ERROR,
} from "./adapter.js";
import {
  derivedNamespace,
  NAMESPACE_MAX_ATTEMPTS,
  NamespaceUnavailableError,
  namespaceBase,
} from "./namespace.js";
import {
  type Agent,
  type AgentLlmKeyInfo,
  type AgentLlmKeyPolicy,
  type AgentLlmKeyRecord,
  type AgentVersion,
  API_KEY_DEFAULT_SCOPES,
  type ApiKey,
  type ApiKeyScopeKind,
  type DeviceCode,
  type DeviceCodeStatus,
  type Environment,
  type Run,
  type RunStatus,
  type Session,
  type StatePartition,
  type StoredState,
  type User,
  type UserDeletionPlan,
  type UserDeletionResult,
} from "./schema.js";

// FK semantics mirror packages/api/src/db/migrations/001_initial_schema.sql
//   - Ownership chains: ON DELETE CASCADE (api_keys, agents, agent_versions, environments).
//     agent_state cascades too (from its agent, its caller's account, its
//     caller's key), but is created in migrate(), not in SCHEMA — see there.
//   - Run history (runs.*): ON DELETE SET NULL — preserves analytics + billing data
//     after the referenced agent/user/environment is deleted.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  scope_kind TEXT NOT NULL DEFAULT 'account',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, name)
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  size INTEGER NOT NULL,
  bundle_key TEXT NOT NULL,
  bundle_sha256 TEXT,
  config_snapshot TEXT,
  notes TEXT,
  pushed_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_id, version)
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  agent_version TEXT NOT NULL,
  model TEXT,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  usage_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  usage_completion_tokens INTEGER NOT NULL DEFAULT 0,
  usage_total_tokens INTEGER NOT NULL DEFAULT 0,
  usage_estimated_cost REAL NOT NULL DEFAULT 0,
  usage_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  usage_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  usage_cache_savings_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  machine_id TEXT,
  private_ip TEXT,
  phase_timings TEXT,
  files TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- Output retention (migration 018). Their partial index is created in
  -- migrate(), never here: on an existing database this SCHEMA runs before
  -- migrate() adds the columns, and the index would name a missing column.
  purge_after TEXT,
  outputs_purged_at TEXT,
  -- When the run's content was cleared by its account's deletion (migration 020).
  content_cleared_at TEXT,
  -- What the run holds of its account's quotas (migration 021). Their two
  -- indexes are created in migrate(), never here, for the reason given above.
  deadline_at TEXT,
  charged_ms INTEGER,
  pool_entitled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code_hash TEXT UNIQUE NOT NULL,
  code_challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  current_interval INTEGER NOT NULL DEFAULT 5,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT
);

-- Browser session store — the SQLite mirror of migration 017_sessions.sql
-- (that file is the Postgres path; this const is the SQLite one, and SQLite
-- replays no migration). id_hash is the SHA-256 of the raw session id, which
-- lives only in the cookie. The FK is inline and targets the users table, which
-- migrateForeignKeys() never rebuilds, so there is no FK-rebuild collision.
-- Timestamps are TEXT (ISO strings) like every other table here.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The only non-primary-key column any session query reads: the hourly sweep.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
`;

/**
 * The agent state table — the SQLite mirror of migration
 * 019_agent_state_per_caller.sql, created by migrate() (not SCHEMA; see there).
 *
 * One row per (agent, partition). `partition_key` is never null — `shared`,
 * `account:<user id>` or `key:<key id>` — so the primary key holds one row per
 * partition even though the two reference columns are nullable (a UNIQUE over
 * nullable columns would accept two `shared` rows). The CHECK ties the key to
 * the references; each branch states its IS NULL / IS NOT NULL explicitly,
 * because a bare equality against a NULL column is NULL, and a CHECK that
 * evaluates to NULL passes.
 *
 * Each reference cascades: the row goes with its agent, with the account and
 * with the key it was written for. The three indexes serve the expiry sweep and
 * the two cascades (a key revocation must not scan the table); the cascade from
 * the agent is served by the primary key.
 */
const AGENT_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  partition_key TEXT NOT NULL,
  caller_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  caller_key_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, partition_key),
  CHECK (
    (partition_key = 'shared' AND caller_user_id IS NULL AND caller_key_id IS NULL)
    OR (caller_user_id IS NOT NULL AND caller_key_id IS NULL
        AND partition_key = 'account:' || caller_user_id)
    OR (caller_key_id IS NOT NULL AND caller_user_id IS NULL
        AND partition_key = 'key:' || caller_key_id)
  )
);
CREATE INDEX IF NOT EXISTS agent_state_expires_at_idx ON agent_state (expires_at);
CREATE INDEX IF NOT EXISTS agent_state_caller_user_idx ON agent_state (caller_user_id)
  WHERE caller_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_state_caller_key_idx ON agent_state (caller_key_id)
  WHERE caller_key_id IS NOT NULL;
`;

/**
 * The partition key of a state row, computed in SQL from the two reference
 * parameters by the same expression as the table's CHECK — so a write can never
 * build a key the CHECK refuses, and a read looks a row up by the key its write
 * produced. Bound by name: `@callerUserId`, `@callerKeyId` (null when absent).
 */
const STATE_PARTITION_KEY_SQL =
  "CASE WHEN @callerUserId IS NOT NULL THEN 'account:' || @callerUserId " +
  "WHEN @callerKeyId IS NOT NULL THEN 'key:' || @callerKeyId ELSE 'shared' END";

/**
 * The runs an account deletion clears: those the account launched, every run
 * of one of its agents, and — when `@leftBehind` is 1, the namespace being the
 * account's alone — the runs left without an agent whose version names the
 * namespace `@ns`: runs of an agent it deleted earlier. The namespace is
 * compared as text, never as a pattern (an older one can hold `_`). Bound by
 * name: `@userId`, `@ns`, `@leftBehind`.
 */
const DELETION_SCOPE_SQL = `(user_id = @userId
    OR agent_id IN (SELECT id FROM agents WHERE owner_id = @userId)
    OR (@leftBehind = 1 AND agent_id IS NULL
        AND substr(agent_version, 1, length(@ns) + 1) = @ns || '/'))`;

/**
 * Whether the namespace `@ns` of the account `@userId` is someone else's too:
 * another account with that username, or an agent under it another account
 * owns.
 */
const NAMESPACE_SHARED_SQL = `SELECT EXISTS (SELECT 1 FROM users WHERE username = @ns AND id <> @userId)
    OR EXISTS (SELECT 1 FROM agents WHERE namespace = @ns AND owner_id <> @userId) AS shared`;

/** The two reference columns of a partition, as named parameters. */
function statePartitionParams(partition: StatePartition): {
  callerUserId: string | null;
  callerKeyId: string | null;
} {
  return {
    callerUserId: partition.kind === "account" ? partition.userId : null,
    callerKeyId: partition.kind === "key" ? partition.keyId : null,
  };
}

export class SqliteDb implements DbAdapter {
  private db: Database.Database;

  constructor(dbPath = "skrun.db") {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.exec(SCHEMA);
      this.migrate();
    } catch (err) {
      // An open that refuses the database (a failed migration, an orphan
      // check) closes the file it opened: left open, the handle outlives the
      // refusal, and on Windows the file can no longer be removed.
      this.db.close();
      throw err;
    }
  }

  /**
   * Idempotent migrations for pre-existing databases.
   * Each step checks the current schema via PRAGMA and applies ALTER if needed.
   * Safe on fresh DBs (columns already exist via SCHEMA) and existing ones.
   */
  private migrate(): void {
    const hasColumn = (table: string, column: string): boolean => {
      const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      return cols.some((c) => c.name === column);
    };
    const tableExists = (table: string): boolean => {
      const rows = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(table) as Array<{ name: string }>;
      return rows.length > 0;
    };

    // Migration: add agent_versions.notes (version notes)
    if (!hasColumn("agent_versions", "notes")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN notes TEXT");
    }

    // Migration 011: add agent_versions.bundle_sha256. Mirrors
    // the .sql file targeting Postgres. The rebuildWithFks static schemas below
    // also carry the column so an FK/UNIQUE rebuild on an upgraded DB preserves it.
    if (!hasColumn("agent_versions", "bundle_sha256")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN bundle_sha256 TEXT");
    }

    // Migration 004: add cache token + savings columns to runs (cache-cost-savings).
    // Mirrors the .sql file targeting Postgres/Supabase. SQLite uses REAL for
    // the fractional NUMERIC(10,6) usage_cache_savings_usd column.
    if (!hasColumn("runs", "usage_cache_read_tokens")) {
      this.db.exec(
        "ALTER TABLE runs ADD COLUMN usage_cache_read_tokens INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasColumn("runs", "usage_cache_write_tokens")) {
      this.db.exec(
        "ALTER TABLE runs ADD COLUMN usage_cache_write_tokens INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasColumn("runs", "usage_cache_savings_usd")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN usage_cache_savings_usd REAL NOT NULL DEFAULT 0");
    }

    // Migration 007: users.role column + revoke pre-existing verified=true
    // agents. Done BEFORE the FK rebuild (005) since 005's table-rebuild path
    // would otherwise lose the role column if it ran first on a DB upgrading
    // from pre-007 schema. The `verified` reset must run EVERY first-upgrade
    // — gated on the column being newly added (one-shot).
    if (!hasColumn("users", "role")) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      // Pre-existing verified=true rows were minted under the old self-served
      // PATCH /verify; they no longer reflect an admin gate, so reset them en
      // masse. An admin (sole role allowed to verify post-007) can re-mint
      // them after upgrading.
      this.db.exec("UPDATE agents SET verified = 0 WHERE verified = 1");
    }

    // Migration 005: retrofit FOREIGN KEY constraints onto pre-existing SQLite
    // DBs. The SCHEMA above declares the FKs for fresh installs; this
    // migration handles existing self-host DBs created before the schema bump.
    // Strategy: for each table missing its expected FK count, run an orphan
    // pre-check first (fail loud with remediation hint), then rebuild the
    // table using SQLite's "create-new + INSERT FROM old + drop + rename"
    // pattern.
    this.migrateForeignKeys();

    // Migration 006: retrofit UNIQUE(agent_id, version) onto
    // agent_versions for DBs that landed on the FK-only migration first.
    // Fresh DBs (and DBs rebuilt via migrateForeignKeys) already have it
    // baked in. This catches the narrow gap of "DB migrated to FKs but not
    // yet to UNIQUE".
    this.migrateAgentVersionsUnique();

    // Migration 008: add per-version verified flag. Mirrors the .sql file for
    // Postgres/Supabase.
    if (!hasColumn("agent_versions", "verified")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
    }

    // Migration 009: drop legacy agents.verified. All consumers now read
    // agent_versions.verified (or the computed latest_version_verified for
    // agent-level surfaces). SQLite 3.35+ supports DROP COLUMN. Gated on
    // hasColumn so fresh DBs (which never had the column post-7.7) skip.
    if (hasColumn("agents", "verified")) {
      this.db.exec("ALTER TABLE agents DROP COLUMN verified");
    }

    // Migration 012: per-agent visibility. Mirrors the .sql file for
    // Postgres. Added AFTER migrateForeignKeys so old DBs that get rebuilt
    // (the rebuild copies only the old columns) still receive it here.
    // CHECK is legal in SQLite ADD COLUMN.
    if (!hasColumn("agents", "visibility")) {
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public'))",
      );
    }

    // Migration 013: API-key scope_kind + api_key_agents join. Mirrors the
    // .sql file for Postgres. scope_kind via ALTER (like visibility, AFTER the
    // FK rebuild). api_key_agents is created HERE (not in the SCHEMA constant)
    // on purpose: SCHEMA runs before migrateForeignKeys(), which on a pre-005
    // upgrade DROPs+rebuilds the api_keys parent table — a child table created
    // in SCHEMA that references api_keys would collide with that rebuild.
    // Creating it after the rebuild sidesteps the hazard entirely.
    if (!hasColumn("api_keys", "scope_kind")) {
      this.db.exec(
        "ALTER TABLE api_keys ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'account' CHECK (scope_kind IN ('account','agents'))",
      );
    }
    if (!tableExists("api_key_agents")) {
      this.db.exec(
        `CREATE TABLE api_key_agents (
          api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          PRIMARY KEY (api_key_id, agent_id)
        )`,
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_api_key_agents_agent ON api_key_agents(agent_id)",
      );
    }

    // Migration 014: creator-attached LLM keys + caller-key policy. Mirrors the
    // .sql file for Postgres. llm_key_policy via ALTER (like visibility, AFTER
    // the FK rebuild). agent_llm_keys is created HERE (not in the SCHEMA
    // constant) for the same reason as api_key_agents: SCHEMA runs before
    // migrateForeignKeys(), which may DROP+rebuild the agents parent table; a
    // child created in SCHEMA would collide with that rebuild.
    if (!hasColumn("agents", "llm_key_policy")) {
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN llm_key_policy TEXT NOT NULL DEFAULT 'open' CHECK (llm_key_policy IN ('open','creator_only'))",
      );
    }
    if (!tableExists("agent_llm_keys")) {
      this.db.exec(
        `CREATE TABLE agent_llm_keys (
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          last4 TEXT,
          key_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, provider)
        )`,
      );
    }

    // Migration 019: agent state kept per agent id and per caller. Mirrors the
    // .sql file for Postgres. The table is created HERE, never in SCHEMA, for
    // the reason api_key_agents and agent_llm_keys are: its foreign keys point
    // at agents, api_keys and users, and SCHEMA runs before
    // migrateForeignKeys(), which on an old database drops and rebuilds agents
    // and api_keys — a child declared in SCHEMA would collide with that
    // rebuild. A table of the earlier shape (keyed by the agent's name, in an
    // `agent_name` column) is dropped first, rows included: a row of that
    // shape names neither the agent's id nor a caller, so none can be carried
    // over. A table already at the new shape is left as it is.
    if (tableExists("agent_state") && hasColumn("agent_state", "agent_name")) {
      this.db.exec("DROP TABLE agent_state");
    }
    this.db.exec(AGENT_STATE_TABLE_SQL);

    // Migration 016: runner cold-start telemetry columns (operator-only).
    // phase_timings is a JSON object stored as TEXT (SQLite has no jsonb).
    // AFTER migrateForeignKeys(), like 012-014 and 018: on a database from
    // before 005, its rebuild re-creates runs from a fixed column list that
    // does not declare these columns, then copies every column of the old
    // table by name. Added before it, as 1.0.0 to 1.2.1 did, they made that
    // copy fail ("table runs has no column named machine_id") and the database
    // would not open. The failed start left them in place; the rebuild now
    // carries such columns over (rebuildWithFks), so that database opens too.
    if (!hasColumn("runs", "machine_id")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN machine_id TEXT");
    }
    if (!hasColumn("runs", "private_ip")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN private_ip TEXT");
    }
    if (!hasColumn("runs", "phase_timings")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN phase_timings TEXT");
    }

    // Migration 018: output retention — the purge deadline and the purge mark
    // on runs. Mirrors the .sql file for Postgres. AFTER migrateForeignKeys(),
    // like 012-014: its rebuild of runs re-creates the table from a fixed column
    // list, and a column added before it would reach the new table only through
    // the rebuild's carry-over, which keeps a name and a type and nothing else
    // of the column's declaration. The partial index follows the columns, here
    // and never in SCHEMA (on an existing database SCHEMA runs before the
    // columns exist); it has the Postgres index's shape, so the two schemas
    // read side by side.
    if (!hasColumn("runs", "purge_after")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN purge_after TEXT");
    }
    if (!hasColumn("runs", "outputs_purged_at")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN outputs_purged_at TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS runs_output_purge_due_idx ON runs (purge_after) WHERE outputs_purged_at IS NULL AND purge_after IS NOT NULL",
    );

    // Migration 020: the date a run's content was cleared. Mirrors the .sql
    // file for Postgres; after migrateForeignKeys() for the reason 018 gives.
    // No index: no query selects runs by it.
    if (!hasColumn("runs", "content_cleared_at")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN content_cleared_at TEXT");
    }

    // Migration 021: a run's seat deadline, its charged time and its right to
    // the pool. Mirrors the .sql file for Postgres; after migrateForeignKeys()
    // for the reason 018 gives — pool_entitled's NOT NULL and default would be
    // lost by the rebuild's carry-over. The two indexes follow the columns,
    // with the Postgres indexes' shapes (the second one partial).
    if (!hasColumn("runs", "deadline_at")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN deadline_at TEXT");
    }
    if (!hasColumn("runs", "charged_ms")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN charged_ms INTEGER");
    }
    if (!hasColumn("runs", "pool_entitled")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN pool_entitled INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs (user_id, created_at)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_running_deadline ON runs (deadline_at) WHERE status = 'running'",
    );
  }

  /** Number of FK rows the table is expected to have post-migration. */
  private static readonly FK_EXPECTED: Record<string, number> = {
    api_keys: 1, // user_id -> users
    agents: 1, // owner_id -> users
    agent_versions: 1, // agent_id -> agents
    environments: 1, // owner_id -> users
    runs: 4, // agent_id, environment_id, user_id, api_key_id (all ON DELETE SET NULL)
  };

  private migrateForeignKeys(): void {
    const tableHasExpectedFks = (table: string, expected: number): boolean => {
      const rows = this.db.pragma(`foreign_key_list(${table})`) as Array<unknown>;
      return rows.length >= expected;
    };

    const orphanCheck = (
      table: string,
      column: string,
      refTable: string,
      refColumn: string,
    ): number => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} t WHERE t.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.${refColumn} = t.${column})`,
        )
        .get() as { n: number };
      return row.n;
    };

    const failOnOrphans = (
      table: string,
      column: string,
      refTable: string,
      orphans: number,
    ): void => {
      throw new Error(
        `Cannot add FOREIGN KEY ${table}.${column} -> ${refTable}: ${orphans} orphan rows found. ` +
          `Run \`DELETE FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM ${refTable});\` ` +
          `(or repair the missing parent rows) before upgrading. See CHANGELOG v0.8.0.`,
      );
    };

    // --- api_keys.user_id -> users.id ON DELETE CASCADE ---
    if (!tableHasExpectedFks("api_keys", SqliteDb.FK_EXPECTED.api_keys)) {
      const orphans = orphanCheck("api_keys", "user_id", "users", "id");
      if (orphans > 0) failOnOrphans("api_keys", "user_id", "users", orphans);
      this.rebuildWithFks(
        "api_keys",
        `CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key_hash TEXT UNIQUE NOT NULL,
          key_prefix TEXT NOT NULL,
          name TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          last_used_at TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL
        )`,
      );
    }

    // --- agents.owner_id -> users.id ON DELETE CASCADE ---
    if (!tableHasExpectedFks("agents", SqliteDb.FK_EXPECTED.agents)) {
      const orphans = orphanCheck("agents", "owner_id", "users", "id");
      if (orphans > 0) failOnOrphans("agents", "owner_id", "users", orphans);
      this.rebuildWithFks(
        "agents",
        `CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          namespace TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          verified INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(namespace, name)
        )`,
      );
    }

    // --- agent_versions.agent_id -> agents.id ON DELETE CASCADE + UNIQUE(agent_id, version) ---
    if (!tableHasExpectedFks("agent_versions", SqliteDb.FK_EXPECTED.agent_versions)) {
      const orphans = orphanCheck("agent_versions", "agent_id", "agents", "id");
      if (orphans > 0) failOnOrphans("agent_versions", "agent_id", "agents", orphans);
      this.rebuildWithFks(
        "agent_versions",
        `CREATE TABLE agent_versions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          version TEXT NOT NULL,
          size INTEGER NOT NULL,
          bundle_key TEXT NOT NULL,
          bundle_sha256 TEXT,
          config_snapshot TEXT,
          notes TEXT,
          pushed_at TEXT NOT NULL,
          UNIQUE(agent_id, version)
        )`,
      );
    }

    // --- environments.owner_id -> users.id ON DELETE CASCADE ---
    if (!tableHasExpectedFks("environments", SqliteDb.FK_EXPECTED.environments)) {
      const orphans = orphanCheck("environments", "owner_id", "users", "id");
      if (orphans > 0) failOnOrphans("environments", "owner_id", "users", orphans);
      this.rebuildWithFks(
        "environments",
        `CREATE TABLE environments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          config TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
    }

    // --- runs.{agent_id, environment_id, user_id} -> ON DELETE SET NULL ---
    // Preserves run history (billing/analytics) after parent deletion.
    if (!tableHasExpectedFks("runs", SqliteDb.FK_EXPECTED.runs)) {
      const orphansAgent = orphanCheck("runs", "agent_id", "agents", "id");
      if (orphansAgent > 0) failOnOrphans("runs", "agent_id", "agents", orphansAgent);
      const orphansUser = orphanCheck("runs", "user_id", "users", "id");
      if (orphansUser > 0) failOnOrphans("runs", "user_id", "users", orphansUser);
      const orphansEnv = orphanCheck("runs", "environment_id", "environments", "id");
      if (orphansEnv > 0) failOnOrphans("runs", "environment_id", "environments", orphansEnv);
      this.rebuildWithFks(
        "runs",
        `CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          agent_version TEXT NOT NULL,
          model TEXT,
          environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          input TEXT,
          output TEXT,
          error TEXT,
          usage_prompt_tokens INTEGER NOT NULL DEFAULT 0,
          usage_completion_tokens INTEGER NOT NULL DEFAULT 0,
          usage_total_tokens INTEGER NOT NULL DEFAULT 0,
          usage_estimated_cost REAL NOT NULL DEFAULT 0,
          usage_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          usage_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          usage_cache_savings_usd REAL NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          files TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )`,
      );
    }
  }

  private migrateAgentVersionsUnique(): void {
    // Detect: does the table already have a UNIQUE constraint on (agent_id, version)?
    // SQLite represents these as automatically-named indexes prefixed `sqlite_autoindex_`.
    const indexes = this.db.pragma("index_list(agent_versions)") as Array<{
      unique: number;
      name: string;
    }>;
    for (const idx of indexes) {
      if (idx.unique !== 1) continue;
      const cols = this.db.pragma(`index_info(${idx.name})`) as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name).sort();
      if (colNames.length === 2 && colNames[0] === "agent_id" && colNames[1] === "version") {
        return; // Already present.
      }
    }

    // Duplicate pre-check before rebuilding (per F-3 plan pattern). Extremely
    // rare on self-host (the codebase already guards POST push against version
    // collisions via service-layer 409 VERSION_EXISTS), but a row could exist
    // from a race older than this constraint, or from manual SQL.
    const dupes = this.db
      .prepare(
        "SELECT agent_id, version, COUNT(*) AS n FROM agent_versions GROUP BY agent_id, version HAVING COUNT(*) > 1 LIMIT 5",
      )
      .all() as Array<{ agent_id: string; version: string; n: number }>;
    if (dupes.length > 0) {
      const sample = dupes
        .map((d) => `(agent_id=${d.agent_id}, version=${d.version}, count=${d.n})`)
        .join(", ");
      throw new Error(
        `Cannot add UNIQUE(agent_id, version) on agent_versions: ${dupes.length}+ duplicate rows found. ` +
          `Sample: ${sample}. ` +
          `Dedupe before upgrading, e.g.: DELETE FROM agent_versions WHERE rowid NOT IN ` +
          `(SELECT MIN(rowid) FROM agent_versions GROUP BY agent_id, version);`,
      );
    }

    this.rebuildWithFks(
      "agent_versions",
      `CREATE TABLE agent_versions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        size INTEGER NOT NULL,
        bundle_key TEXT NOT NULL,
        bundle_sha256 TEXT,
        config_snapshot TEXT,
        notes TEXT,
        pushed_at TEXT NOT NULL,
        UNIQUE(agent_id, version)
      )`,
    );
  }

  /**
   * SQLite "rebuild table with FKs" — recommended pattern from
   * https://www.sqlite.org/lang_altertable.html#otheralter.
   * Wrapped in a transaction; foreign_keys pragma is toggled off so the
   * INSERT FROM old doesn't error on the very FKs we're adding.
   *
   * The new table comes from a fixed column list, and the rows are copied by
   * the old table's column names. A column of the old table that the list does
   * not declare is carried over first, by its name and type only: without it
   * the copy fails, and the database no longer opens. That is the database a
   * start of 1.0.0 to 1.2.1 left behind — it added the telemetry columns to
   * runs before this rebuild, then failed here on them. The rest of such a
   * column's declaration (NOT NULL, a default, a CHECK) is not carried, which
   * is why a migration's ALTER still comes after the rebuilds, never before.
   */
  private rebuildWithFks(table: string, createSql: string): void {
    const backup = `${table}_pre_fk_backup`;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec("BEGIN");
      this.db.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
      this.db.exec(createSql);
      const declared = new Set(
        (this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
      );
      const oldColumns = this.db.pragma(`table_info(${backup})`) as Array<{
        name: string;
        type: string;
      }>;
      for (const column of oldColumns) {
        if (!declared.has(column.name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}`);
        }
      }
      // Copy rows: every column of the old table now exists in the new one.
      const cols = oldColumns.map((c) => c.name).join(", ");
      this.db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${backup}`);
      this.db.exec(`DROP TABLE ${backup}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }

    // foreign_key_check should be empty after a clean rebuild.
    const violations = this.db.pragma("foreign_key_check") as Array<unknown>;
    if (violations.length > 0) {
      throw new Error(
        `FK migration on ${table} left ${violations.length} violation(s) — refusing to continue. ` +
          `Inspect the rolled-back DB and fix referential integrity manually.`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private jsonParse(val: string | null | undefined): unknown {
    if (val == null) return null;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }

  private toAgent(row: Record<string, unknown>): Agent {
    return {
      ...row,
      // Defensive fallback for legacy rows not yet migrated to 014.
      llm_key_policy: (row.llm_key_policy as AgentLlmKeyPolicy) ?? "open",
    } as unknown as Agent;
  }

  private toApiKey(row: Record<string, unknown>): ApiKey {
    return {
      ...row,
      scopes: (this.jsonParse(row.scopes as string) as string[]) ?? [],
      // Defensive fallback for legacy rows not yet migrated to 013.
      scope_kind: (row.scope_kind as ApiKeyScopeKind) ?? "account",
    } as ApiKey;
  }

  private toRun(row: Record<string, unknown>): Run {
    return {
      ...row,
      input: this.jsonParse(row.input as string) as Record<string, unknown> | null,
      output: this.jsonParse(row.output as string) as Record<string, unknown> | null,
      files: this.jsonParse(row.files as string) as Record<string, unknown>[] | null,
      phase_timings: this.jsonParse(row.phase_timings as string) as Record<string, number> | null,
      // Defensive fallbacks for legacy DBs not yet migrated to 004 (cache columns).
      // Once SqliteDb.migrate() runs, these are populated from row.*; the ?? 0
      // handles the brief window where typecheck passes but values are absent.
      usage_cache_read_tokens: (row.usage_cache_read_tokens as number | undefined) ?? 0,
      usage_cache_write_tokens: (row.usage_cache_write_tokens as number | undefined) ?? 0,
      usage_cache_savings_usd: (row.usage_cache_savings_usd as number | undefined) ?? 0,
      // Defensive fallback for legacy rows not yet migrated to 013.
      api_key_id: (row.api_key_id as string | null) ?? null,
      // SQLite has no boolean: the column holds 0 or 1.
      pool_entitled: row.pool_entitled === 1,
    } as Run;
  }

  private toVersion(row: Record<string, unknown>): AgentVersion {
    return {
      ...row,
      config_snapshot: this.jsonParse(row.config_snapshot as string) as
        | Record<string, unknown>
        | undefined,
      notes: (row.notes as string | null) ?? null,
      verified: row.verified === 1,
    } as AgentVersion;
  }

  // ── Agents ────────────────────────────────────────────────────────────

  async createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
    visibility?: "private" | "public";
  }): Promise<Agent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const visibility = data.visibility ?? "private";
    this.db
      .prepare(
        "INSERT INTO agents (id, name, namespace, description, owner_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, data.name, data.namespace, data.description, data.owner_id, visibility, now, now);
    // llm_key_policy relies on the column DEFAULT 'open' at the DB level.
    return { id, ...data, visibility, llm_key_policy: "open", created_at: now, updated_at: now };
  }

  async getAgent(namespace: string, name: string): Promise<Agent | null> {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE namespace = ? AND name = ?")
      .get(namespace, name) as Record<string, unknown> | undefined;
    return row ? this.toAgent(row) : null;
  }

  async listAgents(opts: { page: number; limit: number; userId?: string }): Promise<{
    agents: (Agent & { run_count: number; token_count: number; cost_total: number })[];
    total: number;
  }> {
    const { page, limit, userId } = opts;
    // Filtered count — required so dashboard pagination is accurate (total
    // must match the number of rows visible to this caller, not the global
    // agent count). idx_agents_owner from migration 001 makes this O(log n).
    const total = userId
      ? (
          this.db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE owner_id = ?").get(userId) as {
            cnt: number;
          }
        ).cnt
      : (this.db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number }).cnt;

    const offset = (page - 1) * limit;
    const baseSelect = `SELECT a.*,
         COALESCE(r.run_count, 0) as run_count,
         COALESCE(r.token_count, 0) as token_count,
         COALESCE(r.cost_total, 0) as cost_total
         FROM agents a
         LEFT JOIN (
           SELECT agent_id,
             COUNT(*) as run_count,
             SUM(usage_total_tokens) as token_count,
             SUM(usage_estimated_cost) as cost_total
           FROM runs GROUP BY agent_id
         ) r ON r.agent_id = a.id`;
    const rows = userId
      ? (this.db
          .prepare(`${baseSelect} WHERE a.owner_id = ? LIMIT ? OFFSET ?`)
          .all(userId, limit, offset) as Record<string, unknown>[])
      : (this.db.prepare(`${baseSelect} LIMIT ? OFFSET ?`).all(limit, offset) as Record<
          string,
          unknown
        >[]);

    const agents = rows.map((row) => ({
      ...this.toAgent(row),
      run_count: (row.run_count as number) ?? 0,
      token_count: (row.token_count as number) ?? 0,
      cost_total: (row.cost_total as number) ?? 0,
    }));
    return { agents, total };
  }

  async setVersionVerified(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<AgentVersion | null> {
    const agent = await this.getAgent(namespace, name);
    if (!agent) return null;
    const result = this.db
      .prepare("UPDATE agent_versions SET verified = ? WHERE agent_id = ? AND version = ?")
      .run(verified ? 1 : 0, agent.id, version);
    if (result.changes === 0) return null;
    return this.getVersionByNumber(agent.id, version);
  }

  async setVisibility(
    namespace: string,
    name: string,
    visibility: "private" | "public",
  ): Promise<Agent | null> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE agents SET visibility = ?, updated_at = ? WHERE namespace = ? AND name = ?")
      .run(visibility, now, namespace, name);
    if (result.changes === 0) return null;
    return this.getAgent(namespace, name);
  }

  async setLlmKeyPolicy(
    namespace: string,
    name: string,
    policy: AgentLlmKeyPolicy,
  ): Promise<Agent | null> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE agents SET llm_key_policy = ?, updated_at = ? WHERE namespace = ? AND name = ?",
      )
      .run(policy, now, namespace, name);
    if (result.changes === 0) return null;
    return this.getAgent(namespace, name);
  }

  async deleteAgent(namespace: string, name: string): Promise<boolean> {
    const agent = await this.getAgent(namespace, name);
    if (!agent) return false;
    this.db.prepare("DELETE FROM agent_versions WHERE agent_id = ?").run(agent.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    return true;
  }

  // ── Agent Versions ────────────────────────────────────────────────────

  async createVersion(
    agentId: string,
    data: {
      version: string;
      size: number;
      bundle_key: string;
      bundle_sha256?: string | null;
      config_snapshot?: Record<string, unknown>;
      notes?: string | null;
    },
  ): Promise<AgentVersion> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const snapshot = data.config_snapshot ? JSON.stringify(data.config_snapshot) : null;
    const notes = data.notes ?? null;
    const bundleSha256 = data.bundle_sha256 ?? null;
    this.db
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, version, size, bundle_key, bundle_sha256, config_snapshot, notes, pushed_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        id,
        agentId,
        data.version,
        data.size,
        data.bundle_key,
        bundleSha256,
        snapshot,
        notes,
        now,
      );
    this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(now, agentId);
    return {
      id,
      agent_id: agentId,
      version: data.version,
      size: data.size,
      bundle_key: data.bundle_key,
      bundle_sha256: bundleSha256,
      config_snapshot: data.config_snapshot,
      notes,
      pushed_at: now,
      verified: false,
    };
  }

  /**
   * Never unknown: SQLite writes in this process, so a write that throws has
   * done all it will do. What it wrote before failing is there to be read —
   * `createVersion` inserts the row, then updates the agent, in two statements —:
   * the caller's read decides.
   */
  writeOutcomeUnknown(_err: unknown): boolean {
    return false;
  }

  async getVersions(agentId: string): Promise<AgentVersion[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY pushed_at")
      .all(agentId) as Record<string, unknown>[];
    return rows.map((r) => this.toVersion(r));
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY pushed_at DESC, rowid DESC LIMIT 1",
      )
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? this.toVersion(row) : null;
  }

  async getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?")
      .get(agentId, version) as Record<string, unknown> | undefined;
    return row ? this.toVersion(row) : null;
  }

  async deleteVersion(agentId: string, version: string): Promise<void> {
    this.db
      .prepare("DELETE FROM agent_versions WHERE agent_id = ? AND version = ?")
      .run(agentId, version);
  }

  async sumBundleBytesByOwner(ownerId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(v.size), 0) AS total
           FROM agent_versions v JOIN agents a ON a.id = v.agent_id
          WHERE a.owner_id = ?`,
      )
      .get(ownerId) as { total: number };
    return Number(row.total);
  }

  async listVersionsMissingHash(): Promise<Array<{ id: string; bundle_key: string }>> {
    return this.db
      .prepare("SELECT id, bundle_key FROM agent_versions WHERE bundle_sha256 IS NULL")
      .all() as Array<{ id: string; bundle_key: string }>;
  }

  async setVersionBundleHash(versionId: string, bundleSha256: string): Promise<void> {
    this.db
      .prepare("UPDATE agent_versions SET bundle_sha256 = ? WHERE id = ?")
      .run(bundleSha256, versionId);
  }

  // ── Agent State ───────────────────────────────────────────────────────

  async getState(agentId: string, partition: StatePartition): Promise<StoredState | null> {
    const row = this.db
      .prepare(
        `SELECT state, expires_at FROM agent_state
         WHERE agent_id = @agentId AND partition_key = (${STATE_PARTITION_KEY_SQL})`,
      )
      .get({ agentId, ...statePartitionParams(partition) }) as
      | { state: string; expires_at: string }
      | undefined;
    if (!row) return null;
    return {
      state: this.jsonParse(row.state) as Record<string, unknown>,
      expires_at: row.expires_at,
    };
  }

  async setState(
    agentId: string,
    partition: StatePartition,
    state: Record<string, unknown>,
    expiresAt: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_state
           (agent_id, partition_key, caller_user_id, caller_key_id, state, updated_at, expires_at)
         VALUES
           (@agentId, (${STATE_PARTITION_KEY_SQL}), @callerUserId, @callerKeyId, @state, @updatedAt, @expiresAt)
         ON CONFLICT (agent_id, partition_key) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      )
      .run({
        agentId,
        ...statePartitionParams(partition),
        state: JSON.stringify(state),
        updatedAt: new Date().toISOString(),
        expiresAt,
      });
  }

  async purgeExpiredState(): Promise<void> {
    this.db.prepare("DELETE FROM agent_state WHERE expires_at < ?").run(new Date().toISOString());
  }

  // ── Users ─────────────────────────────────────────────────────────────

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as
      | User
      | undefined;
    return row ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
    return row ?? null;
  }

  async createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User> {
    return this.insertUser(data);
  }

  async createOAuthUser(data: {
    github_id: string;
    login: string;
    email?: string;
    avatar_url?: string;
  }): Promise<{ user: User; derived: number | null }> {
    const findByGithubId = this.db.prepare("SELECT * FROM users WHERE github_id = ?");
    const isTaken = this.db.prepare("SELECT 1 FROM users WHERE username = ?");
    // `users.username` has no UNIQUE here: the explicit read is the guarantee.
    // `immediate` takes the write lock at BEGIN, so another connection to the
    // same file cannot slip an insert between the read and ours.
    const pick = this.db.transaction((): { user: User; derived: number | null } => {
      const existing = findByGithubId.get(data.github_id) as User | undefined;
      if (existing) return { user: existing, derived: null };
      const base = namespaceBase(data.login);
      for (let n = 1; n <= NAMESPACE_MAX_ATTEMPTS; n++) {
        const username = derivedNamespace(base, n);
        if (isTaken.get(username)) continue;
        const user = this.insertUser({
          github_id: data.github_id,
          username,
          email: data.email,
          avatar_url: data.avatar_url,
        });
        return { user, derived: n === 1 ? null : n };
      }
      throw new NamespaceUnavailableError(NAMESPACE_MAX_ATTEMPTS);
    });
    return pick.immediate();
  }

  private insertUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): User {
    const id = randomUUID();
    const now = new Date().toISOString();
    const user: User = {
      id,
      github_id: data.github_id,
      username: data.username,
      email: data.email ?? "",
      avatar_url: data.avatar_url ?? "",
      plan: "free",
      role: "user",
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        "INSERT INTO users (id, github_id, username, email, avatar_url, plan, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        user.id,
        user.github_id,
        user.username,
        user.email,
        user.avatar_url,
        user.plan,
        user.role,
        now,
        now,
      );
    return user;
  }

  async updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (data.email !== undefined) {
      sets.push("email = ?");
      vals.push(data.email);
    }
    if (data.avatar_url !== undefined) {
      sets.push("avatar_url = ?");
      vals.push(data.avatar_url);
    }
    if (data.plan !== undefined) {
      sets.push("plan = ?");
      vals.push(data.plan);
    }
    if (sets.length === 0) return this.getUserById(id);
    sets.push("updated_at = ?");
    vals.push(new Date().toISOString());
    vals.push(id);
    const result = this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (result.changes === 0) return null;
    return this.getUserById(id);
  }

  // ── Account deletion ──────────────────────────────────────────────────

  async planUserDeletion(userId: string): Promise<UserDeletionPlan | null> {
    const user = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as
      | { username: string }
      | undefined;
    if (!user) return null;
    const bundleKeys = this.db
      .prepare(
        "SELECT bundle_key FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE owner_id = ?)",
      )
      .all(userId) as Array<{ bundle_key: string }>;
    const shared =
      (
        this.db.prepare(NAMESPACE_SHARED_SQL).get({ ns: user.username, userId }) as {
          shared: number;
        }
      ).shared === 1;
    const pending = this.db
      .prepare(
        `SELECT id, files FROM runs
         WHERE ${DELETION_SCOPE_SQL} AND purge_after IS NOT NULL AND outputs_purged_at IS NULL`,
      )
      .all({ userId, ns: user.username, leftBehind: shared ? 0 : 1 }) as Array<{
      id: string;
      files: string | null;
    }>;
    return {
      username: user.username,
      bundle_keys: bundleKeys.map((r) => r.bundle_key),
      pending_outputs: pending.map((r) => ({
        id: r.id,
        files: this.jsonParse(r.files) as Record<string, unknown>[] | null,
      })),
      namespace_shared: shared,
    };
  }

  async deleteUser(
    userId: string,
    opts: { purged_output_run_ids: string[]; at: string },
  ): Promise<UserDeletionResult | null> {
    const purged = new Set(opts.purged_output_run_ids);
    // `immediate` takes the write lock at BEGIN: no other connection to the
    // file writes between the reads below and the deletion.
    const remove = this.db.transaction((): UserDeletionResult | null => {
      const user = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as
        | { username: string }
        | undefined;
      if (!user) return null;
      const agents = (
        this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?").get(userId) as {
          n: number;
        }
      ).n;
      const apiKeys = (
        this.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").get(userId) as {
          n: number;
        }
      ).n;
      const bundleKeys = (
        this.db
          .prepare(
            "SELECT bundle_key FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE owner_id = ?)",
          )
          .all(userId) as Array<{ bundle_key: string }>
      ).map((r) => r.bundle_key);
      const shared =
        (
          this.db.prepare(NAMESPACE_SHARED_SQL).get({ ns: user.username, userId }) as {
            shared: number;
          }
        ).shared === 1;
      const scopeParams = { userId, ns: user.username, leftBehind: shared ? 0 : 1 };
      // One synchronous body under the write lock: no completion can commit
      // between this read and the clearing below.
      const scope = this.db
        .prepare(
          `SELECT id, files, purge_after, outputs_purged_at FROM runs WHERE ${DELETION_SCOPE_SQL}`,
        )
        .all(scopeParams) as Array<{
        id: string;
        files: string | null;
        purge_after: string | null;
        outputs_purged_at: string | null;
      }>;
      const lateOutputs = scope
        .filter((r) => r.purge_after != null && r.outputs_purged_at == null && !purged.has(r.id))
        .map((r) => ({
          id: r.id,
          files: this.jsonParse(r.files) as Record<string, unknown>[] | null,
        }));

      // Cleared while the scope can still be selected: once the account and
      // its agents are gone, these runs no longer name them.
      this.db
        .prepare(
          `UPDATE runs SET
             input = NULL, output = NULL, error = NULL, files = '[]',
             content_cleared_at = @at,
             agent_version = CASE
               WHEN substr(agent_version, 1, length(@ns) + 1) = @ns || '/'
                 AND (agent_id IS NULL OR agent_id IN (SELECT id FROM agents WHERE owner_id = @userId))
               THEN CASE WHEN instr(agent_version, '@') > 0
                 THEN '@' || substr(agent_version, instr(agent_version, '@') + 1)
                 ELSE '@' END
               ELSE agent_version END
           WHERE ${DELETION_SCOPE_SQL}`,
        )
        .run({ ...scopeParams, at: opts.at });
      const markPurged = this.db.prepare(
        "UPDATE runs SET outputs_purged_at = ? WHERE id = ? AND outputs_purged_at IS NULL",
      );
      for (const id of purged) markPurged.run(opts.at, id);

      // The foreign keys do the rest (`foreign_keys = ON`).
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return {
        agents,
        versions: bundleKeys.length,
        api_keys: apiKeys,
        cleared_run_ids: scope.map((r) => r.id),
        late_outputs: lateOutputs,
        bundle_keys: bundleKeys,
      };
    });
    return remove.immediate();
  }

  async namespaceInUse(namespace: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM users WHERE username = @ns)
             OR EXISTS (SELECT 1 FROM agents WHERE namespace = @ns) AS used`,
      )
      .get({ ns: namespace }) as { used: number };
    return row.used === 1;
  }

  async referencedBundleKeys(keys: string[], exceptOwnerId?: string): Promise<string[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT v.bundle_key FROM agent_versions v JOIN agents a ON a.id = v.agent_id
         WHERE v.bundle_key IN (${placeholders}) AND a.owner_id IS NOT ?`,
      )
      .all(...keys, exceptOwnerId ?? null) as Array<{ bundle_key: string }>;
    return rows.map((r) => r.bundle_key);
  }

  // ── API Keys ──────────────────────────────────────────────────────────

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toApiKey(row) : null;
  }

  async createApiKey(data: {
    user_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    scopes?: string[];
    scope_kind?: ApiKeyScopeKind;
    agents?: string[];
    expires_at?: string;
  }): Promise<ApiKey> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const apiKey: ApiKey = {
      id,
      user_id: data.user_id,
      key_hash: data.key_hash,
      key_prefix: data.key_prefix,
      name: data.name,
      scopes: data.scopes ?? [...API_KEY_DEFAULT_SCOPES],
      scope_kind: data.scope_kind ?? "account",
      last_used_at: null,
      expires_at: data.expires_at ?? null,
      created_at: now,
    };
    const insertKey = this.db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, scopes, scope_kind, last_used_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertGrant = this.db.prepare(
      "INSERT INTO api_key_agents (api_key_id, agent_id) VALUES (?, ?)",
    );
    // Key + grant rows atomically (a partial insert would leave a scoped key
    // with the wrong grant set).
    this.db.transaction(() => {
      insertKey.run(
        id,
        data.user_id,
        data.key_hash,
        data.key_prefix,
        data.name,
        JSON.stringify(apiKey.scopes),
        apiKey.scope_kind,
        null,
        apiKey.expires_at,
        now,
      );
      for (const agentId of data.agents ?? []) {
        insertGrant.run(id, agentId);
      }
    })();
    return apiKey;
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return result.changes > 0;
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const rows = this.db.prepare("SELECT * FROM api_keys WHERE user_id = ?").all(userId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.toApiKey(r));
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    this.db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async getApiKeyAgentIds(keyId: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT agent_id FROM api_key_agents WHERE api_key_id = ?")
      .all(keyId) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  // ── Device codes (CLI device-login, RFC 8628) ─────────────────────────

  private toDeviceCode(row: Record<string, unknown>): DeviceCode {
    return {
      device_code_hash: row.device_code_hash as string,
      user_code_hash: row.user_code_hash as string,
      code_challenge: row.code_challenge as string,
      status: row.status as DeviceCodeStatus,
      user_id: (row.user_id as string | null) ?? null,
      current_interval: row.current_interval as number,
      attempt_count: row.attempt_count as number,
      created_at: row.created_at as string,
      expires_at: row.expires_at as string,
      last_polled_at: (row.last_polled_at as string | null) ?? null,
    };
  }

  async createDeviceCode(data: {
    device_code_hash: string;
    user_code_hash: string;
    code_challenge: string;
    expires_at: string;
    current_interval?: number;
  }): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO device_codes (device_code_hash, user_code_hash, code_challenge, status, user_id, current_interval, attempt_count, created_at, expires_at, last_polled_at) VALUES (?, ?, ?, 'pending', NULL, ?, 0, ?, ?, NULL)",
      )
      .run(
        data.device_code_hash,
        data.user_code_hash,
        data.code_challenge,
        data.current_interval ?? 5,
        new Date().toISOString(),
        data.expires_at,
      );
  }

  async getDeviceCodeByDeviceHash(deviceCodeHash: string): Promise<DeviceCode | null> {
    const row = this.db
      .prepare("SELECT * FROM device_codes WHERE device_code_hash = ?")
      .get(deviceCodeHash) as Record<string, unknown> | undefined;
    return row ? this.toDeviceCode(row) : null;
  }

  async getDeviceCodeByUserHash(userCodeHash: string): Promise<DeviceCode | null> {
    const row = this.db
      .prepare("SELECT * FROM device_codes WHERE user_code_hash = ?")
      .get(userCodeHash) as Record<string, unknown> | undefined;
    return row ? this.toDeviceCode(row) : null;
  }

  async authorizeDeviceCode(userCodeHash: string, userId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "UPDATE device_codes SET status = 'authorized', user_id = ? WHERE user_code_hash = ? AND status = 'pending'",
      )
      .run(userId, userCodeHash);
    return result.changes > 0;
  }

  async recordDeviceCodePoll(deviceCodeHash: string, slowDown: boolean): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        slowDown
          ? "UPDATE device_codes SET last_polled_at = ?, current_interval = current_interval + 5 WHERE device_code_hash = ?"
          : "UPDATE device_codes SET last_polled_at = ? WHERE device_code_hash = ?",
      )
      .run(now, deviceCodeHash);
  }

  async incrementDeviceCodeAttempts(deviceCodeHash: string): Promise<number> {
    this.db
      .prepare(
        "UPDATE device_codes SET attempt_count = attempt_count + 1 WHERE device_code_hash = ?",
      )
      .run(deviceCodeHash);
    const row = this.db
      .prepare("SELECT attempt_count FROM device_codes WHERE device_code_hash = ?")
      .get(deviceCodeHash) as { attempt_count: number } | undefined;
    return row?.attempt_count ?? 0;
  }

  async consumeDeviceCode(deviceCodeHash: string): Promise<void> {
    this.db.prepare("DELETE FROM device_codes WHERE device_code_hash = ?").run(deviceCodeHash);
  }

  async purgeExpiredDeviceCodes(): Promise<void> {
    this.db.prepare("DELETE FROM device_codes WHERE expires_at < ?").run(new Date().toISOString());
  }

  // ── Sessions (the browser session cookie store) ───────────────────────

  private toSession(row: Record<string, unknown>): Session {
    return {
      id_hash: row.id_hash as string,
      user_id: row.user_id as string,
      created_at: row.created_at as string,
      expires_at: row.expires_at as string,
    };
  }

  async createSession(data: {
    id_hash: string;
    user_id: string;
    expires_at: string;
  }): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(data.id_hash, data.user_id, new Date().toISOString(), data.expires_at);
  }

  /**
   * The row or null. Does NOT filter on expiry: validateSession decides that
   * once, for all three backends, and deletes the row it found expired.
   */
  async getSession(idHash: string): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toSession(row) : null;
  }

  async deleteSession(idHash: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  async purgeExpiredSessions(): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  }

  // ── Agent LLM keys (creator-attached, encrypted) ──────────────────────

  async setAgentLlmKey(
    agentId: string,
    provider: string,
    ciphertext: string,
    last4: string,
    keyVersion: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_llm_keys (agent_id, provider, ciphertext, last4, key_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, provider) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           last4 = excluded.last4,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, provider, ciphertext, last4, keyVersion, now, now);
  }

  async deleteAgentLlmKey(agentId: string, provider: string): Promise<void> {
    this.db
      .prepare("DELETE FROM agent_llm_keys WHERE agent_id = ? AND provider = ?")
      .run(agentId, provider);
  }

  async listAgentLlmKeys(agentId: string): Promise<AgentLlmKeyInfo[]> {
    const rows = this.db
      .prepare(
        "SELECT provider, last4, updated_at FROM agent_llm_keys WHERE agent_id = ? ORDER BY provider",
      )
      .all(agentId) as Array<{ provider: string; last4: string; updated_at: string }>;
    return rows.map((r) => ({ provider: r.provider, last4: r.last4, updated_at: r.updated_at }));
  }

  async getAgentLlmKeySecrets(agentId: string): Promise<AgentLlmKeyRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT agent_id, provider, ciphertext, last4, key_version FROM agent_llm_keys WHERE agent_id = ?",
      )
      .all(agentId) as Array<{
      agent_id: string;
      provider: string;
      ciphertext: string;
      last4: string;
      key_version: number;
    }>;
    return rows.map((r) => ({
      agent_id: r.agent_id,
      provider: r.provider,
      ciphertext: r.ciphertext,
      last4: r.last4,
      key_version: r.key_version,
    }));
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  async createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    api_key_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
    created_at?: string;
  }): Promise<Run> {
    return this.insertRun(data, { deadline_at: null, pool_entitled: false });
  }

  async admitRun(admission: RunAdmission): Promise<RunAdmissionResult> {
    const insert = (poolEntitled: boolean): Run =>
      this.insertRun(
        { ...admission.run, status: "running", created_at: admission.now },
        { deadline_at: admission.deadlineAt, pool_entitled: poolEntitled },
      );
    if (!admissionIsBounded(admission)) {
      // Nothing bounds the run: createRun's plain insert, its deadline and its
      // right to the pool set — no lock, no read.
      const poolEntitled = admission.poolRunning;
      return { admitted: true, run: insert(poolEntitled), poolEntitled, usage: null };
    }
    // `immediate` takes the write lock at BEGIN, before the first read: no
    // other connection to the file can write a run between the sums and the
    // insert. A refusal returns from the body and commits nothing written.
    const admit = this.db.transaction((): RunAdmissionResult => {
      const usage = this.usageOf(admission.run.user_id ?? null, {
        now: admission.now,
        windowStart: admission.windowStart,
        fastSince: fastRunsSince(admission.now),
        instance: admission.limits.instanceCap !== null,
      });
      const verdict = admissionVerdict(admission, usage);
      if (!verdict.admitted) return { admitted: false, reason: verdict.reason, usage };
      return {
        admitted: true,
        run: insert(verdict.poolEntitled),
        poolEntitled: verdict.poolEntitled,
        usage,
      };
    });
    return admit.immediate();
  }

  async returnPoolRight(id: string): Promise<boolean> {
    // The condition is in the statement that writes: a row that does not hold
    // the right is not written.
    const result = this.db
      .prepare("UPDATE runs SET pool_entitled = 0 WHERE id = ? AND pool_entitled = 1")
      .run(id);
    return result.changes === 1;
  }

  async getAccountUsage(
    userId: string | null,
    at: {
      now: string;
      windowStart: string | null;
      fastSince: string | null;
      instance?: boolean;
      fastLimit?: number;
    },
  ): Promise<AccountUsage> {
    const usage = this.usageOf(userId, {
      now: at.now,
      windowStart: at.windowStart,
      fastSince: at.fastSince,
      instance: at.instance === true,
    });
    if (at.fastLimit !== undefined) {
      usage.releasingFastRunAt = this.releasingFastRunAt(
        userId,
        at.fastSince,
        releasingFastRunOffset(usage.fastRunsUsed, at.fastLimit),
      );
    }
    return usage;
  }

  /**
   * The creation of the account's run with the right to a pooled machine,
   * created strictly after `fastSince`, that `offset` others precede, oldest
   * first — `null` when there is none. One row, read through the
   * `(user_id, created_at)` index; a null account or instant matches no row.
   */
  private releasingFastRunAt(
    userId: string | null,
    fastSince: string | null,
    offset: number,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM runs
         WHERE user_id = ? AND pool_entitled = 1 AND created_at > ?
         ORDER BY created_at LIMIT 1 OFFSET ?`,
      )
      .get(userId, fastSince, offset) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  /**
   * The sums an admission reads, in SQL. Timestamps are TEXT here: every
   * comparison is one of two `toISOString()` strings, and a duration is the
   * difference of two `julianday()`, rounded to the millisecond per row.
   */
  private usageOf(
    userId: string | null,
    at: { now: string; windowStart: string | null; fastSince: string | null; instance: boolean },
  ): AccountUsage {
    const usage: AccountUsage = {
      seatsInUse: 0,
      computeUsedMs: 0,
      fastRunsUsed: 0,
      // Read apart, and only when asked (`getAccountUsage`).
      releasingFastRunAt: null,
      instanceSeatsInUse: null,
    };
    if (userId !== null) {
      // Only the rows that can count: those in flight, and those created since
      // the earlier of the two instants.
      const from = [at.windowStart, at.fastSince].filter((t): t is string => t !== null).sort()[0];
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'running' AND deadline_at > @now THEN 1 ELSE 0 END), 0) AS seats,
             COALESCE(SUM(CASE WHEN @windowStart IS NOT NULL AND created_at >= @windowStart THEN
               CASE
                 WHEN status <> 'running' THEN COALESCE(charged_ms,
                   CASE WHEN completed_at IS NULL THEN 0
                     ELSE MAX(0, CAST(ROUND((julianday(completed_at) - julianday(created_at)) * 86400000) AS INTEGER))
                   END)
                 WHEN deadline_at IS NULL OR deadline_at <= @now THEN 0
                 ELSE MAX(0, CAST(ROUND((julianday(@now) - julianday(created_at)) * 86400000) AS INTEGER))
               END
             ELSE 0 END), 0) AS compute,
             COALESCE(SUM(CASE WHEN @fastSince IS NOT NULL AND pool_entitled = 1 AND created_at > @fastSince THEN 1 ELSE 0 END), 0) AS fast
           FROM runs
           WHERE user_id = @userId AND (status = 'running' OR (@from IS NOT NULL AND created_at >= @from))`,
        )
        .get({
          userId,
          now: at.now,
          windowStart: at.windowStart,
          fastSince: at.fastSince,
          from: from ?? null,
        }) as { seats: number; compute: number; fast: number };
      usage.seatsInUse = row.seats;
      usage.computeUsedMs = row.compute;
      usage.fastRunsUsed = row.fast;
    }
    if (at.instance) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND deadline_at > ?")
        .get(at.now) as { n: number };
      usage.instanceSeatsInUse = row.n;
    }
    return usage;
  }

  /** Write a new run row; the foreign keys refuse a missing account, agent or key. */
  private insertRun(
    data: {
      id: string;
      agent_id: string | null;
      agent_version: string;
      model?: string | null;
      environment_id?: string | null;
      user_id?: string | null;
      api_key_id?: string | null;
      status: RunStatus;
      input?: Record<string, unknown>;
      created_at?: string;
    },
    admitted: Pick<Run, "deadline_at" | "pool_entitled">,
  ): Run {
    const now = new Date().toISOString();
    const run: Run = {
      id: data.id,
      agent_id: data.agent_id,
      agent_version: data.agent_version,
      model: data.model ?? null,
      environment_id: data.environment_id ?? null,
      user_id: data.user_id ?? null,
      api_key_id: data.api_key_id ?? null,
      status: data.status,
      input: data.input ?? null,
      output: null,
      error: null,
      usage_prompt_tokens: 0,
      usage_completion_tokens: 0,
      usage_total_tokens: 0,
      usage_estimated_cost: 0,
      usage_cache_read_tokens: 0,
      usage_cache_write_tokens: 0,
      usage_cache_savings_usd: 0,
      duration_ms: null,
      machine_id: null,
      private_ip: null,
      phase_timings: null,
      files: null,
      created_at: data.created_at ?? now,
      completed_at: null,
      purge_after: null,
      outputs_purged_at: null,
      content_cleared_at: null,
      deadline_at: admitted.deadline_at,
      charged_ms: null,
      pool_entitled: admitted.pool_entitled,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, agent_version, model, environment_id, user_id, api_key_id, status, input, output, error, usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost, duration_ms, files, created_at, completed_at, deadline_at, pool_entitled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.agent_id,
        run.agent_version,
        run.model,
        run.environment_id,
        run.user_id,
        run.api_key_id,
        run.status,
        run.input ? JSON.stringify(run.input) : null,
        null,
        null,
        0,
        0,
        0,
        0,
        null,
        null,
        run.created_at,
        null,
        run.deadline_at,
        run.pool_entitled ? 1 : 0,
      );
    return run;
  }

  async updateRun(id: string, data: RunWrite): Promise<Run | null> {
    return this.writeRunRow(id, data, null);
  }

  async finishRun(
    id: string,
    data: FinalRunWrite,
    options?: { replaceShutdownProvisional?: boolean },
  ): Promise<Run | null> {
    return this.writeRunRow(id, data, {
      // Only a completion replaces the stop's provisional failure, and only when it asks.
      replaceShutdownProvisional:
        options?.replaceShutdownProvisional === true && data.status === "completed",
    });
  }

  /**
   * The write of a run row that `updateRun` and `finishRun` share. `finish`
   * set, the row is written only while it is still running — or, for a
   * completion that asks, while it holds the stop's provisional failure: the
   * condition is in the `WHERE` of the statement that writes.
   */
  private async writeRunRow(
    id: string,
    data: RunWrite,
    finish: { replaceShutdownProvisional: boolean } | null,
  ): Promise<Run | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      // A cleared run keeps its content: the mark is tested in the statement
      // that writes the rest, and the row is read back in the same body.
      sets.push(
        RUN_CONTENT_FIELDS.has(key)
          ? `${key} = CASE WHEN content_cleared_at IS NULL THEN ? ELSE ${key} END`
          : `${key} = ?`,
      );
      if (key === "output" || key === "files" || key === "phase_timings") {
        vals.push(val != null ? JSON.stringify(val) : null);
      } else {
        vals.push(val ?? null);
      }
    }
    if (sets.length === 0) return this.getRun(id);
    vals.push(id);
    let where = "id = ?";
    if (finish) {
      if (finish.replaceShutdownProvisional) {
        where += " AND (status = 'running' OR (status = 'failed' AND error = ?))";
        vals.push(SHUTDOWN_RUN_ERROR);
      } else {
        where += " AND status = 'running'";
      }
    }
    const result = this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE ${where}`)
      .run(...vals);
    if (result.changes === 0) return null;
    return this.getRun(id);
  }

  async getRun(id: string): Promise<Run | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toRun(row) : null;
  }

  async listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (filters?.agent_id) {
      wheres.push("agent_id = ?");
      vals.push(filters.agent_id);
    }
    if (filters?.user_id) {
      wheres.push("user_id = ?");
      vals.push(filters.user_id);
    }
    if (filters?.status) {
      wheres.push("status = ?");
      vals.push(filters.status);
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC ${limitClause}`)
      .all(...vals) as Record<string, unknown>[];
    return rows.map((r) => this.toRun(r));
  }

  async getAgentRunTotals(agentId: string): Promise<{ run_count: number; token_count: number }> {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS run_count, COALESCE(SUM(usage_total_tokens), 0) AS token_count FROM runs WHERE agent_id = ?",
      )
      .get(agentId) as { run_count: number; token_count: number };
    return { run_count: Number(row.run_count), token_count: Number(row.token_count) };
  }

  /**
   * Timestamps are TEXT here, so `purge_after <= ?` compares strings — correct
   * only while both sides are `toISOString()` output (fixed width, UTC): the
   * deadline is written, and `now` passed, in that form.
   */
  async listRunsDueForOutputPurge(
    now: string,
    limit: number,
  ): Promise<Array<Pick<Run, "id" | "files">>> {
    const rows = this.db
      .prepare(
        `SELECT id, files FROM runs
         WHERE purge_after <= ? AND outputs_purged_at IS NULL
         ORDER BY purge_after
         LIMIT ?`,
      )
      .all(now, limit) as Array<{ id: string; files: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      files: this.jsonParse(r.files) as Record<string, unknown>[] | null,
    }));
  }

  async markRunOutputsPurged(id: string, at: string): Promise<void> {
    this.db
      .prepare("UPDATE runs SET outputs_purged_at = ? WHERE id = ? AND outputs_purged_at IS NULL")
      .run(at, id);
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  async getStats(opts?: { userId?: string }) {
    // Per-user multi-tenancy: count only the caller's own agents (owner_id),
    // matching the user_id filter on the run aggregates below.
    const agents_count = (
      (opts?.userId
        ? this.db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE owner_id = ?").get(opts.userId)
        : this.db.prepare("SELECT COUNT(*) as cnt FROM agents").get()) as { cnt: number }
    ).cnt;

    const now = new Date();
    // Calendar-day anchors — for the per-day sparkline buckets only.
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    // Rolling windows — headline today/yesterday tiles are trailing 24h / prior
    // 24h (not UTC calendar days). Field names kept for wire compatibility.
    const last24hISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const prev24hISO = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    // Multi-tenancy: when userId provided, every aggregate filters WHERE user_id = ?
    // Self-host single-tenant (dev-token mode) passes a deterministic userId so
    // the filter narrows to that user; cloud mode isolates per-user stats.
    const userClause = opts?.userId ? "AND user_id = ?" : "";
    const userArg = opts?.userId ? [opts.userId] : [];

    const todayRow = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE created_at >= ? ${userClause}`,
      )
      .get(last24hISO, ...userArg) as {
      runs: number;
      tokens: number;
      failed: number;
      cache_savings: number;
      cost: number;
    };

    const yesterdayRow = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE created_at >= ? AND created_at < ? ${userClause}`,
      )
      .get(prev24hISO, last24hISO, ...userArg) as {
      runs: number;
      tokens: number;
      failed: number;
      cache_savings: number;
      cost: number;
    };

    // Daily arrays (7 items)
    const dailyRows = this.db
      .prepare(
        `SELECT date(created_at) as day, COUNT(*) as runs,
         COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE created_at >= ? ${userClause} GROUP BY day ORDER BY day`,
      )
      .all(sevenDaysAgoISO, ...userArg) as {
      day: string;
      runs: number;
      tokens: number;
      failed: number;
      cache_savings: number;
      cost: number;
    }[];

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyCacheSavings = new Array<number>(7).fill(0);
    const dailyCost = new Array<number>(7).fill(0);

    for (const row of dailyRows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex] = row.runs;
        dailyTokens[dayIndex] = row.tokens;
        dailyFailed[dayIndex] = row.failed;
        dailyCacheSavings[dayIndex] = row.cache_savings;
        dailyCost[dayIndex] = row.cost;
      }
    }

    return {
      agents_count,
      runs_today: todayRow.runs,
      tokens_today: todayRow.tokens,
      failed_today: todayRow.failed,
      runs_yesterday: yesterdayRow.runs,
      tokens_yesterday: yesterdayRow.tokens,
      failed_yesterday: yesterdayRow.failed,
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      cache_savings_today: todayRow.cache_savings,
      cache_savings_yesterday: yesterdayRow.cache_savings,
      daily_cache_savings: dailyCacheSavings,
      cost_today: todayRow.cost,
      cost_yesterday: yesterdayRow.cost,
      daily_cost: dailyCost,
    };
  }

  async getAgentStats(agentId: string, days = 7) {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const periodStart = new Date(todayStart);
    periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);
    const periodISO = periodStart.toISOString();

    const prevStart = new Date(periodStart);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);
    const prevISO = prevStart.toISOString();

    // Current period
    const cur = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) as avg_dur,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE agent_id = ? AND created_at >= ?`,
      )
      .get(agentId, periodISO) as {
      runs: number;
      tokens: number;
      failed: number;
      avg_dur: number;
      cache_savings: number;
      cost: number;
    };

    // Previous period
    const prev = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) as avg_dur,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE agent_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(agentId, prevISO, periodISO) as {
      runs: number;
      tokens: number;
      failed: number;
      avg_dur: number;
      cache_savings: number;
      cost: number;
    };

    // Daily arrays (always 7 items for sparklines)
    const dailyStart = new Date(todayStart);
    dailyStart.setUTCDate(dailyStart.getUTCDate() - 6);

    const dailyRows = this.db
      .prepare(
        `SELECT date(created_at) as day, COUNT(*) as runs,
         COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_dur
         FROM runs WHERE agent_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(agentId, dailyStart.toISOString()) as {
      day: string;
      runs: number;
      tokens: number;
      failed: number;
      avg_dur: number | null;
    }[];

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyAvgDuration = new Array<number>(7).fill(0);

    for (const row of dailyRows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - dailyStart.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex] = row.runs;
        dailyTokens[dayIndex] = row.tokens;
        dailyFailed[dayIndex] = row.failed;
        dailyAvgDuration[dayIndex] = row.avg_dur ? Math.round(row.avg_dur) : 0;
      }
    }

    // daily_cache_savings + daily_cost array lengths match the `days` parameter.
    const dailyPeriodRows = this.db
      .prepare(
        `SELECT date(created_at) as day,
         COALESCE(SUM(usage_cache_savings_usd), 0) as cache_savings,
         COALESCE(SUM(usage_estimated_cost), 0) as cost
         FROM runs WHERE agent_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(agentId, periodISO) as { day: string; cache_savings: number; cost: number }[];

    const dailyCacheSavings = new Array<number>(days).fill(0);
    const dailyCost = new Array<number>(days).fill(0);
    for (const row of dailyPeriodRows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < days) {
        dailyCacheSavings[dayIndex] = row.cache_savings;
        dailyCost[dayIndex] = row.cost;
      }
    }

    return {
      runs: cur.runs,
      tokens: cur.tokens,
      failed: cur.failed,
      avg_duration_ms: Math.round(cur.avg_dur),
      prev_runs: prev.runs,
      prev_tokens: prev.tokens,
      prev_failed: prev.failed,
      prev_avg_duration_ms: Math.round(prev.avg_dur),
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      daily_avg_duration_ms: dailyAvgDuration,
      cache_savings: cur.cache_savings,
      prev_cache_savings: prev.cache_savings,
      daily_cache_savings: dailyCacheSavings,
      cost: cur.cost,
      prev_cost: prev.cost,
      daily_cost: dailyCost,
    };
  }

  // ── Environments ──────────────────────────────────────────────────────

  async getEnvironment(id: string): Promise<Environment | null> {
    const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      ...row,
      config: this.jsonParse(row.config as string) as Record<string, unknown>,
    } as Environment;
  }

  async createEnvironment(data: {
    name: string;
    owner_id: string;
    config: Record<string, unknown>;
  }): Promise<Environment> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO environments (id, name, owner_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, data.name, data.owner_id, JSON.stringify(data.config), now, now);
    return {
      id,
      name: data.name,
      owner_id: data.owner_id,
      config: data.config,
      created_at: now,
      updated_at: now,
    };
  }

  async listEnvironments(ownerId: string): Promise<Environment[]> {
    const rows = this.db
      .prepare("SELECT * FROM environments WHERE owner_id = ?")
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...r,
      config: this.jsonParse(r.config as string) as Record<string, unknown>,
    })) as Environment[];
  }
}
