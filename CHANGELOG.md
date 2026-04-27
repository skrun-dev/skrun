# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-27

### Added
- **Version notes at push** — `skrun push -m "retry logic"` (or `--message`) attaches a note to each version, displayed in the dashboard like git commit messages. Max 500 characters, plain text.
- **GitHub OAuth login** — users sign in with GitHub, their username becomes their namespace. Set `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` to enable.
- **API keys** — `sk_live_*` keys for programmatic access. Create via `POST /api/keys` or the dashboard Settings page. Keys are shown once at creation, stored as SHA-256 hashes.
- **Multi-tenant namespaces** — push/verify/delete restricted to namespace owner (GitHub username). Running an agent stays public.
- **Operator Dashboard** at `/dashboard` — agents, runs, stats with sparklines, integrated playground with SSE streaming, API key management. Light/dark theme.
- **Persistent local storage** — SQLite by default (file-based, zero config). Agents, runs, and keys survive restarts. Optional Supabase for production.
- **Agent deletion** — `DELETE /api/agents/:namespace/:name` (namespace owner only) + dashboard button.
- **Stats & runs API** — `GET /api/stats`, `GET /api/agents/:ns/:name/stats`, `GET /api/runs`, `GET /api/runs/:id`.
- **Dashboard agent import** — scan and one-click import agents from a directory set by `SKRUN_AGENTS_DIR`.
- **Model tracked per run** — the LLM used (`provider/name`) appears in run detail and the runs list.
- **Version config snapshot** — the parsed `agent.yaml` is stored with each version and exposed in the versions API. Powers the dashboard playground forms and metadata display.
- **New documentation** — [Concepts](docs/concepts.md), [Getting Started](docs/getting-started.md) (with dashboard screenshots), [Self-hosting](docs/self-hosting.md).
- **Eight new demo agents** under [`agents/`](agents/) — each produces a real downloadable artifact (PDF, XLSX, PPTX, ZIP, CSV, MD) and runs without any secondary API key. Covers OSS workflows (changelog, ADR), team operations (meeting recap, security rules), and analyst deliverables (executive report, slide deck, expense report, knowledge base).

### Changed
- README restructured around 3 use cases + animated dashboard hero GIF.
- Supabase schema updated — self-hosters on older versions run migrations `002_add_model_to_runs.sql` and `003_add_version_notes.sql` from `packages/api/src/db/migrations/`.
- **Renamed `examples/` → `agents/`** to align with the `SKRUN_AGENTS_DIR` convention used by the dashboard import flow. `.env.example` now sets `SKRUN_AGENTS_DIR=./agents` as the dev default. If you have local scripts or bookmarks pointing at `examples/<demo>`, update them to `agents/<demo>`.

### Fixed
- Dashboard "Failed runs" delta showed `NaN%` instead of `0%` when no failed runs existed.
- Dashboard import dialog no longer expands beyond the viewport when the configured directory contains many agents — content area now scrolls.

### Breaking
- On shared instances with OAuth configured, `dev-token` is no longer accepted — use OAuth or an API key.

## [0.5.0] - 2026-04-17

### Breaking
- **`permissions` and `runtime` replaced by `environment` in `agent.yaml`.** The two top-level fields are gone — use a unified `environment` section. Migration: `permissions.network` → `environment.networking.allowed_hosts`, `permissions.filesystem` → `environment.filesystem`, `permissions.secrets` → `environment.secrets`, `runtime.timeout` → `environment.timeout`, `runtime.max_cost` → `environment.max_cost`, `runtime.sandbox` → `environment.sandbox`. If all values are defaults, the entire section can be omitted.
- `PermissionsSchema` and `RuntimeConfigSchema` removed from `@skrun-dev/schema`. Use `EnvironmentConfigSchema` instead.
- `AgentConfigSchema` is now strict — unknown top-level keys (including the old `permissions` and `runtime`) are rejected.

### Added
- `EnvironmentConfigSchema` and `NetworkingConfigSchema` exported from `@skrun-dev/schema`
- **POST /run accepts `environment` override** — optional object in the request body, shallow-merged on top of agent.yaml defaults. Allows per-run adjustments to timeout, max_cost, networking, sandbox, etc.
- SDK `RunOptions.environment` — pass a partial environment override to `run()`, `stream()`, `runAsync()`
- OpenAPI schema: POST /run request body documents the optional `environment` field
- **In-memory bundle extraction cache** — repeated POST /run calls for the same agent+version skip re-extraction. Configurable via `BUNDLE_CACHE_TTL` (seconds, default 600) and `BUNDLE_CACHE_MAX` (entries, default 50) env vars.
- **In-memory MCP connection cache** — MCP servers are connected once and reused across runs. Reconnect-on-error for dropped connections (retry once). Configurable via `MCP_CACHE_TTL` (seconds, default 600) and `MCP_CACHE_MAX` (entries, default 20) env vars.
- Generic `TTLCache` class exported from `@skrun-dev/runtime` — LRU eviction + TTL expiration + onEvict callback
- **`networking.allowed_hosts` enforcement** — MCP remote connections checked against the allowlist before connecting. Empty=all blocked (safe default), glob patterns (`*.github.com`), `["*"]`=unrestricted. Private IPs always blocked. Tool scripts receive `SKRUN_ALLOWED_HOSTS` env var. `isHostAllowed` exported from `@skrun-dev/runtime`.
- **Files API** — agents produce files by writing to `$SKRUN_OUTPUT_DIR`. Run responses include `files: [{ name, size, url }]`. Download via `GET /api/runs/:run_id/files/:filename`. Configurable limits: `FILES_MAX_SIZE_MB` (default 10), `FILES_MAX_COUNT` (default 20), `FILES_RETENTION_S` (default 3600). SDK `SdkRunResult.files` exposes file metadata.

## [0.4.0] - 2026-04-16

### Changed
- **BREAKING — `tools:` in `agent.yaml` must now be objects.** The legacy string-array form (`tools: [pdf-extract]`) is rejected with a migration message. Each tool now requires `name`, `description`, and an `input_schema` ([JSON Schema draft-07](https://json-schema.org/draft-07/)). The LLM receives the declared schema as the tool spec instead of a stub, and arguments are validated via Ajv before the script runs (invalid args → ToolResult.isError so the LLM can self-correct). See `docs/agent-yaml.md#tools` for the new shape and migration tip.

### Added
- `ToolConfigSchema` and `InputSchemaSchema` exported from `@skrun-dev/schema`
- Ajv dependency in `@skrun-dev/runtime` for per-tool schema validation (compiled once per tool, cached)
- **Agent version pinning on `POST /run`** — optional `version` field in the request body targets a specific agent version (strict semver, e.g. `"1.2.0"`). Omit for latest. Ranges (`^`, `~`) and keywords (`"latest"`) are rejected with `400 INVALID_VERSION_FORMAT`. Non-existent version returns `404 VERSION_NOT_FOUND` with an `available: string[]` list (up to 10 most recent, newest first) for recovery.
- `agent_version` is now **always echoed** in every run response: sync 200, SSE `run_start` event, webhook 202 accept, and webhook callback payload.
- SDK `@skrun-dev/sdk`: `run()`, `stream()`, `runAsync()` accept `{ version?: string }` in their options. `SdkRunResult.agent_version` and `AsyncRunResult.agent_version` are now required fields. `RunStartEvent.agent_version` exposes the resolved version.
- OpenAPI schema: request body adds optional `version`; `RunResult` and `AsyncRunResult` require `agent_version`; new `VersionNotFoundResponse` schema; 404 on `POST /run` uses `oneOf(ErrorResponse, VersionNotFoundResponse)`.
- **Structured JSON logging** via pino in `@skrun-dev/runtime` and `@skrun-dev/api`. Every log line is valid JSON with `level`, `time`, `name`, `msg`, and run context (`run_id`, `agent`, `agent_version`). Replaces all ad-hoc `console.log/warn/error` + the Phase 1 `AuditLogger`. `LOG_LEVEL` env var (debug/info/warn/error, default: info) controls verbosity. `createLogger` exported from `@skrun-dev/runtime` for operators embedding the runtime.
- 25+ new tests total: 13 for tool input_schema (7 schema, 6 runtime) + 12 for version pinning (8 api, 4 sdk, 6 openapi, 2 e2e integration) + 4 for structured logs (logger output, child bindings, LOG_LEVEL filtering, callerKeys redaction).

## [0.3.0] - 2026-04-15

### Added
- **SSE streaming** — `Accept: text/event-stream` on POST /run streams real-time events (run_start, tool_call, tool_result, llm_complete, run_complete, run_error)
- **Async webhook** — `webhook_url` in POST /run body returns 202 Accepted, delivers result via POST callback with HMAC-SHA256 signature (`X-Skrun-Signature`)
- Webhook retry: 3 attempts with exponential backoff (1s, 4s, 16s) on non-2xx
- `executeStream()` async generator on RuntimeAdapter — event-driven execution core
- SSE helper (`formatSSEEvent`) and webhook delivery utility (`deliverWebhook`)
- 20 new unit tests (executeStream, SSE formatting, webhook HMAC/retry)
- 11 new E2E integration tests (streaming modes, validation, conflicts)
- 5 new E2E live tests (SSE with real LLM, SSE with tool calls, webhook with real callback)
- **TypeScript SDK** (`@skrun-dev/sdk`) — typed client for calling Skrun agents from Node.js. `run()`, `stream()`, `runAsync()`, `push()`, `pull()`, `list()`, `getAgent()`, `getVersions()`, `verify()`. Zero dependencies, Node.js 18+.
- `SkrunApiError` — typed errors with `code`, `status`, `message`
- SSE parser for SDK (`parseSSEStream`) — `AsyncGenerator<RunEvent>` from fetch response
- 30 SDK unit tests (client, errors, SSE parser)
- 9 SDK E2E integration tests (against real HTTP server)
- 3 SDK live tests (run, stream, list against real LLM)
- **OpenAPI 3.1 schema** — `GET /openapi.json` returns the full API spec (all 9 endpoints, auth, errors, SSE events)
- **Interactive API docs** — `GET /docs` serves Scalar UI with "Try it" functionality
- 7 OpenAPI unit tests (schema validity, endpoints, auth, SSE, error refs)
- 4 OpenAPI E2E tests (/openapi.json, /docs, regression)

## [0.2.0] - 2026-04-12

### Added
- Caller-provided LLM API keys via `X-LLM-API-Key` header on POST /run — callers bring their own keys, operators have zero LLM cost exposure
- Agent verification — `verified` flag controls script execution for third-party agents. Non-verified agents run with LLM + MCP only (scripts skipped). Dev-token bypasses verification for local development.
- `PATCH /api/agents/:ns/:name/verify` endpoint for operators to verify/unverify agents
- `warnings` field in POST /run response (e.g., `agent_not_verified_scripts_disabled`)
- `docs/api.md` — full API reference (endpoints, error codes, rate limits, caller keys, verification)
- `redactCallerKeys` utility — caller keys never logged, persisted, or returned
- Centralized E2E test suite (`tests/e2e/`, 24 tests) — registry, run, caller-keys, verification
- Live E2E tests with auto-start registry (`tests/e2e.ts`, 14 tests)

### Fixed
- Path traversal vulnerability in bundle extraction — skip `../` and absolute paths, verify resolved path with `resolve()` + `sep` (thanks @hobostay, PR #7)
- Anthropic provider message ordering — tool results now correctly ordered as `[user, assistant, user]` (thanks @hobostay, PR #7)
- Tool call args: providers now pass original args instead of hardcoded `{}` when reconstructing conversation history

### Changed
- LLM providers accept explicit `apiKey` parameter (AnthropicProvider, GoogleProvider, OpenAI-compatible)
- LLMRouter resolves providers per-request: caller key > server key > 401
- Audit logger sanitizes caller keys from structured logs
- API error responses strip caller keys from LLM provider error messages

## [0.1.1] - 2026-04-08

### Fixed
- npm packages republished with `pnpm publish` (fixes `workspace:*` resolution)

## [0.1.0] - 2026-04-08

### Added
- Initial release — Deploy any Agent Skill as an API via POST /run
- 4 packages: @skrun-dev/schema, @skrun-dev/cli, @skrun-dev/runtime, @skrun-dev/api
- 5 LLM providers (Anthropic, OpenAI, Google, Mistral, Groq) with automatic fallback
- Tool calling: CLI scripts (`scripts/`) and MCP servers (stdio, Streamable HTTP, SSE)
- Stateful agents via key-value state store
- 10 CLI commands: init, init --from-skill, dev, test, build, push, pull, deploy, logs, login/logout
- 6 demo agents: code-review, pdf-processing, seo-audit, data-analyst, email-drafter, web-scraper
- Security: timeout, cost checker, audit logger
