import { join } from "node:path";
import { serve } from "@hono/node-server";
import { API_KEY_PREFIX } from "./auth/api-key.js";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import { startSessionSweep } from "./auth/session.js";
import { startFileCacheSweep } from "./cache/file-cache-sweep.js";
import type { DbAdapter } from "./db/adapter.js";
import { startRunOutputPurge } from "./files/output-purge.js";
import { createApp } from "./index.js";
import { resolveRuntime } from "./runtime/adapter-selection.js";
import { installShutdownHandlers } from "./runtime/in-flight-runs.js";
import { startStateSweep } from "./services/agent-state.js";
import { readDeletionJournal } from "./services/deletion-journal.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { LocalStorage } from "./storage/local.js";
import { MemoryStorage } from "./storage/memory.js";

// Fail-secure dev-auth defaults for `pnpm dev:registry` (localhost). Set BEFORE
// createApp: NODE_ENV=development keeps dev-auth inside the interlock's allowlist,
// and SKRUN_DEV_AUTH=1 enables the `dev-token` admin shortcut. The published
// image (server.ts) sets neither — fail-secure by default.
process.env.NODE_ENV ??= "development";
process.env.SKRUN_DEV_AUTH ??= "1";

// The deletion journal is kept on either backend, in the bundles' store —
// which, on the Postgres branch below, is in memory: there the journal is lost
// at each restart, as the bundles are. Read here, before the two part ways and
// before any connection, a malformed value refuses the start, naming the
// variable. createApp reads it again and builds it on the bundles' store.
readDeletionJournal(process.env);

let db: DbAdapter;
let storage: StorageAdapter;

if (process.env.DATABASE_URL) {
  // Postgres branch — auto-apply migrations on boot: a first-time dev with
  // DATABASE_URL=postgres://... on an empty DB gets zero-friction migrate.
  // Same auto-apply contract as server.ts (cloud + self-host).
  const { PostgresDb } = await import("./db/postgres.js");
  const { runMigrations } = await import("./db/migrations-runner.js");
  const { readDbStatementTimeoutMs } = await import("./db/pg-timeouts.js");
  // The bound on each statement sent to the database, read on this branch
  // alone — SQLite ignores the variable — and before any connection: a
  // malformed value refuses the start, naming the variable.
  const statementTimeoutMs = readDbStatementTimeoutMs(process.env);
  const pgDb = new PostgresDb(process.env.DATABASE_URL, {}, { statementTimeoutMs });
  const migResult = await runMigrations(pgDb.getPool(), join(import.meta.dirname, "db/migrations"));
  db = pgDb;
  storage = new MemoryStorage();
  console.log(
    `  Storage: Postgres + memory bundles (migrations applied=${migResult.applied} backfilled=${migResult.backfilled} skipped=${migResult.skipped})`,
  );
  // Bundle-hash backfill (Postgres path only — the SQLite branch
  // already has the column via SCHEMA and never runs migrations).
  const { backfillBundleHashes } = await import("./db/backfill-bundle-hashes.js");
  await backfillBundleHashes(pgDb, storage);
} else {
  const { SqliteDb } = await import("./db/sqlite.js");
  db = new SqliteDb();
  storage = new LocalStorage(".skrun/bundles");
  console.log("  Storage: SQLite (skrun.db) + local bundles (.skrun/bundles/)");
}

// The runtime, decided once, as in server.ts: createApp gets the mode and, on
// the cloud runtime, the dependencies the output purge below runs on.
const runtime = resolveRuntime();
const app = createApp(storage, db, { runtimeMode: runtime.mode, flyioDeps: runtime.flyioDeps });

// One call covers both branches above — they converge on the same adapter. As
// in server.ts, this belongs to running a server, not to building an app.
startSessionSweep(db);
// And for the expired state notebooks of every agent, on either backend.
startStateSweep(db);
// And for the output files a cloud run leaves in object storage. The bundles
// stay local here: only the cloud dependencies carry a bucket, so outside the
// cloud runtime nothing starts.
startRunOutputPurge(db, runtime.flyioDeps?.storage);

const port = Number(process.env.PORT ?? 4000);

const server = serve({ fetch: app.fetch, port }, () => {
  // The file caches' sweep, like the ones above: expired run files are deleted on a
  // schedule, and what no live process holds under the temp directory is
  // removed in the background. Started once the server listens, so a large
  // stock left by an earlier version never stands between a start and its
  // health check.
  startFileCacheSweep();
  console.log(`✓ Skrun Registry API running at http://localhost:${port}`);
  console.log("  GET  /health — Health check");
  console.log("  POST /api/agents/:ns/:name/push — Push agent bundle");
  console.log("  GET  /api/agents/:ns/:name/pull — Pull agent bundle");
  console.log("  GET  /api/agents — List agents");
  if (isOAuthConfigured()) {
    console.log(`  Auth: GitHub OAuth + API keys (${API_KEY_PREFIX}*)`);
    console.log("  Login: http://localhost:%d/login", port);
  } else {
    console.log("  Auth: Bearer dev-token (namespace: dev)");
  }
});

// As in server.ts: Ctrl+C (SIGINT) or SIGTERM ends the runs in flight first —
// their rows written within a few seconds; a second Ctrl+C exits at once —,
// and on the cloud runtime stops the pool and destroys its ready machines.
installShutdownHandlers({ server, pool: runtime.flyioDeps?.pool });
