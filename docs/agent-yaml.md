# agent.yaml Specification

The `agent.yaml` file is Skrun's extension to the Agent Skills standard. It declares runtime configuration, I/O contracts, permissions, state, and tests for a deployable agent.

## Fields

### `name` (required)
- **Type**: string
- **Format**: `namespace/slug` (e.g., `acme/seo-audit`)
- **Constraints**: lowercase, hyphens, alphanumeric

### `version` (required)
- **Type**: string
- **Format**: semver (e.g., `1.0.0`)

### `model` (required)
- **Type**: object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | enum | Yes | `anthropic`, `openai`, `google`, `mistral`, `groq`, `meta` |
| `name` | string | Yes | Model name (e.g., `claude-sonnet-4-20250514`) |
| `temperature` | number | No | 0-2, controls randomness |
| `fallback` | object | No | Backup model if primary fails |
| `fallback.provider` | enum | Yes (if fallback) | Same as provider |
| `fallback.name` | string | Yes (if fallback) | Same as name |

### `tools` (optional)
- **Type**: array of objects
- **Default**: `[]`
- **Description**: CLI tools the agent can call during execution. Each tool maps to a script in the `scripts/` directory.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Tool name (used by the LLM to call it) |
| `script` | string | Yes | Path to the script, relative to agent root (e.g., `scripts/lint.sh`) |
| `description` | string | Yes | What the tool does (passed to the LLM so it knows when to use it) |

**How it works**: you create a `scripts/` directory, write your tools (shell, JS, Python — anything executable), and declare them in `tools`. At runtime, the LLM decides when to call each tool based on its description. Skrun executes the script and returns the result to the LLM.

**Example:**

```yaml
tools:
  - name: eslint_check
    script: scripts/eslint-check.sh
    description: "Run ESLint on JavaScript code and return issues as JSON"
  - name: count_lines
    script: scripts/count-lines.sh
    description: "Count lines of code in a file"
```

```
my-agent/
├── SKILL.md
├── agent.yaml
└── scripts/
    ├── eslint-check.sh
    └── count-lines.sh
```

Scripts are bundled into the `.agent` archive at build time and available on the filesystem at runtime.

> **Note**: On multi-user instances, `scripts/` only execute for **verified agents**. Non-verified agents can still run (LLM + MCP), but scripts are skipped. Operators verify agents via `PATCH /api/agents/:ns/:name/verify` (see [API reference](api.md#verify-an-agent)). In dev mode (`dev-token`), verification is bypassed — all scripts execute locally.

### `mcp_servers` (optional)
- **Type**: array of objects
- **Default**: `[]`

Skrun supports the standard MCP ecosystem — the same servers that work with Claude Desktop work with Skrun. MCP servers are npm packages launched via `npx`.

3 transport modes: **stdio** (local, via npx or direct command), **Streamable HTTP** (new MCP standard for remote), and **SSE** (legacy remote).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Server identifier |
| `url` | string (URL) | For remote | MCP server endpoint. Default transport: Streamable HTTP |
| `transport` | enum | No | `stdio`, `sse`, or `streamable-http`. Auto-detected if omitted. |
| `command` | string | For stdio | Command to spawn the MCP server process |
| `args` | string[] | No | Arguments for the stdio command |
| `auth` | enum | No | `none` (default), `api_key`, `oauth2` (remote only) |

**Transport selection**: if `transport: stdio` + `command` → local subprocess. If `url` without transport → Streamable HTTP (new default). If `url` + `transport: sse` → legacy SSE.

**Examples:**

```yaml
mcp_servers:
  # npm package via npx (recommended — same as Claude Desktop)
  - name: browser
    transport: stdio
    command: npx
    args: ["-y", "@playwright/mcp", "--headless"]

  # Another npm MCP server
  - name: memory
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-memory"]

  # Remote server — new standard (Streamable HTTP, default)
  - name: slack
    url: https://mcp.slack.com/mcp
    auth: api_key

  # Remote server — legacy (SSE, deprecated)
  - name: old-server
    url: https://legacy-mcp.example.com/sse
    transport: sse
```

> **Tip**: Browse available MCP servers at [npmjs.com](https://www.npmjs.com/search?q=mcp-server) or the [official MCP servers repo](https://github.com/modelcontextprotocol/servers). Any server that works with Claude Desktop works with Skrun.

> **Note**: SSE transport is deprecated in the MCP specification (since protocol version 2024-11-05). New servers should use Streamable HTTP. Skrun supports SSE for backward compatibility.

### `inputs` (required)
- **Type**: array (min 1)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Input field name |
| `type` | enum | Yes | `string`, `number`, `boolean`, `object`, `array` |
| `required` | boolean | No | Default: `true` |
| `description` | string | No | Human-readable description |
| `default` | any | No | Default value |

### `outputs` (required)
- **Type**: array (min 1)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Output field name |
| `type` | enum | Yes | `string`, `number`, `boolean`, `object`, `array` |
| `description` | string | No | Human-readable description |

### `permissions` (optional)
- **Default**: `{ network: [], filesystem: "read-only", secrets: [] }`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `network` | string[] | `[]` | Allowed domains (e.g., `["googleapis.com", "*.example.com"]`) |
| `filesystem` | enum | `read-only` | `none`, `read-only`, `read-write` |
| `secrets` | string[] | `[]` | Required secret names (injected as env vars) |

### `runtime` (optional)
- **Default**: `{ timeout: "300s", sandbox: "strict" }`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | string | `300s` | Max execution time (format: `Ns`) |
| `max_cost` | number | - | Cost cap per run in USD |
| `sandbox` | enum | `strict` | `strict` or `permissive` |

### `context_mode` (optional)
- **Type**: enum
- **Default**: `skill`
- **Values**: `skill` (use SKILL.md), `persistent` (use AGENTS.md)

### `state` (optional)
- **Default**: `{ type: "kv", ttl: "30d" }`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | enum | `kv` | `kv` (persistent key-value) or `none` |
| `ttl` | string | `30d` | State retention (format: `Nd`) |

### `tests` (optional)
- **Type**: array
- **Default**: `[]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Test name |
| `input` | object | Yes | Test input matching inputs schema |
| `assert` | string | Yes | Assertion expression (e.g., `output.score >= 0`) |

## Full Example

```yaml
name: acme/seo-audit
version: 1.0.0

model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  temperature: 0.3
  fallback:
    provider: openai
    name: gpt-4o

tools:
  - web_search

mcp_servers:
  - name: search-console
    url: https://mcp.gsc.io/sse
    auth: oauth2

inputs:
  - name: website_url
    type: string
    required: true
    description: Website to audit

outputs:
  - name: seo_report
    type: object
  - name: score
    type: number

permissions:
  network: ["googleapis.com", "*.target-site"]
  filesystem: read-only
  secrets: [GSC_API_KEY]

runtime:
  timeout: 300s
  max_cost: 0.50
  sandbox: strict

context_mode: skill

state:
  type: kv
  ttl: 30d

tests:
  - name: basic-audit
    input:
      website_url: "https://example.com"
    assert: output.score >= 0
```
