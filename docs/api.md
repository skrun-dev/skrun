# API Reference

Base URL: `http://localhost:4000` (local dev) or your deployed instance.

> **Interactive docs**: visit `GET /docs` on your running server for a live API explorer (Scalar UI).
> **OpenAPI schema**: `GET /openapi.json` — import into Postman, Insomnia, or use for SDK generation.
> **Prefer the SDK?** Use `@skrun-dev/sdk` for a typed client instead of raw HTTP calls: `npm install @skrun-dev/sdk`

## Authentication

All endpoints except health, list, metadata, and versions require a Bearer token:

```
Authorization: Bearer <token>
```

In dev mode, use `dev-token` (grants access to the `dev` namespace).

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
  "webhook_url": "https://your-app.com/callback"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Input fields matching the agent's `agent.yaml` |
| `version` | No | Pin a specific agent version (**strict semver**, e.g. `"1.2.0"`). Omit to target latest. Ranges (`^`, `~`, `*`) and keywords (`"latest"`, `"HEAD"`) are not supported — omit the field for latest. |
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

### Agent versions

```
GET /api/agents/:namespace/:name/versions
```

List all published versions of an agent. Public, no auth required.

**Response** `200`

```json
{
  "versions": ["1.0.0", "1.1.0"]
}
```

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

### Warning codes

Warnings appear in the `warnings` array of POST /run responses (not errors — the run still executes).

| Code | Description |
|------|-------------|
| `agent_not_verified_scripts_disabled` | Agent has `scripts/` but is not verified — scripts were skipped. Agent ran with LLM + MCP only. |
| `TIMEOUT` | 504 | Agent execution timed out |
| `EXECUTION_FAILED` | 502 | Agent execution failed |

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
