# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
