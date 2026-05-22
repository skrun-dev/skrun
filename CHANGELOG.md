# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-05-22

### Breaking
- **Registry reads now require auth and filter by ownership.** `GET /api/agents`, `/:ns/:name`, `/:ns/:name/versions`, `/:ns/:name/stats`, and `/:ns/:name/pull` (+ `/pull/:version`) return `404` to non-owner non-admin callers (indistinguishable from "doesn't exist"). Running an agent (`POST /run`) stays cross-namespace. `dev-token` self-host is unaffected (auto-admin); OAuth and `sk_live_*` callers must pass `Authorization: Bearer <token>`. SDK + CLI client methods updated to send the header.
- **`agent.yaml`'s `name` is now slug-only** (was `<namespace>/<slug>`). The registry assigns the namespace at push time from your auth context. Migration: `name: dev/email-drafter` → `name: email-drafter`. The registry URL form `<namespace>/<slug>` is unchanged. CLI `--namespace` flag and interactive prompt removed. Dashboard Import dialog now uses explicit form fields (fixes a long-standing filename mis-parse on multi-hyphen slugs).
- **Verification is now per-version + admin-only.** The legacy `PATCH /api/agents/:ns/:name/verify` is removed; use `PATCH /:versions/:version/verify`. SDK `client.verify()` → `client.verifyVersion()`. Existing `verified=true` rows are reset on upgrade — promote an admin (`UPDATE users SET role='admin' WHERE username='you'`) then re-verify each version. Pinned callers are protected: pushing a new version doesn't touch prior verified versions.
- **`POST /run` now returns `403 AGENT_NOT_VERIFIED` for unverified versions.** Runtime refuses before any LLM call, MCP connection, or file alloc. Catch typed via `SkrunNotVerifiedError` in the SDK. The old soft `agent_not_verified_scripts_disabled` warning is gone.
- **File-content endpoints now require auth + ownership.** `GET /api/files/:id`, `GET /api/files/:id/content`, and `GET /api/runs/:run_id/files/:filename` were public before — any caller could fetch any file by id. They now return `401` without auth, `403` for non-owners.
- **`DELETE /api/agents/:ns/:name` and `DELETE .../versions/:v` gain admin override.** Authorization is now "namespace owner OR admin" (was namespace-only). Lets operators clean up squatter / abusive agents across namespaces.
- **Webhook delivery now requires `WEBHOOK_SIGNING_KEY`.** The hardcoded fallback (forgeable from the public source) is removed; the runtime throws if no key is configured. Set `WEBHOOK_SIGNING_KEY` in your environment — see `.env.example`.
- **`CORS_ORIGIN` is now required in production.** When `NODE_ENV=production`, the API fails fast at startup if unset (no implicit `*` fallback). Set e.g. `CORS_ORIGIN=https://app.example.com`. Dev still defaults to `*`.

### Added
- **`skrun whoami`** — prints the current CLI identity (namespace + registry URL).
- **`skrun verify` / `skrun unverify` / `skrun run` CLI commands.** Closes the long-standing gap where `push` had no symmetric `run` in the CLI. `skrun run <ns>/<name>[@<v>]` invokes an agent with input via `-i '<json>'` (inline), `-f <file>` (file path), or `--stdin` (pipe); prints JSON to stdout; renders only `<code>: <message>` on error (never the raw response body). `skrun verify <ns>/<name>@<version>` mints admin trust on a specific version; `skrun unverify` revokes. Admin gate enforced server-side — `dev-token` is auto-admin so local-dev flows just work.
- **`SkrunNotVerifiedError` typed SDK class.** Subclass of `SkrunApiError`. `SkrunApiError.fromResponse` now dispatches on `error.code` to typed subclasses — consumers catch with `if (err instanceof SkrunNotVerifiedError)` instead of string-comparing `err.code`. Extensible dispatch table for future typed codes.
- **Per-version trust surfaces on the dashboard.** Versions table on agent-detail gains Status + Actions columns (per-row badge + Verify/Unverify buttons for admins). Playground Run button is disabled with an amber banner when the selected version is unverified. Listing badge sources from `latest_version_verified`. Delete button hidden for non-owner non-admin viewers.
- **Structured log on every verify/unverify.** Pino `info` line `event: "agent_version_verify"` carrying `{actor, target, action, timestamp}` — the forensic trail until the audit-log UI ships. Pipe the registry's stdout to your log aggregator and filter on the event name.
- **Run output validation against the declared schema.** At the end of every run, the runtime checks the LLM's final JSON output against the agent's `outputs` declarations (top-level keys + types; extra keys allowed; nested arrays/objects accept any internal shape). On mismatch, an `output_validation_warning` event is emitted and the runtime issues one isolated repair call to the LLM with the validation errors. If the retry succeeds, the run terminates normally via `run_complete` with the corrected output and summed token usage across both attempts; if it still fails (schema mismatch or non-JSON), the run terminates via `run_error` with `error.code: OUTPUT_SCHEMA_INVALID` instead of returning a broken payload. Skipped when an agent declares no outputs.
- **Downloadable run artifacts in the dashboard.** Both the live playground and the run-detail page render a Files block listing every artifact the agent produced (`run_complete.files[]`) with a per-file Download button. Downloads go through `/api/files/:id/content` with the caller's auth.

### Changed
- **Tool failures surface as `tool_call_error` SSE events.** When a tool returns `is_error: true`, the runtime emits a new informational event before the existing `tool_result`, carrying the tool name, the error message, and an optional structured `code` parsed from `[CODE]` prefixes (e.g. `[SCRIPT_DEPS_INSTALL_FAILED]`). The `tool_result` still flows back to the LLM normally — recovery decisions (retry, fallback, give up) stay with the LLM. Aligned with the permissive default in AWS Bedrock AgentCore, Claude Managed Agents, and Google Vertex Agent Builder. The dashboard renders these events in red with a `(LLM still received this; run continues)` subtitle.
- **Playground JSON-mode Attach button removed.** It uploaded files to the unified namespace and pasted a `{type:file, source:id}` ref into the textarea, but had no way to know which input field expected the file — agents with multiple file inputs ended up with refs in the wrong slot. JSON mode now renders a small hint pointing to Form mode (which wires the file_id into the correct input slot automatically) for agents that declare file inputs.

### Fixed
- **Supabase `getLatestVersion` non-deterministic tie.** Two rows with identical `pushed_at` (same-millisecond pushes) returned an arbitrary winner — security-relevant now that per-version verify gates on the resolved version. Added `id DESC` tiebreaker after `pushed_at DESC` (matches SQLite's `rowid DESC` behaviour).
- **Dashboard hides the Verify button for non-admin viewers.** Reads `user.role` from `GET /api/me`; missing role is treated as `'user'` (least-privilege). Per-version Verify/Unverify buttons in the versions table follow the same rule.
- `GET /api/agents/:namespace/:name` now returns real `run_count` and `token_count` (was hardcoded to `0`, surfacing misleading stats in the dashboard and CLI).
- **Tool scripts now spawn with `cwd` set to the agent bundle root.** Previously they inherited the registry's own cwd, so agents that referenced relative paths in their inputs (e.g. `./fixtures/sample.csv`) failed silently when called from a different working directory. Agents reading bundled fixtures now work out of the box.
- **Node script-dep install reliable on Windows.** Agents shipping a `package.json` (with or without a lockfile) had previously tripped Node's CVE-2024-27980 mitigation when resolving `pnpm` / `npm` / `yarn` directly (the actual executables are `.cmd` shims on Win32). The runtime now goes through the OS shell on Windows so the shim resolves cleanly. Python install path unchanged.

### Security
- **Cross-tenant run leakage fixed.** `GET /api/runs` now filters by the authenticated user's id (was instance-wide — any user saw every other user's run input/output payloads). Latent on single-user self-host; would have shipped broken on cloud.
- **Cross-tenant run-detail access fixed.** `GET /api/runs/:id` now returns `403` for non-owners (was reachable by any authenticated user via id).
- **IPv6 SSRF bypass closed.** Network allowlist now blocks IPv4-mapped IPv6 (`::ffff:*`, including bracketed URL form) and link-local IPv6 (`fe80:*`). Closes the AWS metadata reach via `http://[::ffff:169.254.169.254]/`.
- **Webhook delivery target validated in production.** When `NODE_ENV=production`, `POST /run` refuses `webhook_url` values resolving to private/reserved addresses (private IPv4, link-local IPv6, IPv4-mapped IPv6, IPv6 loopback — including AWS IMDS `169.254.169.254`). Dev mode bypasses this so local `http://localhost:NNNN/...` callbacks remain available for testing.
- **Gzip-bomb defense on bundle decompression.** Bundle extraction now caps the decompressed buffer at 50 MB by default. Configurable via `BUNDLE_MAX_DECOMPRESSED_MB` for operators with legitimately larger artefacts.
- **Spawned scripts no longer inherit server secrets.** Agent script processes previously received the full `process.env` spread, leaking `*_API_KEY`, `WEBHOOK_SIGNING_KEY`, `DATABASE_URL`, etc. Now strict allowlist: `PATH`, `HOME`, temp/locale vars, Python paths, all `SKRUN_*` vars, and conditional `NODE_PATH`.
- **Symlink path traversal closed.** Output collection now skips symlinks (logged as `symlink_rejected`); file resolution adds a defense-in-depth `realpath` check. Closes `ln -s /etc/passwd` exfil via `/api/files/:id/content`.
- **Security headers on every response.** `X-Frame-Options: DENY`, HSTS 2-year + `includeSubDomains` + `preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin` (so the dashboard can load `/api/files/:id/content` cross-host on cloud). CSP deferred to a follow-up.
- **LocalStorage path-traversal closed + namespace/name validation.** Resolved paths now asserted inside `baseDir` (defangs the `/tmp/storage` vs `/tmp/storage-attacker` startsWith collision). Registry routes also gate `namespace` and `name` path params on `^[a-z0-9-]{1,64}$` at the boundary.

### Internal
- `pnpm dev:registry` and `pnpm test:e2e:live` now spawn Node with `--use-system-ca`. Fixes `unable to verify the first certificate` on Windows machines where an antivirus/firewall installs a MITM root or where the bundled CA store has drifted. Linux/macOS unaffected.
- `.env.example` reorganized into 4 explicit sections (LLM keys, Cloud/Production-required, Storage/DB, OAuth, Runtime advisory limits). The 2 newly-required-in-production vars (`WEBHOOK_SIGNING_KEY`, `CORS_ORIGIN`) are explicit at the top; `BUNDLE_MAX_DECOMPRESSED_MB` documented (default 50 MB); previously-undocumented existing vars surfaced (`DATABASE_URL`, `SUPABASE_KEY`, `GITHUB_CLIENT_ID`/`SECRET`).
- `docs/api.md` gets a top-level "Breaking changes in v0.8.0" summary table. `openapi.ts` enriched: `runAgent` description notes the `WEBHOOK_SIGNING_KEY` requirement; the `webhook_url` doc spells out the private-host refusal + dev-mode bypass.
- Internal refactors in `packages/api/src/routes`: extracted `persistRunCompletion` (DRY for the 3 run-completion sites in `run.ts`) and `dispatchRegistryError` (DRY for 9 `RegistryError` catch blocks). `RegistryError.status` is now typed as a `400 | 403 | 404 | 409 | 500` union. `UserContext.role` is exposed via `GET /api/me` so the dashboard can render admin-only UI.
- Hardened the `sync-public` GitHub workflow against shell injection — `commit_message` now passes through an `env:` mapping rather than being inlined into the `run:` block.
- Script `execFile` now uses an explicit 5 MB `maxBuffer` cap (was the implicit 1 MB Node default). Overflow produces a clear "buffer cap exceeded — truncate or write to `SKRUN_OUTPUT_DIR`" message instead of the opaque `stdout maxBuffer length exceeded`.
- DB `updateRun` failures during `/run` lifecycle (SSE/webhook/sync complete + error) now log at `error` level with `event=db_update_failed` (was silent `.catch(() => {})`, leaving stuck `running` runs undiagnosable).
- SQLite schema now declares `FOREIGN KEY` constraints on ownership and run-history chains (matching Postgres). Ownership uses `ON DELETE CASCADE`; `runs.*` uses `ON DELETE SET NULL` so analytics rows survive parent deletion. On upgrade, an orphan pre-check refuses to migrate when dangling references exist, with a remediation `DELETE` hint.
- SQLite now declares `UNIQUE(agent_id, version)` on `agent_versions` (Postgres parity). The service-layer 409 `VERSION_EXISTS` guard is now backed by a DB-level invariant. Pre-existing duplicates fail the migration loud with a dedupe hint.

## [0.7.0] - 2026-05-12

### Added
- **Cache cost-savings tracking** — `POST /run` response surfaces `cost.saved` (USD, optional, omitted when 0). Persisted in new `runs` columns `usage_cache_read_tokens`, `usage_cache_write_tokens`, `usage_cache_savings_usd` (migration `004`). `GET /api/stats` and `GET /api/agents/:ns/:name/stats` expose aggregated savings (today / yesterday / daily array). SDK `RunResult.cost.saved` mirrors the wire field.
- **Cache savings on the operator dashboard** — "Cost saved" tile on the home page (7-day sparkline + tooltip on empty state), `saved $X.XX` line on the run-detail Cost cell (completed runs only), and "Cache savings 7d" cell on agent-detail stat strip.
- **Native prompt caching across 5 providers** — repeated calls with stable system + tools content now benefit from 30-90% input-token discount automatically, no `agent.yaml` change required. Anthropic gets explicit `cache_control: { type: "ephemeral" }` injected on the last block of the `tools` array AND the last block of the `system` block, but only when each prefix's own token count exceeds the model min-tokens threshold (1k-4k depending on the model — Sonnet 4.6 = 2048, Opus 4.7 = 4096, etc.). OpenAI / xAI Grok / Groq get implicit caching wired with sticky-routing primitives: `prompt_cache_key` body field on OpenAI, `x-grok-conv-id` HTTP header on xAI Grok Chat Completions. Gemini 2.5+/3.x implicit caching is on by default; the runtime parses `cachedContentTokenCount` for cost-tracking. Mistral has no native caching API as of May 2026 — the runtime emits a structured `cache_skipped` debug log and proceeds without primitives.
- **`usage.cache_read_tokens` + `usage.cache_write_tokens`** — new optional fields in the `POST /run` response `usage` object (snake_case wire format), the SDK `RunResult.usage` type (snake_case), and the OpenAPI 3.1 schema. `cache_read_tokens` = tokens served from cache (billed at the cached-read rate). `cache_write_tokens` = Anthropic-only, tokens written to cache at the 1.25× write surcharge (5min TTL by default). Fields are omitted from the response when no cache activity occurred — consumers can treat absence as "no cache hit." Pre-existing `prompt_tokens` is the FULL-RATE residual (cached portion already excluded), so the formula `cost = prompt_tokens × input_rate + cache_read_tokens × cached_rate + completion_tokens × output_rate` is non-overlapping. `cost.estimated` matches the provider invoice within ±5%.
- **`caching: boolean` flag on `ModelCapabilities`** — `packages/schema/src/capability.ts` lists per-model caching support: `true` for all Anthropic Claude / OpenAI GPT-* / Google Gemini 2.5+/3.x / xAI Grok / Groq `openai/gpt-oss-*` family + `kimi-k2-instruct`. `false` for all Mistral and for Groq Llama / Qwen / compound (Groq has not rolled caching to those yet). The `cache` column in `docs/agent-yaml.md` mirrors this flag, with a docs↔code parity unit test catching drift.
- **`MODEL_PRICING` cached-rate fields** — `packages/runtime/src/llm/cost.ts` extends each priced row with optional `inputCachedRead` (per-1M tokens, 0.10× input on Anthropic / GPT-5.x / Gemini, 0.5× on Groq gpt-oss / OpenAI gpt-4o legacy, 0.25× on xAI conservative estimate). Anthropic rows additionally carry `inputCachedWrite5m` (1.25× input, used by the runtime) and `inputCachedWrite1h` (2.0× input, stored for reference — runtime currently uses the 5m default; the 1h toggle is intentionally not exposed). `estimateCost()` accepts the two new optional `cacheReadTokens` + `cacheWriteTokens` parameters and applies the cached rate to the cached portion. When a model has no `inputCachedRead` rate, the cached portion conservatively bills at the full input rate (never under-bills).
- **`packages/runtime/src/llm/cache-key.ts`** — `hashCacheKey(agentName, agentVersion, environmentId): string` SHA-256 hex digest helper used by the router to derive a stable, alphanumeric-safe routing key for OpenAI `prompt_cache_key` and xAI `x-grok-conv-id`. Avoids special-char issues with slashes (`dev/my-agent`) and dots (versions like `1.0.0-beta+build.42`). Same agent name + version + environment share the cache pool; different combinations get isolated pools.
- **`AgentContext` parameter on `LLMRouter.call()`** — new optional 10th positional param `agentContext?: { name, version, environmentId }`. The router computes the cache key once per call and threads it through every tool-loop iteration so all iterations share the same cache pool. When `agentContext` is undefined (e.g. dev-mode raw call), the cache key is also undefined and adapters fall back to no-key behavior. The `LocalAdapter` builds `agentContext` from the existing `RunRequest` fields (`agentConfig.name`, `agent_version`, `environmentId ?? "default"`).
- **Model registry refresh (May 2026)** — `packages/schema/src/capability.ts` and `packages/runtime/src/llm/cost.ts` reverified against authoritative provider docs. New live entries: OpenAI `gpt-5.3-codex` (agentic coding) and `gpt-audio` (parent of `gpt-audio-1.5`); Mistral `magistral-medium-1.2` (chain-of-thought, text-only); xAI `grok-4.1-fast` (the actual fast tier — replaces the phantom `grok-4.3-fast` we had previously listed) and `grok-4.20-multi-agent` (4 native sub-agents); Groq `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `openai/gpt-oss-safeguard-20b` (with the actual `openai/` prefix Groq's API uses), `meta-llama/llama-4-maverick-17b-128e-instruct`, `qwen/qwen3-32b`, `groq/compound`, `groq/compound-mini`.
- **`scripts/check-stale-model-ids.ts`** — new advisory lint script (mirrors `check-public-jargon`) that flags deprecated/renamed/phantom model IDs across the user-facing doc surfaces and the source-of-truth code. Wired into `pnpm lint`. Tracks 9 known-bad IDs at this PR (extensible after future audit refreshes). `CHANGELOG.md` is intentionally excluded from the scan since renames documented here are the value of the entry, not a bug.
- **Tool-choice directives in `agent.yaml`** — declare `tool_choice: auto | required | none | <tool-name>` at top-level to constrain LLM tool invocation. Useful when a model would otherwise satisfy the output schema without calling a side-effecting tool (observed regularly with Gemini Flash on artifact-writing agents). Per-tool `required: true` adds invariants on individual tools (e.g. an audit-log tool that should always fire). Conflict-resolution rules: top-level `none` or specific name wins; top-level `required` + per-tool flags forms a subset. See [agent-yaml.md → Tool choice](docs/agent-yaml.md#tool_choice-optional).
- **Native cross-provider tool-choice translation** — Anthropic `tool_choice: { type, name?, disable_parallel_tool_use? }`, Gemini `tool_config.function_calling_config.{mode, allowed_function_names?}`, OpenAI / xAI `tool_choice: "auto" | "required" | "none" | {type, function}`. Subset-of-N (multiple `required: true`) is natively supported on Gemini via `allowed_function_names`; on Anthropic / OpenAI / xAI it soft-falls back to "any tool fires" with a structured `provider_gap` warning logged. `parallel_tools: false` maps to Anthropic `disable_parallel_tool_use` and OpenAI `parallel_tool_calls: false` (Gemini no-op + warning).
- **xAI Grok 4.3 as 6th first-class provider** — set `XAI_API_KEY` to enable. OpenAI-compatible adapter routed at `https://api.x.ai/v1`. Capability matrix: image input, text-only documents (PDF/audio go through dedicated xAI models, not Grok 4.3 itself). Pricing: $1.25 / M input, $2.50 / M output (subject to xAI's tiered pricing past 200k input tokens). Auto-registered in `LLMRouter` when `XAI_API_KEY` is set.
- **Capability matrix refresh** — `packages/schema/src/capability.ts` updated against authoritative provider docs (May 2026): Anthropic Claude 4.x family (opus-4-7, sonnet-4-6, haiku-4-5 — all accept PDFs); OpenAI GPT-5.x family (5.5, 5.5-pro, 5.4, 5.4-pro/mini/nano — vision + PDF via Files API); Google Gemini 3.x family (3.1-pro, 3.1-flash, 3.1-flash-lite, 3-flash, 3-deep-think — full multimodal); Mistral large-3 / medium-3.1 / small-3.2 / ministral-{14b,8b,3b}-2512 / pixtral-* (vision-only per Mistral vision docs); Groq llama-4-scout (vision); xAI grok-4.3 (image-only). Specialist models on dedicated endpoints (Voxtral, Mistral OCR 3, Groq Whisper, OpenAI transcribe/realtime) intentionally excluded — runtime currently calls `/v1/chat/completions` only. Older model IDs are kept for back-compat.
- **Pricing table refresh** — `packages/runtime/src/llm/cost.ts` now lists Claude 4.x (Opus 4.7 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5), GPT-5.x (5.5 $5/$30, 5.4-mini $0.75/$4.50, 5.4-nano $0.20/$0.80), Gemini 3.1 (Pro $2/$12, Flash $0.50/$3, Flash-Lite $0.25/$1.50), Mistral Large 3 / Medium 3 / Small 3.x / Ministral-8b, Groq additions, and Grok 4.3.
- **Script dependency resolution** — agents declare `package.json` (Node), `requirements.txt`, or `pyproject.toml` (Python) at the bundle root. Detection is filesystem-based — no `agent.yaml` schema change. The runtime resolves the deps on the first script call and caches them at `~/.skrun/deps/<sha256>/` (configurable via `SKRUN_DEPS_DIR`). Subsequent calls reuse the cache (< 5 ms path lookup). The hash is computed from manifest content only (`SHA-256(<ecosystem>\n<manifestKind?>\n<manifestContent>\n[lockfileKind?]\n[lockfileContent])`) — same manifest text on different hosts produces the same hash, so cache entries are shareable across machines. See [agent-yaml.md → Script dependencies](docs/agent-yaml.md#script-dependencies).
- **Lockfile auto-detection** for reproducible installs:
  - Node — precedence `pnpm-lock.yaml` > `yarn.lock` > `package-lock.json`. Triggers `pnpm install --frozen-lockfile --dir=<cache>` / `yarn install --frozen-lockfile --cwd=<cache>` / `npm ci --prefix=<cache>`. No lockfile → `npm install --prefix=<cache>` + `non-reproducible build` warning to install logs.
  - Python — precedence `uv.lock` > `poetry.lock` (with `pyproject.toml`). Triggers real `uv sync --frozen` (uv bootstrapped via `pip install uv`) or `poetry install --no-root` (`POETRY_VIRTUALENVS_CREATE=false` + `VIRTUAL_ENV=<cache>/venv` to reuse the pre-created venv). `pyproject.toml` without lockfile → `pip install <bundle>` (PEP 517, non-editable). `requirements.txt` is treated as already pinned.
- **Install network allowlist** (separate from runtime `environment.networking.allowed_hosts`) — fixed in code, not user-configurable in v1: `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`. Enforced via `PIP_INDEX_URL` / `npm_config_registry` / `YARN_NPM_REGISTRY_SERVER` env vars at spawn. Operator-level overrides (private registries, corporate proxies) deferred to a later release.
- **`skrun cache list`** — table with `HASH` (12-char), `SIZE` (formatted), `PACKAGES` (best-effort count, `?` if layout unknown), `LAST USED` (relative time). Sorted by mtime descending. Prints `No cache entries.` when empty. Skips `.tmp-*` orphans from interrupted installs.
- **`skrun cache clear`** — recursive delete of every cache entry plus orphans. Prompts for confirmation above 100 MB (`Cache is X.X GB. Delete all entries? [y/N]`). Bypass with `--yes` / `-y` for CI cleanups.
- **`SCRIPTS_NO_MANIFEST` warning at `skrun build`** — emitted when `scripts/` contains non-stdlib imports (best-effort regex scan against the language's stdlib module set, biased toward false negatives) but no manifest is found at the bundle root. Non-fatal — build proceeds.
- **`SCRIPT_DEPS_INSTALL_FAILED` typed error** (extends `SkrunError`) — surfaced through `ScriptToolProvider.callTool` as `{ content: "[SCRIPT_DEPS_INSTALL_FAILED] <message>", isError: true }` without spawning the script. The error carries `details: { ecosystem, command, exitCode, stderr }`. The provider memoizes the rejection per instance — persistent failures don't retry the install on every tool call (avoids hammering registries).
- New env var `SKRUN_DEPS_DIR` (default `~/.skrun/deps`) — override the cache root, e.g. for ephemeral CI runners or shared NFS mounts.
- Build-time `EXCLUDE_PATTERNS` extended — `__pycache__/`, `.pytest_cache/`, `venv/`, `.venv/` now stripped from the produced `.agent` tar (joining the legacy exclusions `node_modules/`, `.git/`, `dist/`, `.env`, `.DS_Store`). Devs who run `pip install -r requirements.txt` locally before `skrun build` no longer accidentally bundle their venv.
- **Multimodal inputs** — declare `type: file` in `agent.yaml` with `media: image | document | audio`. Agents read images, PDFs, and audio directly via the LLM's native capability — no upstream OCR.
- **Three transports on POST /run for file inputs** — `source: "id"` (referencing a prior `POST /api/files` upload), `source: "data"` (base64 inline, capped at 4 MB), or `source: "url"` (subject to `allowed_hosts`).
- **Unified `/api/files` namespace** — `POST /api/files` (multipart input upload, returns `file_id`), `GET /api/files/:id` (metadata), `GET /api/files/:id/content` (binary, serves inputs + outputs), `DELETE /api/files/:id` (input-only). Existing `GET /api/runs/:run_id/files/:filename` kept as backward-compat alias.
- **Capability check at `skrun push` / `skrun deploy`** — refuses the operation if a declared `file` input's `media` is unsupported by the chosen model or fallback (e.g. `media: audio` with Claude). Self-hosted models bypass the check.
- **SDK auto-upload** — `client.run()`, `stream()`, `runAsync()` accept `Blob`, `File`, or `Uint8Array` per input. Binaries are uploaded transparently and substituted with `file_id` references. New `client.uploadFile()` helper. New `SkrunFileUploadError` thrown on upload failures.
- **Provider file_id cache** (per-run) — identical multimodal inputs upload once per provider within a single tool loop. Keyed by `(provider, sha256(bytes))`.
- **Output `file_id`** — output files in run responses gain an optional `file_id` field, retrievable via the unified `GET /api/files/:id/content`.
- New env vars: `INPUT_FILES_MAX_SIZE_MB` (default 25), `INPUT_FILES_RETENTION_S` (default 86400), `INPUT_FILES_MAX_INLINE_MB` (default 4).
- OpenAPI 3.1 schema bumped to `0.7.0` — new `WireFileSource` (oneOf 3 transports), `UploadedFileMetadata`, `/api/files` paths, `FileInfo.file_id`.
- **Per-version cleanup endpoint** — `DELETE /api/agents/:ns/:name/versions/:version` lets operators remove a single bad version without removing the whole agent. Returns 409 `LAST_VERSION` if it would leave the agent with no versions (use the whole-agent DELETE for full removal). Past runs referencing the deleted version stay readable (`runs.agent_version` is a text column, no FK cascade).

### Changed
- **Anthropic provider** now injects `cache_control: { type: "ephemeral" }` on the last block of the system + tools prefixes when each prefix exceeds the model's min-tokens threshold (per-prefix check, never on a below-threshold prefix to avoid the 1.25× write surcharge with zero hit potential). Default 5min TTL — 1h is intentionally not exposed (break-even math: 1h needs ~6-7 reuses/hour to outperform 5m's ~2 reuses/5min). Adapter extracts `cache_read_input_tokens` + `cache_creation_input_tokens` from responses into the uniform `cacheReadTokens` + `cacheWriteTokens` fields.
- **OpenAI provider** now passes a hashed `prompt_cache_key` body field on every Chat Completions and Responses API request, derived from the agent context. Adapter extracts cached tokens via dual-path parsing (`prompt_tokens_details.cached_tokens` for Chat, `input_tokens_details.cached_tokens` for Responses) and applies gross→net normalization on `prompt_tokens` so the uniform `promptTokens` is the FULL-RATE residual.
- **xAI Grok adapter** sets the `x-grok-conv-id` HTTP header on Chat Completions (the Grok-specific transport — body `prompt_cache_key` is for Responses API only per docs.x.ai). Adapter extracts cached tokens via the OpenAI shape mirror.
- **Gemini adapter** parses `usageMetadata.cachedContentTokenCount` and applies gross→net normalization (`promptTokens = promptTokenCount - cachedContentTokenCount`). No request-side primitive needed — Gemini 2.5+/3.x implicit caching is the default. Explicit Cache API (with hourly storage fee) intentionally not wired — deferred to a future "managed cache" feature.
- **Groq adapter** extracts `prompt_tokens_details.cached_tokens` (mirrors OpenAI Chat shape). Implicit caching is supported only on `openai/gpt-oss-*` family + `kimi-k2-instruct` per Groq docs; other Groq models return no cache fields → `cacheReadTokens` is undefined.
- **Mistral adapter** emits a structured debug log `{ event: "cache_skipped", provider: "mistral", reason: "no_native_caching" }` on every call and skips all cache primitives. Defensively ignores cache fields in responses (even if Mistral adds caching upstream without our flag flip, behavior stays correct).
- **Runtime LLM call layer** retains its non-streaming shape — caching activates at the LLM-call boundary, not at the API SSE endpoint level. Existing streaming live tests (vt05 streaming-sse, vt06 streaming-async-webhook) preserved unchanged.
- **Mistral medium 3.1 → 3.5** in `capability.ts` and `cost.ts` to match Mistral's current docs.
- **Gemini 3.x model IDs** now carry the `-preview` suffix used by the developer API (e.g. `gemini-3.1-pro` → `gemini-3.1-pro-preview`). 2.5 family stays GA without `-preview`. Users with hardcoded `gemini-3.1-pro` (no suffix) will now get `model not found` from `getCapability` — declare the `-preview` form, which is what `generativelanguage.googleapis.com` actually accepts.
- **xAI fast tier ID** corrected from the phantom `grok-4.3-fast` (never existed in xAI's API) to the real `grok-4.1-fast` (note the dot — released 2025-11). The phantom row in `capability.ts` was removed.
- **Mistral Pixtral standalone dropped** — `pixtral-large-latest` and `pixtral-12b` removed from `capability.ts` and `cost.ts`. Vision is folded into `mistral-large-3` and `mistral-small-4` per Mistral's 2026 lineup.
- **Groq Llama-Guard-4 dropped** — deprecated upstream 2026-02-10. The replacement `openai/gpt-oss-safeguard-20b` is now the safety classifier.
- **Groq Llama-3.2 vision-preview models** (`llama-3.2-90b-vision-preview` and `llama-3.2-11b-vision-preview`) removed from `capability.ts` — Groq dropped them from its catalog 2026-05.
- **Bug fix in `cost.ts`** — `gpt-5.5-pro` was billed at `$5 / $30` per 1M (a copy-paste of `gpt-5.5`). Per OpenAI's published pricing it is `$30 / $180`. Anyone running a `gpt-5.5-pro` agent before this PR was billed correctly by OpenAI but Skrun's reported `cost.estimated` was off by 6×.
- **Anthropic snapshot deprecation comments** — `claude-opus-4-20250514` and `claude-sonnet-4-20250514` are scheduled to retire 2026-06-15 per Anthropic; documented inline in `capability.ts` for the next refresh to drop.
- **`docs/agent-yaml.md` capability matrix** rewritten — one grouped row per (provider, identical capability flags), full model IDs (no abbreviations), parseable by the new docs↔code parity unit test in `capability.test.ts`. Snapshot/dated IDs (e.g. `claude-opus-4-7-20260416`) resolve via longest-prefix matching to their base entry.
- **`docs/api.md` examples** bumped to `claude-sonnet-4-6` (current alias) — the previous `claude-sonnet-4-20250514` examples used a snapshot scheduled for retirement and would have misled new users copy-pasting from docs.
- **`agents/changelog-generator` v0.1.0 → v0.2.0** — adds top-level `tool_choice: write_artifact` so Gemini Flash always invokes the artifact-writing tool (previously skipped on roughly 1 in 5 runs, returning markdown inline without producing a file).
- **`agents/adr-writer` v0.1.0 → v0.2.0** — same `tool_choice: write_artifact` migration as above.
- **`agents/receipts-to-expenses` v0.3.0 → v0.4.0** — adds `tool_choice: build_workbook` (preserving the v0.3.0 runtime-resolved deps + v0.2.0 vision-native input shape). Fixes the live test failure where Gemini Flash sometimes returned the parsed JSON inline without invoking the workbook builder, leaving `expenses.xlsx` and `monthly.pdf` unproduced.
- **`agents/csv-to-executive-report` v0.1.0 → v0.2.0** — manual `pip install -r requirements.txt` instruction removed from README. Runtime auto-resolves `pandas` + `matplotlib` + `reportlab` (~80 MB) on first call, caches at `~/.skrun/deps/<hash>/`. Cold install ~30 s; warm cache instant.
- **`agents/slide-deck-generator` v0.1.0 → v0.2.0** — same migration as above. Resolves `python-pptx` automatically.
- **`agents/receipts-to-expenses` v0.2.0 → v0.3.0** — same migration as above (preserves the v0.2.0 vision-native input shape: `receipts: file/image[]`). Resolves `openpyxl` + `reportlab` + `pandas`.
- **`agents/knowledge-base-from-vault` v0.1.0 → v0.2.0** — declares `package.json` with `jszip` ^3.10.1. Replaces the 95-line hand-rolled STORE-method ZIP writer (CRC-32 table + manual local/central-directory headers) with ~5 lines of `jszip` API. Output is **functionally identical** — extracts to the same files with the same content; the new archive uses deflate (jszip default) instead of STORE, producing slightly smaller files. The `docs/getting-started.md` vision quickstart no longer instructs users to `pip install` before running this agent's family.
- **`agents/receipts-to-expenses` v0.1.0 → v0.2.0 — vision-native.** Replaces the text-mode workflow (`.txt` files + upstream OCR) with direct image input. Breaking for that agent: `receipts_dir: string` → `receipts: file/image[]` (max_count 20); `read_receipts` tool removed.
- `LLMCallRequest.userMessage` is now `@deprecated` — canonical field is `userContent: SkrunPart[]`. Deprecated alias still derived for one release.
- SDKs bumped to access Files APIs natively: `@anthropic-ai/sdk` 0.39 → 0.92, `openai` 4 → 6, `zod` 3 → 4, plus minor bumps (`pino`, `commander`, `@hono/node-server`). No impact on `agent.yaml` authoring or the public HTTP API.
- **Multi-tenancy: `GET /api/stats` filters by authenticated user.** Operators using API keys on shared instances will see only their own stats — was instance-wide before. Single-tenant self-host (dev-token mode) is unaffected: the auth middleware synthesizes a deterministic user id, so the filter narrows to that single user (effectively instance-wide for one-user instances). Cloud / shared deployments now isolate per-user aggregates by default. See `docs/self-hosting.md` for migration notes if you depended on the old shared-instance behavior.

### Fixed
- **Webhook mode now persists run usage to the DB** — pre-existing latent gap since the streaming feature shipped. Webhook-delivered runs (`POST /run` with `webhook_url`) built the webhook payload but never called `db.updateRun()` with usage data, silently storing `usage_*` and `usage_cache_*` columns at `DEFAULT 0`. Stats and run-detail were under-counting any token / savings activity originating from webhook mode. Fixed in passing during the cache-cost-savings wire-up: both `run_complete` and `run_error` branches now mirror the sync / SSE pattern (`run_error` explicitly omits all `usage_*` fields per the "no partial accounting for failed runs" rule).
- **`DELETE /api/agents/:ns/:name` now evicts the bundle cache for all versions** — pre-existing latent gap. The whole-agent delete removed bundles from storage but not from the in-memory bundle cache (10-minute TTL), so a deleted agent could keep serving runs from the cached extracted directory until natural eviction. Fixed in passing alongside the new per-version DELETE — both delete operations now share the same cache-eviction invariant.

### Breaking
- `agents/receipts-to-expenses` 0.1.0 → 0.2.0 (see Changed).
- **Minimum supported Node version bumped to 22.0.0** (was 20 / 18 across packages). Node 20 reaches upstream EOL April 2026 and is being deprecated by GitHub Actions. CI matrix now tests Node 22 + 24. All published packages (`@skrun-dev/cli`, `sdk`, `schema`, `runtime`, `api`) declare `engines.node >=22.0.0`.
- Future-removal warning: provider implementations consuming `LLMCallRequest.userMessage` should migrate to `userContent: SkrunPart[]` before the next major.

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
