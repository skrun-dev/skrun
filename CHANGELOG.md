# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Caller-provided LLM API keys via `X-LLM-API-Key` header on POST /run — callers bring their own keys, operators have zero LLM cost exposure
- `docs/api.md` — full API reference (endpoints, error codes, rate limits, caller keys)
- `redactCallerKeys` utility — caller keys never logged, persisted, or returned
- 24 new tests (header parsing, router key override, redact utility)

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
