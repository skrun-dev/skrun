import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { DbAdapter } from "./adapter.js";
import type { Agent, AgentVersion, ApiKey, Environment, Run, RunStatus, User } from "./schema.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, name)
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  size INTEGER NOT NULL,
  bundle_key TEXT NOT NULL,
  config_snapshot TEXT,
  notes TEXT,
  pushed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_state (
  agent_name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  agent_version TEXT NOT NULL,
  model TEXT,
  environment_id TEXT,
  user_id TEXT,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  usage_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  usage_completion_tokens INTEGER NOT NULL DEFAULT 0,
  usage_total_tokens INTEGER NOT NULL DEFAULT 0,
  usage_estimated_cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  files TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
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

    // Migration: add agent_versions.notes (from #14c)
    if (!hasColumn("agent_versions", "notes")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN notes TEXT");
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
    return { ...row, verified: row.verified === 1 } as Agent;
  }

  private toApiKey(row: Record<string, unknown>): ApiKey {
    return {
      ...row,
      scopes: (this.jsonParse(row.scopes as string) as string[]) ?? [],
    } as ApiKey;
  }

  private toRun(row: Record<string, unknown>): Run {
    return {
      ...row,
      input: this.jsonParse(row.input as string) as Record<string, unknown> | null,
      output: this.jsonParse(row.output as string) as Record<string, unknown> | null,
      files: this.jsonParse(row.files as string) as Record<string, unknown>[] | null,
    } as Run;
  }

  private toVersion(row: Record<string, unknown>): AgentVersion {
    return {
      ...row,
      config_snapshot: this.jsonParse(row.config_snapshot as string) as
        | Record<string, unknown>
        | undefined,
      notes: (row.notes as string | null) ?? null,
    } as AgentVersion;
  }

  // ── Agents ────────────────────────────────────────────────────────────

  async createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
  }): Promise<Agent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO agents (id, name, namespace, description, owner_id, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(id, data.name, data.namespace, data.description, data.owner_id, now, now);
    return { id, ...data, verified: false, created_at: now, updated_at: now };
  }

  async getAgent(namespace: string, name: string): Promise<Agent | null> {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE namespace = ? AND name = ?")
      .get(namespace, name) as Record<string, unknown> | undefined;
    return row ? this.toAgent(row) : null;
  }

  async listAgents(
    page: number,
    limit: number,
  ): Promise<{ agents: (Agent & { run_count: number; token_count: number })[]; total: number }> {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number })
      .cnt;
    const offset = (page - 1) * limit;
    const rows = this.db
      .prepare(
        `SELECT a.*, COALESCE(r.run_count, 0) as run_count, COALESCE(r.token_count, 0) as token_count
         FROM agents a
         LEFT JOIN (
           SELECT agent_id, COUNT(*) as run_count, SUM(usage_total_tokens) as token_count
           FROM runs GROUP BY agent_id
         ) r ON r.agent_id = a.id
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Record<string, unknown>[];
    const agents = rows.map((row) => ({
      ...this.toAgent(row),
      run_count: (row.run_count as number) ?? 0,
      token_count: (row.token_count as number) ?? 0,
    }));
    return { agents, total };
  }

  async setVerified(namespace: string, name: string, verified: boolean): Promise<Agent | null> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE agents SET verified = ?, updated_at = ? WHERE namespace = ? AND name = ?")
      .run(verified ? 1 : 0, now, namespace, name);
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
      config_snapshot?: Record<string, unknown>;
      notes?: string | null;
    },
  ): Promise<AgentVersion> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const snapshot = data.config_snapshot ? JSON.stringify(data.config_snapshot) : null;
    const notes = data.notes ?? null;
    this.db
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, version, size, bundle_key, config_snapshot, notes, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, agentId, data.version, data.size, data.bundle_key, snapshot, notes, now);
    this.db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(now, agentId);
    return {
      id,
      agent_id: agentId,
      version: data.version,
      size: data.size,
      bundle_key: data.bundle_key,
      config_snapshot: data.config_snapshot,
      notes,
      pushed_at: now,
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
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        "INSERT INTO users (id, github_id, username, email, avatar_url, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        user.id,
        user.github_id,
        user.username,
        user.email,
        user.avatar_url,
        user.plan,
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
      scopes: data.scopes ?? [],
      last_used_at: null,
      expires_at: data.expires_at ?? null,
      created_at: now,
    };
    this.db
      .prepare(
        "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, scopes, last_used_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        data.user_id,
        data.key_hash,
        data.key_prefix,
        data.name,
        JSON.stringify(apiKey.scopes),
        null,
        apiKey.expires_at,
        now,
      );
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

  // ── Runs ──────────────────────────────────────────────────────────────

  async createRun(data: {
    id: string;
    agent_id: string | null;
    agent_version: string;
    model?: string | null;
    environment_id?: string | null;
    user_id?: string | null;
    status: RunStatus;
    input?: Record<string, unknown>;
  }): Promise<Run> {
    const now = new Date().toISOString();
    const run: Run = {
      id: data.id,
      agent_id: data.agent_id,
      agent_version: data.agent_version,
      model: data.model ?? null,
      environment_id: data.environment_id ?? null,
      user_id: data.user_id ?? null,
      status: data.status,
      input: data.input ?? null,
      output: null,
      error: null,
      usage_prompt_tokens: 0,
      usage_completion_tokens: 0,
      usage_total_tokens: 0,
      usage_estimated_cost: 0,
      duration_ms: null,
      files: null,
      created_at: now,
      completed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, agent_version, model, environment_id, user_id, status, input, output, error, usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost, duration_ms, files, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.agent_id,
        run.agent_version,
        run.model,
        run.environment_id,
        run.user_id,
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
        now,
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
        | "duration_ms"
        | "files"
        | "completed_at"
      >
    >,
  ): Promise<Run | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      sets.push(`${key} = ?`);
      if (key === "output" || key === "files") {
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

  async getStats() {
    const agents_count = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number }
    ).cnt;

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const yesterdayISO = yesterdayStart.toISOString();

    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    const todayRow = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
         FROM runs WHERE created_at >= ?`,
      )
      .get(todayISO) as { runs: number; tokens: number; failed: number };

    const yesterdayRow = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
         FROM runs WHERE created_at >= ? AND created_at < ?`,
      )
      .get(yesterdayISO, todayISO) as { runs: number; tokens: number; failed: number };

    // Daily arrays (7 items)
    const dailyRows = this.db
      .prepare(
        `SELECT date(created_at) as day, COUNT(*) as runs,
         COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
         FROM runs WHERE created_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(sevenDaysAgoISO) as { day: string; runs: number; tokens: number; failed: number }[];

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);

    for (const row of dailyRows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex] = row.runs;
        dailyTokens[dayIndex] = row.tokens;
        dailyFailed[dayIndex] = row.failed;
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
         COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) as avg_dur
         FROM runs WHERE agent_id = ? AND created_at >= ?`,
      )
      .get(agentId, periodISO) as { runs: number; tokens: number; failed: number; avg_dur: number };

    // Previous period
    const prev = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(usage_total_tokens), 0) as tokens,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) as avg_dur
         FROM runs WHERE agent_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(agentId, prevISO, periodISO) as {
      runs: number;
      tokens: number;
      failed: number;
      avg_dur: number;
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
