<p align="center">
  <img src="assets/banner.svg" alt="Skrun — Deploy any Agent Skill as an API" width="600">
</p>

<p align="center">
  <a href="https://github.com/skrun-dev/skrun/actions"><img alt="CI" src="https://github.com/skrun-dev/skrun/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@skrun-dev/cli"><img alt="npm" src="https://img.shields.io/npm/v/@skrun-dev/cli"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

---

Turn any [Agent Skill](https://agentskills.io) (SKILL.md) into a callable API via `POST /run`. Multi-model, stateful, open source.

## Quick Start

```bash
npm install -g @skrun-dev/cli
```

```bash
# Import an existing skill → deploy → call
skrun init --from-skill ./my-skill
skrun deploy

curl -X POST localhost:4000/api/agents/dev/my-skill/run \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "analyze this"}}'
```

## Get Started

- [Create a new agent](#create-a-new-agent)
- [Import an existing skill](#import-an-existing-skill)
- [Develop & test locally](#develop-locally)
- [Deploy](#deploy)

## Create a new agent

```bash
skrun init my-agent
cd my-agent
# Creates SKILL.md (instructions) + agent.yaml (config)
```

## Import an existing skill

```bash
skrun init --from-skill ./path-to-skill
# Reads SKILL.md, asks 2-3 questions, generates agent.yaml
```

## Develop locally

```bash
skrun dev
# ✓ Server running at http://localhost:3000
# POST /run ready — watching for changes...
```

```bash
skrun test
# ✓ basic-test (output.score >= 0)
# 1 passed, 0 failed
```

## Deploy

```bash
skrun deploy
# ✓ Validated → Built → Pushed
# 🚀 POST http://localhost:4000/api/agents/you/my-agent/run
```

> **v0.1 ships with a local runtime.** Cloud deploy is on the roadmap — the architecture is ready (`RuntimeAdapter` interface).

## Key Concepts

- **[Agent Skills](https://agentskills.io)** — SKILL.md standard, compatible with Claude Code, Copilot, Codex
- **[agent.yaml](docs/agent-yaml.md)** — Runtime config: model, inputs/outputs, permissions, state, tests
- **[POST /run](docs/cli.md)** — Every agent is an API. Typed inputs, structured outputs.
- **Multi-model** — Anthropic, OpenAI, Google, Mistral, Groq with automatic fallback
- **Stateful** — Agents remember across runs via key-value state
- **Tool calling** — Two approaches: CLI tools ([`scripts/`](docs/agent-yaml.md#tools-optional) — write your own, bundled with the agent) and MCP servers ([`npx`](docs/agent-yaml.md#mcp_servers-optional) — [standard ecosystem](https://github.com/modelcontextprotocol/servers), same as Claude Desktop)

## Caller-provided API Keys

By default, POST /run uses the server's LLM API keys (from `.env`). You can instead provide your own keys per request via the `X-LLM-API-Key` header:

```bash
curl -X POST http://localhost:4000/api/agents/dev/code-review/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H 'X-LLM-API-Key: {"anthropic": "sk-ant-your-key"}' \
  -d '{"input": {"code": "function add(a,b) { return a + b; }"}}'
```

The header value is a JSON object mapping provider names to API keys. Accepted providers: `anthropic`, `openai`, `google`, `mistral`, `groq`.

**Key priority**: caller key > server key > 401 error. If the caller key fails (invalid, quota exceeded), the error is returned directly — no fallback to server keys.

**Security**: caller keys are never logged, stored, or returned in responses. Use HTTPS in production.

## Demo Agents

All examples use Google Gemini Flash by default. Change the `model` section in `agent.yaml` to use any [supported provider](#key-concepts).

| Agent | What it shows |
|-------|--------------|
| [code-review](examples/code-review/) | Import a skill, get a code quality API |
| [pdf-processing](examples/pdf-processing/) | Tool calling with local scripts |
| [seo-audit](examples/seo-audit/) | **Stateful** — run twice, it remembers and compares |
| [data-analyst](examples/data-analyst/) | Typed I/O — CSV in, structured insights out |
| [email-drafter](examples/email-drafter/) | Business use case — non-dev API consumer |
| [web-scraper](examples/web-scraper/) | **MCP server** — headless browser via @playwright/mcp |

### Try an example

```bash
# 1. Start the registry
cp .env.example .env          # add your GOOGLE_API_KEY
pnpm dev:registry              # keep this terminal open

# 2. In another terminal
skrun login --token dev-token
cd examples/code-review
skrun build && skrun push

# 3. Call the agent
curl -X POST http://localhost:4000/api/agents/dev/code-review/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"input": {"code": "function add(a,b) { return a + b; }"}}'
```

> **Windows (PowerShell):** use `curl.exe` instead of `curl`, and use `@input.json` for the body.

## CLI

| Command | Description |
|---------|-------------|
| `skrun init [dir]` | Create a new agent |
| `skrun init --from-skill <path>` | Import existing skill |
| `skrun dev` | Local server with POST /run |
| `skrun test` | Run agent tests |
| `skrun build` | Package .agent bundle |
| `skrun deploy` | Build + push + live URL |
| `skrun push` / `pull` | Registry upload/download |
| `skrun login` / `logout` | Authentication |
| `skrun logs <agent>` | Execution logs |

[Full CLI reference →](docs/cli.md)

## Documentation

- [API reference](docs/api.md)
- [agent.yaml specification](docs/agent-yaml.md)
- [CLI reference](docs/cli.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

```bash
git clone https://github.com/skrun-dev/skrun.git
cd skrun
pnpm install && pnpm build && pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and setup.

## License

[MIT](LICENSE)
