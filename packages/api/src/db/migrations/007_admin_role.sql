-- Skrun migration 007 — users.role + revoke pre-existing verified flags
-- Created: 2026-05-13
--
-- Adds the instance-level privilege column used by the admin-only PATCH /verify
-- gate. Reset every existing `verified = true` agent at the same time so the
-- "self-served verify = forged trust" gap closes in one atomic upgrade. An
-- admin (the sole role allowed to verify) can re-mint them after upgrade.
-- See docs/self-hosting.md → Admin role for the rationale.

BEGIN;

-- 1. Add the role column with a safe default. Existing rows acquire role='user'
--    automatically. Promotion to 'admin' is a manual SQL UPDATE — there is no
--    HTTP API for elevation by design.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'
  CHECK (role IN ('admin', 'user'));

-- 2. Revoke pre-existing verified flags. Self-served verification before this
--    migration produced rows whose trust signal no longer reflects an admin
--    gate; reset them en masse so the dashboard "verified" badge means
--    something consistent again.
UPDATE agents SET verified = false WHERE verified = true;

COMMIT;
