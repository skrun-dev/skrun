import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import type { AdmissionLimits, RunAdmission, RunAdmissionResult } from "./adapter.js";
import { DELETION_COUNTED_TABLES, fixtureUsers, runDbContractTests } from "./db-contract.shared.js";
import { assertDisposableDatabaseUrl } from "./disposable-database.shared.js";
import { runMigrations } from "./migrations-runner.js";
import { startMuteRelay } from "./mute-relay.shared.js";
import {
  ADMISSION_ACCOUNT_LOCK,
  ADMISSION_INSTANCE_LOCK,
  PostgresDb,
  RUN_SET_NULL_COLUMNS,
} from "./postgres.js";

/**
 * PostgresDb test wrapper — gated on `DATABASE_URL`. Skipped cleanly on
 * dev machines without a local Postgres. It DROPS the `public` schema of the
 * database it is given: run it only against a throwaway container started for
 * the purpose, never a database that holds anything (a self-hosted stack's
 * `skrun` included) —
 * `docker run -d --rm --name skrun-pg-contract -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=skrun_test -p 127.0.0.1:55432:5432 postgres:16-alpine`,
 * then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/skrun_test`
 * for the one command. Any other URL is refused (`disposable-database.shared.ts`).
 *
 * Per #007 spec SC-10 (amended): this file contains ZERO inline
 * assertions duplicating the shared contract. PG-specific smoke
 * (advisory lock, real-conn round-trip, transaction rollback, VT-12
 * query counter) lives in the `postgres-specific` describe.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_PG = !!DATABASE_URL && /^postgres(ql)?:\/\//.test(DATABASE_URL);
// Every case below drops the `public` schema of this database: only a
// throwaway Postgres on this machine, its database ending in _test, may be
// named (`disposable-database.shared.ts`; the suite's global setup judges it too).
if (HAS_PG) assertDisposableDatabaseUrl(DATABASE_URL as string, "postgres.test.ts");
const describeIfPg = HAS_PG ? describe : describe.skip;

const { dbLines } = vi.hoisted(() => ({
  /** Every line the adapter's own logger writes, parsed, oldest first: a case clears it. */
  dbLines: [] as Array<Record<string, unknown>>,
}));

// The adapter's logger is the runtime's, written to a destination that keeps
// each of its lines for the cases to read, and still prints it. Nothing else
// of the runtime is replaced.
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const destination = {
    write(line: string) {
      dbLines.push(JSON.parse(line) as Record<string, unknown>);
      process.stdout.write(line);
    },
  };
  return {
    ...actual,
    createLogger: (name: string) =>
      name === "db" ? actual.createLogger(name, destination) : actual.createLogger(name),
  };
});

// ── Shared DbAdapter contract — runs against PostgresDb ──────────────

if (HAS_PG) {
  let sharedPool: Pool | null = null;
  // The adapter the factory made for the case before. Each holds its own pool
  // (up to 10 connections, kept idle 30 s): left open, a hundred-odd cases add up
  // to more connections than the server allows ("too many clients"), and the
  // last cases fail on that, not on what they test. Closed before the next one.
  let lastDb: PostgresDb | null = null;

  beforeAll(async () => {
    sharedPool = new Pool({ connectionString: DATABASE_URL });
    // Apply migrations once before contract tests run. The factory below
    // wipes + re-creates `public` for each test, so we need a separate
    // step to seed the schema. We do this via runMigrations against the
    // shared pool after the initial wipe.
  });

  afterAll(async () => {
    if (lastDb) await lastDb.close();
    if (sharedPool) await sharedPool.end();
  });

  runDbContractTests(
    "postgres",
    async () => {
      if (!sharedPool) throw new Error("test pool not initialised");
      if (lastDb) {
        await lastDb.close();
        lastDb = null;
      }
      // Wipe the public schema + re-apply migrations for a clean fixture
      // each test. Expensive (~100ms/test on local PG) but isolates tests.
      await sharedPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await sharedPool.query("CREATE SCHEMA public");
      await runMigrations(sharedPool, join(import.meta.dirname, "migrations"));
      // Seed the FK parent users the shared contract references as
      // owner_id / user_id (factory contract). Mirrors the SQLite factory's
      // seedFixtureUsers — a raw INSERT (not createUser, which mints its own
      // uuid) so the ids match the fx() labels the contract passes.
      for (const u of fixtureUsers()) {
        await sharedPool.query("INSERT INTO users (id, github_id, username) VALUES ($1, $2, $3)", [
          u.id,
          u.github_id,
          u.username,
        ]);
      }
      lastDb = new PostgresDb(DATABASE_URL as string);
      return lastDb;
    },
    {
      async setRunContentCleared(db, runId, at) {
        await (db as PostgresDb)
          .getPool()
          .query("UPDATE runs SET content_cleared_at = $2::timestamptz WHERE id = $1", [runId, at]);
      },
      async countRows(db) {
        const counts: Record<string, number> = {};
        for (const table of DELETION_COUNTED_TABLES) {
          const result = await (db as PostgresDb)
            .getPool()
            .query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
          counts[table] = result.rows[0].n;
        }
        return counts;
      },
      usernameIsUnique: true,
      admission: {
        async setRunChargedMs(db, runId, chargedMs) {
          await (db as PostgresDb)
            .getPool()
            .query("UPDATE runs SET charged_ms = $2 WHERE id = $1", [runId, chargedMs]);
        },
        async analyzeRuns(db) {
          await (db as PostgresDb).getPool().query("ANALYZE runs");
        },
      },
    },
  );
}

// ── PG-specific smoke (advisory lock, tx rollback, VT-12 query counter) ──

describeIfPg("PostgresDb postgres-specific", () => {
  let db: PostgresDb;

  beforeAll(async () => {
    db = new PostgresDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.getPool().query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
    await runMigrations(db.getPool(), join(import.meta.dirname, "migrations"));
  });

  // A connection the pool holds idle can be ended by the database at any
  // moment, outside any query: the pool emits `error` then, which Node turns
  // into an uncaught exception — the process's end — when nothing listens.
  describe("the pool", () => {
    it("an idle connection the database ends is one log line — never an uncaught exception —, and the pool's next query is served", async () => {
      const own = new PostgresDb(DATABASE_URL as string, { max: 1 });
      try {
        const pool = own.getPool();
        const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        expect(pool.idleCount).toBe(1);
        dbLines.length = 0;

        // Another connection ends it, as a restart or a provider would.
        const other = new Client({ connectionString: DATABASE_URL });
        await other.connect();
        try {
          const ended = await other.query<{ ended: boolean }>(
            "SELECT pg_terminate_backend($1) AS ended",
            [pid],
          );
          expect(ended.rows[0]?.ended).toBe(true);
        } finally {
          await other.end();
        }

        await vi.waitFor(() =>
          expect(dbLines.filter((line) => line.event === "db_idle_connection_lost")).toEqual([
            expect.objectContaining({
              level: 40,
              event: "db_idle_connection_lost",
              error_code: "57P01",
            }),
          ]),
        );
        // The error's class and code only: never its message, nor the database's address.
        const said = JSON.stringify(dbLines);
        expect(said).not.toContain("administrator command");
        expect(said).not.toContain(new URL(DATABASE_URL as string).host);
        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(next.rows[0]?.ok).toBe(1);
      } finally {
        await own.close();
      }
    });
  });

  // ── The statement bound of the pool ──
  //
  // Every connection the pool opens sets, before it serves, how long the
  // server may run one of its statements and how long it keeps a transaction
  // that sits idle — the same bound for both. A caller's own pool
  // configuration cannot take either out.

  describe("the statement bound of the pool", () => {
    /** Both settings, read on the first connection the adapter's pool opens. */
    async function settingsOfNewConnection(own: PostgresDb): Promise<string[]> {
      const pool = own.getPool();
      expect(pool.totalCount).toBe(0);
      const client = await pool.connect();
      try {
        const statement = await client.query<{ statement_timeout: string }>(
          "SHOW statement_timeout",
        );
        const idle = await client.query<{ idle_in_transaction_session_timeout: string }>(
          "SHOW idle_in_transaction_session_timeout",
        );
        return [
          statement.rows[0].statement_timeout,
          idle.rows[0].idle_in_transaction_session_timeout,
        ];
      } finally {
        client.release();
      }
    }

    it("a statement past the bound is stopped by the server at the bound (57014); a shorter one is served", async () => {
      const SLEEPER = "skrun-test-statement-bound";
      const own = new PostgresDb(
        DATABASE_URL as string,
        { application_name: SLEEPER },
        { statementTimeoutMs: 1_000 },
      );
      try {
        const started = Date.now();
        const outcome = await own
          .getPool()
          .query("SELECT pg_sleep(2)")
          .then(
            () => "served",
            (err: unknown) => err,
          );
        const elapsed = Date.now() - started;
        // Stopped by the server, not merely given up on by the client: once the
        // query has failed, the statement no longer runs on the server.
        await vi.waitFor(
          async () => {
            const running = await db
              .getPool()
              .query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'",
                [SLEEPER],
              );
            expect(running.rows[0].n).toBe(0);
          },
          { timeout: 300, interval: 50 },
        );
        expect(outcome).toMatchObject({ code: "57014" });
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(1_900);
        const shorter = await own
          .getPool()
          .query<{ slept: string }>("SELECT pg_sleep(0.3)::text AS slept");
        expect(shorter.rows).toHaveLength(1);
      } finally {
        await own.close();
      }
    }, 15_000);

    it("a new connection carries the bound, on its statements and on an idle transaction; 10 s unless set", async () => {
      const set = new PostgresDb(DATABASE_URL as string, {}, { statementTimeoutMs: 1_000 });
      const unset = new PostgresDb(DATABASE_URL as string);
      try {
        expect(await settingsOfNewConnection(set)).toEqual(["1s", "1s"]);
        expect(await settingsOfNewConnection(unset)).toEqual(["10s", "10s"]);
      } finally {
        await set.close();
        await unset.close();
      }
    });

    it("a pool configuration passed by the caller does not take the bounds out", async () => {
      const own = new PostgresDb(
        DATABASE_URL as string,
        { onConnect: undefined, query_timeout: undefined },
        { statementTimeoutMs: 1_000 },
      );
      try {
        expect(await settingsOfNewConnection(own)).toEqual(["1s", "1s"]);
        expect(own.getPool().options.query_timeout).toBe(6_000);
      } finally {
        await own.close();
      }
    });
  });

  // ── A database gone silent on a connection the pool holds ──
  //
  // A relay on the loopback passes everything until it is muted; then the
  // connections already open hear nothing more from the database, while new
  // ones pass. With the bound at 1 s, the client gives up 5 s past it: the
  // query fails `Query read timeout` at about 6 s, its client leaves the pool,
  // and the next query is served on a new connection. A call that holds a
  // client of its own gives up as fast — no ROLLBACK sent to wait behind the
  // silent query, on a timer of its own — and hands its client back broken.

  describe("a database gone silent on a connection the pool holds", () => {
    /** The client's timer, for the 1 s bound of these cases: the bound plus 5 s. */
    const CLIENT_TIMEOUT_MS = 6_000;

    type Settled =
      | { status: "fulfilled"; elapsedMs: number }
      | { status: "rejected"; reason: unknown; elapsedMs: number }
      | { status: "still pending"; elapsedMs: number };

    /** How `promise` settles within `withinMs`, and when; "still pending" past it. */
    async function settleWithin(promise: Promise<unknown>, withinMs: number): Promise<Settled> {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<Settled>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "still pending", elapsedMs: Date.now() - started }),
          withinMs,
        );
      });
      const settled = promise.then(
        (): Settled => ({ status: "fulfilled", elapsedMs: Date.now() - started }),
        (reason: unknown): Settled => ({
          status: "rejected",
          reason,
          elapsedMs: Date.now() - started,
        }),
      );
      try {
        return await Promise.race([settled, pending]);
      } finally {
        clearTimeout(timer);
      }
    }

    function messageOf(outcome: Settled): unknown {
      return outcome.status === "rejected" ? (outcome.reason as Error)?.message : undefined;
    }

    it("a query on the silent connection fails at the client's timer, its client leaves the pool, and the next query is served", async () => {
      const relay = await startMuteRelay(DATABASE_URL as string);
      const own = new PostgresDb(relay.url, { max: 2 }, { statementTimeoutMs: 1_000 });
      try {
        const pool = own.getPool();
        await pool.query("SELECT 1");
        expect(pool.totalCount).toBe(1);
        relay.mute();

        const outcome = await settleWithin(pool.query("SELECT 1"), 9_000);
        expect(outcome.status).toBe("rejected");
        expect(messageOf(outcome)).toBe("Query read timeout");
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(CLIENT_TIMEOUT_MS - 100);
        expect(outcome.elapsedMs).toBeLessThanOrEqual(7_500);
        expect(pool.totalCount).toBe(0);

        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(next.rows[0]?.ok).toBe(1);
      } finally {
        await relay.close();
        await own.close();
      }
    }, 20_000);

    /**
     * The pool at one connection, opened and handed back, then silent: the
     * call borrows that connection, and its BEGIN gets no answer.
     */
    async function callOnSilentConnection(
      call: (db: PostgresDb) => Promise<unknown>,
    ): Promise<void> {
      const relay = await startMuteRelay(DATABASE_URL as string);
      const own = new PostgresDb(relay.url, { max: 1 }, { statementTimeoutMs: 1_000 });
      try {
        const pool = own.getPool();
        await pool.query("SELECT 1");
        expect(pool.idleCount).toBe(1);
        relay.mute();

        const outcome = await settleWithin(call(own), 15_000);
        expect(outcome.status).toBe("rejected");
        expect(messageOf(outcome)).toBe("Query read timeout");
        expect(outcome.elapsedMs, `settled within ${CLIENT_TIMEOUT_MS + 2_000} ms`).toBeLessThan(
          CLIENT_TIMEOUT_MS + 2_000,
        );
        expect(pool.totalCount).toBe(0);

        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(next.rows[0]?.ok).toBe(1);
      } finally {
        await relay.close();
        await own.close();
      }
    }

    it("an account deletion gives up at the client's timer, sends no ROLLBACK, and hands its client back broken", async () => {
      await callOnSilentConnection((own) =>
        own.deleteUser(randomUUID(), { purged_output_run_ids: [], at: new Date().toISOString() }),
      );
    }, 20_000);

    it("an API key's creation gives up at the client's timer, sends no ROLLBACK, and hands its client back broken", async () => {
      await callOnSilentConnection((own) =>
        own.createApiKey({
          user_id: randomUUID(),
          key_hash: "silent-hash",
          key_prefix: "skrun_sk_silent",
          name: "silent",
        }),
      );
    }, 20_000);
  });

  // ── A call that holds a client of its own, when its ROLLBACK fails ──
  //
  // A ROLLBACK that fails says the connection is gone, or silent. The call
  // still rejects with the error that ended its transaction — never the
  // ROLLBACK's own —, and hands its client back broken: kept in the pool, the
  // client would serve the next query inside the transaction it never ended.

  describe("a call that holds a client of its own, when its ROLLBACK fails", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * The pool at one connection. The client the call borrows answers its
     * ROLLBACK with a failure of its own, without sending it; and when
     * `failing` names one of the call's statements, it sends `SELECT 1/0` in
     * its place — a real error of the server (22012), which leaves the
     * transaction aborted. Then: how the call settled, what its client was
     * handed back with, and the pool's next query.
     */
    async function callWhoseRollbackFails(
      call: (own: PostgresDb) => Promise<unknown>,
      failing?: string,
    ): Promise<{ outcome: unknown; releasedWith: unknown[]; clientsLeft: number; next: unknown }> {
      const own = new PostgresDb(DATABASE_URL as string, { max: 1 });
      try {
        const pool = own.getPool();
        const borrow = pool.connect.bind(pool) as () => Promise<PoolClient>;
        const releasedWith: unknown[] = [];
        vi.spyOn(pool, "connect").mockImplementationOnce((async () => {
          const client = await borrow();
          const send = client.query.bind(client) as (...args: unknown[]) => unknown;
          vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
            if (args[0] === "ROLLBACK")
              return Promise.reject(new Error("the ROLLBACK's own failure"));
            if (failing !== undefined && args[0] === failing) return send("SELECT 1/0");
            return send(...args);
          }) as typeof client.query);
          const release = client.release;
          client.release = (err?: Error | boolean) => {
            releasedWith.push(err);
            release(err);
          };
          return client;
        }) as typeof pool.connect);

        const outcome = await call(own).then(
          () => "fulfilled",
          (err: unknown) => err,
        );
        const clientsLeft = pool.totalCount;
        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok").then(
          (result) => result.rows[0]?.ok,
          (err: unknown) => err,
        );
        return { outcome, releasedWith, clientsLeft, next };
      } finally {
        await own.close();
      }
    }

    it("an account deletion rejects with the error of its statement, and hands its client back broken", async () => {
      const { outcome, releasedWith, clientsLeft, next } = await callWhoseRollbackFails(
        (own) =>
          own.deleteUser(randomUUID(), { purged_output_run_ids: [], at: new Date().toISOString() }),
        "SELECT username FROM users WHERE id = $1 FOR UPDATE",
      );
      expect(outcome).toMatchObject({ code: "22012" });
      expect(releasedWith).toEqual([
        expect.objectContaining({ message: "the ROLLBACK's own failure" }),
      ]);
      expect(clientsLeft).toBe(0);
      expect(next).toBe(1);
    });

    it("an API key's creation rejects with the error of its insert, and hands its client back broken", async () => {
      // An account that does not exist: the insert's foreign key refuses it (23503).
      const { outcome, releasedWith, clientsLeft, next } = await callWhoseRollbackFails((own) =>
        own.createApiKey({
          user_id: randomUUID(),
          key_hash: "rollback-hash",
          key_prefix: "skrun_sk_rollback",
          name: "rollback",
        }),
      );
      expect(outcome).toMatchObject({ code: "23503" });
      expect(releasedWith).toEqual([
        expect.objectContaining({ message: "the ROLLBACK's own failure" }),
      ]);
      expect(clientsLeft).toBe(0);
      expect(next).toBe(1);
    });
  });

  // ── A session the server ends while a call holds its client ──
  //
  // A session the server ends — an operator's pg_terminate_backend, a restart,
  // its bound on an idle transaction — arrives at the client as an error event,
  // outside any query's answer. The pool listens only to the clients it keeps
  // idle: while a call holds one, an error event nobody listens to is an
  // uncaught exception, the process's end. Each call is held on the account's
  // row, which another connection keeps locked, and its session is ended there.

  describe("a session the server ends while a call holds its client", () => {
    const HELD = "skrun-test-held-session";

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function endedWhileHeld(call: (own: PostgresDb, userId: string) => Promise<unknown>) {
      const userId = (
        await db.createUser({ github_id: "gh-held-session", username: "held-session" })
      ).id;
      const locker = new Client({ connectionString: DATABASE_URL });
      await locker.connect();
      const own = new PostgresDb(DATABASE_URL as string, { max: 1, application_name: HELD });
      const uncaught: unknown[] = [];
      const onUncaught = (err: unknown) => {
        uncaught.push(err);
      };
      process.on("uncaughtException", onUncaught);
      let pending: Promise<unknown> | undefined;
      try {
        const pool = own.getPool();
        const connect = vi.spyOn(pool, "connect");
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        pending = call(own, userId).then(
          () => "fulfilled",
          (err: unknown) => err,
        );
        // The call's session, waiting on the account's row.
        const pid = await vi.waitFor(
          async () => {
            const waiting = await db
              .getPool()
              .query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
                [HELD],
              );
            expect(waiting.rows).toHaveLength(1);
            return waiting.rows[0].pid;
          },
          { timeout: 5_000, interval: 50 },
        );
        // Meanwhile, the client it borrowed listens for its session's end.
        const client = (await connect.mock.results[0]?.value) as PoolClient;
        expect(client.listenerCount("error")).toBeGreaterThanOrEqual(1);

        const ended = await db
          .getPool()
          .query<{ ended: boolean }>("SELECT pg_terminate_backend($1) AS ended", [pid]);
        expect(ended.rows[0]?.ended).toBe(true);
        const outcome = (await pending) as { code?: unknown; message?: unknown };
        expect(
          outcome.code === "57P01" || outcome.message === "Connection terminated unexpectedly",
          `rejected with the session's end: ${String(outcome.code)} ${String(outcome.message)}`,
        ).toBe(true);
        expect(pool.totalCount).toBe(0);
        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(next.rows[0]?.ok).toBe(1);
        expect(uncaught).toEqual([]);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
        await pending;
        process.off("uncaughtException", onUncaught);
        await own.close();
      }
    }

    it("an account deletion whose session is ended rejects, with no uncaught exception, and its client leaves the pool", async () => {
      await endedWhileHeld((own, userId) =>
        own.deleteUser(userId, { purged_output_run_ids: [], at: new Date().toISOString() }),
      );
    }, 15_000);

    it("an API key's creation whose session is ended rejects, with no uncaught exception, and its client leaves the pool", async () => {
      await endedWhileHeld((own, userId) =>
        own.createApiKey({
          user_id: userId,
          key_hash: "held-hash",
          key_prefix: "skrun_sk_held",
          name: "held",
        }),
      );
    }, 15_000);
  });

  // ── A call that holds a client of its own, once it hands it back ──
  //
  // A call listens for its session's end while it holds its client, and stops
  // once it hands the client back, when the pool listens again. A listener left
  // behind is one more on the same client at each borrow — until Node warns of
  // a leak —, each one keeping the call that added it alive.

  describe("a call that holds a client of its own, once it hands it back", () => {
    /**
     * The pool at one connection, so that each call borrows the same client:
     * the error listeners that client carries idle in the pool, then after each
     * of two calls.
     */
    async function listenersAfterTwoCalls(
      call: (own: PostgresDb, userId: string) => Promise<unknown>,
    ): Promise<{ idle: number; after: number[] }> {
      const userId = (await db.createUser({ github_id: "gh-handed-back", username: "handed-back" }))
        .id;
      const own = new PostgresDb(DATABASE_URL as string, { max: 1 });
      try {
        const pool = own.getPool();
        const client = await pool.connect();
        client.release();
        const idle = client.listenerCount("error");
        const after: number[] = [];
        for (let i = 0; i < 2; i++) {
          await call(own, userId);
          after.push(client.listenerCount("error"));
        }
        // Still the pool's one client: each call borrowed it, and handed it back sound.
        const again = await pool.connect();
        try {
          expect(again === client, "the client each call borrowed").toBe(true);
        } finally {
          again.release();
        }
        return { idle, after };
      } finally {
        await own.close();
      }
    }

    it("an account deletion leaves no listener of its own on the client it hands back", async () => {
      const { idle, after } = await listenersAfterTwoCalls((own) =>
        own.deleteUser(randomUUID(), { purged_output_run_ids: [], at: new Date().toISOString() }),
      );
      expect(after).toEqual([idle, idle]);
    });

    it("an API key's creation leaves no listener of its own on the client it hands back", async () => {
      const { idle, after } = await listenersAfterTwoCalls((own, userId) =>
        own.createApiKey({
          user_id: userId,
          key_hash: `handed-back-${randomUUID()}`,
          key_prefix: "skrun_sk_handed",
          name: "handed-back",
        }),
      );
      expect(after).toEqual([idle, idle]);
    });

    it("a run's admission leaves no listener of its own on the client it hands back", async () => {
      const { idle, after } = await listenersAfterTwoCalls(async (own, userId) => {
        const now = new Date().toISOString();
        // A bound on the run: the admission holds a client for its transaction.
        const result = await own.admitRun({
          run: {
            id: randomUUID(),
            agent_id: null,
            agent_version: "1.0.0",
            user_id: userId,
            input: { label: "handed-back" },
          },
          now,
          deadlineAt: new Date(Date.parse(now) + 600_000).toISOString(),
          windowStart: null,
          limits: {
            concurrentRuns: 100,
            computeMs: null,
            fastRunsPerHour: null,
            instanceCap: null,
          },
          poolRunning: false,
        });
        expect(result.admitted).toBe(true);
      });
      expect(after).toEqual([idle, idle]);
    });
  });

  // ── A route whose database does not answer in time ──
  //
  // The whole path, on a real database: a route of the app, the adapter's pool
  // and its bound. A statement waiting on a row another connection keeps
  // locked is stopped at the bound; a request that waits for one of the pool's
  // connections, every one held, gives up once that wait is over. Either
  // answers 503 DATABASE_TIMEOUT, with a Retry-After.

  describe("a route whose database does not answer in time", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("a revocation waiting on its key's row, locked by another connection, answers 503 at the bound", async () => {
      vi.stubEnv("SKRUN_DEV_AUTH", "1");
      const bounded = new PostgresDb(DATABASE_URL as string, {}, { statementTimeoutMs: 1_000 });
      const locker = new Client({ connectionString: DATABASE_URL });
      await locker.connect();
      try {
        const app = createApp(new MemoryStorage(), bounded);
        const created = await app.request("/api/keys", {
          method: "POST",
          headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "locked" }),
        });
        expect(created.status).toBe(201);
        const { id } = (await created.json()) as { id: string };
        // The key's row locked by another connection, for longer than the bound.
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM api_keys WHERE id = $1 FOR UPDATE", [id]);

        const started = Date.now();
        const res = await app.request(`/api/keys/${id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer dev-token" },
        });
        const elapsed = Date.now() - started;
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "DATABASE_TIMEOUT" } });
        expect(res.headers.get("Retry-After")).toBe("5");
        // Stopped by the server at its bound (1 s), not by the client's timer (6 s).
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(3_000);

        // Once the row is free, the key is revoked as before.
        await locker.query("ROLLBACK");
        const revoked = await app.request(`/api/keys/${id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer dev-token" },
        });
        expect(revoked.status).toBe(204);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
        await bounded.close();
      }
    }, 20_000);

    it("a request that waits for one of the pool's connections, every one held, answers 503 once the wait is over", async () => {
      vi.stubEnv("SKRUN_DEV_AUTH", "1");
      const full = new PostgresDb(DATABASE_URL as string, { max: 1 });
      const held = await full.getPool().connect();
      let released = false;
      try {
        const app = createApp(new MemoryStorage(), full);
        const started = Date.now();
        const res = await app.request("/api/keys", {
          headers: { Authorization: "Bearer dev-token" },
        });
        const elapsed = Date.now() - started;
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "DATABASE_TIMEOUT" } });
        expect(res.headers.get("Retry-After")).toBe("5");
        // The pool's wait for a connection: 5 s.
        expect(elapsed).toBeGreaterThanOrEqual(4_900);
        expect(elapsed).toBeLessThan(8_000);

        // The connection handed back, the next request is served.
        held.release();
        released = true;
        const next = await app.request("/api/keys", {
          headers: { Authorization: "Bearer dev-token" },
        });
        expect(next.status).toBe(200);
      } finally {
        if (!released) held.release();
        await full.close();
      }
    }, 20_000);
  });

  it("SELECT NOW() round-trip via the pool: a timestamptz arrives as an ISO string", async () => {
    const result = await db.getPool().query<{ now: unknown }>("SELECT NOW() AS now");
    const value = result.rows[0].now;
    expect(typeof value).toBe("string");
    expect(new Date(value as string).toISOString()).toBe(value);
  });

  it("transaction rollback discards changes", async () => {
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO users (id, github_id, username) VALUES ('11111111-1111-1111-1111-111111111111', 'tx-test', 'tx-test')",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await db
      .getPool()
      .query<{ cnt: string }>(
        "SELECT COUNT(*)::bigint AS cnt FROM users WHERE username = 'tx-test'",
      );
    expect(Number(after.rows[0].cnt)).toBe(0);
  });

  it("advisory lock acquire + release", async () => {
    const client = await db.getPool().connect();
    try {
      const got = await client.query<{ pg_try_advisory_lock: boolean }>(
        "SELECT pg_try_advisory_lock(424242)",
      );
      expect(got.rows[0].pg_try_advisory_lock).toBe(true);
      await client.query("SELECT pg_advisory_unlock(424242)");
    } finally {
      client.release();
    }
  });

  it("VT-8 (#124): deleting a user cascades to their sessions", async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    await db
      .getPool()
      .query("INSERT INTO users (id, github_id, username) VALUES ($1, 'sess-casc', 'sess-casc')", [
        userId,
      ]);
    await db.createSession({
      id_hash: "sess-cascade",
      user_id: userId,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(await db.getSession("sess-cascade")).not.toBeNull();

    // Delete the user via the raw connection: the adapter exposes no
    // deleteUser, so the ON DELETE CASCADE declaration is what is under test.
    await db.getPool().query("DELETE FROM users WHERE id = $1", [userId]);

    expect(await db.getSession("sess-cascade")).toBeNull();
  });

  /**
   * VT-12 (SC-12): `listAgents` MUST use a single LEFT JOIN, NOT N+1.
   * Wrap `pool.query` via a spy, populate fixtures, call listAgents
   * against 50 agents + runs, assert spy was invoked ≤ 2 times
   * (1 LEFT JOIN query + 1 COUNT for pagination).
   */
  it("VT-12: listAgents uses LEFT JOIN, not N+1 (≤ 2 queries for 50 agents)", async () => {
    // Seed a user the agents will reference (FK).
    const userId = "22222222-2222-2222-2222-222222222222";
    await db
      .getPool()
      .query("INSERT INTO users (id, github_id, username) VALUES ($1, 'vt12', 'vt12')", [userId]);
    // 50 agents + 1 run each (so the LEFT JOIN has work to do).
    for (let i = 0; i < 50; i++) {
      const agent = await db.createAgent({
        name: `n${i.toString().padStart(2, "0")}`,
        namespace: "vt12",
        description: "",
        owner_id: userId,
      });
      await db.createRun({
        id: randomUUID(),
        agent_id: agent.id,
        agent_version: "1.0.0",
        status: "completed",
      });
    }

    const spy = vi.spyOn(db.getPool(), "query");
    await db.listAgents({ page: 1, limit: 50, userId });
    const callCount = spy.mock.calls.length;
    spy.mockRestore();

    // 1 query for the LEFT JOIN + 1 query for the filtered COUNT = 2.
    // Anything > 2 means we regressed to N+1.
    expect(callCount).toBeLessThanOrEqual(2);
  });

  it("VT-10 (#127): the output purge index on runs is partial, on the purge's condition", async () => {
    // The whole definition, as Postgres 16 renders it (measured on a throwaway
    // container): the column, the method and the WHERE, so that neither a
    // non-partial index nor a partial one on another column passes.
    const result = await db
      .getPool()
      .query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'runs' AND indexname = 'runs_output_purge_due_idx'",
      );
    expect(result.rows.map((r) => r.indexdef)).toEqual([
      "CREATE INDEX runs_output_purge_due_idx ON public.runs USING btree (purge_after) WHERE ((outputs_purged_at IS NULL) AND (purge_after IS NOT NULL))",
    ]);
  });

  // ── Two sign-ins at once: the name, or the account, they both want ────
  //
  // A held transaction plays the first sign-in: its `users` row is inserted
  // and left uncommitted, so the second sign-in's insert has to wait on the
  // unique index. The wait is proven, not assumed: each side has its own
  // connection under its own `application_name`, and the test goes on only
  // once Postgres reports the sign-in's backend blocked by the holder's.

  describe("two sign-ins racing", () => {
    const HOLDER = "skrun-test-race-holder";
    const SIGNIN = "skrun-test-race-signin";
    /** Long enough for the last attempt of a sign-in that would try them all. */
    const RACE_TIMEOUT_MS = 30_000;

    async function pidOf(applicationName: string): Promise<number> {
      const result = await db
        .getPool()
        .query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
          applicationName,
        ]);
      if (result.rows.length !== 1) {
        throw new Error(
          `expected one backend named ${applicationName}, found ${result.rows.length}`,
        );
      }
      return result.rows[0].pid;
    }

    /** Waits, at most 5 s, until the sign-in's backend waits on the holder's. */
    async function waitUntilSigninBlockedBy(holderPid: number): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const result = await db.getPool().query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name = $1 AND $2 = ANY (pg_blocking_pids(pid))
           ) AS blocked`,
          [SIGNIN, holderPid],
        );
        if (result.rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the sign-in never waited on the held row");
    }

    /**
     * Holds an uncommitted `users` row, starts a sign-in on its own connection,
     * waits until that sign-in is blocked by the row, commits, and hands back
     * the sign-in's outcome. Every connection is closed whatever happens.
     */
    async function raceAgainstHeldRow(
      held: { id: string; github_id: string; username: string },
      signin: { github_id: string; login: string },
    ): Promise<Awaited<ReturnType<PostgresDb["createOAuthUser"]>>> {
      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const signinDb = new PostgresDb(DATABASE_URL as string, {
        application_name: SIGNIN,
        max: 1,
      });
      const holder = await holderPool.connect();
      let pending: ReturnType<PostgresDb["createOAuthUser"]> | null = null;
      try {
        await holder.query("BEGIN");
        await holder.query("INSERT INTO users (id, github_id, username) VALUES ($1, $2, $3)", [
          held.id,
          held.github_id,
          held.username,
        ]);
        const holderPid = await pidOf(HOLDER);
        pending = signinDb.createOAuthUser(signin);
        // Observed now, so a rejection while the test waits is not unhandled.
        pending.catch(() => {});
        await waitUntilSigninBlockedBy(holderPid);
        await holder.query("COMMIT");
        return await pending;
      } finally {
        holder.release();
        await holderPool.end();
        if (pending) await pending.catch(() => {});
        await signinDb.close();
      }
    }

    async function usersNamed(prefix: string): Promise<string[]> {
      const result = await db
        .getPool()
        .query<{ username: string }>(
          "SELECT username FROM users WHERE username LIKE $1 ORDER BY username",
          [`${prefix}%`],
        );
      return result.rows.map((row) => row.username);
    }

    it(
      "two GitHub accounts, one free login: the second waits, then gets `--2`, without an error",
      async () => {
        const outcome = raceAgainstHeldRow(
          { id: randomUUID(), github_id: "2", username: "alice" },
          { github_id: "3", login: "alice" },
        );
        await expect(outcome).resolves.toMatchObject({
          user: { github_id: "3", username: "alice--2" },
          derived: 2,
        });
        expect((await db.getUserByGithubId("2"))?.username).toBe("alice");
        expect(await usersNamed("alice")).toEqual(["alice", "alice--2"]);
      },
      RACE_TIMEOUT_MS,
    );

    it(
      "one GitHub account signing in twice at once: one account, the one the first sign-in made",
      async () => {
        const heldId = randomUUID();
        const outcome = raceAgainstHeldRow(
          { id: heldId, github_id: "1", username: "alice" },
          { github_id: "1", login: "alice" },
        );
        await expect(outcome).resolves.toMatchObject({
          user: { id: heldId, github_id: "1", username: "alice" },
          derived: null,
        });
        expect(await usersNamed("alice")).toEqual(["alice"]);
      },
      RACE_TIMEOUT_MS,
    );
  });

  // ── The admin route that deletes an account, on a uuid column ──────────
  //
  // Postgres refuses to compare a uuid column with a string that is not one: a
  // read by a malformed id fails rather than finding nothing. The route checks
  // the id's shape first, so a malformed one is a 404 like an unknown one.

  describe("deleting another account by its id", () => {
    function deleteById(app: ReturnType<typeof createApp>, id: string, confirm: string) {
      return app.request(`/api/admin/accounts/${id}`, {
        method: "DELETE",
        // The dev token carries the administrator role.
        headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
    }

    it("a malformed id and an unknown one are 404, never 500; the right id and name delete", async () => {
      const app = createApp(new MemoryStorage(), db);
      const alice = await db.createUser({ github_id: "gh-admin-route", username: "alice" });
      for (const id of ["not-a-uuid", "1", "00000000-0000-4000-8000-000000000000"]) {
        const res = await deleteById(app, id, "alice");
        expect(res.status, id).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
      }
      expect(await db.getUserById(alice.id)).not.toBeNull();

      const res = await deleteById(app, alice.id, "alice");
      expect(res.status).toBe(200);
      expect(await db.getUserById(alice.id)).toBeNull();
    });
  });

  // ── An account deletion, read back in SQL, and one that fails half-way ──

  describe("account deletion", () => {
    const AT = "2026-03-04T05:06:07.890Z";
    const RUN_COLUMNS =
      "input, output, error, files, agent_version, content_cleared_at, user_id, agent_id, api_key_id";

    /**
     * Account A ("alice") with an agent, a version, a key and a session; a run
     * of A on its agent through its key, ended with content; a run of B on A's
     * agent, still running.
     */
    async function seed() {
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
      const own = randomUUID();
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
      const theirs = randomUUID();
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

    async function readRun(id: string) {
      const result = await db
        .getPool()
        .query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id]);
      return result.rows[0];
    }

    it("stores the cleared columns as null, the file list as an empty list, the references as null", async () => {
      const s = await seed();

      await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

      expect(await readRun(s.own)).toEqual({
        input: null,
        output: null,
        error: null,
        files: [],
        agent_version: "@1.0.0",
        content_cleared_at: AT,
        user_id: null,
        agent_id: null,
        api_key_id: null,
      });
      expect(await readRun(s.theirs)).toEqual({
        input: null,
        output: null,
        error: null,
        files: [],
        agent_version: "@1.0.0",
        content_cleared_at: AT,
        user_id: s.b.id,
        agent_id: null,
        api_key_id: null,
      });
      const left = await db
        .getPool()
        .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE id = $1", [s.a.id]);
      expect(left.rows[0].n).toBe(0);
    });

    it("a deletion refused when the account row goes leaves the account and its runs as they were", async () => {
      const s = await seed();
      await db.getPool().query(
        `CREATE FUNCTION refuse_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'refused by the test'; END $$;
         CREATE TRIGGER refuse_account_delete BEFORE DELETE ON users
           FOR EACH ROW EXECUTE FUNCTION refuse_account_delete();`,
      );
      const before = [await readRun(s.own), await readRun(s.theirs)];

      await expect(db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT })).rejects.toThrow(
        "refused by the test",
      );

      // Neither cleared nor marked: the clearing ran, and went with the rest.
      expect([await readRun(s.own), await readRun(s.theirs)]).toEqual(before);
      expect(before[0]).toMatchObject({ input: { asked: "own" }, content_cleared_at: null });
      expect((await db.getUserById(s.a.id))?.username).toBe("alice");
      expect(await db.getSession("raw-sess-a")).not.toBeNull();
      expect((await db.getAgent("alice", "tool"))?.id).toBe(s.agent.id);
    });
  });

  // ── An account deletion, whatever order the foreign keys act in ───────
  //
  // Postgres runs the actions of the foreign keys that reference a table in
  // the order of their triggers' names, and names each trigger after its own
  // OID: a database whose constraints were made in another order — or whose
  // OIDs gained a digit (`…_a_100038` sorts before `…_a_99961`) — runs them
  // in another order. The deletion rewrites its runs first, in its own
  // transaction, and Postgres checks every foreign key of a row its
  // transaction wrote again when an action updates that row: a check made
  // before the action that detaches the row from an agent, a key or an
  // environment already deleted would fail. The order is set here by renaming
  // a trigger, whatever OIDs the schema got.

  describe("account deletion, whatever order the foreign keys act in", () => {
    const AT = "2026-03-04T05:06:07.890Z";

    /**
     * Account A ("alice") with an agent, a key and an environment; account B
     * ("bob") with an agent, a key and an environment. Runs: A on its agent
     * through its key under its environment; B on A's agent through B's key
     * under B's environment — which it keeps; A on B's agent; B on its own
     * agent, which the deletion does not touch.
     */
    async function seed() {
      const a = await db.createUser({ github_id: "gh-order-a", username: "alice" });
      const b = await db.createUser({ github_id: "gh-order-b", username: "bob" });
      const tool = await db.createAgent({
        name: "tool",
        namespace: "alice",
        description: "",
        owner_id: a.id,
      });
      await db.createVersion(tool.id, {
        version: "1.0.0",
        size: 1,
        bundle_key: "alice/tool/1.0.0.agent",
      });
      const other = await db.createAgent({
        name: "other",
        namespace: "bob",
        description: "",
        owner_id: b.id,
      });
      const key = await db.createApiKey({
        user_id: a.id,
        key_hash: "order-hash-a",
        key_prefix: "skrun_sk_oa",
        name: "a",
      });
      const env = await db.createEnvironment({ name: "env-a", owner_id: a.id, config: {} });
      const theirKey = await db.createApiKey({
        user_id: b.id,
        key_hash: "order-hash-b",
        key_prefix: "skrun_sk_ob",
        name: "b",
      });
      const theirEnv = await db.createEnvironment({ name: "env-b", owner_id: b.id, config: {} });
      const run = async (data: {
        agent_id: string;
        agent_version: string;
        user_id: string;
        api_key_id?: string;
        environment_id?: string;
      }) => {
        const id = randomUUID();
        await db.createRun({ id, ...data, status: "completed", input: { asked: "something" } });
        return id;
      };
      const own = await run({
        agent_id: tool.id,
        agent_version: "alice/tool@1.0.0",
        user_id: a.id,
        api_key_id: key.id,
        environment_id: env.id,
      });
      const theirs = await run({
        agent_id: tool.id,
        agent_version: "alice/tool@1.0.0",
        user_id: b.id,
        api_key_id: theirKey.id,
        environment_id: theirEnv.id,
      });
      const away = await run({
        agent_id: other.id,
        agent_version: "bob/other@1.0.0",
        user_id: a.id,
      });
      const untouched = await run({
        agent_id: other.id,
        agent_version: "bob/other@1.0.0",
        user_id: b.id,
      });
      return { a, b, other, env, theirKey, theirEnv, own, theirs, away, untouched };
    }

    /** What the deletion of A leaves: the same, whatever order the foreign keys act in. */
    async function expectAccountDeleted(
      s: Awaited<ReturnType<typeof seed>>,
      result: Awaited<ReturnType<PostgresDb["deleteUser"]>>,
    ): Promise<void> {
      expect({
        ...result,
        cleared_run_ids: [...(result?.cleared_run_ids ?? [])].sort(),
      }).toEqual({
        agents: 1,
        versions: 1,
        api_keys: 1,
        cleared_run_ids: [s.own, s.theirs, s.away].sort(),
        late_outputs: [],
        bundle_keys: ["alice/tool/1.0.0.agent"],
      });
      const rows = await db.getPool().query(
        `SELECT id, input, content_cleared_at, agent_version,
                user_id, agent_id, api_key_id, environment_id
         FROM runs WHERE id = ANY($1::uuid[])`,
        [[s.own, s.theirs, s.away, s.untouched]],
      );
      const byId = Object.fromEntries(rows.rows.map(({ id, ...row }) => [id, row]));
      const cleared = { input: null, content_cleared_at: AT };
      const detached = { user_id: null, agent_id: null, api_key_id: null, environment_id: null };
      expect(byId).toEqual({
        [s.own]: { ...cleared, ...detached, agent_version: "@1.0.0" },
        // Detached from A's agent only: its account, key and environment stay.
        [s.theirs]: {
          ...cleared,
          ...detached,
          agent_version: "@1.0.0",
          user_id: s.b.id,
          api_key_id: s.theirKey.id,
          environment_id: s.theirEnv.id,
        },
        [s.away]: {
          ...cleared,
          ...detached,
          agent_version: "bob/other@1.0.0",
          agent_id: s.other.id,
        },
        [s.untouched]: {
          input: { asked: "something" },
          content_cleared_at: null,
          agent_version: "bob/other@1.0.0",
          user_id: s.b.id,
          agent_id: s.other.id,
          api_key_id: null,
          environment_id: null,
        },
      });
      expect(await db.getUserById(s.a.id)).toBeNull();
      expect(await db.getEnvironment(s.env.id)).toBeNull();
      expect((await db.getUserById(s.b.id))?.username).toBe("bob");
    }

    /**
     * The constraints whose action runs when a `users` row is deleted, in the
     * order Postgres runs them: the order of their triggers' names (`tgtype`
     * bit 8: a trigger on DELETE).
     */
    async function deleteActionOrder(): Promise<string[]> {
      const result = await db.getPool().query<{ conname: string }>(
        `SELECT c.conname FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
         WHERE t.tgrelid = 'users'::regclass AND t.tgisinternal AND (t.tgtype & 8) <> 0
         ORDER BY t.tgname`,
      );
      return result.rows.map((r) => r.conname);
    }

    it("deletes an account whose runs it rewrote, even when the foreign key that detaches them from the account acts first", async () => {
      const s = await seed();
      const trigger = await db.getPool().query<{ tgname: string }>(
        `SELECT t.tgname FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
           WHERE t.tgrelid = 'users'::regclass AND t.tgisinternal AND (t.tgtype & 8) <> 0
             AND c.conname = 'runs_user_id_fkey'`,
      );
      expect(trigger.rows).toHaveLength(1);
      // An internal trigger's name ends in an OID, which never starts with 0.
      await db
        .getPool()
        .query(
          `ALTER TRIGGER "${trigger.rows[0].tgname}" ON users RENAME TO "RI_ConstraintTrigger_a_0"`,
        );
      expect((await deleteActionOrder())[0]).toBe("runs_user_id_fkey");

      const result = await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

      await expectAccountDeleted(s, result);
    });

    it("leaves no run for the foreign keys to update: each reference to what goes is cleared before the account row", async () => {
      const s = await seed();
      // A foreign key's action updates a row from inside its own trigger: such
      // an update of a run is refused here, so the deletion fails if it left
      // one to the actions, in whatever order they would run.
      await db.getPool().query(
        `CREATE FUNCTION refuse_run_update_by_an_action() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF pg_trigger_depth() > 1 THEN
               RAISE EXCEPTION 'a run updated by a foreign key action';
             END IF;
             RETURN NEW;
           END $$;
         CREATE TRIGGER refuse_run_update_by_an_action BEFORE UPDATE ON runs
           FOR EACH ROW EXECUTE FUNCTION refuse_run_update_by_an_action();`,
      );

      const result = await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

      await expectAccountDeleted(s, result);
    });

    // The cases above hold the columns their seed fills, and the deletion sets
    // to null the columns of its list: a foreign key added to runs with a SET
    // NULL action, missing from the list, would be left to its action again
    // with every case green. This one reads the schema. A SET DEFAULT action
    // would update the runs the deletion has rewritten just the same, so runs
    // has no foreign key with one.
    it("sets to null itself every column of runs that a foreign key would set to null", async () => {
      const setNull = await db.getPool().query<{ attname: string }>(
        `SELECT DISTINCT a.attname FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.conrelid = 'runs'::regclass AND c.contype = 'f' AND c.confdeltype = 'n'`,
      );
      expect(
        setNull.rows.map((r) => r.attname).sort(),
        "The columns of runs that a foreign key sets to null on delete must be those the account " +
          "deletion sets to null itself (RUN_SET_NULL_COLUMNS, postgres.ts). A new one: add it " +
          "there, give deleteUserOnce the ids it detaches, and fill it in seed() above. One gone: " +
          "remove it there.",
      ).toEqual([...RUN_SET_NULL_COLUMNS].sort());

      const setDefault = await db.getPool().query<{ conname: string }>(
        `SELECT c.conname FROM pg_constraint c
          WHERE c.conrelid = 'runs'::regclass AND c.contype = 'f' AND c.confdeltype = 'd'`,
      );
      expect(
        setDefault.rows.map((r) => r.conname).sort(),
        "No foreign key of runs may set its column to its default on delete: like a SET NULL one, " +
          "its action would update runs the account deletion has already rewritten, which can fail " +
          "the deletion on a foreign key check (23503). Either set the column to its default in " +
          "deleteUserOnce (postgres.ts) before the account row goes, as the SET NULL columns are " +
          "set to null, and allow the key here; or do not use this action on runs.",
      ).toEqual([]);
    });
  });

  // ── A deletion caught in a deadlock runs again ────────────────────────
  //
  // The deadlock is made, not hoped for. A held transaction locks one of the
  // account's keys; the deletion takes the account's agents and its row, then
  // waits for that key — proven by Postgres reporting the deletion's backend
  // blocked by the holder's, each on its own connection under its own
  // `application_name`. The holder then asks for the agent the deletion
  // holds: a cycle. Postgres checks for one after `deadlock_timeout` of
  // waiting — the server's default, one second, on the deletion's side; ten
  // seconds on the holder's — so it is the deletion that is aborted.

  describe("a deletion caught in a deadlock", () => {
    const HOLDER = "skrun-test-deadlock-holder";
    const DELETER = "skrun-test-deadlock-deleter";
    const AT = "2026-03-04T05:06:07.890Z";

    async function pidOf(applicationName: string): Promise<number> {
      const result = await db
        .getPool()
        .query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
          applicationName,
        ]);
      if (result.rows.length !== 1) {
        throw new Error(
          `expected one backend named ${applicationName}, found ${result.rows.length}`,
        );
      }
      return result.rows[0].pid;
    }

    /** Waits, at most 5 s, until the deletion's backend waits on the holder's. */
    async function waitUntilDeletionBlockedBy(holderPid: number): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const result = await db.getPool().query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name = $1 AND $2 = ANY (pg_blocking_pids(pid))
           ) AS blocked`,
          [DELETER, holderPid],
        );
        if (result.rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the deletion never waited on the held row");
    }

    it("is aborted by Postgres, runs again once the other transaction ends, and deletes the account", async () => {
      const a = await db.createUser({ github_id: "gh-dl-a", username: "alice" });
      const agent = await db.createAgent({
        name: "tool",
        namespace: "alice",
        description: "",
        owner_id: a.id,
      });
      const key = await db.createApiKey({
        user_id: a.id,
        key_hash: "dl-hash-a",
        key_prefix: "skrun_sk_dl",
        name: "a",
      });
      const runId = randomUUID();
      await db.createRun({
        id: runId,
        agent_id: agent.id,
        agent_version: "alice/tool@1.0.0",
        user_id: a.id,
        status: "completed",
        input: { asked: "something" },
      });

      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const deleterDb = new PostgresDb(DATABASE_URL as string, {
        application_name: DELETER,
        max: 1,
      });
      // One connection taken per attempt of the transaction.
      const attempts = vi.spyOn(deleterDb.getPool(), "connect");
      const holder = await holderPool.connect();
      let deletion: ReturnType<PostgresDb["deleteUser"]> | null = null;
      let attemptCount = 0;
      try {
        await holder.query("BEGIN");
        await holder.query("SET LOCAL deadlock_timeout = '10s'");
        await holder.query("SELECT id FROM api_keys WHERE id = $1 FOR UPDATE", [key.id]);
        const holderPid = await pidOf(HOLDER);

        deletion = deleterDb.deleteUser(a.id, { purged_output_run_ids: [], at: AT });
        // Observed now, so a rejection while the test waits is not unhandled.
        deletion.catch(() => {});
        await waitUntilDeletionBlockedBy(holderPid);

        // The holder asks for the agent the deletion holds: the cycle. It is
        // granted once the deletion, chosen by Postgres, lets go of it.
        await holder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agent.id]);
        await holder.query("ROLLBACK");

        // The deletion, run again, goes through.
        await expect(deletion).resolves.toMatchObject({ agents: 1, api_keys: 1 });
      } finally {
        holder.release(true);
        await holderPool.end();
        if (deletion) await deletion.catch(() => {});
        attemptCount = attempts.mock.calls.length;
        attempts.mockRestore();
        await deleterDb.close();
      }
      expect(attemptCount).toBe(2);
      expect(await db.getUserById(a.id)).toBeNull();
      expect(await db.getRun(runId)).toMatchObject({ input: null, content_cleared_at: AT });
    }, 30_000);

    // An agent's deletion takes the agent's row, then the rows its foreign keys
    // reach — the agent's runs, detached. An account deletion locks runs first:
    // a run of the account on another account's agent can close a cycle. Made
    // here with a held run of the agent, then the holder asking for the agent.
    it("an agent deletion caught in one runs again too: its bundles are already gone, it must not fail", async () => {
      const b = await db.createUser({ github_id: "gh-dl-b", username: "bob" });
      const agent = await db.createAgent({
        name: "tool",
        namespace: "bob",
        description: "",
        owner_id: b.id,
      });
      const runId = randomUUID();
      await db.createRun({
        id: runId,
        agent_id: agent.id,
        agent_version: "bob/tool@1.0.0",
        user_id: b.id,
        status: "completed",
      });

      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const deleterDb = new PostgresDb(DATABASE_URL as string, {
        application_name: DELETER,
        max: 1,
      });
      const queries = vi.spyOn(deleterDb.getPool(), "query");
      const holder = await holderPool.connect();
      let deletion: Promise<boolean> | null = null;
      let attemptCount = 0;
      try {
        await holder.query("BEGIN");
        await holder.query("SET LOCAL deadlock_timeout = '10s'");
        await holder.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [runId]);
        const holderPid = await pidOf(HOLDER);

        deletion = deleterDb.deleteAgent("bob", "tool");
        deletion.catch(() => {});
        await waitUntilDeletionBlockedBy(holderPid);

        // The agent row the deletion holds: the cycle, which aborts the deletion.
        await holder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agent.id]);
        await holder.query("ROLLBACK");

        await expect(deletion).resolves.toBe(true);
      } finally {
        holder.release(true);
        await holderPool.end();
        if (deletion) await deletion.catch(() => {});
        attemptCount = queries.mock.calls.filter(([sql]) =>
          String(sql).startsWith("DELETE FROM agents"),
        ).length;
        queries.mockRestore();
        await deleterDb.close();
      }
      expect(attemptCount).toBe(2);
      expect(await db.getAgent("bob", "tool")).toBeNull();
      expect(await db.getRun(runId)).toMatchObject({ agent_id: null });
    }, 30_000);
  });

  // ── A run created or completed while an account is being deleted ──────
  //
  // Each race is made, not hoped for. A held transaction locks a row the
  // deletion needs at a chosen step: one of the account's runs, so the
  // deletion waits inside the clearing with its locks taken; or the version
  // of the account's agent, so it waits at the cascade with the runs cleared
  // and locked. The other request then starts on its own connection, and the
  // test goes on only once Postgres reports that backend blocked by the
  // deletion's — each connection under its own `application_name`.

  describe("a deletion racing a run", () => {
    const HOLDER = "skrun-test-race-holder";
    const DELETER = "skrun-test-race-deleter";
    const OTHER = "skrun-test-race-other";
    const AT = "2026-03-04T05:06:07.890Z";

    async function pidOf(applicationName: string): Promise<number> {
      const result = await db
        .getPool()
        .query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
          applicationName,
        ]);
      if (result.rows.length !== 1) {
        throw new Error(
          `expected one backend named ${applicationName}, found ${result.rows.length}`,
        );
      }
      return result.rows[0].pid;
    }

    /**
     * Waits, at most 5 s, until the backend named `applicationName` waits on
     * `blockerPid`; true then. False when it never did — at the deadline, or
     * as soon as `done` settles (the request went through without waiting).
     */
    async function blockedBy(
      applicationName: string,
      blockerPid: number,
      done?: Promise<unknown>,
    ): Promise<boolean> {
      let settled = false;
      done?.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !settled) {
        const result = await db.getPool().query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name = $1 AND $2 = ANY (pg_blocking_pids(pid))
           ) AS blocked`,
          [applicationName, blockerPid],
        );
        if (result.rows[0].blocked) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    async function seed() {
      const a = await db.createUser({ github_id: "gh-race-a", username: "alice" });
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
      const inFlight = randomUUID();
      await db.createRun({
        id: inFlight,
        agent_id: agent.id,
        agent_version: "alice/tool@1.0.0",
        user_id: a.id,
        status: "running",
        input: { asked: "in flight" },
      });
      return { a, agent, inFlight };
    }

    it("a run created for the account while its runs are being cleared is refused, and nothing is left detached with its input", async () => {
      const s = await seed();
      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const deleterDb = new PostgresDb(DATABASE_URL as string, {
        application_name: DELETER,
        max: 1,
      });
      const creatorDb = new PostgresDb(DATABASE_URL as string, {
        application_name: OTHER,
        max: 1,
      });
      const holder = await holderPool.connect();
      let deletion: ReturnType<PostgresDb["deleteUser"]> | null = null;
      let creation: ReturnType<PostgresDb["createRun"]> | null = null;
      let creationWaited = false;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [s.inFlight]);
        const holderPid = await pidOf(HOLDER);

        deletion = deleterDb.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });
        // Observed now, so a rejection while the test waits is not unhandled.
        deletion.catch(() => {});
        expect(await blockedBy(DELETER, holderPid)).toBe(true);
        const deleterPid = await pidOf(DELETER);

        creation = creatorDb.createRun({
          id: randomUUID(),
          agent_id: s.agent.id,
          agent_version: "alice/tool@1.0.0",
          user_id: s.a.id,
          status: "running",
          input: { asked: "born during the deletion" },
        });
        creation.catch(() => {});
        creationWaited = await blockedBy(OTHER, deleterPid, creation);

        await holder.query("COMMIT");
        await expect(deletion).resolves.not.toBeNull();
        await expect(creation).rejects.toMatchObject({ code: "23503" });
      } finally {
        holder.release(true);
        await holderPool.end();
        if (deletion) await deletion.catch(() => {});
        if (creation) await creation.catch(() => {});
        await deleterDb.close();
        await creatorDb.close();
      }
      const detached = await db
        .getPool()
        .query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM runs WHERE user_id IS NULL AND input IS NOT NULL",
        );
      expect(detached.rows[0].n).toBe(0);
      expect(await db.getRun(s.inFlight)).toMatchObject({ input: null, content_cleared_at: AT });
      // It waited on the deletion's locks: refused by its foreign key, not by luck.
      expect(creationWaited).toBe(true);
    }, 30_000);

    it("a run completed while the deletion waits at the cascade keeps its content empty", async () => {
      const s = await seed();
      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const deleterDb = new PostgresDb(DATABASE_URL as string, {
        application_name: DELETER,
        max: 1,
      });
      const completerDb = new PostgresDb(DATABASE_URL as string, {
        application_name: OTHER,
        max: 1,
      });
      const holder = await holderPool.connect();
      let deletion: ReturnType<PostgresDb["deleteUser"]> | null = null;
      let completion: ReturnType<PostgresDb["updateRun"]> | null = null;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT agent_id FROM agent_versions WHERE agent_id = $1 FOR UPDATE", [
          s.agent.id,
        ]);
        const holderPid = await pidOf(HOLDER);

        deletion = deleterDb.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });
        deletion.catch(() => {});
        expect(await blockedBy(DELETER, holderPid)).toBe(true);
        // At the cascade: the runs are cleared, and locked, by now.
        const step = await db
          .getPool()
          .query<{ query: string }>(
            "SELECT query FROM pg_stat_activity WHERE application_name = $1",
            [DELETER],
          );
        expect(step.rows[0].query).toMatch(/^DELETE FROM users/);
        const deleterPid = await pidOf(DELETER);

        completion = completerDb.updateRun(s.inFlight, {
          status: "completed",
          output: { said: "a late answer" },
          files: [{ name: "late.txt", size: 4 }],
          purge_after: "2026-04-01T00:00:00.000Z",
          duration_ms: 900,
        });
        completion.catch(() => {});
        expect(await blockedBy(OTHER, deleterPid, completion)).toBe(true);

        await holder.query("COMMIT");
        await expect(deletion).resolves.not.toBeNull();
        const expected = {
          status: "completed",
          duration_ms: 900,
          input: null,
          output: null,
          files: [],
          purge_after: null,
          content_cleared_at: AT,
        };
        // The row handed back says the run was cleared.
        expect(await completion).toMatchObject(expected);
        expect(await db.getRun(s.inFlight)).toMatchObject(expected);
      } finally {
        holder.release(true);
        await holderPool.end();
        if (deletion) await deletion.catch(() => {});
        if (completion) await completion.catch(() => {});
        await deleterDb.close();
        await completerDb.close();
      }
    }, 30_000);

    it("a run whose completion commits as the deletion locks its runs has its outputs among the late ones", async () => {
      const s = await seed();
      const holderPool = new Pool({
        connectionString: DATABASE_URL,
        application_name: HOLDER,
        max: 1,
      });
      const deleterDb = new PostgresDb(DATABASE_URL as string, {
        application_name: DELETER,
        max: 1,
      });
      const holder = await holderPool.connect();
      let deletion: ReturnType<PostgresDb["deleteUser"]> | null = null;
      try {
        // The completion's write, not committed yet: it records the run's
        // files and their purge date, as the cloud runtime's completion does.
        await holder.query("BEGIN");
        await holder.query(
          `UPDATE runs SET status = 'completed', files = $2::jsonb, purge_after = $3::timestamptz
           WHERE id = $1`,
          [s.inFlight, JSON.stringify([{ name: "late.txt", size: 4 }]), "2026-04-01T00:00:00.000Z"],
        );
        const holderPid = await pidOf(HOLDER);

        deletion = deleterDb.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });
        deletion.catch(() => {});
        expect(await blockedBy(DELETER, holderPid)).toBe(true);

        // The completion commits while the deletion waits on its row.
        await holder.query("COMMIT");
        const result = await deletion;
        // Read under the lock, after the completion: the keys of its objects
        // can still be rebuilt, and the service deletes them after the commit.
        expect(result?.late_outputs).toEqual([
          { id: s.inFlight, files: [{ name: "late.txt", size: 4 }] },
        ]);
      } finally {
        holder.release(true);
        await holderPool.end();
        if (deletion) await deletion.catch(() => {});
        await deleterDb.close();
      }
      expect(await db.getRun(s.inFlight)).toMatchObject({
        status: "completed",
        files: [],
        content_cleared_at: AT,
      });
    }, 30_000);
  });

  // ── The agent state table: its cascades and its CHECK ─────────────────
  //
  // Each cascade is exercised by a DELETE in raw SQL: the adapter has no way to
  // delete an account, and going through one would tell nothing about the
  // ON DELETE CASCADE declarations, which are what is under test.

  describe("agent state", () => {
    const EXPIRES = "2099-05-06T07:08:09.123Z";

    /**
     * Three accounts and what each holds. Bob owns agent X and two keys: K1,
     * delegated to X, and KB, account-wide. Alice holds a reduced key, KA, and
     * has run Bob's agent herself (as an admin may). Carol owns agent Y.
     * Notebooks on X: shared, K1's, Alice's, KA's. On Y: KB's (Bob running
     * Carol's agent), and Carol's own. Every row is written by the adapter.
     */
    async function seedThreeAccounts() {
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
    async function notebooksLeft(): Promise<string[]> {
      const result = await db
        .getPool()
        .query<{ on: string }>("SELECT state->>'on' AS on FROM agent_state");
      return result.rows.map((row) => row.on).sort();
    }

    it("deleting an account deletes the notebooks written under it and under its keys, and no other", async () => {
      const { alice } = await seedThreeAccounts();

      await db.getPool().query("DELETE FROM users WHERE id = $1", [alice.id]);

      // Alice's own notebook (users → agent_state) and her key's
      // (users → api_keys → agent_state) are gone; Bob's and Carol's stay.
      expect(await notebooksLeft()).toEqual(["x k1", "x shared", "y carol", "y kb"]);
    });

    it("deleting an agent's owner deletes every notebook of the agent, and those of the owner's keys elsewhere", async () => {
      const { bob } = await seedThreeAccounts();

      await db.getPool().query("DELETE FROM users WHERE id = $1", [bob.id]);

      // Every notebook of X goes with it (users → agents → agent_state), the
      // shared one and other callers' included; on Y, the notebook of Bob's
      // key goes (users → api_keys → agent_state), Carol's stays.
      expect(await notebooksLeft()).toEqual(["y carol"]);
    });

    describe("the CHECK ties the partition key to the references", () => {
      /** check_violation: the row was refused by a CHECK, not by a foreign key. */
      const CHECK_VIOLATION = { code: "23514" };

      async function seedEmptyAgent() {
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

      function insertRow(row: {
        agentId: string;
        partitionKey: string;
        callerUserId: string | null;
        callerKeyId: string | null;
      }) {
        return db.getPool().query(
          `INSERT INTO agent_state
             (agent_id, partition_key, caller_user_id, caller_key_id, state, expires_at)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
          [row.agentId, row.partitionKey, row.callerUserId, row.callerKeyId, EXPIRES],
        );
      }

      it("accepts each of the three shapes", async () => {
        const { owner, agent, key } = await seedEmptyAgent();
        const id = agent.id;
        await insertRow({
          agentId: id,
          partitionKey: "shared",
          callerUserId: null,
          callerKeyId: null,
        });
        await insertRow({
          agentId: id,
          partitionKey: `account:${owner.id}`,
          callerUserId: owner.id,
          callerKeyId: null,
        });
        await insertRow({
          agentId: id,
          partitionKey: `key:${key.id}`,
          callerUserId: null,
          callerKeyId: key.id,
        });
        const count = await db
          .getPool()
          .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM agent_state");
        expect(count.rows[0].n).toBe(3);
      });

      it("refuses a shared row that names an account", async () => {
        const { owner, agent } = await seedEmptyAgent();
        await expect(
          insertRow({
            agentId: agent.id,
            partitionKey: "shared",
            callerUserId: owner.id,
            callerKeyId: null,
          }),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      });

      it("refuses an account row that names no account", async () => {
        const { owner, agent } = await seedEmptyAgent();
        await expect(
          insertRow({
            agentId: agent.id,
            partitionKey: `account:${owner.id}`,
            callerUserId: null,
            callerKeyId: null,
          }),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      });

      it("refuses an account row that names both an account and a key", async () => {
        const { owner, agent, key } = await seedEmptyAgent();
        await expect(
          insertRow({
            agentId: agent.id,
            partitionKey: `account:${owner.id}`,
            callerUserId: owner.id,
            callerKeyId: key.id,
          }),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      });

      it("refuses a key row whose key is not the one its partition names", async () => {
        const { agent, key, otherKey } = await seedEmptyAgent();
        await expect(
          insertRow({
            agentId: agent.id,
            partitionKey: `key:${key.id}`,
            callerUserId: null,
            callerKeyId: otherKey.id,
          }),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      });
    });
  });

  // ── Run admission: its locks, on distinct connections ────────────────

  describe("run admission", () => {
    const OFF: AdmissionLimits = {
      concurrentRuns: null,
      computeMs: null,
      fastRunsPerHour: null,
      instanceCap: null,
    };
    /** Databases this block opened, closed after each case. */
    const opened: PostgresDb[] = [];

    afterEach(async () => {
      vi.restoreAllMocks();
      for (const other of opened.splice(0)) await other.close();
    });

    function admissionOf(
      label: string,
      userId: string | null,
      limits: Partial<AdmissionLimits>,
    ): RunAdmission & { run: { id: string } } {
      const now = new Date().toISOString();
      return {
        run: {
          id: randomUUID(),
          agent_id: null,
          agent_version: "1.0.0",
          user_id: userId,
          input: { label },
        },
        now,
        deadlineAt: new Date(Date.parse(now) + 600_000).toISOString(),
        windowStart: null,
        limits: { ...OFF, ...limits },
        poolRunning: false,
      };
    }

    const outcome = (result: RunAdmissionResult): string =>
      result.admitted ? "admitted" : result.reason;

    /**
     * A database whose first bounded admission stops inside its transaction
     * until released: before its insert, after its reads, under the account's
     * lock (`beforeInsert`); or once its row is written and the instance
     * counted, under every lock it takes (`beforeCommit`). Later admissions
     * pass the hook without stopping.
     */
    function holdingFirstAdmission(stage: "beforeInsert" | "beforeCommit"): {
      adb: PostgresDb;
      reached: Promise<void>;
      release: () => void;
    } {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reach = () => {};
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      let calls = 0;
      const hold = async () => {
        calls += 1;
        if (calls === 1) {
          reach();
          await held;
        }
      };
      const adb = new PostgresDb(
        DATABASE_URL as string,
        {},
        {
          admissionHooks:
            stage === "beforeInsert" ? { beforeInsert: hold } : { beforeCommit: hold },
        },
      );
      opened.push(adb);
      return { adb, reached, release: () => release() };
    }

    /**
     * Whether an admission is seen waiting on the advisory lock `lock` (the
     * two-integer form: `classid` the first integer, `objsubid` 2), polled on
     * another connection every 50 ms for at most 1.5 s — under the lock
     * timeout of 2 s, so a waiting admission is still waiting when seen.
     */
    async function seenWaitingOn(lock: number): Promise<boolean> {
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        const waiting = await db.getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2 AND classid = $1::oid
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [lock],
        );
        if (waiting.rows[0].n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }

    async function account(name: string): Promise<string> {
      return (await db.createUser({ github_id: `gh-${name}`, username: name })).id;
    }

    async function rowOf(runId: string): Promise<unknown> {
      return (await db.getRun(runId)) ?? null;
    }

    it("one account at its last seat: the second admission waits on the account's lock while the first writes, then reads the first's row and is refused", async () => {
      const userId = await account("seat-race");
      const { adb, reached, release } = holdingFirstAdmission("beforeInsert");
      try {
        const limits = { concurrentRuns: 1 };
        const first = adb.admitRun(admissionOf("first", userId, limits));
        await reached;
        const second = adb.admitRun(admissionOf("second", userId, limits));
        const waited = await seenWaitingOn(ADMISSION_ACCOUNT_LOCK);
        release();
        const results = await Promise.all([first, second]);
        expect(results.map(outcome)).toEqual(["admitted", "concurrency"]);
        expect(waited).toBe(true);
        expect(results[1].usage).toMatchObject({ seatsInUse: 1 });
      } finally {
        release();
      }
    });

    it("a right given back while an admission of the same account holds the account's lock: the write does not wait on the lock, the held admission — which counted the right — gets none, the next one does, and the hour never holds two", async () => {
      const userId = await account("give-back-race");
      const { adb, reached, release } = holdingFirstAdmission("beforeInsert");
      const fast = { fastRunsPerHour: 1 };
      // The account's rows holding the right, read on the test's own connection.
      const entitled = async (): Promise<number> =>
        (
          await db
            .getPool()
            .query<{ n: number }>(
              "SELECT count(*)::int AS n FROM runs WHERE user_id = $1 AND pool_entitled",
              [userId],
            )
        ).rows[0].n;
      let givingBack: Promise<boolean> | undefined;
      try {
        // A, admitted with the right on the test's database: no hook there.
        const a = admissionOf("a", userId, fast);
        const admittedA = await db.admitRun({ ...a, poolRunning: true });
        expect(admittedA.admitted && admittedA.poolEntitled, "A").toBe(true);
        expect(await entitled()).toBe(1);
        // B stops after reading its sums — it counted A —, holding the account's lock.
        const b = adb.admitRun({ ...admissionOf("b", userId, fast), poolRunning: true });
        await reached;
        // Meanwhile A gives its right back, under a bound shorter than the lock
        // timeout: a write that waited on B's lock would still be waiting.
        givingBack = db.returnPoolRight(a.run.id);
        const given = await Promise.race([
          givingBack.then((back) => (back ? "given back" : "nothing given back")),
          new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
        ]);
        expect(given).toBe("given back");
        expect(await entitled()).toBe(0);
        release();
        const admittedB = await b;
        expect(admittedB.admitted && admittedB.poolEntitled, "B, which counted A").toBe(false);
        expect(admittedB.usage).toMatchObject({ fastRunsUsed: 1 });
        expect(await entitled()).toBe(0);
        const c = await db.admitRun({ ...admissionOf("c", userId, fast), poolRunning: true });
        expect(c.admitted && c.poolEntitled, "C").toBe(true);
        expect(await entitled()).toBe(1);
      } finally {
        release();
        await givingBack?.catch(() => undefined);
      }
    });

    it("two accounts at the instance's last seat: the second admission waits on the instance's lock while the first writes, then is refused", async () => {
      const a = await account("instance-a");
      const b = await account("instance-b");
      const { adb, reached, release } = holdingFirstAdmission("beforeCommit");
      try {
        // One seat held by a run without an account (no bound: no lock, no hook).
        expect(outcome(await adb.admitRun(admissionOf("held", null, {})))).toBe("admitted");
        const limits = { instanceCap: 2 };
        const first = adb.admitRun(admissionOf("first", a, limits));
        await reached;
        const second = adb.admitRun(admissionOf("second", b, limits));
        const waited = await seenWaitingOn(ADMISSION_INSTANCE_LOCK);
        release();
        const results = await Promise.all([first, second]);
        expect(results.map(outcome)).toEqual(["admitted", "instance"]);
        expect(waited).toBe(true);
        expect(results[1].usage).toMatchObject({ instanceSeatsInUse: 2 });
      } finally {
        release();
      }
    });

    it("an account deleted while one of its admissions waits to insert: the deletion does not wait on it, and the admission is refused by its foreign key", async () => {
      const userId = await account("deleted-mid-admission");
      const { adb, reached, release } = holdingFirstAdmission("beforeInsert");
      try {
        const late = admissionOf("late", userId, { concurrentRuns: 2 });
        const pending = adb.admitRun(late).then(
          (result) => result,
          (err: unknown) => err,
        );
        await reached;
        const deleted = await db.deleteUser(userId, {
          purged_output_run_ids: [],
          at: new Date().toISOString(),
        });
        expect(deleted).not.toBeNull();
        release();
        expect(await pending).toMatchObject({ code: "23503" });
        expect(await rowOf(late.run.id)).toBeNull();
      } finally {
        release();
      }
    });

    it("an account deleted amid a burst of its admissions: no deadlock, and no admitted run keeps the account or its input", async () => {
      const userId = await account("deleted-amid-burst");
      const burst = [0, 1, 2, 3, 4, 5].map((i) =>
        admissionOf(`burst-${i}`, userId, { concurrentRuns: 10 }),
      );
      const settled = burst.map((admission) =>
        db.admitRun(admission).then(
          (result) => outcome(result),
          (err: unknown) => (err as { code?: string }).code ?? String(err),
        ),
      );
      const deleted = await db.deleteUser(userId, {
        purged_output_run_ids: [],
        at: new Date().toISOString(),
      });
      expect(deleted).not.toBeNull();
      const outcomes = await Promise.all(settled);
      // Admitted before the deletion locked the account, refused by the
      // foreign key after it, or busy — never a deadlock, never anything else.
      for (const o of outcomes) expect(["admitted", "23503", "busy"]).toContain(o);
      const rows = await db
        .getPool()
        .query<{ user_id: string | null; input: unknown; cleared: boolean }>(
          "SELECT user_id, input, content_cleared_at IS NOT NULL AS cleared FROM runs WHERE id = ANY($1::uuid[])",
          [burst.map((admission) => admission.run.id)],
        );
      expect(rows.rows).toHaveLength(outcomes.filter((o) => o === "admitted").length);
      for (const row of rows.rows) {
        expect(row).toEqual({ user_id: null, input: null, cleared: true });
      }
    });

    it("an account's lock held past the lock timeout: the admission is refused busy, after the timeout and within three seconds, and writes nothing", async () => {
      const userId = await account("lock-held");
      const holder = await db.getPool().connect();
      const adb = new PostgresDb(DATABASE_URL as string);
      opened.push(adb);
      const blocked = admissionOf("blocked", userId, { concurrentRuns: 2 });
      let pending: Promise<RunAdmissionResult> | null = null;
      try {
        await holder.query("SELECT pg_advisory_lock($1, hashtext($2::uuid::text))", [
          ADMISSION_ACCOUNT_LOCK,
          userId,
        ]);
        const started = Date.now();
        pending = adb.admitRun(blocked);
        const raced = await Promise.race([
          pending,
          new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 4_000)),
        ]);
        const elapsed = Date.now() - started;
        expect(typeof raced === "string" ? raced : outcome(raced)).toBe("busy");
        expect(elapsed).toBeLessThan(3_000);
        expect(elapsed).toBeGreaterThanOrEqual(1_900);
        expect(raced).toMatchObject({ usage: null });
        expect(await rowOf(blocked.run.id)).toBeNull();
      } finally {
        await holder.query("SELECT pg_advisory_unlock_all()");
        holder.release();
        await pending?.catch(() => undefined);
      }
    });

    it("an admission whose transaction is left idle — its process stalled, or gone without closing its connection — loses its session past 5 s: its account's lock is let go, it is refused busy, and the account's next admission is admitted", async () => {
      const userId = await account("idle-admission");
      const { adb, reached, release } = holdingFirstAdmission("beforeInsert");
      const limits = { concurrentRuns: 1 };
      const first = adb.admitRun(admissionOf("idle-first", userId, limits));
      try {
        await reached;
        const heldAt = Date.now();
        // The account's lock, granted to the first admission, until its session ends.
        await vi.waitFor(
          async () => {
            const held = await db.getPool().query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks
                WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = $1::oid
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
              [ADMISSION_ACCOUNT_LOCK],
            );
            expect(held.rows[0].n).toBe(0);
          },
          { timeout: 15_000, interval: 100 },
        );
        // The server's idle timeout let it go, not anything sooner.
        expect(Date.now() - heldAt).toBeGreaterThanOrEqual(4_000);
      } finally {
        release();
      }
      const ended = await first;
      expect(outcome(ended)).toBe("busy");
      expect(ended).toMatchObject({ usage: null });
      expect(outcome(await db.admitRun(admissionOf("idle-next", userId, limits)))).toBe("admitted");
    }, 30_000);

    // An admission's bounds are set per transaction: inside it, its statement
    // bound takes the place of the pool's, which comes back once it ends.
    it("a transaction's own statement bound takes the place of the pool's, which comes back once it ends", async () => {
      const client = await db.getPool().connect();
      try {
        const bound = async (): Promise<string> =>
          (await client.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]
            .statement_timeout;
        expect(await bound()).toBe("10s");
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '5s'");
        expect(await bound()).toBe("5s");
        await client.query("COMMIT");
        expect(await bound()).toBe("10s");
      } finally {
        client.release();
      }
    });

    // A connection the pool holds goes silent — the relay of the cases above,
    // muted once its one connection is opened and handed back: the admission
    // borrows it, and its BEGIN gets no answer. With the bound at 1 s, the
    // client gives up 5 s past it; the admission is refused busy then, sends
    // no ROLLBACK to wait behind the silent query, and hands its client back
    // broken.
    it("an admission whose connection goes silent is refused busy at the client's timer, and its client leaves the pool", async () => {
      const userId = await account("silent-admission");
      const relay = await startMuteRelay(DATABASE_URL as string);
      const adb = new PostgresDb(relay.url, { max: 1 }, { statementTimeoutMs: 1_000 });
      opened.push(adb);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pool = adb.getPool();
        await pool.query("SELECT 1");
        expect(pool.idleCount).toBe(1);
        relay.mute();

        const started = Date.now();
        const settled = await Promise.race([
          adb.admitRun(admissionOf("silent", userId, { concurrentRuns: 1 })).then(
            (result) => outcome(result),
            (err: unknown) => `rejected: ${(err as Error)?.message}`,
          ),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("still pending"), 25_000);
          }),
        ]);
        const elapsed = Date.now() - started;
        expect(settled).toBe("busy");
        // The client's timer (6 s), and no second one behind it.
        expect(elapsed, "settled within 8000 ms").toBeLessThan(8_000);
        expect(pool.totalCount).toBe(0);
        const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(next.rows[0]?.ok).toBe(1);
      } finally {
        clearTimeout(timer);
        await relay.close();
      }
    }, 40_000);

    /**
     * Whether a run's insert is seen blocked by the backend `pid`, polled on
     * another connection every 50 ms for at most 1.5 s — under the lock
     * timeout, so a waiting insert is still waiting when seen.
     */
    async function seenInsertBlockedBy(pid: number): Promise<boolean> {
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        const blocked = await db.getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO runs%'`,
          [pid],
        );
        if (blocked.rows[0].n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }

    it("an admission whose insert waits on its account's row holds no instance lock meanwhile: another account, under the instance cap, is admitted at once", async () => {
      const locked = await account("row-locked");
      const other = await account("row-free");
      const locker = await db.getPool().connect();
      const adb = new PostgresDb(DATABASE_URL as string);
      opened.push(adb);
      const limits = { concurrentRuns: 2, instanceCap: 20 };
      const waiting = admissionOf("waiting", locked, limits);
      const next = admissionOf("next", other, limits);
      let pending: Promise<RunAdmissionResult> | null = null;
      try {
        // The account's row locked as an account deletion locks it, for the whole case.
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [locked]);
        const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        const started = Date.now();
        pending = adb.admitRun(waiting);
        expect(await seenInsertBlockedBy(lockerPid)).toBe(true);

        const nextStarted = Date.now();
        const admitted = await adb.admitRun(next);
        const nextElapsed = Date.now() - nextStarted;
        expect({ outcome: outcome(admitted), withinOneSecond: nextElapsed < 1_000 }).toEqual({
          outcome: "admitted",
          withinOneSecond: true,
        });
        expect(await rowOf(next.run.id)).not.toBeNull();

        // The waiting admission is still refused busy within three seconds, and writes nothing.
        const refused = await pending;
        expect(outcome(refused)).toBe("busy");
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(await rowOf(waiting.run.id)).toBeNull();
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        await pending?.catch(() => undefined);
      }
    });

    it("with nothing bounding the run, fifty admissions at once take no advisory lock and open no transaction; under a bound, the account's lock is taken", async () => {
      const userId = await account("no-lock");
      const adb = new PostgresDb(DATABASE_URL as string);
      opened.push(adb);
      const query = vi.spyOn(Client.prototype, "query");
      const statements = () =>
        query.mock.calls.map(([first]) =>
          typeof first === "string" ? first : String((first as { text?: unknown }).text),
        );

      const free = await Promise.all(
        Array.from({ length: 50 }, (_, i) => adb.admitRun(admissionOf(`free-${i}`, userId, {}))),
      );
      expect(free.map(outcome)).toEqual(free.map(() => "admitted"));
      expect(statements().filter((s) => /pg_advisory_xact_lock|^\s*BEGIN/.test(s))).toEqual([]);
      expect(statements().filter((s) => /INSERT INTO runs/.test(s))).toHaveLength(50);

      // The spy sees what a bounded admission does take, and how its transaction is bounded.
      const bounded = await adb.admitRun(admissionOf("bounded", userId, { concurrentRuns: 100 }));
      expect(outcome(bounded)).toBe("admitted");
      expect(statements().filter((s) => /pg_advisory_xact_lock/.test(s))).toHaveLength(1);
      expect(statements().filter((s) => /^SET LOCAL /.test(s))).toEqual([
        "SET LOCAL lock_timeout = '2s'",
        "SET LOCAL statement_timeout = '5s'",
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
      ]);
    });
  });
});

// ── The statement bound an adapter is given (no Postgres: the constructor connects to nothing) ──

describe("PostgresDb: the statement bound it is given", () => {
  const NOWHERE = "postgres://user:secret@127.0.0.1:1/nowhere";

  // A fraction within the bounds too: the value is written into the SET each
  // connection sends.
  it.each([
    999,
    600_001,
    1.5,
    1_000.5,
    Number.NaN,
  ])("%s ms throws a RangeError naming the option", (statementTimeoutMs) => {
    expect(() => new PostgresDb(NOWHERE, {}, { statementTimeoutMs })).toThrow(RangeError);
    expect(() => new PostgresDb(NOWHERE, {}, { statementTimeoutMs })).toThrow(
      /statementTimeoutMs must be a whole number of milliseconds from 1000 to 600000/,
    );
  });

  it.each([1_000, 600_000])("%s ms is taken", async (statementTimeoutMs) => {
    const db = new PostgresDb(NOWHERE, {}, { statementTimeoutMs });
    expect(db.getPool().options.query_timeout).toBe(statementTimeoutMs + 5_000);
    await db.close();
  });
});

// ── SC-16: shared contract `it()` count ≥ 30 (always runs, no PG needed) ──

describe("DbAdapter shared contract: it() count meets SC-16 floor", () => {
  it("db-contract.shared.ts exposes ≥ 30 it() blocks", () => {
    const source = readFileSync(join(import.meta.dirname, "db-contract.shared.ts"), "utf8");
    // Count `it(` calls, excluding comments (strip first to avoid the
    // /^.*?it\(.*?\*\//s false-positive from JSDoc).
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const matches = stripped.match(/\bit\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(30);
  });
});

// ── VT-17 (SC-16): CI-wiring meta-test. Turns a future workflow refactor that
// drops the postgres service / DATABASE_URL — which would silently re-skip the
// pg contract (the exact blind spot follow-up #6 closed) — into a RED CI. ──
if (process.env.CI) {
  describe("PostgresDb CI wiring", () => {
    it("DATABASE_URL is set in CI so the pg contract does not silently skip", () => {
      expect(process.env.DATABASE_URL).toBeTruthy();
    });
  });
}
