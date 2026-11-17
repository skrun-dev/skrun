// The live suite's guard on the database it writes to.
//
// The suite starts a registry that writes to whatever DATABASE_URL names: it
// pushes agents, runs them, deletes accounts, and on Postgres applies the
// migrations of the code under test; two phases also open that database
// themselves. Its `.env` falls back to the main checkout's (env-file.ts), which
// can name a shared or hosted database — so one run against it rewrites a
// database that holds someone else's data.
//
// So it is judged WHERE the suite writes, never at load: in `startRegistry()`
// on the very environment handed to the registry (extraEnv included), in
// `openRegistryDb()`, and before the pool of phase 35. Importing `_ctx.ts`
// judges nothing — the cloud smokes import it with a `.env` whose DATABASE_URL
// they never open, and must not die of it.
//
// The rule is the API tests' own (disposable-database.shared.ts), imported and
// never copied, with one addition the registry's start makes necessary: it
// treats ANY non-empty DATABASE_URL as Postgres (packages/api/src/dev.ts), so
// every non-empty value is judged — a value that is not a postgres:// URL is
// refused rather than let through as "not Postgres". Absent or empty, the
// registry runs on its SQLite file at the repository root, which is accepted.
//
// Pure: it reads only the environment it is handed and throws. The message
// names the host and the database, never the URL (it carries the password).
import {
  assertDisposableDatabaseUrl,
  type DisposableDatabaseReason,
  isPostgresUrl,
} from "../../../packages/api/src/db/disposable-database.shared.js";

const LABEL = "the live suite";

/** What the suite does to the database, and the way out — in every refusal. */
export const LIVE_SUITE_REASON: DisposableDatabaseReason = {
  does: "The live suite writes to the database it is given: its registry pushes and runs agents, deletes accounts and applies the migrations of the code under test",
  how: "Leave DATABASE_URL empty for SQLite, or pass a file of its own with SKRUN_ENV_FILE whose DATABASE_URL names a throwaway Postgres on this machine ending in _test: postgres://postgres:postgres@127.0.0.1:55432/skrun_test.",
};

/**
 * Throw unless the environment `env` would have the suite write to SQLite (no
 * DATABASE_URL) or to a throwaway Postgres on this machine.
 */
export function assertLiveDatabase(env: NodeJS.ProcessEnv): void {
  const value = env.DATABASE_URL;
  if (value === undefined || value === "") return;
  if (!isPostgresUrl(value)) {
    throw new Error(
      `${LABEL}: refusing to run: DATABASE_URL is set but is not a postgres:// or postgresql:// URL, and the registry reads any non-empty value as a Postgres connection. ${LIVE_SUITE_REASON.does}. ${LIVE_SUITE_REASON.how}`,
    );
  }
  assertDisposableDatabaseUrl(value, LABEL, LIVE_SUITE_REASON);
}
