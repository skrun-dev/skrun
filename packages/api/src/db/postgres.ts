/**
 * PostgresDb — `DbAdapter` implementation backed by the `pg` driver
 * (node-postgres v8). Replaces the legacy `SupabaseDb` (deleted in
 * a prior migration) which talked to PostgREST over HTTPS — `PostgresDb`
 * connects directly via the standard `postgres://user:pass@host:port/db`
 * URI so any Postgres ≥ 14 host (Supabase, Fly Postgres, RDS, Neon,
 * Render, …) works without code changes.
 *
 * Constraint enforcement: Postgres-side FK + UNIQUE + NOT NULL via the
 * SQL schema. Failures surface as native `pg.DatabaseError` codes
 * (`23503` FK violation, `23505` unique violation, …) — callers can
 * disambiguate via `err.code` if needed.
 *
 * Pool config tuned for an api-server holding long-lived SSE connections
 * + per-request DB queries. 10-connection cap is comfortable headroom
 * for our SSE throughput on a single Fly machine; can be raised via env
 * if needed.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import { Pool as PgPool, type Pool, type PoolConfig } from "pg";
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
  type Environment,
  type Run,
  type RunStatus,
  type User,
} from "./schema.js";

const logger = createLogger("db");

export class PostgresDb implements DbAdapter {
  private pool: Pool;

  constructor(databaseUrl: string, poolConfig: Partial<PoolConfig> = {}) {
    this.pool = new PgPool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...poolConfig,
    });
    logger.info({ event: "db_connected", url: redactUrl(databaseUrl) }, "Connected to Postgres");
  }

  /** Public for tests + the migrations-runner — callers needing a Pool
   *  reference can read it here (read-only by convention). */
  getPool(): Pool {
    return this.pool;
  }

  /** Graceful shutdown — close all pooled connections. */
  async close(): Promise<void> {
    await this.pool.end();
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
    const result = await this.pool.query<Agent>(
      `INSERT INTO agents (id, name, namespace, description, owner_id, visibility, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        data.name,
        data.namespace,
        data.description,
        data.owner_id,
        data.visibility ?? "private",
        now,
        now,
      ],
    );
    return result.rows[0];
  }

  async getAgent(namespace: string, name: string): Promise<Agent | null> {
    const result = await this.pool.query<Agent>(
      "SELECT * FROM agents WHERE namespace = $1 AND name = $2",
      [namespace, name],
    );
    return result.rows[0] ?? null;
  }

  async setVisibility(
    namespace: string,
    name: string,
    visibility: "private" | "public",
  ): Promise<Agent | null> {
    const result = await this.pool.query<Agent>(
      `UPDATE agents SET visibility = $1, updated_at = $2
       WHERE namespace = $3 AND name = $4
       RETURNING *`,
      [visibility, new Date().toISOString(), namespace, name],
    );
    return result.rows[0] ?? null;
  }

  async setLlmKeyPolicy(
    namespace: string,
    name: string,
    policy: AgentLlmKeyPolicy,
  ): Promise<Agent | null> {
    const result = await this.pool.query<Agent>(
      `UPDATE agents SET llm_key_policy = $1, updated_at = $2
       WHERE namespace = $3 AND name = $4
       RETURNING *`,
      [policy, new Date().toISOString(), namespace, name],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Single LEFT JOIN between `agents` and a `runs` aggregate
   * sub-query. Avoids the N+1 pattern from the legacy SupabaseDb
   * (one extra SELECT per agent for run stats).
   */
  async listAgents(opts: { page: number; limit: number; userId?: string }): Promise<{
    agents: (Agent & { run_count: number; token_count: number; cost_total: number })[];
    total: number;
  }> {
    const { page, limit, userId } = opts;
    const offset = (page - 1) * limit;

    // Filtered count — dashboard pagination needs it to match the
    // number of rows the caller can see. idx_agents_owner from migration
    // 001 makes this O(log n).
    const countSql = userId
      ? "SELECT COUNT(*)::bigint AS cnt FROM agents WHERE owner_id = $1"
      : "SELECT COUNT(*)::bigint AS cnt FROM agents";
    const countParams = userId ? [userId] : [];
    const countRes = await this.pool.query<{ cnt: string }>(countSql, countParams);
    const total = Number(countRes.rows[0]?.cnt ?? 0);

    // Single LEFT JOIN with an inline aggregate sub-query — one round-trip
    // for all agents + their stats.
    const baseSelect = `
      SELECT a.*,
             COALESCE(r.run_count, 0)::int AS run_count,
             COALESCE(r.token_count, 0)::bigint AS token_count,
             COALESCE(r.cost_total, 0)::numeric AS cost_total
      FROM agents a
      LEFT JOIN (
        SELECT agent_id,
               COUNT(*) AS run_count,
               SUM(usage_total_tokens) AS token_count,
               SUM(usage_estimated_cost) AS cost_total
        FROM runs
        WHERE agent_id IS NOT NULL
        GROUP BY agent_id
      ) r ON r.agent_id = a.id
    `;
    const rowsRes = userId
      ? await this.pool.query<
          Agent & { run_count: number; token_count: string; cost_total: string }
        >(`${baseSelect} WHERE a.owner_id = $1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [
          userId,
          limit,
          offset,
        ])
      : await this.pool.query<
          Agent & { run_count: number; token_count: string; cost_total: string }
        >(`${baseSelect} ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);

    const agents = rowsRes.rows.map((row) => ({
      ...row,
      run_count: Number(row.run_count),
      token_count: Number(row.token_count),
      cost_total: Number(row.cost_total),
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
    const result = await this.pool.query<AgentVersion>(
      `UPDATE agent_versions
       SET verified = $1
       WHERE agent_id = $2 AND version = $3
       RETURNING *`,
      [verified, agent.id, version],
    );
    return result.rows[0] ?? null;
  }

  async deleteAgent(namespace: string, name: string): Promise<boolean> {
    // FK cascade handles agent_versions; idx_agents_namespace_name unique.
    const result = await this.pool.query("DELETE FROM agents WHERE namespace = $1 AND name = $2", [
      namespace,
      name,
    ]);
    return (result.rowCount ?? 0) > 0;
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
    const result = await this.pool.query<AgentVersion>(
      `INSERT INTO agent_versions
         (id, agent_id, version, size, bundle_key, bundle_sha256, config_snapshot, notes, pushed_at, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
       RETURNING *`,
      [
        id,
        agentId,
        data.version,
        data.size,
        data.bundle_key,
        data.bundle_sha256 ?? null,
        data.config_snapshot ?? null,
        data.notes ?? null,
        now,
      ],
    );
    // Touch the parent agent's updated_at (mirrors sqlite.ts behaviour).
    await this.pool.query("UPDATE agents SET updated_at = $1 WHERE id = $2", [now, agentId]);
    return result.rows[0];
  }

  async getVersions(agentId: string): Promise<AgentVersion[]> {
    const result = await this.pool.query<AgentVersion>(
      "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY pushed_at",
      [agentId],
    );
    return result.rows;
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | null> {
    const result = await this.pool.query<AgentVersion>(
      "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY pushed_at DESC, id DESC LIMIT 1",
      [agentId],
    );
    return result.rows[0] ?? null;
  }

  async getVersionByNumber(agentId: string, version: string): Promise<AgentVersion | null> {
    const result = await this.pool.query<AgentVersion>(
      "SELECT * FROM agent_versions WHERE agent_id = $1 AND version = $2",
      [agentId, version],
    );
    return result.rows[0] ?? null;
  }

  async deleteVersion(agentId: string, version: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_versions WHERE agent_id = $1 AND version = $2", [
      agentId,
      version,
    ]);
  }

  async listVersionsMissingHash(): Promise<Array<{ id: string; bundle_key: string }>> {
    const result = await this.pool.query<{ id: string; bundle_key: string }>(
      "SELECT id, bundle_key FROM agent_versions WHERE bundle_sha256 IS NULL",
    );
    return result.rows;
  }

  async setVersionBundleHash(versionId: string, bundleSha256: string): Promise<void> {
    await this.pool.query("UPDATE agent_versions SET bundle_sha256 = $2 WHERE id = $1", [
      versionId,
      bundleSha256,
    ]);
  }

  // ── Agent State ───────────────────────────────────────────────────────
  //
  // `agent_state.agent_id` is `text` (aligned with SqliteDb's
  // `agent_name TEXT PRIMARY KEY`). The runtime contract passes
  // `<namespace>/<slug>` strings — not the agents UUID — so the key is
  // composite, not a real FK. Migration 010 (a live-test
  // finding) drops the legacy FK and ALTERs the column to text.

  async getState(agentName: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ state: Record<string, unknown> }>(
      "SELECT state FROM agent_state WHERE agent_id = $1",
      [agentName],
    );
    return result.rows[0]?.state ?? null;
  }

  async setState(agentName: string, state: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (agent_id, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [agentName, state],
    );
  }

  async deleteState(agentName: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_state WHERE agent_id = $1", [agentName]);
  }

  // ── Users ─────────────────────────────────────────────────────────────

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const result = await this.pool.query<User>("SELECT * FROM users WHERE github_id = $1", [
      githubId,
    ]);
    return result.rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.pool.query<User>("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async createUser(data: {
    github_id: string;
    username: string;
    email?: string;
    avatar_url?: string;
  }): Promise<User> {
    const id = randomUUID();
    const result = await this.pool.query<User>(
      `INSERT INTO users (id, github_id, username, email, avatar_url, plan, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'free', 'user', NOW(), NOW())
       RETURNING *`,
      [id, data.github_id, data.username, data.email ?? "", data.avatar_url ?? ""],
    );
    return result.rows[0];
  }

  async updateUser(
    id: string,
    data: Partial<Pick<User, "email" | "avatar_url" | "plan">>,
  ): Promise<User | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let paramIdx = 1;
    if (data.email !== undefined) {
      sets.push(`email = $${paramIdx++}`);
      vals.push(data.email);
    }
    if (data.avatar_url !== undefined) {
      sets.push(`avatar_url = $${paramIdx++}`);
      vals.push(data.avatar_url);
    }
    if (data.plan !== undefined) {
      sets.push(`plan = $${paramIdx++}`);
      vals.push(data.plan);
    }
    if (sets.length === 0) return this.getUserById(id);
    sets.push(`updated_at = $${paramIdx++}`);
    vals.push(new Date().toISOString());
    vals.push(id);
    const result = await this.pool.query<User>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      vals,
    );
    return result.rows[0] ?? null;
  }

  // ── API Keys ──────────────────────────────────────────────────────────
  //
  // `scopes` is `text[]` (Postgres array, not JSONB) — `pg` returns it as
  // a JS string[] directly. No JSON parsing needed.

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const result = await this.pool.query<ApiKey>("SELECT * FROM api_keys WHERE key_hash = $1", [
      keyHash,
    ]);
    return result.rows[0] ?? null;
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
    const agents = data.agents ?? [];
    // Key + grant rows atomically (a partial insert would leave a scoped key
    // with the wrong grant set).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ApiKey>(
        `INSERT INTO api_keys
           (id, user_id, key_hash, key_prefix, name, scopes, scope_kind, last_used_at, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NOW())
         RETURNING *`,
        [
          id,
          data.user_id,
          data.key_hash,
          data.key_prefix,
          data.name,
          data.scopes ?? [...API_KEY_DEFAULT_SCOPES],
          data.scope_kind ?? "account",
          data.expires_at ?? null,
        ],
      );
      for (const agentId of agents) {
        await client.query(
          "INSERT INTO api_key_agents (api_key_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [id, agentId],
        );
      }
      await client.query("COMMIT");
      return result.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM api_keys WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteApiKeyByOwner(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2", [
      id,
      userId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const result = await this.pool.query<ApiKey>("SELECT * FROM api_keys WHERE user_id = $1", [
      userId,
    ]);
    return result.rows;
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    await this.pool.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [id]);
  }

  async getApiKeyAgentIds(keyId: string): Promise<string[]> {
    const result = await this.pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM api_key_agents WHERE api_key_id = $1",
      [keyId],
    );
    return result.rows.map((r) => r.agent_id);
  }

  // ── Device codes (CLI device-login, RFC 8628) ─────────────────────────

  async createDeviceCode(data: {
    device_code_hash: string;
    user_code_hash: string;
    code_challenge: string;
    expires_at: string;
    current_interval?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_codes
         (device_code_hash, user_code_hash, code_challenge, status, user_id, current_interval, attempt_count, created_at, expires_at, last_polled_at)
       VALUES ($1, $2, $3, 'pending', NULL, $4, 0, NOW(), $5, NULL)`,
      [
        data.device_code_hash,
        data.user_code_hash,
        data.code_challenge,
        data.current_interval ?? 5,
        data.expires_at,
      ],
    );
  }

  async getDeviceCodeByDeviceHash(deviceCodeHash: string): Promise<DeviceCode | null> {
    const result = await this.pool.query<DeviceCode>(
      "SELECT * FROM device_codes WHERE device_code_hash = $1",
      [deviceCodeHash],
    );
    return result.rows[0] ?? null;
  }

  async getDeviceCodeByUserHash(userCodeHash: string): Promise<DeviceCode | null> {
    const result = await this.pool.query<DeviceCode>(
      "SELECT * FROM device_codes WHERE user_code_hash = $1",
      [userCodeHash],
    );
    return result.rows[0] ?? null;
  }

  async authorizeDeviceCode(userCodeHash: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE device_codes SET status = 'authorized', user_id = $1 WHERE user_code_hash = $2 AND status = 'pending'",
      [userId, userCodeHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordDeviceCodePoll(deviceCodeHash: string, slowDown: boolean): Promise<void> {
    await this.pool.query(
      slowDown
        ? "UPDATE device_codes SET last_polled_at = NOW(), current_interval = current_interval + 5 WHERE device_code_hash = $1"
        : "UPDATE device_codes SET last_polled_at = NOW() WHERE device_code_hash = $1",
      [deviceCodeHash],
    );
  }

  async incrementDeviceCodeAttempts(deviceCodeHash: string): Promise<number> {
    const result = await this.pool.query<{ attempt_count: number }>(
      "UPDATE device_codes SET attempt_count = attempt_count + 1 WHERE device_code_hash = $1 RETURNING attempt_count",
      [deviceCodeHash],
    );
    return result.rows[0]?.attempt_count ?? 0;
  }

  async consumeDeviceCode(deviceCodeHash: string): Promise<void> {
    await this.pool.query("DELETE FROM device_codes WHERE device_code_hash = $1", [deviceCodeHash]);
  }

  async purgeExpiredDeviceCodes(): Promise<void> {
    await this.pool.query("DELETE FROM device_codes WHERE expires_at < NOW()");
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
    await this.pool.query(
      `INSERT INTO agent_llm_keys (agent_id, provider, ciphertext, last4, key_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (agent_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         last4 = EXCLUDED.last4,
         key_version = EXCLUDED.key_version,
         updated_at = EXCLUDED.updated_at`,
      [agentId, provider, ciphertext, last4, keyVersion, now],
    );
  }

  async deleteAgentLlmKey(agentId: string, provider: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_llm_keys WHERE agent_id = $1 AND provider = $2", [
      agentId,
      provider,
    ]);
  }

  async listAgentLlmKeys(agentId: string): Promise<AgentLlmKeyInfo[]> {
    const result = await this.pool.query<{ provider: string; last4: string; updated_at: string }>(
      "SELECT provider, last4, updated_at FROM agent_llm_keys WHERE agent_id = $1 ORDER BY provider",
      [agentId],
    );
    return result.rows.map((r) => ({
      provider: r.provider,
      last4: r.last4,
      updated_at: r.updated_at,
    }));
  }

  async getAgentLlmKeySecrets(agentId: string): Promise<AgentLlmKeyRecord[]> {
    const result = await this.pool.query<AgentLlmKeyRecord>(
      "SELECT agent_id, provider, ciphertext, last4, key_version FROM agent_llm_keys WHERE agent_id = $1",
      [agentId],
    );
    return result.rows.map((r) => ({
      agent_id: r.agent_id,
      provider: r.provider,
      ciphertext: r.ciphertext,
      last4: r.last4,
      key_version: Number(r.key_version),
    }));
  }

  // ── Runs ──────────────────────────────────────────────────────────────
  //
  // JSONB columns (input, output, files) — `pg` round-trips JS objects
  // automatically. Numeric (10,6) columns return as strings; we
  // `Number()` at the edge so callers don't deal with BigInt/string.

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
    const result = await this.pool.query<Run>(
      `INSERT INTO runs
         (id, agent_id, agent_version, model, environment_id, user_id, api_key_id, status, input,
          usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost,
          usage_cache_read_tokens, usage_cache_write_tokens, usage_cache_savings_usd,
          created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, 0, 0, 0, 0, 0, COALESCE($10::timestamptz, NOW()), NULL)
       RETURNING *`,
      [
        data.id,
        data.agent_id,
        data.agent_version,
        data.model ?? null,
        data.environment_id ?? null,
        data.user_id ?? null,
        data.api_key_id ?? null,
        data.status,
        data.input ?? null,
        data.created_at ?? null,
      ],
    );
    return this.coerceRun(result.rows[0]);
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
    let paramIdx = 1;
    // jsonb columns must be JSON-serialised explicitly: `pg` auto-stringifies a
    // plain object but renders a JS array (e.g. `files`) as a Postgres array
    // literal `{...}`, which is invalid json. Stringify so arrays + objects
    // both round-trip.
    const jsonCols = new Set(["input", "output", "files", "phase_timings"]);
    for (const [key, val] of Object.entries(data)) {
      sets.push(`${key} = $${paramIdx++}`);
      vals.push(jsonCols.has(key) && val != null ? JSON.stringify(val) : (val ?? null));
    }
    if (sets.length === 0) return this.getRun(id);
    vals.push(id);
    const result = await this.pool.query<Run>(
      `UPDATE runs SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      vals,
    );
    return result.rows[0] ? this.coerceRun(result.rows[0]) : null;
  }

  async getRun(id: string): Promise<Run | null> {
    const result = await this.pool.query<Run>("SELECT * FROM runs WHERE id = $1", [id]);
    return result.rows[0] ? this.coerceRun(result.rows[0]) : null;
  }

  async listRuns(filters?: {
    agent_id?: string;
    user_id?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<Run[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    let paramIdx = 1;
    if (filters?.agent_id) {
      wheres.push(`agent_id = $${paramIdx++}`);
      vals.push(filters.agent_id);
    }
    if (filters?.user_id) {
      wheres.push(`user_id = $${paramIdx++}`);
      vals.push(filters.user_id);
    }
    if (filters?.status) {
      wheres.push(`status = $${paramIdx++}`);
      vals.push(filters.status);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limitClause = filters?.limit ? `LIMIT ${Number(filters.limit)}` : "";
    const result = await this.pool.query<Run>(
      `SELECT * FROM runs ${whereClause} ORDER BY created_at DESC ${limitClause}`,
      vals,
    );
    return result.rows.map((r) => this.coerceRun(r));
  }

  /**
   * Normalise PG numeric (returned as string) + ensure cache fields are
   * never `null` at the edge (DB default 0; legacy rows without the
   * cache columns would expose null, which the type expects as number).
   */
  private coerceRun(row: Run): Run {
    return {
      ...row,
      usage_estimated_cost: Number(row.usage_estimated_cost ?? 0),
      usage_cache_savings_usd: Number(row.usage_cache_savings_usd ?? 0),
      usage_cache_read_tokens: Number(row.usage_cache_read_tokens ?? 0),
      usage_cache_write_tokens: Number(row.usage_cache_write_tokens ?? 0),
      usage_prompt_tokens: Number(row.usage_prompt_tokens ?? 0),
      usage_completion_tokens: Number(row.usage_completion_tokens ?? 0),
      usage_total_tokens: Number(row.usage_total_tokens ?? 0),
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────
  //
  // Native SQL aggregates — single round-trip per stats block. Daily
  // arrays computed in JS from the DATE-grouped rows (matches sqlite.ts
  // contract: getStats / getAgentStats daily_runs/tokens/failed/avg_duration
  // hardcoded to length 7 for sparkline UX; only daily_cache_savings +
  // daily_cost honour the `days` param).

  async getStats(opts?: { userId?: string }): Promise<{
    agents_count: number;
    runs_today: number;
    tokens_today: number;
    failed_today: number;
    runs_yesterday: number;
    tokens_yesterday: number;
    failed_yesterday: number;
    daily_runs: number[];
    daily_tokens: number[];
    daily_failed: number[];
    cache_savings_today: number;
    cache_savings_yesterday: number;
    daily_cache_savings: number[];
    cost_today: number;
    cost_yesterday: number;
    daily_cost: number[];
  }> {
    // Per-user multi-tenancy: count only the caller's own agents (owner_id),
    // matching the user_id filter applied to every run aggregate below. An
    // unfiltered COUNT leaked the instance-wide agent total on shared deploys.
    const agentsCountRes = await this.pool.query<{ cnt: string }>(
      opts?.userId
        ? "SELECT COUNT(*)::bigint AS cnt FROM agents WHERE owner_id = $1"
        : "SELECT COUNT(*)::bigint AS cnt FROM agents",
      opts?.userId ? [opts.userId] : [],
    );
    const agents_count = Number(agentsCountRes.rows[0]?.cnt ?? 0);

    const now = new Date();
    // Calendar-day anchors — used ONLY for the per-day sparkline buckets
    // (daily_* arrays); a sparkline bar is intrinsically one UTC calendar day.
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    // Rolling windows — the headline "today"/"yesterday" tiles are the trailing
    // 24h and the 24h before it (NOT UTC calendar days), so a run from ~21h ago
    // still counts regardless of the UTC-midnight boundary or viewer timezone.
    // Field names stay *_today/*_yesterday for wire compatibility.
    const last24hISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const prev24hISO = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const userClause = opts?.userId ? "AND user_id = $2" : "";
    const userArg = opts?.userId ? [opts.userId] : [];

    interface AggRow {
      runs: string;
      tokens: string;
      failed: string;
      cache_savings: string;
      cost: string;
    }
    const todayRes = await this.pool.query<AggRow>(
      `SELECT COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE created_at >= $1 ${userClause}`,
      [last24hISO, ...userArg],
    );
    const yesterdayRes = await this.pool.query<AggRow>(
      `SELECT COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE created_at >= $1 AND created_at < $2 ${opts?.userId ? "AND user_id = $3" : ""}`,
      [prev24hISO, last24hISO, ...(opts?.userId ? [opts.userId] : [])],
    );

    interface DailyRow {
      day: string;
      runs: string;
      tokens: string;
      failed: string;
      cache_savings: string;
      cost: string;
    }
    const dailyRes = await this.pool.query<DailyRow>(
      `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE created_at >= $1 ${userClause}
       GROUP BY day ORDER BY day`,
      [sevenDaysAgoISO, ...userArg],
    );

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyCacheSavings = new Array<number>(7).fill(0);
    const dailyCost = new Array<number>(7).fill(0);

    for (const row of dailyRes.rows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex] = Number(row.runs);
        dailyTokens[dayIndex] = Number(row.tokens);
        dailyFailed[dayIndex] = Number(row.failed);
        dailyCacheSavings[dayIndex] = Number(row.cache_savings);
        dailyCost[dayIndex] = Number(row.cost);
      }
    }

    const today = todayRes.rows[0];
    const yesterday = yesterdayRes.rows[0];

    return {
      agents_count,
      runs_today: Number(today.runs),
      tokens_today: Number(today.tokens),
      failed_today: Number(today.failed),
      runs_yesterday: Number(yesterday.runs),
      tokens_yesterday: Number(yesterday.tokens),
      failed_yesterday: Number(yesterday.failed),
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      cache_savings_today: Number(today.cache_savings),
      cache_savings_yesterday: Number(yesterday.cache_savings),
      daily_cache_savings: dailyCacheSavings,
      cost_today: Number(today.cost),
      cost_yesterday: Number(yesterday.cost),
      daily_cost: dailyCost,
    };
  }

  async getAgentStats(
    agentId: string,
    days = 7,
  ): Promise<{
    runs: number;
    tokens: number;
    failed: number;
    avg_duration_ms: number;
    prev_runs: number;
    prev_tokens: number;
    prev_failed: number;
    prev_avg_duration_ms: number;
    daily_runs: number[];
    daily_tokens: number[];
    daily_failed: number[];
    daily_avg_duration_ms: number[];
    cache_savings: number;
    prev_cache_savings: number;
    daily_cache_savings: number[];
    cost: number;
    prev_cost: number;
    daily_cost: number[];
  }> {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const periodStart = new Date(todayStart);
    periodStart.setUTCDate(periodStart.getUTCDate() - days + 1);
    const prevStart = new Date(periodStart);
    prevStart.setUTCDate(prevStart.getUTCDate() - days);

    const periodISO = periodStart.toISOString();
    const prevISO = prevStart.toISOString();

    interface CurRow {
      runs: string;
      tokens: string;
      failed: string;
      avg_dur: string | null;
      cache_savings: string;
      cost: string;
    }
    const curRes = await this.pool.query<CurRow>(
      `SELECT COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              AVG(NULLIF(duration_ms, 0)) AS avg_dur,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, periodISO],
    );
    const prevRes = await this.pool.query<CurRow>(
      `SELECT COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              AVG(NULLIF(duration_ms, 0)) AS avg_dur,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`,
      [agentId, prevISO, periodISO],
    );

    // Sparkline-window (always 7 days) for runs/tokens/failed/avg_duration.
    const dailyStart = new Date(todayStart);
    dailyStart.setUTCDate(dailyStart.getUTCDate() - 6);

    interface DailyRow {
      day: string;
      runs: string;
      tokens: string;
      failed: string;
      avg_dur: string | null;
    }
    const dailyRes = await this.pool.query<DailyRow>(
      `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS runs,
              COALESCE(SUM(usage_total_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS failed,
              AVG(NULLIF(duration_ms, 0)) AS avg_dur
       FROM runs WHERE agent_id = $1 AND created_at >= $2 GROUP BY day ORDER BY day`,
      [agentId, dailyStart.toISOString()],
    );

    const dailyRuns = new Array<number>(7).fill(0);
    const dailyTokens = new Array<number>(7).fill(0);
    const dailyFailed = new Array<number>(7).fill(0);
    const dailyAvgDuration = new Array<number>(7).fill(0);

    for (const row of dailyRes.rows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - dailyStart.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < 7) {
        dailyRuns[dayIndex] = Number(row.runs);
        dailyTokens[dayIndex] = Number(row.tokens);
        dailyFailed[dayIndex] = Number(row.failed);
        dailyAvgDuration[dayIndex] = row.avg_dur ? Math.round(Number(row.avg_dur)) : 0;
      }
    }

    // daily_cache_savings + daily_cost match the `days` parameter.
    interface PeriodRow {
      day: string;
      cache_savings: string;
      cost: string;
    }
    const dailyPeriodRes = await this.pool.query<PeriodRow>(
      `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(usage_cache_savings_usd), 0)::numeric AS cache_savings,
              COALESCE(SUM(usage_estimated_cost), 0)::numeric AS cost
       FROM runs WHERE agent_id = $1 AND created_at >= $2 GROUP BY day ORDER BY day`,
      [agentId, periodISO],
    );

    const dailyCacheSavings = new Array<number>(days).fill(0);
    const dailyCost = new Array<number>(days).fill(0);
    for (const row of dailyPeriodRes.rows) {
      const rowDate = new Date(`${row.day}T00:00:00.000Z`);
      const dayIndex = Math.floor(
        (rowDate.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (dayIndex >= 0 && dayIndex < days) {
        dailyCacheSavings[dayIndex] = Number(row.cache_savings);
        dailyCost[dayIndex] = Number(row.cost);
      }
    }

    const cur = curRes.rows[0];
    const prev = prevRes.rows[0];
    return {
      runs: Number(cur.runs),
      tokens: Number(cur.tokens),
      failed: Number(cur.failed),
      avg_duration_ms: cur.avg_dur ? Math.round(Number(cur.avg_dur)) : 0,
      prev_runs: Number(prev.runs),
      prev_tokens: Number(prev.tokens),
      prev_failed: Number(prev.failed),
      prev_avg_duration_ms: prev.avg_dur ? Math.round(Number(prev.avg_dur)) : 0,
      daily_runs: dailyRuns,
      daily_tokens: dailyTokens,
      daily_failed: dailyFailed,
      daily_avg_duration_ms: dailyAvgDuration,
      cache_savings: Number(cur.cache_savings),
      prev_cache_savings: Number(prev.cache_savings),
      daily_cache_savings: dailyCacheSavings,
      cost: Number(cur.cost),
      prev_cost: Number(prev.cost),
      daily_cost: dailyCost,
    };
  }

  // ── Environments ──────────────────────────────────────────────────────

  async getEnvironment(id: string): Promise<Environment | null> {
    const result = await this.pool.query<Environment>("SELECT * FROM environments WHERE id = $1", [
      id,
    ]);
    return result.rows[0] ?? null;
  }

  async createEnvironment(data: {
    name: string;
    owner_id: string;
    config: Record<string, unknown>;
  }): Promise<Environment> {
    const id = randomUUID();
    const result = await this.pool.query<Environment>(
      `INSERT INTO environments (id, name, owner_id, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [id, data.name, data.owner_id, data.config],
    );
    return result.rows[0];
  }

  async listEnvironments(ownerId: string): Promise<Environment[]> {
    const result = await this.pool.query<Environment>(
      "SELECT * FROM environments WHERE owner_id = $1",
      [ownerId],
    );
    return result.rows;
  }
}

/**
 * Redact the password segment of a `postgres://` URI for safe logging.
 * Input: `postgres://user:secret@host:port/db` → `postgres://user:***@host:port/db`.
 */
function redactUrl(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/i, "$1***$2");
}
