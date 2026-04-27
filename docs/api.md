# API Reference

Base URL: `http://localhost:4000` (local dev) or your deployed instance.

> **Interactive docs**: visit `GET /docs` on your running server for a live API explorer (Scalar UI).
> **OpenAPI schema**: `GET /openapi.json` — import into Postman, Insomnia, or use for SDK generation.
> **Prefer the SDK?** Use `@skrun-dev/sdk` for a typed client instead of raw HTTP calls: `npm install @skrun-dev/sdk`

## Authentication

Skrun has three authentication modes. The mode is **auto-detected** based on whether GitHub OAuth env vars are configured.

```
No GITHUB_CLIENT_ID set  →  dev-token mode (local dev)
GITHUB_CLIENT_ID set     →  OAuth mode (self-hosted or cloud)
```

### Mode 1: Local dev (default)

When no OAuth env vars are configured, Skrun accepts a simple `dev-token`. This is the default for local development — zero setup.

```bash
# Login
skrun login --token dev-token

# Push an agent (namespace = "dev")
skrun build && skrun push

# Call your agent
curl -X POST http://localhost:4000/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hello"}}'
```

All agents live in the `dev` namespace. There is no user isolation — this mode is for a single developer working locally.

### Mode 2: Self-hosted (GitHub OAuth)

When you deploy Skrun on a shared server, enable real authentication:

**Step 1.** Create a GitHub OAuth App at [github.com/settings/developers](https://github.com/settings/developers):
- **Homepage URL**: `https://your-domain.com` (or `http://localhost:4000` for testing)
- **Authorization callback URL**: `https://your-domain.com/auth/github/callback`

**Step 2.** Configure two env vars on the server:
```bash
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
```

**Step 3.** Start the server. OAuth is now active. `dev-token` is rejected.

**Step 4.** Users sign in:
1. Visit `/login` in a browser — click "Sign in with GitHub"
2. After GitHub authorization, a session cookie is set
3. The user's GitHub username becomes their namespace (e.g., `alice`)

**Step 5.** Create API keys for programmatic access (CLI, CI/CD):
```bash
# From a browser session — create a key
curl -X POST https://your-domain.com/api/keys \
  -H "Cookie: skrun_session=<your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI deploy"}'
# Response: {"id": "...", "key": "sk_live_a1b2c3d4...", ...}
# ⚠️ The key is shown ONCE — save it now.

# Use the API key everywhere
skrun login --token sk_live_a1b2c3d4...
skrun build && skrun push   # pushes to alice/my-agent

curl -X POST https://your-domain.com/api/agents/alice/my-agent/run \
  -H "Authorization: Bearer sk_live_a1b2c3d4..." \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hello"}}'
```

### Mode 3: Cloud (skrun.sh) — coming soon

Same as self-hosted, but hosted by us. Sign in at `skrun.sh/login`. Comes with billing and a marketplace.

### Transitioning from local to production

When moving from local dev to a self-hosted or cloud instance:

| | Local dev | Production |
|--|-----------|------------|
| Auth | `Bearer dev-token` | `Bearer sk_live_...` (API key) or session cookie |
| Namespace | `dev` | Your GitHub username (e.g., `alice`) |
| Agent names | `dev/my-agent` | `alice/my-agent` |
| `agent.yaml` name | `name: dev/my-agent` | `name: alice/my-agent` |

Update the `name` field in your `agent.yaml` to match your production namespace, then `skrun build && skrun push`.

### Namespaces

Your namespace equals your GitHub username (lowercase). Permissions:

| Action | Who can do it |
|--------|---------------|
| Push, verify, delete | Namespace owner only (`alice` can only push to `alice/*`) |
| Run any agent | Anyone (marketplace model — `bob` can run `alice/my-agent`) |
| List agents | Anyone (public listing) |

### API keys

API keys use the `sk_live_` prefix followed by 32 hex characters. They are stored as SHA-256 hashes — the raw key is shown only once at creation time.

Default scopes: `agent:push`, `agent:run`, `agent:verify` (all granted).

### Auth middleware priority

When a request arrives, the middleware checks authentication in this order:

1. **Session cookie** (`skrun_session`) — from browser login
2. **API key** (`Bearer sk_live_...`) — from `POST /api/keys`
3. **Dev-token** (`Bearer dev-token`) — only if OAuth is NOT configured
4. Otherwise — `401 Unauthorized`

### Auth endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/login` | GET | No | Login page (HTML) — shows "Sign in with GitHub" or dev-token instructions |
| `/auth/github` | GET | No | Redirects to GitHub OAuth (returns 404 if OAuth not configured) |
| `/auth/github/callback` | GET | No | Handles OAuth callback — creates user, sets session cookie |
| `/auth/logout` | POST | No | Clears session cookie, redirects to `/` |
| `/api/me` | GET | Yes | Returns current user info (`id`, `username`, `namespace`, `email`, `plan`) |
| `/api/keys` | POST | Yes | Create API key — returns `sk_live_...` key (shown once) |
| `/api/keys` | GET | Yes | List your API keys (prefix only, never the full key) |
| `/api/keys/:id` | DELETE | Yes | Revoke an API key — takes effect immediately |

---

## Endpoints

### Health

```
GET /health
```

**Response** `200`
```json
{ "status": "ok" }
```

---

### Run an agent

```
POST /api/agents/:namespace/:name/run
```

Execute an agent and return the result. Supports three modes:
- **Sync** (default): blocks until completion, returns full result
- **SSE streaming**: real-time events via Server-Sent Events
- **Async webhook**: returns immediately, delivers result via callback

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |
| `Accept` | No | Set to `text/event-stream` for SSE streaming mode |
| `X-LLM-API-Key` | No | Caller-provided LLM API keys (see [Caller-provided API keys](#caller-provided-api-keys)) |

**Request body**

```json
{
  "input": {
    "field_name": "value"
  },
  "version": "1.2.0",
  "environment": {
    "timeout": "600s",
    "max_cost": 10.0
  },
  "webhook_url": "https://your-app.com/callback"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Input fields matching the agent's `agent.yaml` |
| `version` | No | Pin a specific agent version (**strict semver**, e.g. `"1.2.0"`). Omit to target latest. Ranges (`^`, `~`, `*`) and keywords (`"latest"`, `"HEAD"`) are not supported — omit the field for latest. |
| `environment` | No | Environment override — shallow-merged on top of agent.yaml defaults. Accepts any subset of: `networking.allowed_hosts`, `filesystem`, `secrets`, `timeout`, `max_cost`, `sandbox`. |
| `webhook_url` | No | URL to receive the result when execution completes (activates async mode) |

**Note**: `Accept: text/event-stream` and `webhook_url` are mutually exclusive. If both are present, the server returns `400`.

**Response** `200`

```json
{
  "run_id": "uuid",
  "status": "completed",
  "agent_version": "1.2.0",
  "output": {
    "field_name": "value"
  },
  "usage": {
    "prompt_tokens": 500,
    "completion_tokens": 150,
    "total_tokens": 650
  },
  "cost": {
    "estimated": 0.00025
  },
  "duration_ms": 3200
}
```

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string | Unique run identifier |
| `status` | `"completed"` or `"failed"` | Execution result |
| `agent_version` | string | Resolved agent version (semver) that was executed. Always present, whether pinned or resolved-to-latest. |
| `output` | object | Agent output fields (as defined in agent.yaml) |
| `usage.prompt_tokens` | number | Tokens sent to the LLM |
| `usage.completion_tokens` | number | Tokens received from the LLM |
| `usage.total_tokens` | number | Total tokens |
| `warnings` | string[] | Warnings (only present if non-empty). E.g., `["agent_not_verified_scripts_disabled"]` |
| `cost.estimated` | number | Estimated cost in USD |
| `duration_ms` | number | Total execution time in milliseconds |
| `error` | string | Error message (only when `status` is `"failed"`) |

**Version-related errors**

| Status | Code | When |
|--------|------|------|
| `400` | `INVALID_VERSION_FORMAT` | `version` is not strict semver (e.g. `"1.0"`, `"^1.0.0"`, `"latest"`, `""`) |
| `404` | `VERSION_NOT_FOUND` | Pinned version does not exist. Response body includes `available: string[]` — up to 10 most recent versions (newest first) for quick recovery |

Example 404:
```json
{
  "error": {
    "code": "VERSION_NOT_FOUND",
    "message": "Version 9.9.9 not found for acme/seo-audit",
    "available": ["1.2.0", "1.1.0", "1.0.0"]
  }
}
```

**Rate limit**: 60 requests per minute per IP.

---

### SSE Streaming

Send `Accept: text/event-stream` to receive real-time events during agent execution.

```bash
curl -N -X POST http://localhost:4000/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input": {"query": "hello"}}'
```

**Event types**

| Event | Description | Data fields |
|-------|-------------|-------------|
| `run_start` | Agent execution started | `run_id`, `agent`, `agent_version`, `timestamp` |
| `tool_call` | Agent is calling a tool | `run_id`, `tool`, `args`, `timestamp` |
| `tool_result` | Tool returned a result | `run_id`, `tool`, `result`, `is_error`, `timestamp` |
| `llm_complete` | LLM finished generating | `run_id`, `provider`, `model`, `tokens`, `timestamp` |
| `run_complete` | Execution finished successfully | `run_id`, `output`, `usage`, `cost`, `duration_ms`, `timestamp` |
| `run_error` | Execution failed | `run_id`, `error.code`, `error.message`, `timestamp` |

Events follow the W3C SSE spec (`event: <type>\ndata: <json>\n\n`). The stream closes after `run_complete` or `run_error`.

Validation errors (401, 400, etc.) return normal JSON responses, not SSE streams.

---

### Async Webhook

Send `webhook_url` in the request body to trigger async execution.

```bash
curl -X POST http://localhost:4000/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hello"}, "webhook_url": "https://your-app.com/callback"}'
```

**Response** `202 Accepted`

```json
{
  "run_id": "uuid",
  "agent_version": "1.2.0"
}
```

The server executes the agent in the background and POSTs the full result to `webhook_url` when done.

**Webhook delivery**

- Method: `POST`
- Content-Type: `application/json`
- Body: same format as the sync response (includes `agent_version`, `run_id`, `status`, `output`, `usage`, `cost`, `duration_ms`)
- Header `X-Skrun-Signature`: `sha256=<hmac>` — HMAC-SHA256 of the body using the server's signing key
- Retries: up to 3 times with exponential backoff (1s, 4s, 16s) on non-2xx responses

**Requirements**

- `webhook_url` must be a valid URL
- `webhook_url` must use HTTPS in production (HTTP allowed in dev mode)
- Cannot be combined with `Accept: text/event-stream`

---

### Caller-provided API keys

By default, POST /run uses the server's LLM API keys (from `.env`). Callers can provide their own keys via the `X-LLM-API-Key` header:

```
X-LLM-API-Key: {"google": "AIza...", "anthropic": "sk-ant-..."}
```

The value is a JSON object mapping provider names to API keys.

**Accepted providers**: `anthropic`, `openai`, `google`, `mistral`, `groq`

**Key priority** (per provider):
1. Caller key (from header) — takes precedence
2. Server key (from `.env`) — fallback
3. Neither available — `401` error

If a caller-provided key fails (invalid, quota exceeded), the error is returned directly. There is no fallback to server keys when a caller key was explicitly provided.

**Security**: caller keys are never logged, persisted, or returned in responses. Use HTTPS in production.

**Example**

```bash
curl -X POST http://localhost:4000/api/agents/dev/code-review/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H 'X-LLM-API-Key: {"google": "AIza..."}' \
  -d '{"input": {"code": "function add(a,b) { return a + b; }"}}'
```

---

### Push an agent

```
POST /api/agents/:namespace/:name/push?version=1.0.0
```

Upload an agent bundle to the registry.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/octet-stream` |
| `X-Skrun-Version-Notes` | No | Optional note attached to this version. Percent-encoded UTF-8, max 500 characters, plain text only. Used to describe what changed (like a commit message). The CLI `-m` / `--message` flag sets this header. |

**Body**: raw `.agent` bundle (tar.gz created by `skrun build`).

**Query params**

| Param | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Semver version string (e.g., `1.0.0`) |

**Response** `200`

```json
{
  "name": "my-agent",
  "namespace": "dev",
  "latest_version": "1.0.0"
}
```

**Response headers**

| Header | When |
|--------|------|
| `X-Skrun-Warning: notes-unsupported` | Set only if the client sent `X-Skrun-Version-Notes` but the server version doesn't support it. The push still succeeds but the note is not stored. |

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `MISSING_VERSION` | `version` query param is missing |
| `400` | `INVALID_NOTES` | `X-Skrun-Version-Notes` is > 500 chars, contains null bytes, or is malformed percent-encoding |
| `403` | `FORBIDDEN` | Pushing outside your namespace |
| `409` | `VERSION_EXISTS` | Same version already pushed (bump `version` in `agent.yaml`) |

**Rate limit**: 10 requests per minute per IP.

**Note**: you can only push to your own namespace. `dev-token` grants access to the `dev` namespace.

---

### Pull an agent

```
GET /api/agents/:namespace/:name/pull
GET /api/agents/:namespace/:name/pull/:version
```

Download an agent bundle. Without `:version`, returns the latest version.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response**: binary `.agent` bundle with headers:
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="name-version.agent"`
- `X-Agent-Version: 1.0.0`

---

### List agents

```
GET /api/agents?page=1&limit=20
```

List all agents in the registry. Public, no auth required.

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `20` | Results per page |

**Response** `200`

```json
{
  "agents": [...],
  "total": 12,
  "page": 1,
  "limit": 20
}
```

---

### Agent metadata

```
GET /api/agents/:namespace/:name
```

Get metadata for a specific agent. Public, no auth required.

**Response** `200`

```json
{
  "name": "code-review",
  "namespace": "dev",
  "verified": false,
  "latest_version": "1.0.0",
  "created_at": "2026-04-11T...",
  "updated_at": "2026-04-11T..."
}
```

---

### Verify an agent

```
PATCH /api/agents/:namespace/:name/verify
```

Set or unset the `verified` flag on an agent. Only verified agents can execute scripts from `scripts/`. Operator action — requires authentication.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |

**Request body**

```json
{ "verified": true }
```

**Response** `200`: returns the updated agent metadata (same format as GET metadata, with `verified` updated).

**Errors**: `401` if no auth, `404` if agent not found, `400` if body is invalid.

**Note**: in dev mode (`dev-token`), verification is bypassed — all agents can execute scripts without being verified. This ensures zero friction for local development.

---

### Delete an agent

```
DELETE /api/agents/:namespace/:name
```

Permanently delete an agent along with all its versions. Requires authentication and namespace ownership (only the owner can delete).

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{ "success": true }
```

**Errors**: `401` if no auth, `403` if not namespace owner, `404` if agent not found.

Note: past runs for the deleted agent remain in the database with `agent_id: null` (soft reference via `ON DELETE SET NULL`).

---

### Agent versions

```
GET /api/agents/:namespace/:name/versions
```

List all published versions of an agent with full metadata. Public, no auth required.

**Response** `200`

```json
{
  "versions": [
    {
      "version": "1.0.0",
      "size": 4523,
      "pushed_at": "2026-04-20T10:00:00Z",
      "notes": "Initial release — Claude primary with GPT-4 fallback",
      "config_snapshot": {
        "model": {
          "provider": "anthropic",
          "name": "claude-sonnet-4-20250514",
          "fallback": { "provider": "openai", "name": "gpt-4o" }
        },
        "tools": [{ "name": "search", "description": "Search the web" }],
        "mcp_servers": [],
        "inputs": [{ "name": "query", "type": "string", "description": "Search query" }],
        "environment": { "timeout": "120s" }
      }
    },
    {
      "version": "1.1.0",
      "size": 4600,
      "pushed_at": "2026-04-22T11:30:00Z",
      "notes": null,
      "config_snapshot": { "...": "..." }
    }
  ]
}
```

**Response fields** (per version object):

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Semver version string |
| `size` | number | Bundle size in bytes |
| `pushed_at` | string (ISO 8601) | When this version was pushed |
| `notes` | string \| null | Optional note attached at push time via `-m` / `--message` (≤ 500 chars, plain text). `null` if not provided. |
| `config_snapshot` | object | Parsed `agent.yaml` from the bundle at push time (model, tools, mcp_servers, inputs, environment, etc.). Used by the dashboard to display metadata and generate playground forms. |

The `config_snapshot` is populated at push time by parsing the `agent.yaml` from the uploaded bundle. It includes model configuration (with fallback), tools, MCP servers, inputs schema, and environment settings.

---

### Dashboard stats

```
GET /api/stats
```

Returns aggregated metrics for the dashboard home page.

**Response** `200`
```json
{
  "agents_count": 3,
  "runs_today": 12,
  "tokens_today": 45200,
  "failed_today": 1,
  "runs_yesterday": 10,
  "tokens_yesterday": 38000,
  "failed_yesterday": 0,
  "daily_runs": [5, 8, 10, 12, 9, 10, 12],
  "daily_tokens": [20000, 32000, 38000, 45200, 35000, 38000, 45200],
  "daily_failed": [0, 1, 0, 0, 1, 0, 1]
}
```

- `runs_yesterday` / `tokens_yesterday` / `failed_yesterday`: previous UTC day totals (for delta computation).
- `failed_today` / `failed_yesterday`: failed run counts for today and yesterday.
- `daily_runs` / `daily_tokens` / `daily_failed`: 7-element arrays (oldest first, index 6 = today). Zero-padded if fewer than 7 days of data.
- "Today" = current UTC day (00:00 to now).

---

### Agent stats

```
GET /api/agents/:namespace/:name/stats?days=N
```

Returns aggregated metrics for a specific agent over the requested period.

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `days` | `7` | Number of days to aggregate (1-30) |

**Response** `200`
```json
{
  "runs": 42,
  "tokens": 84000,
  "failed": 2,
  "avg_duration_ms": 1200,
  "prev_runs": 38,
  "prev_tokens": 72000,
  "prev_failed": 1,
  "prev_avg_duration_ms": 1350,
  "daily_runs": [4, 6, 8, 5, 7, 6, 6],
  "daily_tokens": [8000, 12000, 16000, 10000, 14000, 12000, 12000],
  "daily_failed": [0, 1, 0, 0, 1, 0, 0],
  "daily_avg_duration_ms": [1100, 1300, 1200, 1150, 1250, 1200, 1200]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `runs` | number | Total runs in the requested period |
| `tokens` | number | Total tokens consumed in the period |
| `failed` | number | Failed runs in the period |
| `avg_duration_ms` | number | Average run duration in milliseconds |
| `prev_runs` | number | Total runs in the previous equivalent period (for delta computation) |
| `prev_tokens` | number | Total tokens in the previous period |
| `prev_failed` | number | Failed runs in the previous period |
| `prev_avg_duration_ms` | number | Average duration in the previous period |
| `daily_runs` | number[] | Runs per day (oldest first, last element = today). Zero-padded if fewer days of data. |
| `daily_tokens` | number[] | Tokens per day (same ordering) |
| `daily_failed` | number[] | Failed runs per day (same ordering) |
| `daily_avg_duration_ms` | number[] | Average duration per day (same ordering) |

---

### List runs

```
GET /api/runs
```

Returns recent runs, sorted by most recent first.

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | — | Filter by agent ID |
| `status` | string | — | Filter by status: `running`, `completed`, `failed`, `cancelled` |
| `limit` | number | 50 | Max results (capped at 100) |

**Response** `200` — array of run objects.

---

### Get run detail

```
GET /api/runs/:id
```

Returns a single run by ID with all fields.

**Response** `200`
```json
{
  "id": "run-abc-123",
  "agent_id": "...",
  "agent_version": "dev/my-agent@1.0.0",
  "status": "completed",
  "model": "anthropic/claude-sonnet-4-20250514",
  "input": { "topic": "AI" },
  "output": { "result": "..." },
  "error": null,
  "usage_prompt_tokens": 200,
  "usage_completion_tokens": 300,
  "usage_total_tokens": 500,
  "usage_estimated_cost": 0.0025,
  "duration_ms": 1500,
  "created_at": "2026-04-21T10:00:00Z",
  "completed_at": "2026-04-21T10:00:01Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | string \| null | LLM model used for this run, formatted as `"provider/model-name"` (e.g., `"anthropic/claude-sonnet-4-20250514"`). Populated at POST /run time. `null` if not applicable. |

**Response** `404` — run not found.

---

### Scan agent directory

```
GET /api/agents/scan
```

Lists agent directories found in the path configured by `SKRUN_AGENTS_DIR` env var.

**Response** `200`
```json
{
  "configured": true,
  "agents": [
    { "name": "email-drafter", "path": "/path/to/agents/email-drafter", "registered": false },
    { "name": "code-review", "path": "/path/to/agents/code-review", "registered": true }
  ]
}
```

If `SKRUN_AGENTS_DIR` is not set: `{ "configured": false, "agents": [] }`.

---

### Push scanned agent

```
POST /api/agents/scan/:name/push
```

Reads agent files from the scanned directory and registers the agent under the authenticated user's namespace. Version is read from `agent.yaml`.

**Response** `200` — agent metadata (same format as push).

---

## Error format

All errors follow the same format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

### Error codes

| Code | HTTP | Description |
|------|------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid Authorization header |
| `FORBIDDEN` | 403 | No permission (wrong namespace) |
| `INVALID_REQUEST` | 400 | Invalid JSON body |
| `MISSING_INPUT` | 400 | Required input field missing |
| `INVALID_INPUT_TYPE` | 400 | Input field has wrong type |
| `INVALID_LLM_KEY_HEADER` | 400 | Malformed X-LLM-API-Key header |
| `SSE_WEBHOOK_CONFLICT` | 400 | Both SSE and webhook requested in the same call |
| `INVALID_WEBHOOK_URL` | 400 | webhook_url is not a valid URL or not HTTPS |
| `MISSING_VERSION` | 400 | Version query param missing on push |
| `NOT_FOUND` | 404 | Agent not found in registry |
| `CONFLICT` | 409 | Version already exists |
| `RATE_LIMITED` | 429 | Too many requests |
| `BUNDLE_CORRUPT` | 500 | Failed to extract agent bundle |
| `MISSING_CONFIG` | 500 | agent.yaml not found in bundle |
| `INVALID_CONFIG` | 500 | agent.yaml is invalid |
| `INVALID_NOTES` | 400 | Version notes header is invalid (>500 chars, contains null bytes, or malformed percent-encoding) |
| `EXECUTION_FAILED` | 502 | Agent execution failed |
| `TIMEOUT` | 504 | Agent execution timed out |

### Warning codes

Warnings appear in the `warnings` array of POST /run responses (not errors — the run still executes).

| Code | Description |
|------|-------------|
| `agent_not_verified_scripts_disabled` | Agent has `scripts/` but is not verified — scripts were skipped. Agent ran with LLM + MCP only. |

### Response warning headers

Some endpoints may emit informational warning headers to signal non-fatal issues:

| Header | When |
|--------|------|
| `X-Skrun-Warning: notes-unsupported` | The client sent `X-Skrun-Version-Notes` but the server doesn't support the feature (version skew). The push still succeeds but the note is not stored. Upgrade the registry to use `-m`. |

## Database configuration

Skrun uses a pluggable database backend via the `DbAdapter` interface. Three implementations ship:

**Local dev (default)**: no configuration needed. Skrun uses SQLite (`SqliteDb`) — a file-based database (`skrun.db` in the working directory) that persists agents, runs, API keys, and users across restarts. Zero external dependencies.

**Production (Supabase)**: set `DATABASE_URL` + `SUPABASE_KEY` env vars. Skrun auto-detects and uses `SupabaseDb` (PostgreSQL).

**Tests**: `MemoryDb` — in-memory, fast, isolated (used by the unit test suite, not in production paths).

```bash
# Default — SQLite (file-based, persistent)
pnpm dev:registry

# Production — Supabase
DATABASE_URL=https://your-project.supabase.co SUPABASE_KEY=your-service-key pnpm dev:registry
```

**Selection logic**: if `DATABASE_URL` is set, Skrun uses `SupabaseDb`. Otherwise, it uses `SqliteDb`.

**SQL schema (Supabase)**: migration files live in `packages/api/src/db/migrations/`. Run them in order against your Supabase project via the SQL editor or CLI:

- `001_initial_schema.sql` — initial schema (7 tables: users, api_keys, agents, agent_versions, agent_state, environments, runs). Fresh installs: run this only.
- `002_add_model_to_runs.sql` — backfills the `runs.model` column added in v0.5.0. Run if upgrading from pre-v0.5.0.
- `003_add_version_notes.sql` — backfills `agent_versions.notes` added in v0.6.0. Run if upgrading from pre-v0.6.0.

**SQLite migrations**: handled automatically at startup — the `SqliteDb` constructor detects missing columns via `PRAGMA table_info` and runs idempotent `ALTER TABLE` statements. Nothing to do manually.

**Run tracking**: every `POST /run` call creates a record in the `runs` table with agent, version, model, status, input/output, token usage, cost, duration, and files. This data powers the dashboard and is available for your own billing or observability pipeline.

| Env var | Default | Description |
|---------|---------|-------------|
| `DATABASE_URL` | — | Supabase project URL. If not set, SQLite is used. |
| `SUPABASE_KEY` | — | Supabase service role key (for server-side access). Required when `DATABASE_URL` is set. |

---

## Structured logging

Skrun emits **structured JSON logs to stdout** via [pino](https://getpino.io). Every log line is a valid JSON object that can be piped directly to Axiom, Datadog, Grafana Loki, ELK, CloudWatch Logs, or any log backend that accepts JSON.

**Example log line** (formatted for readability):

```json
{
  "level": 30,
  "time": 1713225600000,
  "name": "skrun:api",
  "run_id": "a1b2c3d4-...",
  "agent": "dev/code-review",
  "agent_version": "1.2.0",
  "event": "run_complete",
  "msg": "Agent run completed",
  "durationMs": 3200,
  "cost": 0.00025
}
```

**`LOG_LEVEL` env var** controls verbosity (default: `info`):

| Level | What it shows |
|-------|---------------|
| `debug` | Everything — verbose internal state |
| `info` | Run lifecycle, tool calls, LLM calls (default) |
| `warn` | Fallback triggers, cost exceeded, parse failures |
| `error` | Execution failures, webhook exhaustion |

```bash
# Suppress info logs in production (only warn + error)
LOG_LEVEL=warn pnpm dev:registry

# Pipe to a log backend
pnpm dev:registry | npx pino-pretty   # human-readable dev output
pnpm dev:registry > /var/log/skrun.jsonl   # file for ingestion
```

**Run context**: every log entry emitted during a `POST /run` includes `run_id`, `agent`, and `agent_version` automatically (via pino child logger bindings).

### Caching

Repeated POST /run calls for the same agent+version reuse cached bundle extractions and MCP connections. Both caches are in-memory with TTL eviction.

| Env var | Default | Description |
|---------|---------|-------------|
| `BUNDLE_CACHE_TTL` | `600` (10 min) | Bundle extraction cache TTL in seconds |
| `BUNDLE_CACHE_MAX` | `50` | Max cached bundle extractions |
| `MCP_CACHE_TTL` | `600` (10 min) | MCP connection cache TTL in seconds |
| `MCP_CACHE_MAX` | `20` | Max cached MCP connections |

MCP connections automatically reconnect on error (retry once). Cached entries are cleaned up on eviction (temp dirs removed, MCP connections closed).

---

## Files API

Agents produce files by writing to the `$SKRUN_OUTPUT_DIR` directory during execution (available to tool scripts and MCP stdio processes). After the run, produced files appear in the response `files` array and are downloadable via a dedicated endpoint.

**Response format** (sync, SSE `run_complete`, webhook callback):
```json
{
  "files": [
    { "name": "report.pdf", "size": 524288, "url": "/api/runs/<run_id>/files/report.pdf" }
  ]
}
```

**Download**: `GET /api/runs/:run_id/files/:filename` — returns the file with correct Content-Type and Content-Disposition header. Returns 404 if the run or file doesn't exist, or if the retention period has expired.

| Env var | Default | Description |
|---------|---------|-------------|
| `FILES_MAX_SIZE_MB` | `10` | Max file size in MB (larger files excluded) |
| `FILES_MAX_COUNT` | `20` | Max files per run |
| `FILES_RETENTION_S` | `3600` (1 hour) | How long files are available for download |

Agents without file output get `files: []` in the response (backward compatible).

---

## Rate limiting

Rate limits are per IP address. Response headers indicate current status:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests in the current window |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

| Endpoint | Limit |
|----------|-------|
| `POST /api/agents/:ns/:name/run` | 60/min |
| `POST /api/agents/:ns/:name/push` | 10/min |
