/**
 * Phase 35 — a request whose database does not answer in time is answered
 * `503 DATABASE_TIMEOUT`, on the live registry's own Postgres.
 *
 * The bound on each statement the server sends its database is Postgres only:
 * on a registry that runs on SQLite (no `DATABASE_URL`), the phase is one SKIP
 * line, the suite's convention, and restarts nothing.
 *
 * On Postgres, the registry is started again for this phase with
 * `SKRUN_DB_STATEMENT_TIMEOUT_MS=1000`, and started again without it at the
 * end, whatever happened. The phase mints a key with the suite's token, opens a
 * connection of its own to the registry's database (`pg` resolved from the API
 * package, as the registry loads it) and, in a transaction, locks the key's row
 * (`SELECT … FOR UPDATE`). The revocation of that key then waits on the row
 * past the bound. Its PASS line prints the status, the code, `Retry-After` and
 * how long the request took: `waited_ms` near one second says the database
 * stopped the statement at the bound the registry sets on each of its
 * connections — through whatever pooler stands in front of the database —;
 * near six seconds, that the registry's own timer gave up on the connection
 * first, the bound never having reached the database — the line then fails,
 * whatever the status: 5 seconds or more is not a PASS. The transaction is then
 * rolled back, and the key is revoked for good: a second revocation answers
 * 204.
 *
 * The phase's connection is closed whatever happens, and its key revoked if it
 * is still there. Neither the database's URL nor a query's message (which may
 * name the host) is printed. The restarts lose the bundles the registry held:
 * the phase pushes none, and a phase after it pushes its own. No model is
 * called.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { REGISTRY, ROOT, results, startRegistry, stopRegistry, TOKEN } from "./_ctx.js";
import { assertLiveDatabase } from "./database-guard.js";
import { queryFailure } from "./registry-db.js";

const AGENT = "database-timeout";
/** The statement bound the registry is started with for this phase, in milliseconds. */
const BOUND_MS = 1_000;
/** What the answer tells the caller to wait before sending the request again, in seconds. */
const RETRY_AFTER_S = "5";
/**
 * Under this, the database stopped the statement at the bound the registry
 * sets on its connections; past it, only the registry's own timer (the bound,
 * plus 5 s) gave up on the connection: the bound never reached the database —
 * a pooler that drops the setting would still give a 503, and the phase fails.
 */
const BOUND_REACHED_WITHIN_MS = 5_000;

/** The part of `pg` this phase uses. */
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}
interface PgModule {
  Client: new (config: {
    connectionString: string;
    connectionTimeoutMillis: number;
    query_timeout: number;
  }) => PgClient;
}
/** How long the phase's own connection may take to open, or one of its queries to answer. */
const PHASE_CONNECTION_WAIT_MS = 10_000;

const bearer = { Authorization: `Bearer ${TOKEN}` };

function record(feature: string, passed: boolean, detail: string, duration = 0): void {
  results.push({ agent: AGENT, feature, passed, duration, cost: 0, detail });
}

function revoke(id: string): Promise<Response> {
  return fetch(`${REGISTRY}/api/keys/${id}`, { method: "DELETE", headers: bearer });
}

export async function run(): Promise<void> {
  console.log("Testing a request whose database does not answer in time (503 DATABASE_TIMEOUT)...");
  const feature = `a revocation whose key row another connection holds past a ${BOUND_MS} ms statement bound answers 503 DATABASE_TIMEOUT, with its Retry-After`;
  const url = process.env.DATABASE_URL;
  if (!url) {
    record(
      feature,
      true,
      "SKIP — the registry runs on SQLite (DATABASE_URL unset): the statement bound is Postgres only",
    );
    return;
  }
  // The suite's database guard, before this phase opens a connection of its own.
  assertLiveDatabase(process.env);
  // `pg` is a dependency of the API package only: it does not resolve from
  // `tests/`. Resolved from that package, as the registry itself loads it.
  const pg = createRequire(join(ROOT, "packages/api/package.json"))("pg") as PgModule;

  let keyId: string | undefined;
  let revoked = false;
  let client: PgClient | undefined;
  let connected = false;
  try {
    stopRegistry();
    await startRegistry({ extraEnv: { SKRUN_DB_STATEMENT_TIMEOUT_MS: String(BOUND_MS) } });
    console.log(`  registry started again with SKRUN_DB_STATEMENT_TIMEOUT_MS=${BOUND_MS}`);

    const minted = await fetch(`${REGISTRY}/api/keys`, {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "database-timeout-live" }),
    });
    const key = (await minted.json().catch(() => ({}))) as { id?: unknown };
    keyId = typeof key.id === "string" ? key.id : undefined;
    if (minted.status !== 201 || keyId === undefined) {
      record(
        "setup: a key minted with the suite's token",
        false,
        `status=${minted.status} id=${keyId === undefined ? "absent" : "present"}`,
      );
      return;
    }

    // Bounded on the client's side, so that neither the connection nor one of
    // its queries can hold the suite up.
    client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: PHASE_CONNECTION_WAIT_MS,
      query_timeout: PHASE_CONNECTION_WAIT_MS,
    });
    // An error on the connection rejects the query waiting on it, which says
    // so below; without a listener, the same error would end the suite.
    client.on("error", () => {});
    let locked: number | null;
    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN");
      const lock = await client.query("SELECT id FROM api_keys WHERE id = $1 FOR UPDATE", [keyId]);
      locked = lock.rowCount;
    } catch (err) {
      record(
        "setup: the key's row locked from a connection of the phase",
        false,
        queryFailure(err),
      );
      return;
    }
    if (locked !== 1) {
      record(
        "setup: the key's row locked from a connection of the phase",
        false,
        `rows=${locked ?? "none"}`,
      );
      return;
    }

    const started = Date.now();
    const res = await revoke(keyId);
    const waitedMs = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const retryAfter = res.headers.get("retry-after");
    const boundReached = waitedMs < BOUND_REACHED_WITHIN_MS;
    record(
      feature,
      res.status === 503 &&
        code === "DATABASE_TIMEOUT" &&
        retryAfter === RETRY_AFTER_S &&
        boundReached,
      `status=${res.status} code=${code ?? "absent"} retry_after=${retryAfter ?? "absent"} waited_ms=${waitedMs}${
        boundReached
          ? ""
          : ` — not within ${BOUND_REACHED_WITHIN_MS} ms: the statement bound did not reach the database's connection`
      }`,
      waitedMs,
    );

    try {
      await client.query("ROLLBACK");
    } catch (err) {
      record("the phase's transaction rolled back, the row released", false, queryFailure(err));
      return;
    }
    const again = await revoke(keyId);
    revoked = again.status === 204;
    record(
      "once the row is released, the key is revoked for good",
      revoked,
      `status=${again.status}`,
    );
  } catch (err) {
    record(
      "the database timeout phase",
      false,
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
  } finally {
    // A query sent on a client whose connection never opened would wait for it
    // forever: the rollback goes only to an open one.
    if (client && connected) await client.query("ROLLBACK").catch(() => {});
    await client?.end().catch(() => {});
    if (keyId !== undefined && !revoked) await revoke(keyId).catch(() => {});
    // The registry again as every other phase knows it: without the phase's bound.
    const restarted = Date.now();
    stopRegistry();
    try {
      await startRegistry();
      record(
        "the registry runs again without the phase's statement bound",
        true,
        "health=ok",
        Date.now() - restarted,
      );
    } catch (err) {
      record(
        "the registry runs again without the phase's statement bound",
        false,
        err instanceof Error ? err.message : String(err),
        Date.now() - restarted,
      );
    }
  }
}
