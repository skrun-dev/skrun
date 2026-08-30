import { join } from "node:path";
import { serve } from "@hono/node-server";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import type { DbAdapter } from "./db/adapter.js";
import { createApp } from "./index.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { LocalStorage } from "./storage/local.js";
import { MemoryStorage } from "./storage/memory.js";

// Fail-secure dev-auth defaults for `pnpm dev:registry` (localhost). Set BEFORE
// createApp: NODE_ENV=development keeps dev-auth inside the interlock's allowlist,
// and SKRUN_DEV_AUTH=1 enables the `dev-token` admin shortcut. The published
// image (server.ts) sets neither — fail-secure by default.
process.env.NODE_ENV ??= "development";
process.env.SKRUN_DEV_AUTH ??= "1";

let db: DbAdapter;
let storage: StorageAdapter;

if (process.env.DATABASE_URL) {
  // Postgres branch — auto-apply migrations on boot: a first-time dev with
  // DATABASE_URL=postgres://... on an empty DB gets zero-friction migrate.
  // Same auto-apply contract as server.ts (cloud + self-host).
  const { PostgresDb } = await import("./db/postgres.js");
  const { runMigrations } = await import("./db/migrations-runner.js");
  const pgDb = new PostgresDb(process.env.DATABASE_URL);
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

const app = createApp(storage, db);
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`✓ Skrun Registry API running at http://localhost:${port}`);
  console.log("  GET  /health — Health check");
  console.log("  POST /api/agents/:ns/:name/push — Push agent bundle");
  console.log("  GET  /api/agents/:ns/:name/pull — Pull agent bundle");
  console.log("  GET  /api/agents — List agents");
  if (isOAuthConfigured()) {
    console.log("  Auth: GitHub OAuth + API keys (sk_live_*)");
    console.log("  Login: http://localhost:%d/login", port);
  } else {
    console.log("  Auth: Bearer dev-token (namespace: dev)");
  }
});
