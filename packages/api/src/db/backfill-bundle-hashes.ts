import { createHash } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { StorageAdapter } from "../storage/adapter.js";
import type { DbAdapter } from "./adapter.js";

const logger = createLogger("bundle-backfill");

/**
 * One-shot, idempotent backfill of `agent_versions.bundle_sha256` for rows that
 * predate hashing. DB-row-driven: lists the null-hash versions,
 * fetches each bundle from storage, hashes + persists it. Skips — without
 * failing — versions whose bundle is missing from storage (those are already
 * broken: pull() 500s BUNDLE_NOT_FOUND, not our concern here).
 *
 * Runs ONCE at boot, AFTER runMigrations(), and OUTSIDE the migrations advisory
 * lock / transaction — it issues storage GETs (HTTP for R2) which must never run
 * inside a DB transaction. Only wired on the Postgres boot paths (server.ts +
 * dev.ts pg branch); the SQLite dev path already has the column via its SCHEMA
 * const and needs no backfill. Synchronous-at-boot is fine while bundle counts
 * are tiny; a future high-volume operator would move this to a background job.
 *
 * Idempotent: a second run finds no null-hash rows (the first populated them)
 * → no-op.
 */
export async function backfillBundleHashes(
  db: DbAdapter,
  storage: StorageAdapter,
): Promise<{ scanned: number; hashed: number; missing: number }> {
  const rows = await db.listVersionsMissingHash();
  let hashed = 0;
  let missing = 0;
  for (const row of rows) {
    const buffer = await storage.get(row.bundle_key);
    if (!buffer) {
      missing++;
      logger.debug(
        { event: "bundle_backfill_skip", version_id: row.id, bundle_key: row.bundle_key },
        "Backfill: bundle missing from storage — skipping",
      );
      continue;
    }
    const sha = createHash("sha256").update(buffer).digest("hex");
    await db.setVersionBundleHash(row.id, sha);
    hashed++;
  }
  if (rows.length > 0) {
    logger.info(
      { event: "bundle_backfill", scanned: rows.length, hashed, missing },
      "Backfilled bundle checksums",
    );
  }
  return { scanned: rows.length, hashed, missing };
}
