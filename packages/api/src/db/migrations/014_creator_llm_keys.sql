-- Migration 014: creator-attached LLM keys (encrypted at rest) + caller-key policy
-- Version: 014
-- Created: 2026-06-19
--
-- Lets a creator attach their own LLM key to their agent so callers don't need
-- one (resolution: caller > creator > server > error). The key is encrypted at
-- rest (AES-256-GCM, see services/secrets/key-provider.ts); only the
-- ciphertext + a display-only last4 are stored here. Per-agent + per-provider
-- (a stable billing key, mirrors the X-LLM-API-Key provider->key map).
--
--   * agent_llm_keys — one row per (agent, provider). ON DELETE CASCADE so the
--     keys vanish with the agent. Never returned by any read endpoint.
--   * agents.llm_key_policy — 'open' (default; callers may bring their own key)
--     or 'creator_only' (caller-provided keys rejected with 403).
--
-- The llm_key_policy DDL DEFAULT fills existing agents with 'open' at apply time
-- — no UPDATE backfill, non-breaking (existing agents keep today's behavior).
-- Mirrored for SQLite in sqlite.ts (agent_llm_keys created in migrate() AFTER
-- migrateForeignKeys(), NOT in the SCHEMA constant — the api_key_agents
-- precedent — to avoid the FK-rebuild collision); the Memory adapter carries the
-- fields in JS. This .sql file is the Postgres path.
--
-- Idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS) — passes the
-- migrations-runner lint (no top-level BEGIN/COMMIT; the runner wraps the file
-- in its own transaction).
CREATE TABLE IF NOT EXISTS agent_llm_keys (
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  ciphertext  text NOT NULL,
  last4       text,
  key_version integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, provider)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_key_policy TEXT NOT NULL DEFAULT 'open' CHECK (llm_key_policy IN ('open','creator_only'));
