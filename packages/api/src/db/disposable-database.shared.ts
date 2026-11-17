/**
 * The guard of the API's tests against a real Postgres. Two test files destroy
 * what DATABASE_URL names — the `DbAdapter` contract (`postgres.test.ts`) drops
 * the `public` schema before every case, the migrations' integration block
 * (`migrations-runner.test.ts`) creates and drops whole databases on that
 * server. Pointed at a database that holds anything — a shared or hosted one,
 * a self-hosted stack's own database, a remote server reached through a tunnel
 * — they erase it.
 *
 * So a Postgres URL is accepted only when both hold:
 *   - its server is on this machine — `localhost`, an address of
 *     `127.0.0.0/8`, or `::1` — and no query parameter names another one
 *     (`host`, `hostaddr`, `service`, in any case: the driver takes a host from
 *     the query over the one before it, `…@localhost/db?host=elsewhere`);
 *   - its database's name ends in `_test` — `skrun_test`, as CI's service and
 *     the throwaway container are named. "On this machine" is not "throwaway":
 *     a self-hosted stack's `skrun` database, or a tunnel's local end, are local
 *     too. The name is the one thing that says the database was made to be
 *     destroyed.
 *
 * Anything else throws before a single statement is sent — from the suite's
 * global setup (`vitest.global-setup.ts`) for the whole run, and again when
 * each of the two files loads. The run fails loudly rather than skipping, so no
 * one reads a skipped file as a passed one. The message names the host and the
 * database, never the URL (it carries the password).
 */

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]"]);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Query parameters with which a URL names another server than its host (any case). */
const REMOTE_PARAMETERS = new Set(["host", "hostaddr", "service"]);
const DISPOSABLE_NAME = /_test$/;

/**
 * Why a caller refuses and what to do instead — in the message, after the
 * refusal itself. Each caller says what it really does to the database.
 */
export interface DisposableDatabaseReason {
  /** What the caller does to the database it is given: one sentence, no final period. */
  does: string;
  /** The way out: what DATABASE_URL should be instead. */
  how: string;
}

/** The API's own tests — the reason every caller gets unless it gives its own. */
const API_TESTS_REASON: DisposableDatabaseReason = {
  does: "These tests destroy the database they are given (the schema dropped, databases created and dropped)",
  how: "Point DATABASE_URL at a throwaway Postgres on this machine whose database ends in _test, as CI does: postgres://postgres:postgres@127.0.0.1:55432/skrun_test (a container started for the purpose).",
};

/** True when `hostname` (as `URL` parses it) names this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_NAMES.has(host) || IPV4_LOOPBACK.test(host);
}

/** True when `value` is a Postgres URL — the only kind these tests connect with. */
export function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\//.test(value);
}

/**
 * Throw unless `databaseUrl` names a throwaway Postgres on this machine (see
 * the module's comment). `label` says who refuses, in the message; `reason`,
 * what that caller does to the database and the way out — the API's tests' by
 * default.
 */
export function assertDisposableDatabaseUrl(
  databaseUrl: string,
  label: string,
  reason: DisposableDatabaseReason = API_TESTS_REASON,
): void {
  const why = `${reason.does}. ${reason.how}`;
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      `${label}: DATABASE_URL is not a URL this guard can read, so it refuses to run. ${why}`,
    );
  }
  const host = parsed.hostname;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `${label}: refusing to run against the Postgres at "${host || "(no host)"}", which is not on this machine. ${why}`,
    );
  }
  if ([...parsed.searchParams.keys()].some((key) => REMOTE_PARAMETERS.has(key.toLowerCase()))) {
    throw new Error(
      `${label}: refusing to run: DATABASE_URL carries a host, hostaddr or service parameter, which names another server than "${host}". ${why}`,
    );
  }
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    database = parsed.pathname;
  }
  if (!DISPOSABLE_NAME.test(database)) {
    throw new Error(
      `${label}: refusing to run against the database "${database || "(none)"}": its name does not end in _test — a local database can hold real data too. ${why}`,
    );
  }
}
