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
```

Requires authentication (`skrun login` first). Runs the full pipeline and prints the live POST /run URL with a curl example.

## skrun push

Push a built `.agent` bundle to the registry.

```bash
skrun push
skrun push --force
```

Requires authentication and a built `.agent` bundle (`skrun build` first).

`--force` overwrites an existing version in the local registry so you can re-push the same `agent.yaml` version during development.

## skrun pull

Download an agent from the registry.

```bash
skrun pull acme/seo-audit
skrun pull acme/seo-audit@1.0.0
```

Downloads and extracts the agent into a local directory.

## skrun login

Authenticate with the Skrun registry.

```bash
skrun login
skrun login --token <token>
```

**Options:**
| Flag | Description |
|------|-------------|
| `--token <token>` | API token (non-interactive) |

Saves the token to `~/.skrun/config.json`.

## skrun logout

Remove stored authentication.

```bash
skrun logout
```

## skrun logs

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
skrun test         # Verify changes
skrun deploy       # Re-deploy (bump version in agent.yaml first)
```
