-- Migration 018: run output retention — the purge deadline and the purge mark
-- Version: 018
-- Created: 2026-09-25
--
-- A run on the cloud runtime uploads its output files to object storage, under
-- a prefix of its own, and nothing ever deleted them. These two columns let a
-- background purge do it — and, being in the database, the deadline outlives a
-- stopped process: the next start finds it.
--
--   * purge_after — the deadline: completion time plus the files retention
--     window (FILES_RETENTION_S), written in the same update as `files` and
--     `completed_at`. Set only for a run whose files went to object storage and
--     that produced at least one; NULL for every other run (local runtime, no
--     file, failed run).
--   * outputs_purged_at — when the purge deleted the run's output objects. Set
--     once: a run already marked keeps its first date. The file names and sizes
--     stay in `files`.
--
-- Both are operator-only bookkeeping, never part of the run API response.
-- Nullable, no default: a run that predates this migration has no deadline,
-- so the purge never selects it.
--
-- The index serves the only query that reads these columns: the purge, run on
-- every instance every five minutes and at boot, forever. It is PARTIAL because
-- most rows never enter it — local runs, runs without files, runs already
-- purged — the same shape as idx_runs_active (001_initial_schema.sql,
-- WHERE status = 'running'). The purge's condition (deadline reached, no mark
-- yet) implies the index's WHERE, so that query can use it.
--
-- Mirrored in sqlite.ts: the columns in the SCHEMA const (fresh installs) and in
-- migrate() after the foreign-key rebuild (existing databases); the index in
-- migrate() only — on an existing database SCHEMA runs before the columns
-- exist. And in the Memory adapter. This .sql file is the Postgres path.
--
-- Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) — passes the
-- migrations-runner lint (no top-level BEGIN/COMMIT; the runner wraps the file
-- in its own transaction).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS outputs_purged_at timestamptz;

CREATE INDEX IF NOT EXISTS runs_output_purge_due_idx ON runs (purge_after)
  WHERE outputs_purged_at IS NULL AND purge_after IS NOT NULL;
