-- Migration 012: per-agent visibility
--
-- Adds `agents.visibility` ('private' default | 'public'). Makes POST /run
-- run-authorized (owner-only for private agents) instead of cross-tenant.
-- The DDL DEFAULT fills existing rows with 'private' at apply time — no
-- separate UPDATE backfill needed.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — passes the migrations-runner boot
-- lint that rejects non-idempotent DDL + top-level BEGIN/COMMIT.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public'));
