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
import {
  type CustomTypesConfig,
  Pool as PgPool,
  type Pool,
  type PoolClient,
  type PoolConfig,
  types as pgTypes,
} from "pg";
import { errorFields } from "../utils/error-fields.js";
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
  clientTimeoutMs,
  DB_STATEMENT_TIMEOUT_MAX_MS,
  DB_STATEMENT_TIMEOUT_MIN_MS,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  isClientReadTimeout,
  writeOutcomeUnknown as pgWriteOutcomeUnknown,
} from "./pg-timeouts.js";
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
  type Session,
  type StatePartition,
  type StoredState,
  type User,
  type UserDeletionPlan,
  type UserDeletionResult,
} from "./schema.js";

const logger = createLogger("db");

/**
 * How this adapter's pool parses the values Postgres sends: the driver's
 * defaults, except `timestamptz`, handed back as the `toISOString()` string the
 * `DbAdapter` contract types every timestamp as — the string the memory and
 * SQLite backends already return. This is the one place timestamps are
 * converted: every row of every table goes through it, tables added later
 * included, so no reader has to remember a per-table normaliser.
 *
 * - Scoped to this pool (the `types` option), never `pg.types.setTypeParser`,
 *   which would change every `pg` client of the process.
 * - Built on the driver's own parser, looked up at each call: Postgres's text
 *   form of a timestamp is not ISO 8601, so `new Date(text)` is not a parser.
 * - `timestamptz` only. The schema declares no `timestamp` without time zone
 *   (it would keep the default parser, and so a `Date`), and `date` columns
 *   keep theirs too: the stats read days as text, through `to_char`.
 */
const TIMESTAMPTZ_AS_ISO: CustomTypesConfig = {
  getTypeParser: (id, format) => {
    const base = pgTypes.getTypeParser(id, format);
    if (id !== pgTypes.builtins.TIMESTAMPTZ) return base;
    return (value: unknown) => {
      const parsed = base(value);
      return parsed instanceof Date ? parsed.toISOString() : parsed;
    };
  },
};

/**
 * The partition key of a state row, computed in SQL from the two reference
 * parameters by the same expression as the table's CHECK (migration 019), so a
 * write can never build a key the CHECK refuses and a read finds the key its
 * write produced. Positional: `$2` is the caller's user id, `$3` the caller's
 * key id (each null when absent) — in every query that embeds it.
 */
const STATE_PARTITION_KEY_SQL =
  "CASE WHEN $2::uuid IS NOT NULL THEN 'account:' || $2::uuid::text " +
  "WHEN $3::uuid IS NOT NULL THEN 'key:' || $3::uuid::text ELSE 'shared' END";

/** Postgres: a unique violation. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return code === PG_UNIQUE_VIOLATION;
}

/** Postgres: the transaction was chosen to break a deadlock. */
const PG_DEADLOCK_DETECTED = "40P01";

function isDeadlock(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return code === PG_DEADLOCK_DETECTED;
}

/**
 * How many times a deletion that Postgres can abort to break a deadlock runs,
 * in all — an account's, an agent's — before the error goes up.
 */
const DEADLOCK_MAX_ATTEMPTS = 3;

/**
 * Run `once` again when Postgres reports a deadlock, at most
 * `DEADLOCK_MAX_ATTEMPTS` times in all. Only for one transaction (or one
 * statement) with no effect outside the database: an aborted attempt left
 * nothing behind.
 */
async function retryOnDeadlock<T>(once: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= DEADLOCK_MAX_ATTEMPTS) throw err;
    }
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * What a call that holds a client of its own does once its transaction failed
 * with `err`; returns the error to hand the client back with — which takes it
 * out of the pool —, or nothing for a client still fit to serve.
 *
 * - Its session is lost (`lost`, see `listenForLostSession`): no ROLLBACK, the
 *   server rolled the transaction back as the session ended. The client is
 *   handed back broken, whatever `err` says.
 * - The client's own timer gave up on a query the server may still be
 *   running: no ROLLBACK, which would wait behind that query, on a timer of
 *   its own. The client is handed back broken: the pool closes its
 *   connection, and the server rolls the transaction back as the session ends.
 * - Otherwise, ROLLBACK; a rollback that fails says the connection is gone,
 *   or silent: the client is handed back broken too.
 */
async function abandonTransaction(
  client: PoolClient,
  err: unknown,
  lost: Error | undefined,
): Promise<Error | undefined> {
  if (lost !== undefined) return lost;
  if (isClientReadTimeout(err)) return asError(err);
  let broken: Error | undefined;
  await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
    broken = asError(rollbackErr);
  });
  return broken;
}

/**
 * Listens for the error event of a client a call holds, from the moment it is
 * borrowed until it is handed back. A session the server ends — an operator's
 * `pg_terminate_backend`, a restart, its bound on an idle transaction — or a
 * connection that drops arrives as an error event of the client, outside any
 * query's answer. The pool listens only to the clients it keeps idle, and an
 * error event nobody listens to is an uncaught exception: the process's end.
 * `lost()` is that error once it came — the client is then handed back
 * broken, whatever else happened —; `stop()` stops listening once the client
 * is handed back, when the pool listens again.
 */
function listenForLostSession(client: PoolClient): {
  lost: () => Error | undefined;
  stop: () => void;
} {
  let lost: Error | undefined;
  const onError = (err: unknown) => {
    lost ??= asError(err);
  };
  client.on("error", onError);
  return {
    lost: () => lost,
    stop: () => {
      client.off("error", onError);
    },
  };
}

/**
 * Whether the namespace `$2` of the account `$1` is someone else's too:
 * another account with that username, or an agent under it another account
 * owns.
 */
const NAMESPACE_SHARED_SQL = `SELECT EXISTS (SELECT 1 FROM users WHERE username = $2 AND id <> $1)
    OR EXISTS (SELECT 1 FROM agents WHERE namespace = $2 AND owner_id <> $1) AS shared`;

/**
 * The runs an account deletion clears, for the account `$1`, its agents `$2`
 * and its namespace `$3`: the runs it launched, every run of its agents, and —
 * when `$4`, the namespace being its alone — the runs left without an agent
 * whose version names that namespace: runs of an agent it deleted earlier.
 * The namespace is compared as text, never as a pattern (an older one can
 * hold `_`).
 */
const DELETION_SCOPE_SQL = `(user_id = $1 OR agent_id = ANY($2::uuid[])
    OR ($4::boolean AND agent_id IS NULL
        AND left(agent_version, length($3::text) + 1) = $3::text || '/'))`;

/**
 * The columns of `runs` whose foreign key sets them to null when the row they
 * name is deleted — every one of them: a test compares this list with the
 * schema. An account deletion sets them to null itself, in this order, before
 * the account row goes (`deleteUserOnce`).
 */
export const RUN_SET_NULL_COLUMNS = [
  "user_id",
  "agent_id",
  "api_key_id",
  "environment_id",
] as const;
type RunSetNullColumn = (typeof RUN_SET_NULL_COLUMNS)[number];

/**
 * The advisory locks of a run admission, in the two-integer form — a key space
 * distinct from the one-`bigint` form the migrations' lock takes. The first
 * integer names the lock: `hashtext('skrun_run_admission_account')` and
 * `hashtext('skrun_run_admission_instance')`, computed once on Postgres 16.
 * The second is the account's id hashed (`hashtext` of its `uuid::text`,
 * always lowercase), or 0 for the instance. Account first, instance last.
 */
export const ADMISSION_ACCOUNT_LOCK = 318_419_508;
export const ADMISSION_INSTANCE_LOCK = 1_511_183_156;

/**
 * How long an admission waits for a lock — an advisory lock, or a row lock
 * its insert's foreign keys take (waited for under the account's lock alone,
 * before the instance's) — and how long one of its statements may run,
 * before it gives up as `busy`. Set per transaction. Inside it, the statement
 * bound takes the place of the one the pool sets on every connection —
 * shorter than its 10 s default; the pool sets no bound of its own on a lock
 * wait, which its statement bound covers.
 */
const ADMISSION_LOCK_TIMEOUT = "2s";
const ADMISSION_STATEMENT_TIMEOUT = "5s";

/**
 * How long an admission's transaction may sit idle — its client sending
 * nothing — before the server ends its session, and with it the transaction
 * and its locks. An API process that stalls, or is gone without closing its
 * connection, would otherwise hold the account's lock — and the instance's,
 * which every admission of every account takes — for as long as the pool's
 * own bound on an idle transaction (10 s by default). Set per transaction:
 * inside it, it takes the place of the pool's bound.
 */
const ADMISSION_IDLE_TIMEOUT = "5s";

/**
 * Postgres: a lock not obtained within `lock_timeout`, a statement past
 * `statement_timeout`, a session ended past `idle_in_transaction_session_timeout`.
 */
const PG_LOCK_NOT_AVAILABLE = "55P03";
const PG_QUERY_CANCELED = "57014";
const PG_IDLE_IN_TRANSACTION_TIMEOUT = "25P03";

function isAdmissionTimeout(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return (
    code === PG_LOCK_NOT_AVAILABLE ||
    code === PG_QUERY_CANCELED ||
    code === PG_IDLE_IN_TRANSACTION_TIMEOUT
  );
}

/** What a `PostgresDb` takes beyond its pool's configuration. */
export interface PostgresDbOptions {
  /**
   * The bound on each statement the adapter's connections send, in
   * milliseconds — a whole number from 1000 to 600000; 10000 when absent.
   * Every connection the pool opens sets it, before it serves, as the server's
   * `statement_timeout` and `idle_in_transaction_session_timeout`; a query
   * that gets no answer 5 s past it is given up on by the client.
   */
  statementTimeoutMs?: number;
  /**
   * For tests only: production never sets it. Awaited by a bounded admission
   * inside its transaction — `beforeInsert` between its reads and its insert,
   * under the account's lock; `beforeCommit` once its row is written and the
   * instance counted, under every lock it takes — so a test can hold one
   * admission there and see the next one wait on a lock, instead of hoping
   * for a race.
   */
  admissionHooks?: {
    beforeInsert?: (runId: string) => Promise<void>;
    beforeCommit?: (runId: string) => Promise<void>;
  };
}

/** The two reference columns of a partition, in the order of `$2`, `$3`. */
function statePartitionParams(partition: StatePartition): {
  callerUserId: string | null;
  callerKeyId: string | null;
} {
  return {
    callerUserId: partition.kind === "account" ? partition.userId : null,
    callerKeyId: partition.kind === "key" ? partition.keyId : null,
  };
}

export class PostgresDb implements DbAdapter {
  private pool: Pool;
  private readonly admissionHooks: NonNullable<PostgresDbOptions["admissionHooks"]>;

  constructor(
    databaseUrl: string,
    poolConfig: Partial<PoolConfig> = {},
    options: PostgresDbOptions = {},
  ) {
    const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_DB_STATEMENT_TIMEOUT_MS;
    // Checked here, and not only where the environment is read: the value is
    // written into the SET each connection sends, and every caller of this
    // constructor — a script, a test — goes through the same check.
    if (
      !Number.isInteger(statementTimeoutMs) ||
      statementTimeoutMs < DB_STATEMENT_TIMEOUT_MIN_MS ||
      statementTimeoutMs > DB_STATEMENT_TIMEOUT_MAX_MS
    ) {
      throw new RangeError(
        `statementTimeoutMs must be a whole number of milliseconds from ${DB_STATEMENT_TIMEOUT_MIN_MS} to ${DB_STATEMENT_TIMEOUT_MAX_MS} (got ${statementTimeoutMs})`,
      );
    }
    this.admissionHooks = options.admissionHooks ?? {};
    this.pool = new PgPool({
      connectionString: databaseUrl,
      // A capacity lever: each process holds up to this many connections, and
      // a run's admission holds one while it checks. Before changing it, see
      // the capacity levers in the operator docs (docs/self-hosting.md).
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...poolConfig,
      // After the spread: the shape of what this adapter returns is its
      // contract, not a pool setting a caller may override — nor are the
      // bounds below.
      types: TIMESTAMPTZ_AS_ISO,
      // Every connection the pool opens bounds, before it serves, how long the
      // server runs one of its statements and how long it keeps a transaction
      // that sits idle: past either, the server stops the statement (57014) or
      // ends the session (25P03), and the locks it held go with it. One simple
      // query, the value a whole number checked above. Sent on each new
      // connection, it also rewrites whatever an earlier session left on the
      // same connection of a pooler in session mode.
      onConnect: async (client) => {
        await client.query(
          `SET statement_timeout = ${statementTimeoutMs}; SET idle_in_transaction_session_timeout = ${statementTimeoutMs}`,
        );
      },
      // The client's own timer, for a connection that gets no answer at all —
      // a server gone silent stops nothing: a query fails `Query read timeout`
      // 5 s past the server's bound. Through `pool.query`, its client goes back
      // to the pool with that error, which takes it out.
      query_timeout: clientTimeoutMs(statementTimeoutMs),
    });
    // A connection the pool holds idle can be ended by the database at any
    // moment, outside any query — a restart, a provider's idle timeout, an
    // operator's `pg_terminate_backend`: the pool then emits `error`, which
    // Node turns into an uncaught exception, the process's end, when nothing
    // listens. One line says so — the error's class and code only: the error
    // carries its client, whose configuration holds the connection string.
    // The pool has already dropped that client, and opens another when a
    // query needs one.
    this.pool.on("error", (err) => {
      logger.warn(
        { event: "db_idle_connection_lost", ...errorFields(err) },
        "An idle database connection was closed by the server; the pool opens another when it needs one",
      );
    });
    logger.info(
      { event: "db_connected", url: redactDatabaseUrl(databaseUrl) },
      "Connected to Postgres",
    );
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
    // The statement takes the agent's row, then the rows its foreign keys
    // reach (its runs, detached): an account deletion, which locks runs
    // first, can close a cycle with it. One statement, nothing outside the
    // database: run again when Postgres aborts it — its caller has already
    // deleted the bundles.
    const result = await retryOnDeadlock(() =>
      this.pool.query("DELETE FROM agents WHERE namespace = $1 AND name = $2", [namespace, name]),
    );
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

  /**
   * Unknown unless the server answered a refusal that rolls the statement back
   * (`writeOutcomeUnknown`, `pg-timeouts.ts`).
   */
  writeOutcomeUnknown(err: unknown): boolean {
    return pgWriteOutcomeUnknown(err);
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

  async sumBundleBytesByOwner(ownerId: string): Promise<number> {
    // The sum of an `integer` column is a `bigint`, which the driver hands back
    // as a string: one account's bundles may add up past 2^31 bytes.
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(v.size), 0)::bigint AS total
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE a.owner_id = $1`,
      [ownerId],
    );
    return Number(result.rows[0]?.total ?? 0);
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
  // `agent_state` is keyed by the agent's id (a real foreign key, with its
  // cascade) and by a partition: `shared`, `account:<user id>` or
  // `key:<key id>` (migration 019). The partition key is computed in SQL from
  // the reference parameters, by the same expression as the table's CHECK:
  // `uuid::text` is always lower-case, so a key built in JS from an id in
  // another case would be refused by the CHECK. Before migration 019 the key
  // was the text `<namespace>/<slug>`, with no foreign key: a re-created agent
  // of the same name inherited the notebook, and nothing went with the agent.

  async getState(agentId: string, partition: StatePartition): Promise<StoredState | null> {
    const { callerUserId, callerKeyId } = statePartitionParams(partition);
    const result = await this.pool.query<StoredState>(
      `SELECT state, expires_at FROM agent_state
       WHERE agent_id = $1 AND partition_key = (${STATE_PARTITION_KEY_SQL})`,
      [agentId, callerUserId, callerKeyId],
    );
    const row = result.rows[0];
    return row ? { state: row.state, expires_at: row.expires_at } : null;
  }

  async setState(
    agentId: string,
    partition: StatePartition,
    state: Record<string, unknown>,
    expiresAt: string,
  ): Promise<void> {
    const { callerUserId, callerKeyId } = statePartitionParams(partition);
    await this.pool.query(
      `INSERT INTO agent_state
         (agent_id, partition_key, caller_user_id, caller_key_id, state, updated_at, expires_at)
       VALUES ($1, (${STATE_PARTITION_KEY_SQL}), $2::uuid, $3::uuid, $4, NOW(), $5)
       ON CONFLICT (agent_id, partition_key) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at`,
      [agentId, callerUserId, callerKeyId, state, expiresAt],
    );
  }

  async purgeExpiredState(): Promise<void> {
    // The instant is passed from the process, as a toISOString() string, not
    // read from NOW(): the deadline was written from the same clock, in the
    // same form, on all three backends.
    await this.pool.query("DELETE FROM agent_state WHERE expires_at < $1", [
      new Date().toISOString(),
    ]);
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

  async createOAuthUser(data: {
    github_id: string;
    login: string;
    email?: string;
    avatar_url?: string;
  }): Promise<{ user: User; derived: number | null }> {
    const existing = await this.getUserByGithubId(data.github_id);
    if (existing) return { user: existing, derived: null };

    const base = namespaceBase(data.login);
    for (let n = 1; n <= NAMESPACE_MAX_ATTEMPTS; n++) {
      const username = derivedNamespace(base, n);
      const taken = await this.pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
      if ((taken.rowCount ?? 0) > 0) continue;
      try {
        const user = await this.createUser({
          github_id: data.github_id,
          username,
          email: data.email,
          avatar_url: data.avatar_url,
        });
        return { user, derived: n === 1 ? null : n };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent sign-in won the row. `users` has two UNIQUE columns,
        // and a violation is raised only once the other row is committed —
        // so it is visible here. Same GitHub account: that is the account.
        // Otherwise the name was taken: try the next one. No constraint name
        // is read.
        const raced = await this.getUserByGithubId(data.github_id);
        if (raced) return { user: raced, derived: null };
      }
    }
    throw new NamespaceUnavailableError(NAMESPACE_MAX_ATTEMPTS);
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

  // ── Account deletion ──────────────────────────────────────────────────

  async planUserDeletion(userId: string): Promise<UserDeletionPlan | null> {
    const user = await this.pool.query<{ username: string }>(
      "SELECT username FROM users WHERE id = $1",
      [userId],
    );
    if (user.rows.length === 0) return null;
    const username = user.rows[0].username;
    const agents = await this.pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE owner_id = $1",
      [userId],
    );
    const agentIds = agents.rows.map((r) => r.id);
    const bundleKeys = await this.pool.query<{ bundle_key: string }>(
      "SELECT bundle_key FROM agent_versions WHERE agent_id = ANY($1::uuid[])",
      [agentIds],
    );
    const shared = (
      await this.pool.query<{ shared: boolean }>(NAMESPACE_SHARED_SQL, [userId, username])
    ).rows[0].shared;
    const pending = await this.pool.query<Pick<Run, "id" | "files">>(
      `SELECT id, files FROM runs
       WHERE ${DELETION_SCOPE_SQL}
         AND purge_after IS NOT NULL AND outputs_purged_at IS NULL`,
      [userId, agentIds, username, !shared],
    );
    return {
      username,
      bundle_keys: bundleKeys.rows.map((r) => r.bundle_key),
      pending_outputs: pending.rows,
      namespace_shared: shared,
    };
  }

  async deleteUser(
    userId: string,
    opts: { purged_output_run_ids: string[]; at: string },
  ): Promise<UserDeletionResult | null> {
    // Postgres aborted one side of a lock cycle: everything this transaction
    // did is undone, so it is run again from the start.
    return retryOnDeadlock(() => this.deleteUserOnce(userId, opts));
  }

  private async deleteUserOnce(
    userId: string,
    opts: { purged_output_run_ids: string[]; at: string },
  ): Promise<UserDeletionResult | null> {
    const client = await this.pool.connect();
    const session = listenForLostSession(client);
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      // Locks first, in the order an insert of a run takes its foreign key
      // locks (agent, then account, then key — the RI triggers fire by name):
      // a run being created for this account waits on one of these rows, then
      // fails on its foreign key once they are gone, instead of slipping into
      // the cleared set with its input. Once the account row is locked, no
      // agent or key of it can be created: the agents are read again for one
      // born in between. Then the runs of the scope (below).
      await client.query("SELECT id FROM agents WHERE owner_id = $1 FOR UPDATE", [userId]);
      const user = await client.query<{ username: string }>(
        "SELECT username FROM users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      if (user.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const username = user.rows[0].username;
      const agents = await client.query<{ id: string }>(
        "SELECT id FROM agents WHERE owner_id = $1 FOR UPDATE",
        [userId],
      );
      const keys = await client.query<{ id: string }>(
        "SELECT id FROM api_keys WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const agentIds = agents.rows.map((r) => r.id);
      const versions = await client.query<{ bundle_key: string }>(
        "SELECT bundle_key FROM agent_versions WHERE agent_id = ANY($1::uuid[])",
        [agentIds],
      );
      const shared = (
        await client.query<{ shared: boolean }>(NAMESPACE_SHARED_SQL, [userId, username])
      ).rows[0].shared;
      // The runs of the scope, locked before anything is read from them. A
      // completion that committed before this lock is read with its files and
      // purge date; one that comes after waits for the row, then finds it
      // cleared and deletes its objects itself. Read unlocked, a completion
      // committed between this read and the clearing would have its files
      // emptied with its objects left unlisted. In id order: two deletions
      // lock what they share in one order. Every row of the scope is locked,
      // but `files` comes back only for a run whose outputs wait for their
      // purge — the only ones read from it.
      const scope = await client.query<{
        id: string;
        files: Run["files"];
        purge_after: unknown;
        outputs_purged_at: unknown;
      }>(
        `SELECT id,
           CASE WHEN purge_after IS NOT NULL AND outputs_purged_at IS NULL THEN files END AS files,
           purge_after, outputs_purged_at
         FROM runs
         WHERE ${DELETION_SCOPE_SQL}
         ORDER BY id FOR UPDATE`,
        [userId, agentIds, username, !shared],
      );
      // Read before the clearing empties `files`: the object keys are
      // rebuilt from it.
      const purged = new Set(opts.purged_output_run_ids);
      const late = scope.rows
        .filter((r) => r.purge_after != null && r.outputs_purged_at == null && !purged.has(r.id))
        .map((r) => ({ id: r.id, files: r.files }));
      // Cleared by the ids read and locked above, never selected again: the
      // detachment below changes nothing of which runs are cleared.
      const cleared = await client.query<{ id: string }>(
        `UPDATE runs SET
           input = NULL, output = NULL, error = NULL, files = '[]'::jsonb,
           content_cleared_at = $3::timestamptz,
           agent_version = CASE
             WHEN left(agent_version, length($2::text) + 1) = $2::text || '/'
               AND (agent_id IS NULL OR agent_id = ANY($1::uuid[]))
             THEN CASE WHEN strpos(agent_version, '@') > 0
               THEN '@' || substr(agent_version, strpos(agent_version, '@') + 1)
               ELSE '@' END
             ELSE agent_version END
         WHERE id = ANY($4::uuid[])
         RETURNING id`,
        [agentIds, username, opts.at, scope.rows.map((r) => r.id)],
      );
      await client.query(
        `UPDATE runs SET outputs_purged_at = $2::timestamptz
         WHERE id = ANY($1::uuid[]) AND outputs_purged_at IS NULL`,
        [opts.purged_output_run_ids, opts.at],
      );
      // The runs are detached here from the account and from what goes with
      // it, before its row goes — never left to the foreign keys' SET NULL
      // actions. Postgres runs those in the order of their triggers' names,
      // which follow the OIDs the constraints got: an order the database's
      // history sets, not this code. And when an action updates a run this
      // transaction rewrote above, every foreign key of the row is checked
      // again: run before the action that detaches it from an agent, a key or
      // an environment already deleted, that check fails (23503). Each
      // statement here is checked at its end, while every row it names still
      // exists, and the actions find nothing left to do. The columns set to
      // null are those the foreign keys would set: RUN_SET_NULL_COLUMNS.
      const environments = await client.query<{ id: string }>(
        "SELECT id FROM environments WHERE owner_id = $1",
        [userId],
      );
      // What each column names that goes with the account: a column added to
      // the list does not compile here until it is given its ids.
      const detached: Record<RunSetNullColumn, string[]> = {
        user_id: [userId],
        agent_id: agentIds,
        api_key_id: keys.rows.map((r) => r.id),
        environment_id: environments.rows.map((r) => r.id),
      };
      for (const column of RUN_SET_NULL_COLUMNS) {
        // Neither api_key_id nor environment_id has an index: a column is
        // scanned only when there is something to detach, as its foreign
        // key's action would be. The column's name comes from the list above.
        if (detached[column].length === 0) continue;
        await client.query(`UPDATE runs SET ${column} = NULL WHERE ${column} = ANY($1::uuid[])`, [
          detached[column],
        ]);
      }
      // The foreign keys delete the rest; their SET NULL actions find no run
      // left to update.
      await client.query("DELETE FROM users WHERE id = $1", [userId]);
      await client.query("COMMIT");
      const bundleKeys = versions.rows.map((r) => r.bundle_key);
      return {
        agents: agentIds.length,
        versions: bundleKeys.length,
        api_keys: keys.rows.length,
        cleared_run_ids: cleared.rows.map((r) => r.id),
        late_outputs: late,
        bundle_keys: bundleKeys,
      };
    } catch (err) {
      broken = await abandonTransaction(client, err, session.lost());
      throw err;
    } finally {
      client.release(broken ?? session.lost());
      session.stop();
    }
  }

  async namespaceInUse(namespace: string): Promise<boolean> {
    const result = await this.pool.query<{ used: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)
           OR EXISTS (SELECT 1 FROM agents WHERE namespace = $1) AS used`,
      [namespace],
    );
    return result.rows[0].used;
  }

  async referencedBundleKeys(keys: string[], exceptOwnerId?: string): Promise<string[]> {
    if (keys.length === 0) return [];
    const result = await this.pool.query<{ bundle_key: string }>(
      `SELECT DISTINCT v.bundle_key FROM agent_versions v JOIN agents a ON a.id = v.agent_id
       WHERE v.bundle_key = ANY($1::text[]) AND a.owner_id IS DISTINCT FROM $2::uuid`,
      [keys, exceptOwnerId ?? null],
    );
    return result.rows.map((r) => r.bundle_key);
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
    const session = listenForLostSession(client);
    let broken: Error | undefined;
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
      broken = await abandonTransaction(client, err, session.lost());
      throw err;
    } finally {
      client.release(broken ?? session.lost());
      session.stop();
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

  // ── Sessions (the browser session cookie store) ───────────────────────

  async createSession(data: {
    id_hash: string;
    user_id: string;
    expires_at: string;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, NOW(), $3)",
      [data.id_hash, data.user_id, data.expires_at],
    );
  }

  /**
   * The row or null. Does NOT filter on expiry: validateSession decides that
   * once, for all three backends, and deletes the row it found expired.
   *
   * Its timestamps are already the contract's ISO strings: the pool converts
   * every `timestamptz` it reads (`TIMESTAMPTZ_AS_ISO`, top of this file).
   */
  async getSession(idHash: string): Promise<Session | null> {
    const result = await this.pool.query<Session>("SELECT * FROM sessions WHERE id_hash = $1", [
      idHash,
    ]);
    return result.rows[0] ?? null;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id_hash = $1", [idHash]);
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
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
    return this.insertRun(null, data, { deadline_at: null, pool_entitled: false });
  }

  async admitRun(admission: RunAdmission): Promise<RunAdmissionResult> {
    const row = { ...admission.run, status: "running" as const, created_at: admission.now };
    if (!admissionIsBounded(admission)) {
      // Nothing bounds the run: createRun's plain insert, its deadline and its
      // right to the pool set — no lock, no read.
      const poolEntitled = admission.poolRunning;
      const run = await this.insertRun(null, row, {
        deadline_at: admission.deadlineAt,
        pool_entitled: poolEntitled,
      });
      return { admitted: true, run, poolEntitled, usage: null };
    }
    const userId = admission.run.user_id ?? null;
    const client = await this.pool.connect();
    // The session the server ends while this client holds it — idle in its
    // transaction past ADMISSION_IDLE_TIMEOUT — arrives as an error event of
    // the client, which would otherwise go uncaught: kept by the listener, and
    // the client released broken, out of the pool.
    const session = listenForLostSession(client);
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${ADMISSION_LOCK_TIMEOUT}'`);
      await client.query(`SET LOCAL statement_timeout = '${ADMISSION_STATEMENT_TIMEOUT}'`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${ADMISSION_IDLE_TIMEOUT}'`,
      );
      // The account's lock before its first read: two admissions of one
      // account read their sums one after the other, each seeing the other's
      // row once it is committed (READ COMMITTED reads anew each statement).
      if (userId !== null) {
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2::uuid::text))", [
          ADMISSION_ACCOUNT_LOCK,
          userId,
        ]);
      }
      const usage = await this.readAccountUsage(client, userId, {
        now: admission.now,
        windowStart: admission.windowStart,
        fastSince: fastRunsSince(admission.now),
      });
      // The account's refusals first: an account that cannot run writes
      // nothing and takes no instance lock.
      let verdict = admissionVerdict(admission, usage);
      if (!verdict.admitted) {
        await client.query("ROLLBACK");
        return { admitted: false, reason: verdict.reason, usage };
      }
      // The row next, under the account's lock alone: its foreign keys lock
      // the rows they name (agent, environment, account, key), and a row
      // locked elsewhere — an account or an agent being deleted — is waited
      // for here, never under
      // the instance's lock, which every admission of every account needs.
      // Its right to the pool is the account's alone: the instance changes
      // nothing of it.
      await this.admissionHooks.beforeInsert?.(admission.run.id);
      const run = await this.insertRun(client, row, {
        deadline_at: admission.deadlineAt,
        pool_entitled: verdict.poolEntitled,
      });
      // The instance's lock last, then its count of the other runs' seats —
      // this row is not counted, so the count is the seats in use before it.
      // Refused: the row is rolled back with the rest.
      if (admission.limits.instanceCap !== null) {
        await client.query("SELECT pg_advisory_xact_lock($1, 0)", [ADMISSION_INSTANCE_LOCK]);
        usage.instanceSeatsInUse = await this.readInstanceSeats(client, admission.now, run.id);
        verdict = admissionVerdict(admission, usage);
        if (!verdict.admitted) {
          await client.query("ROLLBACK");
          return { admitted: false, reason: verdict.reason, usage };
        }
      }
      await this.admissionHooks.beforeCommit?.(admission.run.id);
      await client.query("COMMIT");
      return { admitted: true, run, poolEntitled: verdict.poolEntitled, usage };
    } catch (err) {
      // ROLLBACK, unless the session is lost or the client's own timer gave
      // up — the client is then handed back broken, as it is when the
      // rollback fails: it leaves the pool.
      broken = await abandonTransaction(client, err, session.lost());
      // A lock not obtained, a statement past its time, the transaction left
      // idle past its time — the session ended by the server —, or a
      // connection gone silent past the client's timer: the run is refused as
      // busy. Any other error — a missing account, agent or key included —
      // goes up as it is.
      if (
        isAdmissionTimeout(err) ||
        isAdmissionTimeout(session.lost()) ||
        isClientReadTimeout(err)
      ) {
        return { admitted: false, reason: "busy", usage: null };
      }
      throw err;
    } finally {
      client.release(broken ?? session.lost());
      session.stop();
    }
  }

  async returnPoolRight(id: string): Promise<boolean> {
    // One statement on a connection of the pool — no transaction, no account
    // lock —, the condition in its WHERE: a row that does not hold the right is
    // not written, and a write that waited on the row's lock tests it against
    // the version committed meanwhile.
    const result = await this.pool.query(
      "UPDATE runs SET pool_entitled = false WHERE id = $1 AND pool_entitled",
      [id],
    );
    return result.rowCount === 1;
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
    const usage = await this.readAccountUsage(null, userId, at);
    if (at.instance === true) {
      usage.instanceSeatsInUse = await this.readInstanceSeats(null, at.now, null);
    }
    if (at.fastLimit !== undefined) {
      usage.releasingFastRunAt = await this.readReleasingFastRun(
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
   * `(user_id, created_at)` index, on a connection of the pool; a null
   * account or instant matches no row.
   */
  private async readReleasingFastRun(
    userId: string | null,
    fastSince: string | null,
    offset: number,
  ): Promise<string | null> {
    const result = await this.pool.query<{ created_at: string }>(
      `SELECT created_at FROM runs
       WHERE user_id = $1 AND pool_entitled AND created_at > $2::timestamptz
       ORDER BY created_at OFFSET $3 LIMIT 1`,
      [userId, fastSince, offset],
    );
    return result.rows[0]?.created_at ?? null;
  }

  /**
   * An account's sums at `now`, in one query: the rows in flight, and those
   * created since the earlier of the window's start and `fastSince` (the
   * `(user_id, created_at)` index). Durations rounded to the millisecond per
   * row. `client` null: a connection of the pool.
   */
  private async readAccountUsage(
    client: PoolClient | null,
    userId: string | null,
    at: { now: string; windowStart: string | null; fastSince: string | null },
  ): Promise<AccountUsage> {
    const usage: AccountUsage = {
      seatsInUse: 0,
      computeUsedMs: 0,
      fastRunsUsed: 0,
      // Read apart, and only when asked (`getAccountUsage`).
      releasingFastRunAt: null,
      instanceSeatsInUse: null,
    };
    if (userId === null) return usage;
    const from = [at.windowStart, at.fastSince].filter((t): t is string => t !== null).sort()[0];
    const sql = `SELECT
         COUNT(*) FILTER (WHERE status = 'running' AND deadline_at > $2::timestamptz)::int AS seats,
         COALESCE(SUM(
           CASE
             WHEN status <> 'running' THEN COALESCE(charged_ms,
               CASE WHEN completed_at IS NULL THEN 0
                 ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000))
               END)
             WHEN deadline_at IS NULL OR deadline_at <= $2::timestamptz THEN 0
             ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM ($2::timestamptz - created_at)) * 1000))
           END
         ) FILTER (WHERE $3::timestamptz IS NOT NULL AND created_at >= $3::timestamptz), 0)::bigint AS compute,
         COUNT(*) FILTER (WHERE $4::timestamptz IS NOT NULL AND pool_entitled AND created_at > $4::timestamptz)::int AS fast
       FROM runs
       WHERE user_id = $1 AND (status = 'running' OR ($5::timestamptz IS NOT NULL AND created_at >= $5::timestamptz))`;
    const values = [userId, at.now, at.windowStart, at.fastSince, from ?? null];
    type Sums = { seats: number; compute: string; fast: number };
    const result = client
      ? await client.query<Sums>(sql, values)
      : await this.pool.query<Sums>(sql, values);
    const sums = result.rows[0];
    usage.seatsInUse = sums.seats;
    usage.computeUsedMs = Number(sums.compute);
    usage.fastRunsUsed = sums.fast;
    return usage;
  }

  /**
   * The runs holding a seat on the whole instance at `now` (the partial
   * deadline index), the run `excludedId` left out — an admission's own row,
   * written before the count.
   */
  private async readInstanceSeats(
    client: PoolClient | null,
    now: string,
    excludedId: string | null,
  ): Promise<number> {
    const sql = `SELECT COUNT(*)::int AS n FROM runs
       WHERE status = 'running' AND deadline_at > $1::timestamptz
         AND ($2::uuid IS NULL OR id <> $2::uuid)`;
    const values = [now, excludedId];
    const result = client
      ? await client.query<{ n: number }>(sql, values)
      : await this.pool.query<{ n: number }>(sql, values);
    return result.rows[0].n;
  }

  /**
   * Write a new run row; its foreign keys refuse a missing account, agent or
   * key (`23503`). `created_at` is the one given, or the database's `NOW()`
   * when none is. `client` null: a connection of the pool.
   */
  private async insertRun(
    client: PoolClient | null,
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
  ): Promise<Run> {
    const sql = `INSERT INTO runs
         (id, agent_id, agent_version, model, environment_id, user_id, api_key_id, status, input,
          usage_prompt_tokens, usage_completion_tokens, usage_total_tokens, usage_estimated_cost,
          usage_cache_read_tokens, usage_cache_write_tokens, usage_cache_savings_usd,
          created_at, completed_at, deadline_at, pool_entitled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, 0, 0, 0, 0, 0,
               COALESCE($10::timestamptz, NOW()), NULL, $11::timestamptz, $12)
       RETURNING *`;
    const values = [
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
      admitted.deadline_at,
      admitted.pool_entitled,
    ];
    const result = client
      ? await client.query<Run>(sql, values)
      : await this.pool.query<Run>(sql, values);
    return this.coerceRun(result.rows[0]);
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
   * completion that asks, while it holds the stop's provisional failure. The
   * condition is in the `WHERE` of the statement that writes: a write that
   * waited on the row's lock tests it against the version committed meanwhile,
   * so of two final writes racing on one row, one lands.
   */
  private async writeRunRow(
    id: string,
    data: RunWrite,
    finish: { replaceShutdownProvisional: boolean } | null,
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
      const param = `$${paramIdx++}`;
      // A cleared run keeps its content: the mark is tested here, in the row
      // this statement writes — after a wait on a row lock, the committed
      // version it reads again.
      sets.push(
        RUN_CONTENT_FIELDS.has(key)
          ? `${key} = CASE WHEN content_cleared_at IS NULL THEN ${param} ELSE ${key} END`
          : `${key} = ${param}`,
      );
      vals.push(jsonCols.has(key) && val != null ? JSON.stringify(val) : (val ?? null));
    }
    if (sets.length === 0) return this.getRun(id);
    vals.push(id);
    let where = `id = $${paramIdx++}`;
    if (finish) {
      if (finish.replaceShutdownProvisional) {
        where += ` AND (status = 'running' OR (status = 'failed' AND error = $${paramIdx++}))`;
        vals.push(SHUTDOWN_RUN_ERROR);
      } else {
        where += " AND status = 'running'";
      }
    }
    const result = await this.pool.query<Run>(
      `UPDATE runs SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
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

  async getAgentRunTotals(agentId: string): Promise<{ run_count: number; token_count: number }> {
    // Both are bigint, which the driver hands back as strings.
    const result = await this.pool.query<{ run_count: string; token_count: string }>(
      `SELECT COUNT(*)::bigint AS run_count, COALESCE(SUM(usage_total_tokens), 0)::bigint AS token_count
       FROM runs WHERE agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return { run_count: Number(row.run_count), token_count: Number(row.token_count) };
  }

  /** This WHERE implies the one of `runs_output_purge_due_idx` (migration 018), which can serve it. */
  async listRunsDueForOutputPurge(
    now: string,
    limit: number,
  ): Promise<Array<Pick<Run, "id" | "files">>> {
    const result = await this.pool.query<Pick<Run, "id" | "files">>(
      `SELECT id, files FROM runs
       WHERE purge_after <= $1::timestamptz AND outputs_purged_at IS NULL
       ORDER BY purge_after
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }

  async markRunOutputsPurged(id: string, at: string): Promise<void> {
    await this.pool.query(
      "UPDATE runs SET outputs_purged_at = $2::timestamptz WHERE id = $1 AND outputs_purged_at IS NULL",
      [id, at],
    );
  }

  /**
   * Normalise PG numeric (returned as string) + ensure cache fields are
   * never `null` at the edge (DB default 0; legacy rows without the
   * cache columns would expose null, which the type expects as number).
   * `charged_ms` is a `bigint`, which the driver hands back as a string.
   */
  private coerceRun(row: Run): Run {
    return {
      ...row,
      charged_ms: row.charged_ms == null ? null : Number(row.charged_ms),
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
 * What the `db_connected` line logs of the connection string:
 * `host:port/database`, nothing else. The user goes with the password (on a
 * Supabase pooler it is `postgres.<project ref>`, an account identifier), and
 * so does the query string, which can carry a password of its own
 * (`?password=…`). The whole string is never returned.
 *
 * A URL can also parse wrong. A password left unencoded that holds a `/`, `?`
 * or `#` ends the authority early: the user can become the host and the start
 * of the password its port, or an `@` can land in the path, the query or the
 * fragment — a password passed in the query can hold one too. So a URL that
 * holds an `@` is believed only when the parser read credentials before it and
 * left no `@` after them. Otherwise, as for a URL that does not parse, the part
 * after the last `@` stands in, cut at its first `?` or `#` — but only when
 * that `@` comes before any `?` or `#`: after one, what follows it can be the
 * end of a password, and a fixed text is written instead.
 */
function redactDatabaseUrl(url: string): string {
  const notLogged = "(unparseable database URL, not logged)";
  const at = url.lastIndexOf("@");
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "") throw new Error("no host");
    if (at !== -1) {
      const credentialsRead = parsed.username !== "" || parsed.password !== "";
      const atLeft = `${parsed.pathname}${parsed.search}${parsed.hash}`.includes("@");
      if (!credentialsRead || atLeft)
        throw new Error("an @ not read as the end of the credentials");
    }
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    if (at === -1) return notLogged;
    const firstQueryOrFragment = url.search(/[?#]/);
    if (firstQueryOrFragment !== -1 && firstQueryOrFragment < at) return notLogged;
    return url.slice(at + 1).split(/[?#]/)[0] ?? "";
  }
}
