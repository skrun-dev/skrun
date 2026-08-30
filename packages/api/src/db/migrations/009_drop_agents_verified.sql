-- Skrun migration 009 — drop legacy agents.verified column
-- Created: 2026-05-19
--
-- Companion drop step for migration 008. Per-version verification is now the
-- single source of truth (agent_versions.verified, gated by
-- PATCH /api/agents/:ns/:name/versions/:version/verify). All consumers have
-- migrated: the runtime gate at POST /run reads the version flag, the SDK
-- exposes client.verifyVersion(), the CLI ships skrun verify / unverify, the
-- dashboard uses the per-row Verify/Unverify buttons in the versions table.
-- The legacy column is now dead code at the application layer; dropping it
-- prevents drift and removes a footgun where an operator could mistake the
-- agent-level flag for the runtime trust signal.
--
-- Safe to drop: every row was already false (migration 007 reset). No data
-- preservation needed.

-- Note: no `BEGIN;`/`COMMIT;` here — the migrations-runner wraps
-- each file in a transaction at apply-time. Nested BEGIN inside an outer
-- transaction would commit the inner half early. Lint check in
-- migrations-runner.ts enforces this convention at boot.

-- IF EXISTS makes the migration idempotent (mid-crash recovery safe).
ALTER TABLE agents
  DROP COLUMN IF EXISTS verified;
