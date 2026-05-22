# API Reference

Base URL: `http://localhost:4000` (local dev) or your deployed instance.

> **Interactive docs**: visit `GET /docs` on your running server for a live API explorer (Scalar UI).
> **OpenAPI schema**: `GET /openapi.json` — import into Postman, Insomnia, or use for SDK generation.
> **Prefer the SDK?** Use `@skrun-dev/sdk` for a typed client instead of raw HTTP calls: `npm install @skrun-dev/sdk`

## Breaking changes in v0.8.0

v0.8.0 tightened five surfaces that previously had insecure defaults or missing checks. **Self-host operators upgrading from v0.7.x must update their environment + workflows accordingly.** All changes are documented in detail at the referenced sections below.

| # | Change | Action required | Section |
|---|---|---|---|
| 1 | `WEBHOOK_SIGNING_KEY` env required for webhook delivery | Generate via `openssl rand -hex 32` and set in env | [Run an agent — async webhook mode](#run-an-agent) |
| 2 | `CORS_ORIGIN` env required in production | Set to your dashboard / client origin | (API boot — fails fast at startup without it) |
| 3 | Verification is now **per version** + admin-only. Legacy `PATCH /api/agents/:ns/:name/verify` is **removed**. Use the new `PATCH /api/agents/:ns/:name/versions/:version/verify`. `POST /run` returns `403 AGENT_NOT_VERIFIED` for unverified versions. | Promote first admin via SQL: `UPDATE users SET role='admin' WHERE username='you'`, then verify each pushed version | [Verify a version](#verify-a-version-admin-only) |
| 4 | File-content endpoints require authentication + ownership | Send `Authorization` header on `GET /api/files/:id`, `GET /api/files/:id/content`, `GET /api/runs/:run_id/files/:filename` | [GET /api/files/:id](#get-apifilesid--file-metadata) |
| 5 | All pre-existing `verified=true` agents reset to `verified=false` (migration 007) + agent-level `verified` column dropped (migration 009 — moved to `agent_versions.verified`) | Re-verify each version of trusted agents after upgrade (admin only) | (one-time migrations 007 + 009) |

See `CHANGELOG.md` for the full per-change detail.

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
| Namespace (assigned by registry) | `dev` | Your GitHub username (e.g., `alice`) |
| Registry URL form | `dev/my-agent` | `alice/my-agent` |
| `agent.yaml` `name` | `my-agent` | `my-agent` |

The `agent.yaml` is identical across environments — the slug-only `name` field travels with the bundle, and the registry assigns the namespace at push time based on your auth context. You don't edit `agent.yaml` when switching from `dev-token` to OAuth; just `skrun build && skrun push` and the right namespace is used.

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
| `input` | Yes | Input fields matching the agent's `agent.yaml`. For `file`-typed inputs, pass an array of source descriptors — see [Uploading input files](#uploading-input-files). |
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
    "total_tokens": 650,
    "cache_read_tokens": 2048,
    "cache_write_tokens": 1024
  },
  "cost": {
    "estimated": 0.00025,
    "saved": 0.00185
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
| `usage.prompt_tokens` | number | Tokens billed at the FULL input rate (cached portion already excluded — see `cache_read_tokens` below) |
| `usage.completion_tokens` | number | Tokens received from the LLM |
| `usage.total_tokens` | number | Sum of `prompt_tokens + completion_tokens` (excludes cached portion — preserves the legacy pre-caching semantic) |
| `usage.cache_read_tokens` | number? | Optional. Tokens served from the provider's prompt cache. Billed at the cached-read rate (typically 0.10× input on Anthropic / GPT-5.x / Gemini 2.5+, 0.5× on Groq gpt-oss / OpenAI gpt-4o legacy). Only present when the provider returned cache activity. |
| `usage.cache_write_tokens` | number? | Optional. Tokens written to the provider's prompt cache. Anthropic only — other providers do not expose a separate cache write surcharge. Billed at the cached-write rate (1.25× input at 5min TTL). |
| `warnings` | string[] | Warnings (only present if non-empty). Reserved for future advisory signals — no specific code is currently emitted. |
| `cost.estimated` | number | Estimated cost in USD. Applies the per-model cached-read rate to `cache_read_tokens` and cached-write rate to `cache_write_tokens` so the value matches what the provider invoice will show within ±5%. |
| `cost.saved` | number? | Optional. Dollar savings (USD) produced by prompt-caching on this run, computed as `cache_read_tokens × (full_input_rate - cached_rate) / 1_000_000`. Surfaced only when > 0 (omitted when no cache activity, model has no caching, or savings round to 0). Aligned with NUMERIC(10,6) DB precision (6 decimals). Same value persisted in the `runs.usage_cache_savings_usd` column. |
| `duration_ms` | number | Total execution time in milliseconds |
| `error` | string | Error message (only when `status` is `"failed"`) |

**Version-related errors**

| Status | Code | When |
|--------|------|------|
| `400` | `INVALID_VERSION_FORMAT` | `version` is not strict semver (e.g. `"1.0"`, `"^1.0.0"`, `"latest"`, `""`) |
| `403` | `AGENT_NOT_VERIFIED` | The resolved version (pinned or latest) is not verified by an admin. Returned before any LLM call, MCP connection, file allocation, or DB write happens. The message includes the resolved version so the caller can either pin a verified version or ask an admin to verify the current one. Catch typed via `SkrunNotVerifiedError` in the SDK. |
| `404` | `VERSION_NOT_FOUND` | Pinned version does not exist. Response body includes `available: string[]` — up to 10 most recent versions (newest first) for quick recovery |

Example 403:
```json
{
  "error": {
    "code": "AGENT_NOT_VERIFIED",
    "message": "Agent acme/seo-audit version 1.2.0 must be verified by an admin before it can run."
  }
}
```

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
| `tool_call_error` | A tool returned an error result (informational — see note below) | `run_id`, `tool`, `message`, `code?`, `timestamp` |
| `tool_result` | Tool returned a result | `run_id`, `tool`, `result`, `is_error`, `timestamp` |
| `llm_complete` | LLM finished generating | `run_id`, `provider`, `model`, `tokens`, `timestamp` |
| `output_validation_warning` | Final output failed schema validation — repair retry follows (see note below) | `run_id`, `errors`, `timestamp` |
| `run_complete` | Execution finished successfully | `run_id`, `output`, `usage`, `cost`, `duration_ms`, `timestamp` |
| `run_error` | Execution failed | `run_id`, `error.code`, `error.message`, `timestamp` |

Events follow the W3C SSE spec (`event: <type>\ndata: <json>\n\n`). The stream closes after `run_complete` or `run_error`.

**About `tool_call_error`** (added in v0.8.0): emitted **before** the matching `tool_result` whenever a tool returns `is_error: true`. It is **informational only** — the `tool_result` content still flows back to the LLM, which decides how to react (retry, fallback, graceful failure). Skrun does NOT abort the run on tool failure by default, aligning with the industry permissive contract (AWS Bedrock AgentCore, Claude Managed Agents, Google Vertex Agent Builder all behave the same way). Operators get failure visibility (e.g. red event in the dashboard timeline) without losing the LLM's recovery capability.

**About `output_validation_warning` and `OUTPUT_SCHEMA_INVALID`** (added in v0.8.0): emitted when the LLM's final JSON output fails validation against the agent's declared `outputs` schema (declared top-level fields missing or of the wrong type). Skrun then issues a single isolated repair call to the LLM, asking it to re-emit a compliant output. The retry's token usage is summed into the final `usage` regardless of outcome. If the repair succeeds, the run terminates normally via `run_complete` with the corrected output. If the repair still fails (schema mismatch or non-JSON response), the run terminates via `run_error` with `error.code: OUTPUT_SCHEMA_INVALID` — same terminus pattern as `TIMEOUT`/`EXECUTION_FAILED`, no `run_complete` is emitted.

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

**Server requirement: `WEBHOOK_SIGNING_KEY`** (added in v0.8.0)

The server signs every delivery with `WEBHOOK_SIGNING_KEY`. If the env var is unset, the runtime **refuses to deliver** the webhook (no insecure default). Generate one and set it before enabling webhook mode:

```bash
# Generate a 32-byte random hex key
echo "WEBHOOK_SIGNING_KEY=$(openssl rand -hex 32)" >> .env
```

The receiver verifies the signature by computing `HMAC-SHA256(body, WEBHOOK_SIGNING_KEY)` and comparing to the `sha256=...` portion of the `X-Skrun-Signature` header.

**Requirements**

- `webhook_url` must be a valid URL
- `webhook_url` must use HTTPS in production (HTTP allowed in dev mode)
- `webhook_url` hostname must NOT resolve to a private/reserved address in production (blocks AWS IMDS, localhost services, link-local, IPv4-mapped IPv6); dev mode allows `http://localhost:NNNN/...` for local testing
- Cannot be combined with `Accept: text/event-stream`
- Server requires `WEBHOOK_SIGNING_KEY` env var (see above)

---

### Caller-provided API keys

By default, POST /run uses the server's LLM API keys (from `.env`). Callers can provide their own keys via the `X-LLM-API-Key` header:

```
X-LLM-API-Key: {"google": "AIza...", "anthropic": "sk-ant-..."}
```

The value is a JSON object mapping provider names to API keys.

**Accepted providers**: `anthropic`, `openai`, `google`, `mistral`, `groq`, `xai`

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

**Multi-tenancy**: a caller without access to the agent (non-owner non-admin) receives a `404 NOT_FOUND` indistinguishable from "agent does not exist" — the response body and headers are identical to a genuine not-found. No bundle bytes leak, no `Content-Disposition` header on the 404. Admins (and dev-token in self-host) bypass this filter.

**Response** `200`: binary `.agent` bundle with headers:
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="name-version.agent"`
- `X-Agent-Version: 1.0.0`

**Response** `401`: anonymous caller. Body `{ "error": { "code": "UNAUTHORIZED", ... } }`.

**Response** `404`: agent does not exist OR caller is not the owner / admin (opaque).

---

### List agents

```
GET /api/agents?page=1&limit=20
```

List agents. **Authentication required.** Returns the caller's own agents (filtered by `owner_id`) when `user.role === 'user'`; returns all agents instance-wide when `user.role === 'admin'`. In self-host with dev-token mode, the caller is auto-granted admin and sees all agents — same UX as before the multi-tenant filter shipped.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

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

The `total` field reflects the **filtered** count (not the global agent count). A user who owns no agents receives `{ "agents": [], "total": 0 }` — no error.

**Response** `401`: anonymous caller.

---

### Agent metadata

```
GET /api/agents/:namespace/:name
```

Get metadata for a specific agent. **Authentication required.** Non-owner non-admin callers receive `404 NOT_FOUND` indistinguishable from agent-not-found — existence is hidden from non-privileged readers (GitHub Private Repo / Stripe / Linear pattern).

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{
  "name": "code-review",
  "namespace": "dev",
  "latest_version_verified": false,
  "latest_version": "1.0.0",
  "created_at": "2026-04-11T...",
  "updated_at": "2026-04-11T..."
}
```

`latest_version_verified` mirrors the `verified` flag of the most recently pushed version. It's the signal that drives the dashboard listing badge. Older versions may have a different state — fetch `GET /versions` (below) to see the per-version flag.

**Response** `401`: anonymous caller.

**Response** `404`: agent does not exist OR caller is not the owner / admin (opaque body — identical in both cases).

---

### Verify a version (admin only)

```
PATCH /api/agents/:namespace/:name/versions/:version/verify
```

Set or unset the `verified` flag on a **specific version** of an agent. Only verified versions can be invoked via `POST /run` — unverified runs return `403 AGENT_NOT_VERIFIED`.

**Restricted to admin callers** (`user.role === 'admin'`). The previous self-served behaviour — any namespace owner could verify their own agents — was closed in v0.8.0; the trust signal was not meaningful when the agent author was the one minting it.

**Per-version, not per-agent**: pushing a new version creates a row at `verified=false` without touching prior versions. A caller pinning `version: "1.0.0"` keeps running even after a newer v1.1.0 push (until the v1.0.0 row is explicitly unverified). This protects pinned production callers from author iteration.

Promotion to admin is a manual SQL update — there is no HTTP endpoint for role elevation by design.

```bash
# Promote a user to admin on self-host
sqlite3 skrun.db "UPDATE users SET role='admin' WHERE username='you'"

# Or on Postgres
psql $DATABASE_URL -c "UPDATE users SET role='admin' WHERE username='you';"
```

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |

**Request body**

```json
{ "verified": true }
```

**Response** `200`: returns the updated version row.

```json
{
  "version": "1.0.0",
  "size": 12345,
  "pushed_at": "2026-04-11T...",
  "notes": null,
  "verified": true
}
```

**Errors**: `401` if no auth, `403` if caller is not admin, `404` if agent or version not found, `400` if body is invalid.

**Note**: in dev mode (`dev-token`, used when OAuth is not configured), the caller is granted admin role unconditionally so `PATCH .../verify` works without any extra setup — this preserves zero-friction local development.

**Structured log**: every successful flip emits a pino `info` line (`event: "agent_version_verify"`) with the actor identity, target version, and action — see [Admin role](self-hosting.md#admin-role) in the self-hosting guide.

**Legacy endpoint removed**: the agent-level `PATCH /api/agents/:ns/:name/verify` (v0.7.x) is gone — calls now return `404`. Migrate to the per-version path above.

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

### Delete a single version

```
DELETE /api/agents/:namespace/:name/versions/:version
```

Permanently delete one version of an agent. Use this when a single push went bad (broken bundle, wrong content) and you don't want to remove the whole agent. Requires authentication and namespace ownership. Cannot delete the last remaining version — use [`DELETE /api/agents/:namespace/:name`](#delete-an-agent) for full removal.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `204` (no body)

**Errors**:
- `401` if no auth
- `403` if not namespace owner
- `404 NOT_FOUND` if the agent does not exist
- `404 VERSION_NOT_FOUND` if the agent exists but the version does not
- `409 LAST_VERSION` if deletion would leave the agent with zero versions

**Example**

```bash
curl -X DELETE \
  -H "Authorization: Bearer dev-token" \
  http://localhost:4000/api/agents/dev/email-drafter/versions/1.0.5
# → HTTP/1.1 204 No Content
```

Note: past runs referencing the deleted version remain readable. `runs.agent_version` is stored as plain text (not a foreign key), so historical run records keep their version reference even after the version row is gone. The agent's `latest_version` field automatically reflects the new latest after deletion.

---

### Agent versions

```
GET /api/agents/:namespace/:name/versions
```

List all published versions of an agent with full metadata. **Authentication required.** Same multi-tenancy gate as the metadata endpoint — non-owner non-admin callers receive `404 NOT_FOUND` with no `versions` array leaked in the body.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{
  "versions": [
    {
      "version": "1.0.0",
      "size": 4523,
      "pushed_at": "2026-04-20T10:00:00Z",
      "notes": "Initial release — Claude primary with GPT-4 fallback",
      "verified": true,
      "config_snapshot": {
        "model": {
          "provider": "anthropic",
          "name": "claude-sonnet-4-6",
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
  "daily_failed": [0, 1, 0, 0, 1, 0, 1],
  "cache_savings_today": 0.42,
  "cache_savings_yesterday": 0.31,
  "daily_cache_savings": [0.05, 0.18, 0.22, 0.31, 0.27, 0.33, 0.42]
}
```

- `runs_yesterday` / `tokens_yesterday` / `failed_yesterday`: previous UTC day totals (for delta computation).
- `failed_today` / `failed_yesterday`: failed run counts for today and yesterday.
- `daily_runs` / `daily_tokens` / `daily_failed`: 7-element arrays (oldest first, index 6 = today). Zero-padded if fewer than 7 days of data.
- `cache_savings_today` / `cache_savings_yesterday` / `daily_cache_savings`: dollar savings (USD, fractional) produced by prompt-caching. Same 7-element array layout for `daily_cache_savings`. Snapshot at run completion via `cache_read_tokens × (full_input_rate - cached_rate)`.
- **Multi-tenancy**: aggregates filter by the authenticated user. Single-tenant self-host (dev-token mode) gets effectively instance-wide stats; cloud / shared deployments isolate per-user.
- "Today" = current UTC day (00:00 to now).

---

### Agent stats

```
GET /api/agents/:namespace/:name/stats?days=N
```

Returns aggregated metrics for a specific agent over the requested period. **Authentication required.** Same multi-tenancy gate as the metadata + versions endpoints — non-owner non-admin callers receive `404 NOT_FOUND` indistinguishable from agent-not-found, with no `runs` / `tokens` / `cost` fields leaked.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

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
  "daily_avg_duration_ms": [1100, 1300, 1200, 1150, 1250, 1200, 1200],
  "cache_savings": 1.42,
  "prev_cache_savings": 0.95,
  "daily_cache_savings": [0.10, 0.15, 0.22, 0.18, 0.25, 0.20, 0.32]
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
| `cache_savings` | number | Total dollar savings (USD) produced by prompt-caching for this agent in the current period. |
| `prev_cache_savings` | number | Cache savings in the previous equivalent period. |
| `daily_cache_savings` | number[] | Daily savings array (USD). Length matches the `days` query param (default 7). |

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
  "model": "anthropic/claude-sonnet-4-6",
  "input": { "topic": "AI" },
  "output": { "result": "..." },
  "error": null,
  "usage_prompt_tokens": 200,
  "usage_completion_tokens": 300,
  "usage_total_tokens": 500,
  "usage_estimated_cost": 0.0025,
  "usage_cache_read_tokens": 7143,
  "usage_cache_write_tokens": 0,
  "usage_cache_savings_usd": 0.001928,
  "duration_ms": 1500,
  "created_at": "2026-04-21T10:00:00Z",
  "completed_at": "2026-04-21T10:00:01Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | string \| null | LLM model used for this run, formatted as `"provider/model-name"` (e.g., `"anthropic/claude-sonnet-4-6"`). Populated at POST /run time. `null` if not applicable. |
| `usage_cache_read_tokens` | number | Tokens served from the provider's prompt cache. 0 when no cache activity. Persisted at run completion. |
| `usage_cache_write_tokens` | number | Tokens written to the provider's prompt cache (Anthropic only). 0 for non-Anthropic models or runs without cache activity. |
| `usage_cache_savings_usd` | number | Dollar savings (USD) produced by prompt-caching, snapshot at write time using the model's per-token rates from `cost.ts`. NUMERIC(10,6) precision. 0 for failed runs (no partial accounting). Same value mirrored as `cost.saved` on the live POST /run response. |

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
| `FORBIDDEN` | 403 | No permission (wrong namespace or non-admin on an admin-gated route) |
| `AGENT_NOT_VERIFIED` | 403 | The resolved version (pinned or latest) has `verified=false`. `POST /run` returns this before any execution. Catch typed via `SkrunNotVerifiedError` in the SDK. |
| `VERSION_NOT_FOUND` | 404 | Pinned version does not exist. Response includes `available: string[]` for recovery. |
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

Warnings appear in the `warnings` array of POST /run responses (not errors — the run still executes). The field is reserved for advisory signals; v0.8.0 emits none by default (the `agent_not_verified_scripts_disabled` soft warning of v0.7.x is gone — unverified runs now return `403 AGENT_NOT_VERIFIED` upstream).

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

## Uploading input files

For agents that declare `file`-typed inputs (image, PDF, audio — see [agent-yaml.md → File inputs](agent-yaml.md#inputs-required)), there are **three interchangeable ways** to pass each file in the `POST /run` request body. All three are wrapped in a discriminated `source` field. The wire format is **always an array**, regardless of `max_count`.

### The three transports

```jsonc
// (1) file_id reference — uploaded ahead of time via POST /api/files
{ "type": "file", "source": "id", "file_id": "fil_a1b2c3..." }

// (2) base64 inline — capped at 4 MB total per request
{ "type": "file", "source": "data",
  "media_type": "image/jpeg", "data": "<base64-encoded-bytes>" }

// (3) URL — fetched server-side, subject to allowed_hosts
{ "type": "file", "source": "url",
  "url": "https://files.example.com/photo.jpg" }
```

Use `source: id` for any payload bigger than ~4 MB or that you'll reuse across multiple runs. Use `source: data` for one-shot small payloads. Use `source: url` for assets already publicly hosted.

**Example — agent with `receipts: file/image[]` (max_count: 20)**

```bash
# Upload the 3 files, capture each file_id
RECEIPT_1=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-1.jpg" | jq -r .file_id)

RECEIPT_2=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-2.jpg" | jq -r .file_id)

RECEIPT_3=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-3.jpg" | jq -r .file_id)

# Run with the file_id refs
curl -X POST http://localhost:4000/api/agents/dev/receipts-to-expenses/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d "{
    \"input\": {
      \"receipts\": [
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_1\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_2\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_3\" }
      ],
      \"month\": \"2026-04\"
    }
  }"
```

The TypeScript SDK auto-uploads `Blob`, `File`, and `Uint8Array` values via `POST /api/files` transparently — pass them directly to `client.run()`.

### POST /api/files — upload an input file

```
POST /api/files
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Form fields**

| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | The binary file. Filename is derived from the multipart `filename` parameter. |

**Broad media-class allowlist at upload**: `image/*`, `application/pdf`, `audio/*`. Mime types outside these classes return `415 MIME_NOT_ALLOWED` (e.g. `text/plain`, `application/zip`). Strict per-agent `mime_types` validation runs at `/run` time against the agent's `agent.yaml` declaration.

**Response** `201`

```json
{
  "file_id": "fil_a1b2c3d4e5f6789012345678901234ab",
  "size": 524288,
  "media_type": "image/jpeg",
  "purpose": "input",
  "expires_at": "2026-05-02T10:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `file_id` | string | Unified-namespace identifier — use to reference the file in subsequent `/run` calls and `GET /api/files/:id/content`. Format: `fil_<32 hex>`. |
| `size` | number | File size in bytes |
| `media_type` | string | MIME type as detected from the multipart upload |
| `purpose` | `"input"` | Always `input` for caller-uploaded files |
| `expires_at` | string (ISO 8601) | When the file will be evicted from storage. Default TTL: 24 h. |

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `INVALID_MULTIPART` | Body is not valid `multipart/form-data` |
| `400` | `MISSING_FILE` | No `file` field in the form |
| `413` | `FILE_TOO_LARGE` | File size exceeds `INPUT_FILES_MAX_SIZE_MB` (default 25 MB) |
| `415` | `MIME_NOT_ALLOWED` | MIME type outside the broad upload allowlist |
| `401` | — | Missing / invalid `Authorization` header |

### GET /api/files/:id — file metadata

```
GET /api/files/:id
Authorization: Bearer <token>
```

**Authentication is required.** The caller must be the file owner: the uploader for `purpose: input` files, or the run owner for `purpose: output` files. Cross-tenant reads return `403 FORBIDDEN`.

**Response** `200`

```json
{
  "file_id": "fil_a1b2c3...",
  "size": 524288,
  "media_type": "image/jpeg",
  "purpose": "input",
  "expires_at": "2026-05-02T10:00:00.000Z"
}
```

For `purpose: output` files (produced by an agent run, see [Output files](#output-files)), the response shape is the same minus `expires_at` (output retention follows `FILES_RETENTION_S`, not `INPUT_FILES_RETENTION_S`).

| Status | Code | When |
|--------|------|------|
| `200` | — | File found |
| `401` | — | Missing / invalid `Authorization` header |
| `403` | `FORBIDDEN` | Caller is not the file owner |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` or TTL expired |

### GET /api/files/:id/content — download binary

```
GET /api/files/:id/content
Authorization: Bearer <token>
```

**Authentication is required** with the same ownership semantics as `GET /api/files/:id` above.

Returns the raw bytes with the recorded `Content-Type`. Works for both input and output files (unified namespace).

| Status | Code | When |
|--------|------|------|
| `200` | — | Binary content |
| `401` | — | Missing / invalid `Authorization` header |
| `403` | `FORBIDDEN` | Caller is not the file owner |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` or TTL expired |

### DELETE /api/files/:id — delete an input file

```
DELETE /api/files/:id
Authorization: Bearer <token>
```

Removes the file from storage and the cache. Returns `204 No Content` on success.

| Status | Code | When |
|--------|------|------|
| `204` | — | Deleted |
| `403` | `DELETE_OUTPUT_FORBIDDEN` | The `file_id` belongs to a `purpose: output` file. Output files are produced by agents and cannot be deleted by callers. |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` |
| `401` | — | Missing / invalid `Authorization` header |

### Storage configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `INPUT_FILES_MAX_SIZE_MB` | `25` | Max upload size per file |
| `INPUT_FILES_RETENTION_S` | `86400` (24 h) | How long uploaded input files remain available |
| `INPUT_FILES_MAX_INLINE_MB` | `4` | Max base64 inline size on `POST /run` (`source: data`) |

### Capability negotiation

When an `agent.yaml` declares `file`-typed inputs, the chosen `model` (and its `fallback`) must support the declared `media`. The check runs at `skrun deploy` / `skrun push` and refuses the operation with a clear error before any network call. The runtime also enforces the same matrix as defense-in-depth — calls reaching the LLM router with unsupported media throw `LLMCapabilityError` (status `422`).

### Errors at /run for binary inputs

| Status | Code | When |
|--------|------|------|
| `400` | `REQUIRED_INPUT_MISSING` | Agent declared `required: true` but the field is absent |
| `404` | `FILE_NOT_FOUND` | `source: id` references an unknown or expired `file_id` |
| `403` | `URL_NOT_ALLOWED` | `source: url` host is not in the agent's `allowed_hosts` allowlist (SSRF protection) |
| `413` | `INLINE_TOO_LARGE` | `source: data` decodes to more than `INPUT_FILES_MAX_INLINE_MB` (default 4 MB). Use `source: id` via `POST /api/files` for larger payloads. |
| `413` | `MAX_COUNT_EXCEEDED` | Field has more elements than `max_count` in `agent.yaml` |
| `415` | `MIME_NOT_ALLOWED` | Resolved file's `media_type` is not in the agent's `mime_types` allowlist |
| `422` | `LLM_CAPABILITY_UNSUPPORTED` | The chosen model does not support the resolved `media` (defense-in-depth — primary gate is at deploy/push) |
| `502` | `URL_FETCH_FAILED` | `source: url` returned non-2xx |

---

## Output files

Agents produce files by writing to the `$SKRUN_OUTPUT_DIR` directory during execution (available to tool scripts and MCP stdio processes). After the run, produced files appear in the response `files` array and are downloadable via two equivalent paths.

**Response format** (sync, SSE `run_complete`, webhook callback):
```json
{
  "files": [
    {
      "name": "report.pdf",
      "size": 524288,
      "url": "/api/runs/<run_id>/files/report.pdf",
      "file_id": "fil_b2c3d4e5..."
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `name` | Original filename as written to `$SKRUN_OUTPUT_DIR` |
| `size` | File size in bytes |
| `url` | Run-scoped download path (existing route — kept for backward compatibility) |
| `file_id` | Unified-namespace identifier — use with `GET /api/files/:id/content` |

**Download — two equivalent paths**:
- `GET /api/files/:id/content` — unified namespace (recommended). Same path for input + output.
- `GET /api/runs/:run_id/files/:filename` — run-scoped (existing route, backward-compatible).

Both paths now **require authentication** and refuse cross-tenant reads with `403 FORBIDDEN`. The run-scoped path additionally returns `403` if the caller is not the run owner.

**`DELETE /api/files/:id` on a `purpose: output` file** returns `403 DELETE_OUTPUT_FORBIDDEN` — output files are owned by the run, not by the caller.

| Env var | Default | Description |
|---------|---------|-------------|
| `FILES_MAX_SIZE_MB` | `10` | Max file size in MB (larger files excluded) |
| `FILES_MAX_COUNT` | `20` | Max files per run |
| `FILES_RETENTION_S` | `3600` (1 hour) | How long output files are available for download |

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
