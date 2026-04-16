# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
