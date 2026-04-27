-- Skrun migration 002 — add version notes
-- Version: 002
-- Created: 2026-04-24
-- Applies to: existing Supabase deployments upgraded from pre-#14c
-- Fresh installs get this via patched 001_initial_schema.sql.

ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS notes text;
