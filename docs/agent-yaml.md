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
| `base_url` | string | No | Custom API endpoint (for self-hosted models — Ollama, vLLM, LocalAI). Any OpenAI-compatible endpoint. |
| `fallback` | object | No | Backup model if primary fails |
| `fallback.provider` | enum | Yes (if fallback) | Same as provider |
| `fallback.name` | string | Yes (if fallback) | Same as name |

**Custom endpoints**: set `base_url` to use any OpenAI-compatible API. Works with self-hosted models, Chinese providers, and inference platforms.

```yaml
# Self-hosted (Ollama, vLLM, LocalAI)
model:
  provider: openai
  name: llama3
  base_url: http://localhost:11434/v1

# DeepSeek
model:
  provider: openai
  name: deepseek-chat
  base_url: https://api.deepseek.com/v1

# Kimi (Moonshot)
model:
  provider: openai
  name: kimi-k2.5
  base_url: https://api.moonshot.ai/v1

# Qwen (Alibaba)
model:
  provider: openai
  name: qwen-plus
  base_url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1

# Zhipu GLM
model:
  provider: openai
  name: glm-4-flash
  base_url: https://api.z.ai/api/paas/v4/
```

Set the API key via `X-LLM-API-Key` header or the `OPENAI_API_KEY` env var (it's used for any OpenAI-compatible endpoint when `base_url` is set).

### `tools` (optional)
- **Type**: array of objects
- **Default**: `[]`
- **Description**: Local script tools the agent can call during execution. Each tool maps to a file in the `scripts/` directory (filename without extension matches the declared `name`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Tool identifier. Must match a script file in `scripts/` (e.g., `pdf-extract` → `scripts/pdf-extract.js`). Regex: `/^[a-zA-Z_][a-zA-Z0-9_-]*$/`. |
| `description` | string | Yes | What the tool does. Passed to the LLM so it knows when and how to use it. |
| `input_schema` | object | Yes | [JSON Schema draft-07](https://json-schema.org/draft-07/) describing the tool's input parameters. Validated before the script runs. |

**How it works**: you create a `scripts/` directory, write your tools (Node.js, TypeScript, or Python — read JSON args from stdin, write result to stdout), and declare them in `tools`. At runtime, Skrun passes `input_schema` to the LLM as the tool spec. When the LLM calls the tool, Skrun validates the arguments against the schema (via Ajv) **before** spawning the script. Invalid arguments return an error to the LLM (which can self-correct) and do NOT execute the script.

**Example:**

```yaml
tools:
  - name: pdf-extract
    description: "Extract text content from a PDF file."
    input_schema:
      type: object
      properties:
        path:
          type: string
          description: "Absolute path to the PDF file."
        max_pages:
          type: integer
          minimum: 1
          default: 10
      required: [path]
      additionalProperties: false
  - name: count-lines
    description: "Count lines of code in a file."
    input_schema:
      type: object
      properties:
        path: { type: string }
      required: [path]
      additionalProperties: false
```

```
my-agent/
├── SKILL.md
├── agent.yaml
└── scripts/
    ├── pdf-extract.js
    └── count-lines.js
```

Scripts are bundled into the `.agent` archive at build time and available on the filesystem at runtime.

> **Breaking change (v0.4.0)**: `tools: ["pdf-extract"]` (string array) is no longer accepted. Wrap each entry in the object form above. This change brings Skrun tool declarations in line with the JSON Schema standard that every LLM provider (Anthropic, OpenAI, Google, Mistral, Groq) expects.

> **Note on MCP**: MCP servers expose their own schemas via the protocol (`tools/list`). Do NOT declare MCP tools in `tools:` — only local scripts. See `mcp_servers` below.

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
  - name: web_search
    description: Search the web and return the top results
    input_schema:
      type: object
      properties:
        query: { type: string }
        max_results: { type: integer, minimum: 1, default: 5 }
      required: [query]
      additionalProperties: false

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
