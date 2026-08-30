-- Skrun migration 010 — align agent_state.agent_id with the runtime contract
-- Created: 2026-05-28
--
-- Previously (SupabaseDb via PostgREST), agent_state.agent_id was declared
-- `uuid REFERENCES agents(id) ON DELETE CASCADE` (migration 001:81), but
-- the runtime contract has always passed `<namespace>/<slug>` strings as
-- the key (e.g., "dev/seo-audit"). PostgREST silently swallowed the type
-- mismatch — agent_state was never actually populated in the cloud DB.
-- The direct pg driver (PostgresDb) is strict — surfaced as
-- `invalid input syntax for type uuid: "dev/seo-audit"` during the
-- Phase 9.4 live E2E live suite.
--
-- This migration aligns the PG schema with the SqliteDb schema (which
-- declares `agent_name TEXT PRIMARY KEY`): change agent_state.agent_id
-- to text + drop the FK to agents(id). The runtime key is composite
-- (`<ns>/<slug>`) — not an agents UUID — so the FK was conceptually
-- wrong anyway.
--
-- Safety: 0 rows in agent_state at migration time (verified 2026-05-28
-- via MCP). No data preservation needed.
--
-- Note: no `BEGIN;`/`COMMIT;` here — the migrations-runner wraps
-- each file in a transaction at apply-time.

-- 1. Drop the FK constraint. DROP CONSTRAINT IF EXISTS is idempotent.
ALTER TABLE agent_state
  DROP CONSTRAINT IF EXISTS agent_state_agent_id_fkey;

-- 2. Change agent_id to text. ALTER COLUMN TYPE is idempotent only via
-- the explicit USING expression (and the type check). On a second run,
-- the column already has type text so the ALTER is a no-op.
ALTER TABLE agent_state
  ALTER COLUMN agent_id TYPE text USING agent_id::text;
