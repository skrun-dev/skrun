-- Skrun migration 016 — add runner cold-start telemetry columns to runs
-- Version: 016
-- Created: 2026-07-15
-- Applies to: Postgres (>= 14). SQLite handled separately by SqliteDb.migrate() in sqlite.ts.
--
-- Operator-only per-run runner identity + the per-phase spawn breakdown emitted
-- by the FlyioAdapter cold-start telemetry. machine_id / private_ip are internal
-- topology (not exposed in the run API); phase_timings holds the durations map.
-- All nullable — populated only for cloud (Fly) runs, null for local runs.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS machine_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS private_ip text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase_timings jsonb;
