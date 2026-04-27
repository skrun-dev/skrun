-- Skrun migration 002 — add model column to runs
-- Version: 002
-- Created: 2026-04-24
-- Applies to: existing Supabase deployments upgraded from pre-#14d
-- Fresh installs get this via patched 001_initial_schema.sql.
--
-- Stores the LLM model used per run as "provider/model-name" (e.g., "anthropic/claude-sonnet-4-20250514").
-- Populated at POST /run time. Displayed in the dashboard runs list + run detail.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS model text;
