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

A **Bundle** is the packaged `.agent` archive produced by `skrun build`. It's a tar.gz containing `SKILL.md`, `agent.yaml`, optional `scripts/` and `references/`, and the parsed config snapshot. This is the artifact the registry stores — not your source directory.

Bundles are immutable once pushed. Each [version](#version) is a distinct bundle. Callers don't interact with bundles directly — the runtime extracts them on demand when an agent is invoked.

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

## What's next

- [Getting Started](./getting-started.md) — install the CLI, build your first agent, explore the dashboard.
- [agent.yaml reference](./agent-yaml.md) — every field with type, default, and example.
- [API reference](./api.md) — HTTP endpoints, auth, streaming, webhooks.
- [Self-hosting](./self-hosting.md) — deploy on your own infra.
