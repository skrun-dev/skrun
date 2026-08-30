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

A **Namespace** identifies who published an agent in the registry. It is the **owner scope**, not part of the agent's artefact identity. The full registry-qualified reference an agent is `<namespace>/<slug>` (e.g., `acme/seo-audit`), but the slug alone (`seo-audit`) is what the author writes in `agent.yaml`.

**Two halves of the identity:**

- **Slug** — the artefact identifier, owned by the author. Declared in `agent.yaml`'s `name` field (slug only, no slash). The author picks it; it travels with the bundle. Same convention as `npm`'s package `name`, Docker image's `name`, or a Cargo crate's `name`.
- **Namespace** — the registry scope, assigned at push time from your auth context. Never written in `agent.yaml`. In local dev with `dev-token` it is always `dev`. In OAuth mode (cloud or self-host) it's your GitHub username.

This split keeps the bundle portable: the same `.agent` file pushed under two namespaces produces two distinct registry entries (`alice/seo-audit` and `bob/seo-audit`) without re-editing the yaml.

**Permissions are scoped by namespace.** Only the namespace owner can push to their namespace. **Registry reads** (list, metadata, versions, pull, stats) are filtered to the caller's own namespace by default — non-owners see the same `404 NOT_FOUND` response whether the agent doesn't exist OR they simply don't have access (opacity by design; see [Multi-tenancy in self-hosting](./self-hosting.md#multi-tenancy)). **Invocation** (`POST /run`) follows the agent's visibility: agents are **private by default**, so only the owner (or an admin) can call one and a non-owner gets that same opaque `404` — see [Visibility & access](#visibility--access). To delegate one agent to an outside caller, the owner mints an agent-scoped key. **Admin role** bypasses the read filter and can delete cross-namespace. **Who may flip verification is the operator's choice** (`SKRUN_VERIFICATION_POLICY`, default `admin`) — see Verification below.

**Where you see it**: registry URLs (`/api/agents/<namespace>/<slug>/run`), CLI display strings (`Pushed acme/seo-audit@1.0.0`), CLI namespace errors, API 403 on cross-namespace push attempts, the Agents page in the dashboard.

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

### Run artifacts (files)

An agent can produce **file artifacts** alongside its JSON output — a rendered PDF, a generated audio file, a built `kb.zip`, etc. Two ways: (a) call the built-in `write_artifact` tool, or (b) write directly into the path exposed via the `SKRUN_OUTPUT_DIR` environment variable from a tool script. The runtime scans that directory at the end of the run and surfaces every file under `run_complete.files[]` and on the persisted run row.

Each file in the response carries `{name, size, file_id, url}`. The `file_id` is the canonical reference into the unified files namespace and can be fetched via `GET /api/files/<id>/content` with normal auth. The dashboard renders the produced files as a **Files block** with download buttons under the agent's Output, both in the playground (live) and on the run-detail page (after persistence). Files are scoped to the run's owner — only the calling user (or an admin) can download them.

---

## Environment

The **Environment** describes *how* and *where* an agent runs — separate from *what* the agent does. It's a section of `agent.yaml` covering networking (`allowed_hosts`), filesystem access (`none` / `read-only` / `read-write`), required secrets, execution timeout, max cost cap, and sandbox mode.

This separation means the same agent logic can run in different environments (dev vs prod) without changing the agent itself. Callers can also override specific environment fields per-run via the POST /run body — e.g., raising the timeout for a particular call.

**Where you see it**: `agent.yaml` `environment:` section, [`agent-yaml.md`](./agent-yaml.md#environment-optional), POST /run body `environment` override, dashboard agent-detail metadata.

---

## State

**State** is a key-value store scoped to an agent, persisted across runs. An agent can emit `_state` in its output to write; subsequent runs for the same agent receive the state as context. This is what makes a stateful agent — it accumulates context over time (e.g., SEO audit comparing scores week over week, onboarding agent remembering questions already asked).

> ⚠️ **One agent, one state — shared by every caller.** A single row per agent, keyed on the agent name; no partition by caller. If more than one party can run the agent, they all read and write the same state, and what one run stores is replayed into the next caller's prompt. Namespacing inside the state does not help — the whole object is injected on every run. Where callers must not see each other's data: `type: none`, or a separate agent per caller.

State is enabled via `agent.yaml` `state: { type: kv, ttl: 30d }`. Set `type: none` to disable. The storage backend follows the DbAdapter: in-memory (tests), SQLite (local dev), any standard Postgres ≥ 14 (production).

> ⚠️ **`ttl` is declared but not enforced yet.** The field is parsed and validated, but nothing expires state on that schedule — KV state persists until the agent is deleted (the row cascades with it). Do not rely on `ttl` to age out sensitive data: use `type: none` for an agent that should hold none, or clear keys explicitly from the agent itself.

**Where you see it**: `agent.yaml` `state:` section, agent output `_state` field, `GET /api/agents/<ns>/<name>/state` (dashboard).

---

## Verification

**Verification** is a **per-version** flag, governed by the operator **verification policy**, that controls whether a version of an agent can be invoked via `POST /run`. Under the default policy an unverified version returns `403 AGENT_NOT_VERIFIED` from the runtime — no LLM call, no MCP connection, no DB write happens for an unapproved version. The verified flag lets an operator vet what runs in their Skrun before any caller can use it.

Verification is per version, not per agent. Pushing a new version is a pure INSERT — it never touches the verified state of any existing version. A caller pinning `version: "1.0.0"` keeps running even if the author pushes a not-yet-verified v1.1.0 (the new version is what's blocked, not the old one). Without a version pin, `POST /run` resolves to the most recently pushed version; if that one is unverified, the call gets 403 — pin an older verified version to keep running.

**Who may flip the flag — and whether it gates runs at all — is the operator's choice**, via `SKRUN_VERIFICATION_POLICY` (default `admin`):

- **`admin`** — only an instance admin may attest a version, and an unverified version cannot run (the legacy behavior). Promotion to admin is a manual SQL update on the `users` table (no API for elevation by design).
- **`owner`** — the agent **owner** is the trust authority for their own agents: they (or an admin) may attest, and a private agent runs without the verification gate (the owner's responsibility plus sandbox isolation cover safety). Suited to multi-tenant hosting where one operator can't vet everyone's agents.
- **`disabled`** — verification never gates a run; the flag is inert metadata.

The local `dev-token` (when `SKRUN_DEV_AUTH` is enabled — `pnpm dev:registry` does this) is mapped to admin automatically so single-user self-host flows just work. New pushes always start at `verified=false`. Every verify and unverify call writes a structured pino log entry (`event: "agent_version_verify"`) carrying the actor identity, target version, action, and `kind` (`admin` or `owner_self`) — the forensic trail for any future audit-log UI.

**Where you see it**:
- API: `PATCH /api/agents/<ns>/<name>/versions/<version>/verify`, `POST /run` returns 403 with `code: "AGENT_NOT_VERIFIED"` for unverified versions.
- CLI: `skrun verify <ns>/<name>@<version>` and `skrun unverify <ns>/<name>@<version>` (authority set by `SKRUN_VERIFICATION_POLICY`).
- SDK: `client.verifyVersion(agent, version, verified)` and a typed `SkrunNotVerifiedError` consumers can catch.
- Dashboard: per-row Status badges + Verify/Unverify buttons in the versions table on agent-detail; playground Run button disabled with an amber banner when the selected version is unverified.

---

## Visibility & access

**Visibility** controls *who can call* an agent — a separate axis from verification (which controls *whether a version is approved to run at all*). Every agent has a `visibility` of `private` (the default) or `public`:

- **`private`** — only the agent's owner (or an instance admin) can `POST /run`. Anyone else gets a `404` byte-identical to a genuinely-missing agent, so a private agent's very existence stays hidden.
- **`public`** — any authenticated caller can `POST /run`. **Public is a marketplace capability; the set-path is disabled for now** — agents are **private-only** until the marketplace ships. The `visibility` column and the run-authorization branch are retained, so the capability reactivates without a migration.

Authentication is always required — there is no anonymous run. The access credential (an `sk_live_…` key or a session) answers *who are you*; visibility answers *may you call this agent*. Both are distinct from the LLM key (`X-LLM-API-Key`), which only decides who pays for the inference.

Visibility affects run-authorization **only**. A `public` agent is *runnable* by anyone authenticated, but its source bundle, metadata, and version list stay owner-only — you can execute a public agent, not download or inspect it. Public *discovery* (listing/search) is a separate, later capability.

Because the agent's declared environment (e.g. `allowed_hosts`) is part of its safety contract, the per-run `environment` override is restricted to the owner/admin: a non-owner running a public agent who supplies an override gets `403 ENV_OVERRIDE_FORBIDDEN`. Runtime parameters belong in `input`, not in an environment override.

- API: `PATCH /api/agents/<ns>/<name>/visibility` with `{ "visibility": "private" }` (namespace owner or admin). `"public"` is rejected with `400 PUBLIC_VISIBILITY_DISABLED` until the marketplace.
- CLI: `skrun visibility <ns>/<name> private`.
- SDK: `client.setVisibility(agent, "private")`.
- Dashboard: a visibility badge on agent-detail (the public toggle is hidden while the set-path is disabled).

---

## LLM keys

Running an agent needs an LLM API key. Skrun resolves one **per provider**, in order:

1. **Caller key** — the `X-LLM-API-Key` request header (a JSON map of `provider → key`). The caller brings their own key and pays for that run.
2. **Creator key** — a key the agent's owner attaches to the agent (encrypted at rest). This lets a creator offer *"call my agent, I cover the inference"*: their callers don't need a key, and the creator pays. Attach one per provider your agent's model (and fallback) use.
3. **Server key** — an instance-level `<PROVIDER>_API_KEY` env var. Self-host only; the hosted cloud sets none.

If no tier has a key for the provider a model needs, the run errors. The model order (primary then fallback) is the agent author's choice — key availability never reorders it; each model independently resolves its provider's key through the chain above.

A creator key is **write-only**: it is encrypted with `SKRUN_SECRETS_ENCRYPTION_KEY` before storage and never returned — reads expose only the provider and the last four characters.

**Caller-key policy.** Each agent has an `llm_key_policy`:

- **`open`** (default) — callers may bring their own key (the chain above).
- **`creator_only`** — caller keys are rejected: a run carrying `X-LLM-API-Key` gets `403 CALLER_KEY_NOT_ALLOWED`, and the agent runs only on the creator's key. Set this when every call should be billed to you.

Manage creator keys + the policy (namespace owner/admin, account-wide credential):

- API: `PUT /api/agents/<ns>/<name>/llm-keys/<provider>` `{ "key": "…" }`, `DELETE …`, `GET …/llm-keys` (policy + presence), `PUT …/llm-key-policy` `{ "policy": "creator_only" }`.
- CLI: `skrun llm-key set <provider> --agent <ns>/<name>` (key from stdin or `--key-env`, never an argument), `… list`, `… rm <provider>`, `… policy creator-only`.
- Dashboard: an "LLM keys" panel on agent-detail (owner-only).

---

## API-key scopes

An `sk_live_…` key has **two scope axes**, both enforced. A session login and (in self-host) `dev-token` carry no key and are unrestricted "master" credentials.

- **Operation** — what the key may *do*: `agent:run`, `agent:push`, `agent:verify`. A new key defaults to all three (a "full" key); a **run-only** key carries just `agent:run`.
- **Resource** (`scope_kind`) — *which agents* the key may touch: `account` (the default — your whole account) or `agents` (restricted to specific agents you own).

The headline use case is the **restricted client key** (the Stripe/GitHub-fine-grained-token pattern). A key always belongs to its creator's account, so handing one to a client lets them act *as a narrowed slice of your account* — they never need their own Skrun account:

```bash
# Mint a run-only key scoped to a single agent, for a customer:
skrun keys create --name client-acme --agent dev/my-agent --run-only
```

That key can `POST /run` **only** `dev/my-agent` and nothing else: not your other agents (`403 KEY_SCOPE_FORBIDDEN`), not the source via `GET /pull`, not the version list, not your run history or stats, and it cannot mint or revoke keys. A resource-scoped key may read only the **metadata** of its in-scope agents (enough to know the inputs). Account-management actions (key CRUD, visibility, delete) require an account-wide *full* key — so a delegated or run-only key can never escalate to a broader one.

Scopes are created from the dashboard (Settings → Create Key → **Access** + **Scope**) or `skrun keys create`; `skrun keys list` / `skrun keys revoke <id>` round out the group. Every run records the calling key (`runs.api_key_id`) so usage can be metered per key — i.e. per client.

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

**Where you see it**: `usage.cache_read_tokens` + `usage.cache_write_tokens` in POST /run responses ([api.md](api.md#run-an-agent)), the SDK's typed `usage` object, the OpenAPI schema. The `cache` column in [agent-yaml.md → Models per provider](agent-yaml.md#model-required) marks per-model support. No agent.yaml configuration is required — caching is automatic for every supported model.

### Tracking your savings

Operators care about dollars, not tokens. The runtime snapshots a USD savings value at run completion: live as `cost.saved` on the `POST /run` response, persisted as `usage_cache_savings_usd` on the run record, and aggregated in `GET /api/stats` + `GET /api/agents/:ns/:name/stats`. The dashboard renders all three (home tile, run-detail Cost cell, agent-detail stat). Full field reference in [api.md](api.md#run-an-agent).

---

## What's next

- [Getting Started](./getting-started.md) — install the CLI, build your first agent, explore the dashboard.
- [agent.yaml reference](./agent-yaml.md) — every field with type, default, and example.
- [API reference](./api.md) — HTTP endpoints, auth, streaming, webhooks.
- [Self-hosting](./self-hosting.md) — deploy on your own infra.
