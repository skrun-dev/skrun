-- Migration 013: API-key resource scoping + per-key run metering
-- Version: 013
-- Created: 2026-06-17
--
-- Makes API-key scopes enforceable along two axes:
--   * operation — the existing api_keys.scopes text[] (agent:run/push/verify),
--     now consulted by the auth layer instead of being inert.
--   * resource — api_keys.scope_kind ('account' default | 'agents') plus an
--     api_key_agents join table binding a scoped key to specific agents.
-- Also adds runs.api_key_id so a run can be attributed to the key that made it
-- (per-key = per-client metering, consumed later by billing/quotas).
--
-- The scope_kind DDL DEFAULT fills existing api_keys with 'account' at apply
-- time — no UPDATE backfill, non-breaking (existing keys stay account-wide).
-- Mirrored for SQLite in sqlite.ts (SCHEMA constant + migrate()); the Memory
-- adapter carries the fields in JS. This .sql file is the Postgres path.
--
-- Idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS) — passes the
-- migrations-runner lint (no top-level BEGIN/COMMIT; the runner wraps the file
-- in its own transaction).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope_kind TEXT NOT NULL DEFAULT 'account' CHECK (scope_kind IN ('account','agents'));

CREATE TABLE IF NOT EXISTS api_key_agents (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
  PRIMARY KEY (api_key_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_api_key_agents_agent ON api_key_agents(agent_id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
