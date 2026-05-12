-- Skrun migration 004 — add cache token + savings columns to runs
-- Version: 004
-- Created: 2026-05-05
-- Applies to: Supabase (Postgres ≥ 11). SQLite handled separately by SqliteDb.migrate() in sqlite.ts.
-- Fresh installs get these via patched 001_initial_schema.sql (TODO post-merge).
--
-- Persists the cache hit/miss data emitted by POST /run (#68 prompt-caching).
-- usage_cache_savings_usd is a write-time snapshot computed from cost.ts rates,
-- aligned with the existing usage_estimated_cost numeric(10,6) pattern. Sub-cent
-- precision preserved at the row level so SUM aggregates remain accurate on
-- low-traffic workspaces.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_cache_read_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_cache_write_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS usage_cache_savings_usd numeric(10,6) NOT NULL DEFAULT 0;
