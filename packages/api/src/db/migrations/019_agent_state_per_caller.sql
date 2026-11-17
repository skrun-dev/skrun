-- Migration 019: agent state kept per agent id and per caller
-- Version: 019
-- Created: 2026-10-06
--
-- An agent's state (its "notebook") used to be one row per agent, keyed by the
-- text `<namespace>/<slug>`: every caller of the agent read and wrote the same
-- notebook, nothing tied the row to the agent it belonged to, and an agent
-- deleted then re-created under the same name inherited it. This migration
-- replaces the table:
--
--   * agent_id — the agent's id, with a foreign key: the notebook goes with
--     its agent, and a re-created agent of the same name starts empty.
--   * partition_key — whose notebook it is, never null: `shared` (one notebook
--     for every caller), `account:<user id>` or `key:<key id>`.
--   * caller_user_id / caller_key_id — the account or the API key the notebook
--     belongs to; exactly one of the two for a per-caller row, neither for a
--     `shared` one. Each cascades: deleting the account or revoking the key
--     deletes its notebooks.
--   * state — the notebook itself.
--   * updated_at — the last write.
--   * expires_at — the deadline: the last write plus the retention the agent
--     declares (bounded by the server). Written by the code, never defaulted.
--
-- The primary key (agent_id, partition_key) holds one row per partition: a
-- UNIQUE over the nullable reference columns would accept two `shared` rows of
-- the same agent, and Postgres 14 has no NULLS NOT DISTINCT. The CHECK ties
-- the key to the references; each branch states its IS NULL / IS NOT NULL
-- explicitly, because a bare equality against a NULL column is NULL, and a
-- CHECK that evaluates to NULL passes.
--
-- !!! ALL EXISTING AGENT STATE IS DELETED. !!!
-- A row of the earlier shape names neither the agent's id nor a caller, so it
-- cannot be attributed to anyone, and none is carried over. To keep a copy,
-- export the table BEFORE upgrading:
--
--   SELECT * FROM agent_state;
--
-- Indexes: expires_at for the expiry sweep, which reads it on every instance;
-- caller_user_id and caller_key_id for the two cascades — revoking a key is an
-- ordinary owner action and must not scan the table. The cascade from the
-- agent is served by the primary key.
--
-- Mirrored in sqlite.ts (created in migrate(), after the foreign-key rebuild,
-- with the same drop-if-old-shape rule) and in the Memory adapter. This .sql
-- file is the Postgres path.
--
-- Idempotent: the table is dropped only while it still has the earlier shape
-- (an `agent_id` column and no `partition_key`), so running this file again
-- does not empty the new table. CREATE TABLE / CREATE INDEX IF NOT EXISTS; no
-- top-level BEGIN/COMMIT (the migrations-runner wraps the file in its own
-- transaction).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_state'
      AND column_name = 'agent_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_state'
      AND column_name = 'partition_key'
  ) THEN
    DROP TABLE IF EXISTS agent_state;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_state (
  agent_id       uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  partition_key  text        NOT NULL,
  caller_user_id uuid        REFERENCES users(id) ON DELETE CASCADE,
  caller_key_id  uuid        REFERENCES api_keys(id) ON DELETE CASCADE,
  state          jsonb       NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (agent_id, partition_key),
  CHECK (
    (partition_key = 'shared' AND caller_user_id IS NULL AND caller_key_id IS NULL)
    OR (caller_user_id IS NOT NULL AND caller_key_id IS NULL
        AND partition_key = 'account:' || caller_user_id::text)
    OR (caller_key_id IS NOT NULL AND caller_user_id IS NULL
        AND partition_key = 'key:' || caller_key_id::text)
  )
);

CREATE INDEX IF NOT EXISTS agent_state_expires_at_idx ON agent_state (expires_at);
CREATE INDEX IF NOT EXISTS agent_state_caller_user_idx ON agent_state (caller_user_id)
  WHERE caller_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_state_caller_key_idx ON agent_state (caller_key_id)
  WHERE caller_key_id IS NOT NULL;
