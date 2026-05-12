# Concepts

The vocabulary you'll see throughout Skrun — in the CLI, the dashboard, the API, and the docs.

> → Want to try it hands-on? Read the [Getting Started tutorial](./getting-started.md).
> → Deploying on your own infrastructure? See the [Self-hosting guide](./self-hosting.md).

---

## Agent

An **Agent** is a deployable AI unit — the thing you build, push, and run on Skrun. It wraps a [skill](#skill) with all the runtime configuration it needs to be callable: which LLM to use (with optional fallback), which tools and MCP servers to expose, typed inputs and outputs, execution environment (networking, timeout, sandbox), and tests.

An agent lives in a directory with three core files: `SKILL.md` (the instructions the LLM reads), [`agent.yaml`](./agent-yaml.md) (the runtime config), and optionally a `scripts/` directory with local tools. You build it into a [bundle](#bundle) with `skrun build` and push it to a registry with `skrun push`. Once pushed, it becomes callable via `POST /api/agents/<namespace>/<name>/run`.

**Where you see it**: CLI (`skrun init`, `skrun push`, `skrun deploy`), dashboard Agents page, API endpoints, SDK (`client.run`, `client.push`).

---

## Skill

A **Skill** is the portable unit of AI capability — a `SKILL.md` file that describes what an agent does and how it should behave. The format follows the Agent Skills standard, which is also used by Claude Code, Copilot, and Codex. This means a skill written for one tool can be imported into another without rewriting.

In Skrun, the skill is the brain of the agent. An [agent](#agent) wraps a skill with deployment config (model, tools, environment). You can import any existing skill into Skrun with `skrun init --from-skill <path>`.

**Where you see it**: `SKILL.md` file in your agent directory, the `skill-md-parser` package, the [agentskills.io](https://agentskills.io) standard.

---

## Bundle

A **Bundle** is the packaged `.agent` archive produced by `skrun build`. It's a tar.gz containing `SKILL.md`, `agent.yaml`, optional `scripts/` and `references/`, the optional [script dependency manifest](#script-dependencies) (`package.json` / `requirements.txt` / `pyproject.toml`), and the parsed config snapshot. This is the artifact the registry stores — not your source directory.

Bundles are immutable once pushed. Each [version](#version) is a distinct bundle. Callers don't interact with bundles directly — the runtime extracts them on demand when an agent is invoked.

`skrun build` excludes dev-only directories from the tar: `node_modules/`, `venv/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.git/`, `dist/`, `.env`. Only the manifest travels in the bundle; deps are resolved at runtime (see [Script dependencies](#script-dependencies)).

**Where you see it**: `skrun build` output (`my-agent-1.0.0.agent` file), the registry's bundle storage, `GET /api/agents/<ns>/<name>/pull`.

---

## Namespace

A **Namespace** is the owner prefix on every agent name — it identifies who published it. Every agent is named `namespace/slug` (e.g., `acme/seo-audit`). In local dev with `dev-token`, the namespace is always `dev`. In production (self-hosted with GitHub OAuth, or the hosted cloud), the namespace is your GitHub username.

Permissions are scoped by namespace. Only the namespace owner can push, verify, or delete an agent in their namespace. Running an agent is public (marketplace model) — anyone with a valid auth can call any public agent.

**Where you see it**: every agent name (`namespace/slug`), CLI namespace errors, API 403 on cross-namespace push attempts, the Agents page in the dashboard.

---

## Version

A **Version** is an immutable semver-tagged snapshot of an agent's [bundle](#bundle). Every `skrun push` creates a new version. Pushing the same version twice returns `409 CONFLICT` — bump the version in `agent.yaml` to re-push.

Each version carries its own `config_snapshot` (the parsed `agent.yaml` at push time) and an optional **note** — a short plain-text message (max 500 chars) attached via `skrun push -m "Added retry logic"`. Notes work like git commit messages: they describe what changed. They're visible in the dashboard next to each version and returned by `GET /api/agents/<ns>/<name>/versions`.

Callers can pin a specific version at runtime via the `version` field in the POST /run body — useful for reproducible integrations that shouldn't silently track latest.

Operators can remove a single bad version (broken bundle, wrong content) via [`DELETE /api/agents/:ns/:name/versions/:version`](api.md#delete-a-single-version) without removing the whole agent. Past runs referencing the deleted version stay readable.

**Where you see it**: `agent.yaml` `version:` field, `skrun push -m "..."`, dashboard agent-detail Versions card, versions API response.

---

## Run

A **Run** is one execution of an agent — a single `POST /api/agents/<ns>/<name>/run` call. It has a unique `run_id`, a status (`running`, `completed`, `failed`, `cancelled`), the input it was called with, the output it produced, LLM token usage, estimated cost, duration, and any files it generated.

Runs are persisted in the database — they don't disappear after the HTTP response. You can list them, filter by agent/status, and inspect the full I/O and event timeline in the dashboard.

**Where you see it**: `POST /run` responses, dashboard Runs page + run-detail, `GET /api/runs`, `skrun logs <agent>` (planned).

---

## Environment

The **Environment** describes *how* and *where* an agent runs — separate from *what* the agent does. It's a section of `agent.yaml` covering networking (`allowed_hosts`), filesystem access (`none` / `read-only` / `read-write`), required secrets, execution timeout, max cost cap, and sandbox mode.

This separation means the same agent logic can run in different environments (dev vs prod) without changing the agent itself. Callers can also override specific environment fields per-run via the POST /run body — e.g., raising the timeout for a particular call.

**Where you see it**: `agent.yaml` `environment:` section, [`agent-yaml.md`](./agent-yaml.md#environment-optional), POST /run body `environment` override, dashboard agent-detail metadata.

---

## State

**State** is a key-value store scoped to an agent, persisted across runs. An agent can emit `_state` in its output to write; subsequent runs for the same agent receive the state as context. This is what makes a stateful agent — it accumulates context over time (e.g., SEO audit comparing scores week over week, onboarding agent remembering questions already asked).

State is enabled via `agent.yaml` `state: { type: kv, ttl: 30d }`. Set `type: none` to disable. Storage backend depends on the DbAdapter: in-memory (tests), SQLite (local dev), Supabase (production).

**Where you see it**: `agent.yaml` `state:` section, agent output `_state` field, `GET /api/agents/<ns>/<name>/state` (dashboard).

---

## Verification

**Verification** is a per-agent operator flag that controls whether the agent's local `scripts/` can execute. Unverified agents run with LLM + MCP only — their scripts are skipped with a warning. The verified flag lets an operator trust a third-party agent enough to run its scripts in their environment.

In local dev (`dev-token` mode), verification is bypassed — all scripts run by default. In production (OAuth or API keys), only the namespace owner can verify, and new pushes start unverified. The warning `agent_not_verified_scripts_disabled` appears in POST /run responses when scripts were skipped.

**Where you see it**: `PATCH /api/agents/<ns>/<name>/verify`, dashboard agent-detail verified pill, run response `warnings` array.

---

## MCP

**MCP** (Model Context Protocol) is an open standard for exposing tools to LLMs, created by Anthropic and adopted by Claude Desktop, Claude Code, and Skrun among others. An MCP server exposes tools that the agent can call — anything from a headless browser to a Slack workspace to a custom API.

Skrun supports 3 MCP transports: **stdio** (local, typically via `npx` for npm-packaged servers), **Streamable HTTP** (new remote standard), and **SSE** (legacy remote). Declare MCP servers in `agent.yaml` under `mcp_servers:` — any MCP server that works with Claude Desktop works with Skrun.

**Where you see it**: `agent.yaml` `mcp_servers:` section, [npm MCP servers](https://www.npmjs.com/search?q=mcp-server), the [official MCP servers repo](https://github.com/modelcontextprotocol/servers).

---

## Script dependencies

When your `scripts/` import third-party libraries, declare them in a standard manifest at the bundle root: `package.json` (Node), `requirements.txt` (Python), or `pyproject.toml` (Python, PEP 621). The runtime detects the manifest, installs the dependencies on the **first** call, and caches them at `~/.skrun/deps/<sha256>/` so every subsequent call hits the cache and skips the install entirely.

The hash is computed from the manifest's CONTENT only — same manifest text on two different machines produces the same hash. This means container build layers and shared NFS mounts can cache resolved deps across pushes of the same agent without re-downloading.

Lockfiles are auto-detected and trigger reproducible installs: `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` for Node; `uv.lock` / `poetry.lock` for Python. Without a lockfile, the install resolves to the latest version satisfying each declared range and emits a "non-reproducible build" warning. **Add a lockfile to your bundle for stable, repeatable installs.**

The runtime separates two networks: install-time (limited to public registries `registry.npmjs.org`, `pypi.org`, etc.) and runtime (governed by your `environment.networking.allowed_hosts`). Your scripts only see the runtime network — they cannot reach pypi.org once installed.

**Where you see it**: bundle root (the manifest itself), `~/.skrun/deps/` on the runtime host, [`skrun cache list`](cli.md#skrun-cache-list) for inspection, [`skrun cache clear`](cli.md#skrun-cache-clear) to free disk. Full reference: [agent-yaml.md → Script dependencies](agent-yaml.md#script-dependencies).

---

## Tool choice

By default the LLM decides whether and which tool to invoke for a given turn. This works well most of the time, but some models — Gemini Flash in particular — sometimes satisfy the output schema without calling the tool the agent author actually needed (e.g. returning markdown inline instead of writing a file via `write_artifact`). **Tool choice** is the declarative escape hatch: state in `agent.yaml` that the model **must** call a tool, the runtime translates that to the provider's native directive.

Three forms cover the common cases:
- **Top-level `tool_choice: required`** — any tool must fire before the response is final.
- **Top-level `tool_choice: <tool-name>`** — that specific tool must fire.
- **Per-tool `required: true`** — declarative invariant on a single tool (e.g. an audit-log tool that must always run, regardless of caller intent).

The orthogonal `parallel_tools: bool` controls whether the model may emit multiple tool calls per turn. Set it to `false` to force at-most-one tool call per response.

**Where you see it**: `agent.yaml` top-level (`tool_choice`, `parallel_tools`) and per-tool (`required`). Provider behavior — Anthropic, Gemini, OpenAI, xAI — and the soft-fallback rules for cases a provider doesn't natively support (subset-of-N) are detailed in [agent-yaml.md → Tool choice](agent-yaml.md#tool_choice-optional).

---

## Cost & caching

LLM providers bill input tokens at a higher rate than cached tokens — typically 90% off on Anthropic, OpenAI GPT-5.x, and Gemini 2.5+; 50% off on Groq's openai/gpt-oss-* family. When the runtime wires the provider's caching primitive correctly, every repeat of a stable prefix (system prompt + tool definitions + reference documents) is served from cache and billed at the cheaper rate. Skrun does this automatically across 5 of the 6 first-class providers:

- **Anthropic** — explicit `cache_control: { type: "ephemeral" }` injected on the last block of the `tools` array AND the last block of the `system` block, but ONLY when each prefix's own token count exceeds the model threshold (1k-4k tokens depending on the model). Default TTL is 5 minutes — cache survives idle periods of less than 5 min within the same workspace.
- **OpenAI** (Chat Completions + Responses API) — passes a stable `prompt_cache_key` body field derived from `${agent.name}@${agent.version}+default`, hashed with SHA-256. Caching is automatic past 1024-token prefixes. Same agent + same version share the cache pool across runs.
- **Google Gemini** (2.5+ and 3.x) — implicit caching is on by default; the runtime parses `cachedContentTokenCount` from responses for accurate cost-tracking. Explicit Cache API (with hourly storage fee) is intentionally not wired — runtime backlog item.
- **xAI Grok** — sets `x-grok-conv-id` HTTP header on Chat Completions requests for sticky-routing, mirroring OpenAI's `prompt_cache_key` semantics.
- **Groq** — implicit on the `openai/gpt-oss-*` family + `kimi-k2-instruct` only; Llama / Qwen / compound models do not yet expose caching.
- **Mistral** — no native caching API as of May 2026; the runtime emits a structured `cache_skipped` log and proceeds without cache primitives.

**Reading the discount in your runs**: every `POST /run` response includes optional `usage.cache_read_tokens` (tokens served from cache, billed at the cached-read rate) and `usage.cache_write_tokens` (Anthropic only — tokens written to cache at the 1.25× write surcharge). When fields are absent, no cache activity occurred. The `cost.estimated` field already accounts for the cached-rate billing — within ±5% of the provider's actual invoice.

**Anthropic 5min vs 1h TTL break-even**: 5min TTL costs 1.25× input on writes + 0.10× on reads → break-even at ~2 reuses within 5 minutes. 1h TTL costs 2.0× write + 0.10× read → break-even at ~6-7 reuses within the hour. The runtime defaults to 5min — sufficient for most multi-turn agents and chained API calls. The 1h toggle is a runtime-backlog item for long-PDF workflows.

**Cache invalidation triggers** (Anthropic explicit cache only — implicit providers re-detect prefix automatically): tool definitions change, image add / remove / reorder in messages, `tool_choice` value change, thinking-settings change, web-search or citations toggling, and any system prompt content change (even one character). Repeat calls with stable system + tools survive across iterations of the tool-loop without re-write.

**Where you see it**: `usage.cache_read_tokens` + `usage.cache_write_tokens` in POST /run responses ([api.md](api.md#post-runs-execute-an-agent)), the SDK's typed `usage` object, the OpenAPI schema. The `cache` column in [agent-yaml.md → Models per provider](agent-yaml.md#model-required) marks per-model support. No agent.yaml configuration is required — caching is automatic for every supported model.

### Tracking your savings

Operators care about dollars, not tokens. The runtime snapshots a USD savings value at run completion: live as `cost.saved` on the `POST /run` response, persisted as `usage_cache_savings_usd` on the run record, and aggregated in `GET /api/stats` + `GET /api/agents/:ns/:name/stats`. The dashboard renders all three (home tile, run-detail Cost cell, agent-detail stat). Full field reference in [api.md](api.md#post-runs-execute-an-agent).

---

## What's next

- [Getting Started](./getting-started.md) — install the CLI, build your first agent, explore the dashboard.
- [agent.yaml reference](./agent-yaml.md) — every field with type, default, and example.
- [API reference](./api.md) — HTTP endpoints, auth, streaming, webhooks.
- [Self-hosting](./self-hosting.md) — deploy on your own infra.
