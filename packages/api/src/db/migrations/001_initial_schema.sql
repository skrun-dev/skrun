-- Skrun initial database schema
-- Version: 001
-- Created: 2026-04-18
--
-- Conventions:
--   PK: uuid DEFAULT gen_random_uuid()
--   Timestamps: timestamptz DEFAULT now()
--   Tables/columns: snake_case
--   Flexible data: jsonb
--   FK ownership: ON DELETE CASCADE
--   FK optional refs: ON DELETE SET NULL

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id  text        UNIQUE NOT NULL,
  username   text        UNIQUE NOT NULL,
  email      text        DEFAULT '',
  avatar_url text        DEFAULT '',
  plan       text        DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- 2. api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     text        UNIQUE NOT NULL,
  key_prefix   text        NOT NULL,
  name         text        NOT NULL,
  scopes       text[]      DEFAULT '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user     ON api_keys(user_id);

-- ============================================================
-- 3. agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace   text        NOT NULL,
  name        text        NOT NULL,
  description text        DEFAULT '',
  owner_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified    boolean     DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (namespace, name)
);

CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);

-- ============================================================
-- 4. agent_versions
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_versions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version         text        NOT NULL,
  size            integer     NOT NULL,
  bundle_key      text        NOT NULL,
  config_snapshot jsonb,
  notes           text,
  pushed_at       timestamptz DEFAULT now(),
  UNIQUE (agent_id, version)
);

-- ============================================================
-- 5. agent_state
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id   uuid        PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  state      jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- 6. environments
-- ============================================================
CREATE TABLE IF NOT EXISTS environments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  owner_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config     jsonb       NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- ============================================================
-- 7. runs
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id                       uuid        PRIMARY KEY,
  agent_id                 uuid        REFERENCES agents(id) ON DELETE SET NULL,
  agent_version            text        NOT NULL,
  model                    text,
  environment_id           uuid        REFERENCES environments(id) ON DELETE SET NULL,
  user_id                  uuid        REFERENCES users(id) ON DELETE SET NULL,
  status                   text        NOT NULL DEFAULT 'running',
  input                    jsonb,
  output                   jsonb,
  error                    text,
  usage_prompt_tokens      integer     DEFAULT 0,
  usage_completion_tokens  integer     DEFAULT 0,
  usage_total_tokens       integer     DEFAULT 0,
  usage_estimated_cost     numeric(10,6) DEFAULT 0,
  duration_ms              integer,
  files                    jsonb       DEFAULT '[]',
  created_at               timestamptz DEFAULT now(),
  completed_at             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_runs_agent   ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_user    ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_active  ON runs(status) WHERE status = 'running';
