-- Skrun migration 006 — UNIQUE(agent_id, version) on agent_versions
-- Created: 2026-05-13
--
-- Postgres already has this constraint via 001_initial_schema.sql (line 74).
-- This migration is the parity guard: detects if a UNIQUE constraint on
-- (agent_id, version) is missing (e.g. operator dropped it manually, or a
-- pre-001 install lacks it) and re-adds it after a duplicate pre-check.
-- Idempotent — a no-op when the constraint is already present.

DO $$
DECLARE
  constraint_count int;
  dup_count int;
BEGIN
  -- Is the UNIQUE constraint on (agent_id, version) already present?
  -- 2026-05-25 fix: cast attname (type `name`) to `text` so the array equality
  -- doesn't fail with `operator does not exist: name[] = text[]` on stricter
  -- Postgres versions (verified against live Supabase Postgres 17).
  SELECT count(*) INTO constraint_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE c.contype = 'u'
     AND t.relname = 'agent_versions'
     AND (
       SELECT array_agg(a.attname::text ORDER BY a.attname)
         FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = ANY(c.conkey)
     ) = ARRAY['agent_id', 'version'];

  IF constraint_count = 0 THEN
    -- Duplicate pre-check
    SELECT count(*) INTO dup_count
      FROM (
        SELECT 1
          FROM agent_versions
         GROUP BY agent_id, version
        HAVING count(*) > 1
      ) sub;

    IF dup_count > 0 THEN
      RAISE EXCEPTION
        'UNIQUE(agent_id, version) missing AND % duplicate (agent_id, version) groups exist. Dedupe with: DELETE FROM agent_versions WHERE ctid NOT IN (SELECT min(ctid) FROM agent_versions GROUP BY agent_id, version); then re-apply this migration.',
        dup_count;
    END IF;

    ALTER TABLE agent_versions
      ADD CONSTRAINT agent_versions_agent_id_version_key UNIQUE (agent_id, version);
    RAISE NOTICE 'Added UNIQUE(agent_id, version) on agent_versions';
  END IF;
END;
$$ LANGUAGE plpgsql;
