import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { DbAdapter } from "./adapter.js";
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
  type User,
} from "./schema.js";

// FK semantics mirror packages/api/src/db/migrations/001_initial_schema.sql
//   - Ownership chains: ON DELETE CASCADE (api_keys, agents, agent_versions, agent_state, environments)
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

CREATE TABLE IF NOT EXISTS agent_state (
  agent_name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  completed_at TEXT
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
`;

export class SqliteDb implements DbAdapter {
  private db: Database.Database;

  constructor(dbPath = "skrun.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
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

    // Migration: add agent_versions.notes (from #14c)
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

    // Migration 016: runner cold-start telemetry columns (operator-only).
    // phase_timings is a JSON object stored as TEXT (SQLite has no jsonb).
    if (!hasColumn("runs", "machine_id")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN machine_id TEXT");
    }
    if (!hasColumn("runs", "private_ip")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN private_ip TEXT");
    }
    if (!hasColumn("runs", "phase_timings")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN phase_timings TEXT");
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
    // from a pre-#77 race or manual SQL.
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
   */
  private rebuildWithFks(table: string, createSql: string): void {
    const backup = `${table}_pre_fk_backup`;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec("BEGIN");
      this.db.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
      this.db.exec(createSql);
      // Copy rows (column lists match by name since we kept identical columns).
      const cols = (this.db.pragma(`table_info(${backup})`) as Array<{ name: string }>)
        .map((c) => c.name)
        .join(", ");
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

  async getState(agentName: string): Promise<Record<string, unknown> | null> {
    const row = this.db
      .prepare("SELECT state FROM agent_state WHERE agent_name = ?")
      .get(agentName) as { state: string } | undefined;
    return row ? (this.jsonParse(row.state) as Record<string, unknown>) : null;
  }

  async setState(agentName: string, state: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO agent_state (agent_name, state, updated_at) VALUES (?, ?, ?)",
      )
      .run(agentName, JSON.stringify(state), now);
  }

  async deleteState(agentName: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_state WHERE agent_name = ?").run(agentName);
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
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, agent_version, model, environment_id, user_id, api_key_id, status, input, output, error, usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost, duration_ms, files, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return run;
  }

  async updateRun(
    id: string,
    data: Partial<
      Pick<
        Run,
        | "status"
        | "output"
        | "error"
        | "usage_prompt_tokens"
        | "usage_completion_tokens"
        | "usage_total_tokens"
        | "usage_estimated_cost"
        | "usage_cache_read_tokens"
        | "usage_cache_write_tokens"
        | "usage_cache_savings_usd"
        | "duration_ms"
        | "files"
        | "completed_at"
        | "machine_id"
        | "private_ip"
        | "phase_timings"
      >
    >,
  ): Promise<Run | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      sets.push(`${key} = ?`);
      if (key === "output" || key === "files" || key === "phase_timings") {
        vals.push(val != null ? JSON.stringify(val) : null);
      } else {
        vals.push(val ?? null);
      }
    }
    if (sets.length === 0) return this.getRun(id);
    vals.push(id);
    const result = this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
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
