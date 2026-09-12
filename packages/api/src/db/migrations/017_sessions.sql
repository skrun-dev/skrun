-- Migration 017: sessions — the browser session store
-- Version: 017
-- Created: 2026-09-11
--
-- Backs the `skrun_session` browser cookie. The store used to be a Map living
-- in the api process, so every restart or rolling deploy signed everyone out,
-- and two instances never shared a session — a login on one answered 401 on the
-- other, with nothing failing and nothing warning.
--
--   * id_hash — SHA-256 of the raw session id. The raw id lives only in the
--     cookie, so a DB read never yields a usable credential (same idea as
--     api_keys.key_hash and device_codes.device_code_hash).
--   * user_id — the authenticated user this session stands for.
--   * created_at — not required by the code. Kept because the neighbouring
--     tables carry it, and because it is the only way to tell an old session
--     from one about to expire when reading rows during an incident.
--   * expires_at — an ABSOLUTE deadline (SESSION_TTL_S), never extended by use.
--
-- The index on expires_at covers the only non-primary-key column any query
-- looks at: the hourly sweep reads it on every instance, forever. Creating it
-- here keeps the sweep from ever becoming the thing that grows with the user
-- count, and saves a later migration. No index on user_id — no query reads it,
-- and the cascade below is rare on a small table.
--
-- ON DELETE CASCADE on user_id so a deleted account takes its sessions with it.
-- Mirrored in sqlite.ts (the sessions table lives in the SCHEMA const with the
-- inline FK — the FK is to `users`, which migrateForeignKeys() never rebuilds,
-- so there is no FK-rebuild collision) and in the Memory adapter (JS map).
-- This .sql file is the Postgres path.
--
-- Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS) — passes the
-- migrations-runner lint (no top-level BEGIN/COMMIT; the runner wraps the file
-- in its own transaction).
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
