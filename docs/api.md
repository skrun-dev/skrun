# API Reference

Base URL: `http://localhost:4000` (local dev) or your deployed instance.

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

Execute an agent and return the result.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |
| `X-LLM-API-Key` | No | Caller-provided LLM API keys (see [Caller-provided API keys](#caller-provided-api-keys)) |

**Request body**

```json
{
  "input": {
    "field_name": "value"
  }
}
```

Input fields must match the `inputs` defined in the agent's `agent.yaml`.

**Response** `200`

```json
{
  "run_id": "uuid",
  "status": "completed",
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
| `output` | object | Agent output fields (as defined in agent.yaml) |
| `usage.prompt_tokens` | number | Tokens sent to the LLM |
| `usage.completion_tokens` | number | Tokens received from the LLM |
| `usage.total_tokens` | number | Total tokens |
| `cost.estimated` | number | Estimated cost in USD |
| `duration_ms` | number | Total execution time in milliseconds |
| `error` | string | Error message (only when `status` is `"failed"`) |

**Rate limit**: 60 requests per minute per IP.

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
  "latest_version": "1.0.0",
  "created_at": "2026-04-11T...",
  "updated_at": "2026-04-11T..."
}
```

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
| `MISSING_VERSION` | 400 | Version query param missing on push |
| `NOT_FOUND` | 404 | Agent not found in registry |
| `CONFLICT` | 409 | Version already exists |
| `RATE_LIMITED` | 429 | Too many requests |
| `BUNDLE_CORRUPT` | 500 | Failed to extract agent bundle |
| `MISSING_CONFIG` | 500 | agent.yaml not found in bundle |
| `INVALID_CONFIG` | 500 | agent.yaml is invalid |
| `TIMEOUT` | 504 | Agent execution timed out |
| `EXECUTION_FAILED` | 502 | Agent execution failed |

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
