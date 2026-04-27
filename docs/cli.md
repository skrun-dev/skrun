# CLI Reference

## skrun init

Create a new Skrun agent.

```bash
skrun init [dir]
skrun init my-agent
skrun init --from-skill ./existing-skill
```

**Options:**
| Flag | Description |
|------|-------------|
| `--from-skill <path>` | Import an existing Agent Skill directory |
| `--force` | Overwrite existing files |
| `--name <name>` | Agent name (non-interactive) |
| `--description <desc>` | Agent description (non-interactive) |
| `--model <provider/name>` | Model (non-interactive) |
| `--namespace <ns>` | Namespace (non-interactive) |

## skrun dev

Start a local development server with POST /run.

```bash
skrun dev
skrun dev --port 8080
```

**Options:**
| Flag | Description |
|------|-------------|
| `--port <n>` | Server port (default: 3000) |

The dev server validates the agent, starts an HTTP server, and watches for file changes. POST /run returns **mock responses** — no real LLM calls, no cost. Use this to iterate on your SKILL.md prompt and test your integration (curl, frontend, SDK) without spending tokens. When you're ready to validate with a real LLM, use `skrun test`.

## skrun test

Run tests defined in agent.yaml.

```bash
skrun test
```

Reads the `tests` array from agent.yaml, runs each test, evaluates assertions, and prints results. Exits with code 1 if any test fails.

**Assertion syntax:** `output.<field> <op> <value>`
- Operators: `>=`, `<=`, `==`, `!=`, `>`, `<`
- Examples: `output.score >= 0`, `output.status == "success"`

## skrun build

Package the agent into a `.agent` bundle.

```bash
skrun build
skrun build --output ./dist/
```

**Options:**
| Flag | Description |
|------|-------------|
| `--output <path>` | Output directory |

Creates a `{slug}-{version}.agent` tar.gz archive containing SKILL.md, agent.yaml, scripts/, references/, and assets/. Excludes node_modules, .git, .env, and hidden files.

## skrun deploy

One-command deployment: validate, build, push, get live URL.

```bash
skrun deploy
skrun deploy -m "Fixed tool calling edge case"
```

**Options:**
| Flag | Description |
|------|-------------|
| `-m, --message <text>` | Attach a note to this version (passed through to `skrun push`). Same rules as `skrun push -m`. |

Requires authentication (`skrun login` first). Runs the full pipeline and prints the live POST /run URL with a curl example.

## skrun push

Push a built `.agent` bundle to the registry.

```bash
skrun push
skrun push -m "Added retry logic"
skrun push --message "v1 — initial release with Claude primary + GPT-4 fallback"
```

**Options:**
| Flag | Description |
|------|-------------|
| `-m, --message <text>` | Attach a note to this version (max 500 chars, plain text). Stored per-version and displayed in the dashboard. Useful for describing what changed — like a git commit message. |

Requires authentication and a built `.agent` bundle (`skrun build` first).

**Version notes**:
- Max 500 characters, plain text only (no markdown, no HTML — rendered as literal text in the dashboard).
- Empty string `-m ""` is treated the same as omitting the flag (no note stored).
- Sent to the server via the `X-Skrun-Version-Notes` HTTP header (not a query param — avoids leaking notes into proxy/CDN logs).
- If the server doesn't support this feature yet (old registry), the CLI surfaces a visible warning. The push still succeeds — the note is just not stored.

## skrun pull

Download an agent from the registry.

```bash
skrun pull acme/seo-audit
skrun pull acme/seo-audit@1.0.0
```

Downloads and extracts the agent into a local directory.

## skrun login

Authenticate with the Skrun registry. Supports three modes, auto-detected based on the registry and arguments:

```bash
skrun login                         # interactive: OAuth if supported, else token prompt
skrun login --token dev-token       # local dev (non-interactive)
skrun login --token sk_live_...     # production API key (non-interactive)
```

**Options:**
| Flag | Description |
|------|-------------|
| `--token <token>` | API token or key (skip interactive flow). Use `dev-token` for local dev, `sk_live_...` for production. |

**Interactive flow (no `--token`)**:

1. The CLI pings `GET /auth/github` on the registry to detect if OAuth is configured (a 302 redirect indicates yes).
2. **If OAuth is supported**: the CLI opens your browser to the GitHub login page, listens on a local port for the callback, and saves the token returned by the server. Your GitHub username becomes your namespace. Timeout: 2 minutes.
3. **If OAuth is not supported** (e.g., local dev with `dev-token` mode): the CLI prompts for a token and saves it.

Tokens are saved to `~/.skrun/config.json`. Use `skrun logout` to clear.

## skrun logout

Remove stored authentication.

```bash
skrun logout
```

## skrun logs

> **⚠️ Planned**: the `skrun logs` CLI command exists, but the backend endpoint (`GET /api/agents/:ns/:name/logs`) is not yet implemented in the registry. Running this command today returns `Agent not found or no logs available`. Execution logs are currently available via the **operator dashboard** at `/dashboard` (Runs page) or via the structured JSON logs on stdout (see [api.md → Structured logging](api.md#structured-logging)). This CLI command will be wired up in a later release.

View recent execution logs for a deployed agent.

```bash
skrun logs acme/seo-audit
skrun logs acme/seo-audit -n 20
```

**Options:**
| Flag | Description |
|------|-------------|
| `-n, --lines <n>` | Number of recent runs (default: 10) |

## Common Workflows

### New agent from scratch
```bash
skrun init my-agent && cd my-agent
# Edit SKILL.md and agent.yaml
skrun dev          # Iterate on prompt (mock, free)
skrun test         # Validate with real LLM
skrun deploy       # Ship it
```

### Import existing skill
```bash
skrun init --from-skill ./my-existing-skill
skrun test
skrun deploy
```

### Agent with CLI tools (scripts)
```bash
skrun init my-linter && cd my-linter

# 1. Create your tools
mkdir scripts
cat > scripts/eslint-check.sh << 'EOF'
#!/bin/bash
echo "$1" > /tmp/code.js
npx eslint /tmp/code.js --format json 2>/dev/null
EOF
chmod +x scripts/eslint-check.sh

# 2. Declare them in agent.yaml (filename matches the tool name)
#    tools:
#      - name: eslint-check
#        description: "Run ESLint on JavaScript code"
#        input_schema:
#          type: object
#          properties:
#            code: { type: string }
#          required: [code]
#          additionalProperties: false

# 3. Build, test, deploy
skrun dev          # Iterate on SKILL.md prompt
skrun test         # LLM calls eslint_check tool, verify results
skrun deploy       # Scripts bundled in .agent archive
```

### Agent with MCP server
```bash
skrun init my-scraper && cd my-scraper

# Add to agent.yaml:
#   mcp_servers:
#     - name: browser
#       transport: stdio
#       command: npx
#       args: ["-y", "@playwright/mcp", "--headless"]

skrun test         # LLM uses MCP tools (navigate, click, etc.)
skrun deploy       # npx installs MCP server at runtime
```

### Update a deployed agent
```bash
# Edit SKILL.md or agent.yaml
skrun test                                    # Verify changes
skrun deploy -m "Improved tool-calling prompt" # Re-deploy (bump version first)
```

### Deploy with a version note (changelog-style)

Each push can carry a short note explaining what changed — shown in the dashboard next to the version, like a git commit message.

```bash
# Bump version in agent.yaml (e.g., 1.1.0 → 1.2.0)
skrun build
skrun push -m "Fixed retry loop on 429 responses"

# Or in one go
skrun deploy --message "v1.2 — added fallback to Claude Haiku"
```

Notes are max 500 characters, plain text. They're visible in the dashboard at `/dashboard/agents/:ns/:name` and via `GET /api/agents/:ns/:name/versions`.
