-- Migration 011: bundle integrity (SHA-256 checksum of each agent bundle)
--
-- Adds a SHA-256 checksum of each version's bundle, computed at push and
-- verified (constant-time) at pull. Nullable: rows that predate hashing are
-- populated by the one-shot boot backfill (backfill-bundle-hashes.ts); the
-- always-set invariant for new pushes lives in RegistryService.push().
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — passes the migrations-runner boot
-- lint that rejects non-idempotent DDL + top-level BEGIN/COMMIT.
ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS bundle_sha256 TEXT;
