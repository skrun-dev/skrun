-- Migration 015: device_codes — OAuth 2.0 Device Authorization Grant (RFC 8628) store
-- Version: 015
-- Created: 2026-06-20
--
-- Backs the CLI device-login flow that replaces the old loopback ?token=
-- redirect (which leaked the sk_live key via the URL query string).
-- The CLI polls POST /auth/device/token; the token is minted only when the
-- poll succeeds and returned in the response body — never via a URL.
--
--   * device_code_hash / user_code_hash — SHA-256 of the raw codes (the raw
--     codes live only in transit; a DB read never yields a usable code, same
--     idea as api_keys.key_hash). The token is NOT stored here: it is minted
--     at poll-success (mint-at-poll), so this table holds no secret at rest.
--   * code_challenge — the PKCE (RFC 7636) S256 challenge; the poll requires
--     the matching verifier (which never leaves the CLI).
--   * status — 'pending' until the browser leg authorizes it, then 'authorized'
--     with the bound user_id (the user who completed GitHub OAuth).
--   * current_interval / last_polled_at — RFC 8628 slow_down back-off state.
--   * attempt_count — PKCE verifier attempts; capped to stop verifier grinding.
--   * expires_at — short TTL (SKRUN_DEVICE_CODE_TTL_S, default 600s).
--
-- ON DELETE CASCADE on user_id so a deleted user's in-flight codes vanish.
-- Mirrored in sqlite.ts (the device_codes table lives in the SCHEMA const with
-- the inline FK — the FK is to `users`, which migrateForeignKeys() never
-- rebuilds, so there is no FK-rebuild collision) and in the Memory adapter
-- (JS map). This .sql file is the Postgres path.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS) — passes the migrations-runner lint
-- (no top-level BEGIN/COMMIT; the runner wraps the file in its own transaction).
CREATE TABLE IF NOT EXISTS device_codes (
  device_code_hash text PRIMARY KEY,
  user_code_hash   text NOT NULL UNIQUE,
  code_challenge   text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized')),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  current_interval integer NOT NULL DEFAULT 5,
  attempt_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  last_polled_at   timestamptz
);
