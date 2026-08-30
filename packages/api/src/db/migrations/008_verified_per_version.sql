-- Skrun migration 008 — add per-version verified flag (additive only)
-- Created: 2026-05-19
--
-- Verification is now per-version, not per-agent. Each version owns its trust
-- state independently — pushing a new version is a pure INSERT with
-- verified=false, leaving prior verified versions untouched. Pinned production
-- callers (POST /run with version: "X.Y.Z") remain runnable through admin
-- iteration of newer versions, which is the breakage the per-agent reset would
-- have caused.
--
-- This migration adds the per-version flag on `agent_versions`. The
-- companion migration 009 drops the legacy agent-level `agents.verified`
-- column — the two migrations together implement the per-version trust
-- model end-to-end.
--
-- Safety: all `agent_versions` rows start at `verified = false`. Admins
-- re-verify each version explicitly via
-- PATCH /api/agents/:ns/:name/versions/:version/verify.

-- Note: no `BEGIN;`/`COMMIT;` here — the migrations-runner wraps
-- each file in a transaction at apply-time. Nested BEGIN inside an outer
-- transaction would commit the inner half early. Lint check in
-- migrations-runner.ts enforces this convention at boot.

-- Add the per-version verified flag. Existing rows acquire verified=false
-- automatically — admins re-verify each version through the new endpoint.
-- IF NOT EXISTS makes the migration idempotent (mid-crash recovery safe).
ALTER TABLE agent_versions
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
