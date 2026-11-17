-- Migration 021: what a run holds of its account's quotas — its seat's deadline,
-- the time it is charged, and whether it holds the right to a pooled machine
-- Version: 021
-- Created: 2026-10-16
--
-- An account's bounds are read from its own rows in `runs`: a run in flight
-- holds a seat, and the time of its runs created in the current window is its
-- compute. No table of counters: the row is the seat.
--
--   * deadline_at — the instant past which a run still `running` no longer
--     holds a seat (nor one of the instance): its start, plus its timeout,
--     plus the margin that covers the machine's acquisition and the upload of
--     its outputs. A process that dies with the run in flight leaves the row
--     `running` forever; the deadline frees the seat anyway. Written once, by
--     the insert that admits the run, from the process's clock. A NULL deadline
--     counts as expired: a run that predates this migration holds no seat and
--     no time, with no backfill.
--   * charged_ms — the time the run is charged, written with its final
--     status: the time from its creation to its end, or 0 when its machine was
--     never ready. A finished run whose charged_ms is NULL counts that same
--     time from its creation to its end — never 0.
--   * pool_entitled — the run holds the right to a pooled machine: set by the
--     insert that admits it, taken back once when its machine is ready and no
--     pooled machine was taken for it. The count of an account's runs per
--     rolling hour that hold it. False for every run before this migration.
--
-- The three follow the row: an account deletion keeps them, as it keeps the
-- run's timestamps, status and usage. Operator-only bookkeeping, never part
-- of the run API response.
--
-- The two indexes serve the admission's reads: an account's runs from a given
-- instant (its window, its hour), and the runs still holding a seat — PARTIAL,
-- the same shape as idx_runs_active (001_initial_schema.sql), because most rows
-- are finished.
--
-- Mirrored in sqlite.ts: the columns in the SCHEMA const (fresh installs) and in
-- migrate() after the foreign-key rebuild (existing databases); the indexes in
-- migrate() only — on an existing database SCHEMA runs before the columns
-- exist. And in the Memory adapter. This .sql file is the Postgres path.
--
-- Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) — passes the
-- migrations-runner lint (no top-level BEGIN/COMMIT; the runner wraps the file
-- in its own transaction).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS charged_ms bigint;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pool_entitled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_running_deadline ON runs (deadline_at)
  WHERE status = 'running';
