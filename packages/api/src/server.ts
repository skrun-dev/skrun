/**
 * Production api-server entry — used by the multi-runtime image in
 * `SKRUN_CONTAINER_MODE=api-server` mode (cloud deployment via Fly.io,
 * plus self-host docker-compose).
 *
 * Differs from `dev.ts` in three ways:
 *   1. NO SQLite fallback — if DATABASE_URL is missing, we throw at
 *      startup. Cloud must fail loud rather than silently switch to a
 *      filesystem DB that won't survive a Fly machine restart.
 *   2. NO MemoryStorage shortcut — uses R2 (S3-compatible) in all cases,
 *      matching what FlyioAdapter expects when spawning runner machines.
 *   3. Quiet log output — single structured line, no help banner.
 *
 * **PostgresDb replaces the legacy SupabaseDb
 * with PostgresDb (direct `pg` driver). Migrations auto-apply on boot
 * via the migrations-runner with `pg_advisory_lock` concurrent-safety.**
 *
 * Required env (the api-server refuses to boot if any missing):
 *   DATABASE_URL          Standard `postgres://user:pass@host:port/db`
 *                         connection string. In cloud, use Supabase's
 *                         pooler URL on port 6543 (transaction mode).
 *   S3_BUCKET             R2 (or MinIO) bucket holding bundles + outputs
 *   S3_ACCESS_KEY_ID      R2 / MinIO credentials
 *   S3_SECRET_ACCESS_KEY  R2 / MinIO credentials
 *
 * One of:
 *   S3_ACCOUNT_ID         R2 mode — URL derived to
 *                         https://<id>.r2.cloudflarestorage.com
 *   S3_ENDPOINT           MinIO mode — explicit endpoint URL
 *
 * Optional env:
 *   PORT                  Listen port (default 4000)
 *   S3_REGION             Defaults to "auto" for R2, "us-east-1" for MinIO
 *   SKRUN_RUNTIME         "local" or "flyio" (default "local"). When
 *                         "flyio", additional env required — see
 *                         runtime/adapter-selection.ts.
 *
 * Plus the usual NODE_ENV / CORS_ORIGIN / WEBHOOK_SIGNING_KEY / LLM API
 * keys / OAuth / SKRUN_AGENTS_DIR, validated as needed by `createApp` and
 * its sub-modules.
 */

import { join } from "node:path";
import { serve } from "@hono/node-server";
import { backfillBundleHashes } from "./db/backfill-bundle-hashes.js";
import { runMigrations } from "./db/migrations-runner.js";
import { PostgresDb } from "./db/postgres.js";
import { createApp } from "./index.js";
import { R2Storage } from "./storage/r2.js";

function fail(msg: string): never {
  console.error(`[skrun-api] FATAL: ${msg}`);
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  fail(
    "DATABASE_URL is required in api-server mode. " +
      "Use a standard `postgres://user:pass@host:port/db` connection string " +
      "(e.g. Supabase pooler URL on port 6543). " +
      "For self-host single-tenant without Postgres, run `pnpm dev:registry` from the source tree.",
  );
}
if (!/^postgres(ql)?:\/\//.test(dbUrl)) {
  fail(
    `DATABASE_URL must start with postgres:// or postgresql:// (got: ${dbUrl.slice(0, 8)}...). ` +
      "Pre-#007 cloud secrets used the Supabase HTTPS project URL — that format is no longer supported.",
  );
}

const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const accountId = process.env.S3_ACCOUNT_ID;
const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION;

if (!bucket) fail("S3_BUCKET is required in api-server mode.");
if (!accessKeyId) fail("S3_ACCESS_KEY_ID is required in api-server mode.");
if (!secretAccessKey) fail("S3_SECRET_ACCESS_KEY is required in api-server mode.");
if (!accountId && !endpoint) {
  fail(
    "Either S3_ACCOUNT_ID (Cloudflare R2) or S3_ENDPOINT (MinIO / self-host) must be set in api-server mode.",
  );
}

const db = new PostgresDb(dbUrl);

// Auto-apply migrations on boot (#007 spec §Approach 4). `pg_advisory_lock`
// in the runner serialises concurrent boots (rolling deploys); cloud
// backfill probe records pre-007 MCP-applied migrations without re-running.
const migResult = await runMigrations(db.getPool(), join(import.meta.dirname, "db/migrations"));

const storage = new R2Storage({
  bucket,
  accessKeyId,
  secretAccessKey,
  accountId,
  endpoint,
  region,
});

// Populate bundle_sha256 for any legacy (pre-checksum) versions (one-shot,
// idempotent, out-of-lock — runs after migrations). No-op once all rows hashed.
await backfillBundleHashes(db, storage);

const app = createApp(storage, db);
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `[skrun-api] listening on :${port} runtime=${process.env.SKRUN_RUNTIME ?? "local"} db=postgres storage=r2 migrations applied=${migResult.applied} backfilled=${migResult.backfilled} skipped=${migResult.skipped}`,
  );
});
