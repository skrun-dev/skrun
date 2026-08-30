-- Skrun migration 005 — FOREIGN KEY parity with SQLite
-- Created: 2026-05-13
--
-- Postgres already has all the FK constraints we want via 001_initial_schema.sql.
-- This migration is the "Postgres parity" pass: it adds an orphan pre-check +
-- idempotent guard so the operator finds out at upgrade time if their DB
-- drifted (someone wrote rows with foreign_keys disabled in a parallel
-- process, or a logical replication subscriber lagged behind a DELETE).
--
-- Strategy: query pg_constraint to verify each expected FK is present; if
-- any is missing, run the orphan pre-check first and raise a remediation
-- hint. If all present, this is a no-op.

-- 2026-05-25 fix (validated against live Supabase Postgres 17):
--   - Replaced `expected_fks[i:i][1:4]` 2D slicing (which yields a 2D result that
--     does NOT flatten into a text[] variable — gives nulls in PL/pgSQL) with
--     direct `expected_fks[i][N]` element access.
--   - Cast `a.attname` (type `name`) to `text` so the `= ANY(...)` comparison
--     resolves cleanly without the `name[] = text[]` operator-not-found error
--     seen on stricter Postgres versions.
DO $$
DECLARE
  expected_fks text[][] := ARRAY[
    -- [table, column, ref_table, on_delete]
    ARRAY['api_keys',       'user_id',        'users',        'CASCADE'],
    ARRAY['agents',         'owner_id',       'users',        'CASCADE'],
    ARRAY['agent_versions', 'agent_id',       'agents',       'CASCADE'],
    ARRAY['agent_state',    'agent_id',       'agents',       'CASCADE'],
    ARRAY['environments',   'owner_id',       'users',        'CASCADE'],
    ARRAY['runs',           'agent_id',       'agents',       'SET NULL'],
    ARRAY['runs',           'environment_id', 'environments', 'SET NULL'],
    ARRAY['runs',           'user_id',        'users',        'SET NULL']
  ];
  fk_count int;
  orphan_count int;
  remediation text;
BEGIN
  FOR i IN 1..array_length(expected_fks, 1) LOOP
    -- Is the FK present?
    SELECT count(*) INTO fk_count
      FROM pg_constraint c
      JOIN pg_class child  ON child.oid  = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
     WHERE c.contype = 'f'
       AND child.relname  = expected_fks[i][1]
       AND parent.relname = expected_fks[i][3]
       AND expected_fks[i][2] = ANY(
             SELECT a.attname::text
               FROM pg_attribute a
              WHERE a.attrelid = child.oid
                AND a.attnum   = ANY(c.conkey)
           );

    IF fk_count = 0 THEN
      -- FK missing — run orphan check before failing the migration
      EXECUTE format(
        'SELECT count(*) FROM %I t WHERE t.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I r WHERE r.id = t.%I)',
        expected_fks[i][1], expected_fks[i][2], expected_fks[i][3], expected_fks[i][2]
      ) INTO orphan_count;

      IF orphan_count > 0 THEN
        remediation := format(
          'DELETE FROM %I WHERE %I IS NOT NULL AND %I NOT IN (SELECT id FROM %I);',
          expected_fks[i][1], expected_fks[i][2], expected_fks[i][2], expected_fks[i][3]
        );
        RAISE EXCEPTION
          'FK %.% -> %.id is missing AND % orphan rows exist. Run % then re-apply this migration.',
          expected_fks[i][1], expected_fks[i][2], expected_fks[i][3], orphan_count, remediation;
      END IF;

      -- No orphans; add the FK now.
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT fk_%I_%I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s',
        expected_fks[i][1], expected_fks[i][1], expected_fks[i][2], expected_fks[i][2], expected_fks[i][3], expected_fks[i][4]
      );
      RAISE NOTICE 'Added FK %.% -> %.id ON DELETE %', expected_fks[i][1], expected_fks[i][2], expected_fks[i][3], expected_fks[i][4];
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
