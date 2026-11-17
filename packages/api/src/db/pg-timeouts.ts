/**
 * The bound on each statement the server sends its Postgres database, read
 * from its operator's environment, and how a database that did not answer in
 * time is told apart from any other failure — and whether a write that threw
 * may have been committed all the same (`writeOutcomeUnknown`).
 *
 * Nothing here imports `pg`: the reader runs at the start, before any
 * connection, and the cause is read on every backend. The driver's messages
 * this module recognises are pinned by a test against the installed version.
 */

/** The statement bound when its variable is unset, in milliseconds. */
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 10_000;

/** The lowest statement bound an operator may set, in milliseconds. */
export const DB_STATEMENT_TIMEOUT_MIN_MS = 1_000;

/** The highest statement bound an operator may set — ten minutes. */
export const DB_STATEMENT_TIMEOUT_MAX_MS = 600_000;

/**
 * How long past the statement bound a connection may stay silent before the
 * client gives up on it. When the server stops a statement at its bound, its
 * answer comes back well within this margin, so the server, not the client, is
 * the one that ends a statement it was running.
 */
export const DB_CLIENT_TIMEOUT_MARGIN_MS = 5_000;

/** The `Retry-After` of a request the database did not answer in time, in seconds. */
export const DATABASE_TIMEOUT_RETRY_AFTER_S = 5;

/**
 * SKRUN_DB_STATEMENT_TIMEOUT_MS, read the strict way. Unset → the default.
 * Set, it must be a whole number of milliseconds from 1000 to 600000 once the
 * spaces around it are set aside; anything else — the empty string, `0`, a
 * negative, a fraction, `1e3`, `0x10`, a value out of range — throws, naming
 * the variable: the server reads it at its start, which refuses to go on.
 * `Number(x) || 10000` would take `1e3` for a second and a negative for a bound,
 * and quietly turn a typo into the default.
 */
export function readDbStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SKRUN_DB_STATEMENT_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_DB_STATEMENT_TIMEOUT_MS;
  const trimmed = raw.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!(ms >= DB_STATEMENT_TIMEOUT_MIN_MS && ms <= DB_STATEMENT_TIMEOUT_MAX_MS)) {
    throw new Error(
      `SKRUN_DB_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds from ${DB_STATEMENT_TIMEOUT_MIN_MS} to ${DB_STATEMENT_TIMEOUT_MAX_MS} (got "${raw}"). Unset it to use the ${DEFAULT_DB_STATEMENT_TIMEOUT_MS} ms default.`,
    );
  }
  return ms;
}

/** How long the client waits for an answer, for a given statement bound. */
export function clientTimeoutMs(statementTimeoutMs: number): number {
  return statementTimeoutMs + DB_CLIENT_TIMEOUT_MARGIN_MS;
}

/** Postgres: a statement stopped — past `statement_timeout`, or cancelled. */
const PG_QUERY_CANCELED = "57014";

/** `pg`: the client's own timer gave up on a query the server never answered. */
const QUERY_READ_TIMEOUT_MESSAGE = "Query read timeout";

/** `pg-pool`: every connection of the pool stayed busy past the wait for one. */
const POOL_WAIT_MESSAGE = "timeout exceeded when trying to connect";

/** `pg-pool`: a new connection got no answer within the connection timeout. */
const POOL_CONNECT_TIMEOUT_MESSAGE = "Connection terminated due to connection timeout";

/** `pg`: the same, for a client connecting outside a pool. */
const CLIENT_CONNECT_TIMEOUT_MESSAGE = "timeout expired";

/** Why the database did not answer in time. */
export type DatabaseTimeoutCause =
  | "statement_timeout"
  | "query_read_timeout"
  | "pool_wait"
  | "connect_timeout";

function fieldOf(err: unknown, field: "code" | "message" | "cause" | "severity"): unknown {
  return typeof err === "object" && err !== null
    ? (err as Record<string, unknown>)[field]
    : undefined;
}

function ownCause(err: unknown): DatabaseTimeoutCause | null {
  if (fieldOf(err, "code") === PG_QUERY_CANCELED) return "statement_timeout";
  switch (fieldOf(err, "message")) {
    case QUERY_READ_TIMEOUT_MESSAGE:
      return "query_read_timeout";
    case POOL_WAIT_MESSAGE:
      return "pool_wait";
    case POOL_CONNECT_TIMEOUT_MESSAGE:
    case CLIENT_CONNECT_TIMEOUT_MESSAGE:
      return "connect_timeout";
    default:
      return null;
  }
}

/**
 * Whether the client's own timer gave up on a query: the server may still be
 * running it, and the connection is to be dropped, never reused.
 */
export function isClientReadTimeout(err: unknown): boolean {
  return fieldOf(err, "message") === QUERY_READ_TIMEOUT_MESSAGE;
}

/**
 * Why `err` says the database did not answer in time, or null when it says
 * something else. Reads the error, then its `cause` once: the pool wraps the
 * failed connection it gave up on. A database that refuses, a host that
 * cannot be found, a connection cut or closed are not timeouts: null.
 */
export function databaseTimeoutCause(err: unknown): DatabaseTimeoutCause | null {
  return ownCause(err) ?? ownCause(fieldOf(err, "cause"));
}

/** A SQLSTATE: five digits or capital letters, its class the first two. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE classes of a statement the server refused and rolled back
 * before any commit: `22` data exception, `23` integrity constraint, `25`
 * invalid transaction state, `40` transaction rollback, `42` syntax error or
 * access rule, `54` program limit exceeded.
 */
const DEFINITE_REFUSAL_CLASSES: ReadonlySet<string> = new Set(["22", "23", "25", "40", "42", "54"]);

/** Severities of an error that ends the session: what ran in it is not answered for. */
const SESSION_ENDING_SEVERITIES: ReadonlySet<string> = new Set(["FATAL", "PANIC"]);

/**
 * Whether a write sent to the Postgres database may have been committed
 * although it threw — its outcome unknown to the caller. It is known only for
 * an answer of the server — the driver's `DatabaseError`, carrying a `severity`
 * and a SQLSTATE `code` — whose class says the statement itself was refused
 * and rolled back (`DEFINITE_REFUSAL_CLASSES`). Anything else is unknown: an
 * error with no SQLSTATE — a socket reset or closed, the client's own timer, a
 * connection never made —, any other class — `08` a connection failed, `57` a
 * statement stopped or a server shut down, `53` resources, `58` a system
 * error, `XX` an internal error, which a connection pooler also answers when
 * the server's session behind it dies with a query in flight —, and a
 * severity that ends the session (`FATAL`, `PANIC`). The class decides: the
 * severity the driver exposes is the server's localized word, which a server
 * in another language writes otherwise.
 */
export function writeOutcomeUnknown(err: unknown): boolean {
  const severity = fieldOf(err, "severity");
  const code = fieldOf(err, "code");
  if (typeof severity !== "string" || typeof code !== "string" || !SQLSTATE_SHAPE.test(code)) {
    return true;
  }
  if (SESSION_ENDING_SEVERITIES.has(severity)) return true;
  return !DEFINITE_REFUSAL_CLASSES.has(code.slice(0, 2));
}
