# agent.yaml Specification

The `agent.yaml` file is Skrun's extension to the Agent Skills standard. It declares runtime configuration, I/O contracts, environment, state, and tests for a deployable agent.

## Fields

### `name` (required)
- **Type**: string
- **Format**: slug — lowercase letters, digits, and hyphens. Same shape as `SKILL.md`'s `name`. Examples: `email-drafter`, `seo-audit`.
- **Regex**: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (no leading or trailing hyphen, no consecutive hyphens, length ≥ 1).
- **No namespace prefix.** The namespace under which the agent is published is determined by the registry at push time from your auth context (your GitHub username on cloud, `dev` for the dev-token in self-host). The bundle's yaml only carries the slug.

> **Migrating from `<namespace>/<slug>` format:** earlier Skrun versions required the form `name: dev/email-drafter`. The slash-prefixed form is no longer accepted — edit your `agent.yaml` to drop the prefix (`name: dev/email-drafter` → `name: email-drafter`) and re-run `skrun push`. The registry derives the namespace from your auth at push, so the bundle stays portable across namespaces (fork, transfer, white-label) without re-editing the yaml.

### `version` (required)
- **Type**: string
- **Format**: semver (e.g., `1.0.0`)

### `model` (required)
- **Type**: object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | enum | Yes | `anthropic`, `openai`, `google`, `mistral`, `groq`, `xai`, `meta` |
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

**Models per provider** (capabilities: image / document / audio / cache). Source of truth: `packages/schema/src/capability.ts`. Refreshed against authoritative provider docs May 2026. Models are grouped by identical capability flags. Snapshot / dated model IDs (e.g. `claude-opus-4-7-20260416`) resolve to their base entry via longest-prefix matching, so they don't need their own row here.

The `cache` column indicates whether the model supports the runtime's prompt-caching wire-up (Anthropic explicit `cache_control`, OpenAI / xAI `prompt_cache_key`, Gemini implicit, Groq implicit on selected models). When `cache=✓`, repeated calls with stable system + tools content benefit from 30-90% input-token discount automatically — no agent.yaml change required. See [docs/concepts.md → Cost & caching](./concepts.md#cost--caching) for the full story.

| Provider | Model | image | document | audio | cache |
|----------|-------|-------|----------|-------|-------|
| anthropic | claude-opus-4-7 / claude-opus-4-6 / claude-opus-4 / claude-sonnet-4-6 / claude-sonnet-4-5 / claude-sonnet-4 / claude-haiku-4-5 / claude-haiku-4 / claude-3-7-sonnet / claude-3-5-sonnet / claude-3-5-haiku / claude-3-opus | ✓ | ✓ | — | ✓ |
| anthropic | claude-3-haiku | ✓ | — | — | ✓ |
| google | gemini-3.1-pro-preview / gemini-3.1-flash-preview / gemini-3.1-flash-lite-preview / gemini-3-flash-preview / gemini-3-deep-think-preview / gemini-2.5-pro / gemini-2.5-flash / gemini-2.5-flash-lite | ✓ | ✓ | ✓ | ✓ |
| openai | gpt-5.5-pro / gpt-5.5 / gpt-5.4-pro / gpt-5.4-mini / gpt-5.4-nano / gpt-5.4 / gpt-5.3-codex / gpt-5-pro / gpt-5 / gpt-4o / gpt-4o-mini | ✓ | ✓ | — | ✓ |
| openai | gpt-4-turbo / o1 | ✓ | — | — | ✓ |
| openai | o1-mini | — | — | — | ✓ |
| openai | gpt-audio / gpt-audio-1.5 / gpt-4o-audio-preview | — | — | ✓ | ✓ |
| mistral | mistral-large-3 / mistral-large-2512 / mistral-medium-3.5 / mistral-medium-2508 / mistral-medium-3 / mistral-small-3.2 / mistral-small-2506 / mistral-small-3.1 / ministral-14b-2512 / ministral-8b-2512 / ministral-3b-2512 | ✓ | — | — | — |
| mistral | mistral-small-4 / mistral-large-latest / ministral-8b / magistral-medium-1.2 | — | — | — | — |
| groq | llama-4-scout-17b-16e-instruct | ✓ | — | — | — |
| groq | openai/gpt-oss-120b / openai/gpt-oss-20b / openai/gpt-oss-safeguard-20b / gpt-oss-120b / gpt-oss-20b | — | — | — | ✓ |
| groq | meta-llama/llama-4-maverick-17b-128e-instruct / qwen/qwen3-32b / llama-3.3-70b-versatile / llama-3.1-8b-instant / groq/compound / groq/compound-mini | — | — | — | — |
| xai | grok-4.3 / grok-4.1-fast / grok-4.20-multi-agent | ✓ | — | — | ✓ |

Notes:
- Snapshot IDs (e.g. `claude-opus-4-7-20260416`, `gpt-5.5-2026-04-23`, `gemini-3-flash-preview-001`) resolve to the base entry via longest-prefix matching — declare them in your `agent.yaml` as-is.
- Anthropic PDF support: every active Claude 4.x / 3.5+ model accepts PDFs via the `document` content block (URL / base64 / Files API). Claude 3 Haiku is the only entry without doc support.
- OpenAI PDF support: vision-capable models accept PDFs via the Files API (`purpose: user_data`); the system extracts text+images server-side. `o1-mini` and the gpt-audio family are text/audio only.
- Gemini accepts video natively (mp4/mpeg/mov/avi/flv/mpg/webm/wmv/3gpp, plus YouTube URLs); Skrun's runtime does not yet wire video as an input modality. Wiring it is tracked on the runtime backlog.
- xAI Grok 4.3 also accepts video natively (mp4/mov/webm, ≤5 min, ≤1080p) — same backlog item as above.
- **Specialist models on dedicated endpoints** are intentionally NOT in the matrix because the Skrun runtime currently calls `/v1/chat/completions` only. Multi-endpoint routing is on the runtime backlog:
    - Mistral Voxtral (audio chat + STT + realtime + TTS) — `/v1/chat/completions` for the chat variant; `/v1/audio/transcriptions` and `/v1/audio/speech` for STT/TTS.
    - Mistral OCR 3 (document parsing) — `/v1/ocr`.
    - Groq Whisper (audio transcription) — `whisper-large-v3`, `whisper-large-v3-turbo` on `/v1/audio/transcriptions`.
    - OpenAI `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` on `/v1/audio/transcriptions`; `gpt-realtime`, `gpt-realtime-1.5` on `/v1/realtime`; `gpt-image-2`, `gpt-image-1.5` on `/v1/images/*`.
    - xAI Voice API (STT/TTS) and Imagine API (image + video generation).
- Self-hosted models accessed via `base_url` are not in this table — capability validation is skipped for unknown model names (the runtime treats them as opaque pass-through).

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

### `tool_choice` (optional)
- **Type**: string
- **Default**: `auto`
- **Values**: `auto` | `required` | `none` | `<tool-name>`

Forces the LLM to invoke (or skip) tools rather than relying on prompt phrasing. Useful when a model would otherwise satisfy the output schema without calling a side-effecting tool — observed frequently on Gemini Flash with artifact-writing agents.

| Value | Behavior |
|-------|----------|
| `auto` (default) | LLM decides whether and which tools to call (current behavior, no provider directive sent). |
| `required` | LLM must call **at least one** declared tool before producing a final response. |
| `none` | LLM must not call any tool. |
| `<tool-name>` | LLM must call the named tool (must match a declared tool). |

```yaml
tools:
  - name: write_artifact
    description: Write a Markdown file to the run output directory.
    input_schema: { ... }

tool_choice: write_artifact   # force this exact tool every run
```

### `parallel_tools` (optional)
- **Type**: boolean
- **Default**: `true`

Whether the model may emit multiple tool calls in parallel within one response. Set to `false` to force at-most-one tool call per turn (useful for ordered workflows or rate-limited tools).

```yaml
parallel_tools: false
```

### Per-tool `required` flag

In addition to top-level `tool_choice`, individual tools can declare `required: true` to model a "this tool must always fire" invariant (e.g., an audit-log tool that should run regardless of caller intent):

```yaml
tools:
  - name: audit_log
    description: Append an audit entry. Always called.
    input_schema: { ... }
    required: true       # this tool must be called
  - name: search
    description: Search docs (optional).
    input_schema: { ... }
```

**Precedence rules** (when both top-level and per-tool flags are set):
- Top-level `tool_choice: none` or a specific tool name **wins** outright; per-tool `required: true` is ignored.
- Top-level `tool_choice: required` + per-tool `required: true` → **subset** semantics (the LLM must call at least one tool from the required subset).
- Top-level absent or `auto` + per-tool `required: true` → behaves like `tool_choice: <that-tool>` (or subset for multiple).

### Provider support matrix

Each provider implements tool-choice differently — Skrun translates to the native API shape:

| Capability | Anthropic | Gemini | OpenAI | xAI |
|------------|-----------|--------|--------|-----|
| `auto` / `required` / `none` / specific tool | ✓ | ✓ | ✓ | ✓ |
| Subset of N tools (multiple `required: true`) | ✗ → soft fallback to `required` + warning | ✓ native (`allowed_function_names`) | ✗ → soft fallback | ✗ → soft fallback |
| `parallel_tools: false` | ✓ (`disable_parallel_tool_use`) | ✗ → no-op + warning | ✓ (`parallel_tool_calls: false`) | ✓ (OpenAI compat) |

When a directive isn't natively supported, the runtime degrades gracefully (collapses to the closest supported mode + structured warning in logs) rather than rejecting the agent.

### Script dependencies

If your `scripts/` import third-party libraries, declare them in a standard manifest file at the bundle root. Skrun's runtime detects the manifest, resolves the dependencies once, and caches them at `~/.skrun/deps/<hash>/` for every subsequent run.

**No new `agent.yaml` field.** Detection is filesystem-based: the runtime scans the bundle root for one of the manifests below.

#### Supported manifests

| File at bundle root | Ecosystem | Resolver |
|---------------------|-----------|----------|
| `package.json` | Node | `npm` (default) — `npm install --prefix=<cache>` |
| `requirements.txt` | Python | `pip install -r requirements.txt` (pinned versions in the file = the lock) |
| `pyproject.toml` (PEP 621) | Python | `pip install <bundle>` (PEP 517) |

**Lockfile precedence** (auto-detected, all optional):

| Lockfile | Triggers | Resolver invocation |
|----------|----------|---------------------|
| `pnpm-lock.yaml` | Node | `pnpm install --frozen-lockfile --dir=<cache>` |
| `yarn.lock` | Node | `yarn install --frozen-lockfile --cwd=<cache>` |
| `package-lock.json` | Node | `npm ci --prefix=<cache>` |
| `uv.lock` | Python (with `pyproject.toml`) | `uv sync --frozen` (uv bootstrapped via pip) |
| `poetry.lock` | Python (with `pyproject.toml`) | `poetry install --no-root` (poetry bootstrapped via pip) |

When both Python manifests are present, `pyproject.toml` wins and `requirements.txt` is ignored. For Node lockfile precedence: `pnpm-lock.yaml` > `yarn.lock` > `package-lock.json`.

#### Reproducible builds

Without a lockfile, the install resolves the latest version satisfying each declared range. The runtime emits a `non-reproducible build` warning to install logs (visible in `skrun logs`). **Add a lockfile to your bundle for reproducible installs.**

#### Caching

Resolved dependencies live at `~/.skrun/deps/<sha256>/`, where the hash is `SHA-256(<ecosystem>\n<manifestKind?>\n<manifestContent>\n[lockfileKind?]\n[lockfileContent])`. The hash is **content-only** — two bundles with identical manifest text on different machines produce the same hash, so cache entries are shareable across hosts (and across container build layers in cloud setups).

Manage the cache with the [`skrun cache`](cli.md#skrun-cache) CLI subcommands (`list`, `clear`).

#### Install network policy

Install-time network access is **separate** from your agent's runtime `environment.networking.allowed_hosts`. The install allowlist is fixed in code (security perimeter, not user-configurable in v1):

- `registry.npmjs.org` (npm / pnpm)
- `registry.yarnpkg.com` (yarn)
- `pypi.org` + `files.pythonhosted.org` (pip / uv / poetry)

Your agent's `environment.networking.allowed_hosts` continues to govern what scripts may reach **at runtime**, after the install completes.

#### Example: Python with pinned `requirements.txt`

```
my-agent/
├── SKILL.md
├── agent.yaml
├── requirements.txt        ← pandas==2.2.3 / matplotlib==3.10.0
└── scripts/
    └── analyze.py          ← imports pandas
```

```text
# requirements.txt
pandas==2.2.3
matplotlib==3.10.0
```

#### Example: Node with pnpm lockfile

```
my-agent/
├── SKILL.md
├── agent.yaml
├── package.json            ← declares jszip
├── pnpm-lock.yaml          ← reproducible install
└── scripts/
    └── build_zip.js        ← imports jszip
```

```json
{
  "name": "my-agent-deps",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "jszip": "^3.10.1" }
}
```

#### Build-time exclusions

`skrun build` automatically excludes `node_modules/`, `venv/`, `.venv/`, `__pycache__/`, and `.pytest_cache/` from the produced `.agent` tar. Only the manifest + lockfile travels in the bundle; the install happens on the runtime host (or in a Docker layer for cloud).

If your `scripts/` directory contains imports beyond the language stdlib but no manifest is found, `skrun build` emits a `SCRIPTS_NO_MANIFEST` warning so you can add the manifest before deploy.

#### Cold start vs warm cache

| Run | Behavior | Latency |
|-----|----------|---------|
| First run for a given hash | Resolver downloads + installs deps | ~30s for typical Python (pandas) / ~5s for Node (jszip) |
| Subsequent runs | Cache hit, path lookup only | < 5 ms |

#### Failure handling

If the install fails (registry down, package not found, network error), the runtime raises `SCRIPT_DEPS_INSTALL_FAILED` and the script does **not** spawn. The error surfaces to the LLM tool-call loop with `isError: true`. The failed install is **memoized** for the lifetime of the runtime instance — subsequent calls return the cached rejection without retrying (avoids hammering the registry on persistent failure).

#### Out of scope (for now)

- `uv` as the default resolver (use `pip` for universality; `uv` opt-in via `uv.lock`)
- Other languages: Go modules, Cargo, Ruby gems, Composer
- Lockfile auto-generation (Skrun reads lockfiles, never writes them)
- System packages (`apt-get`) — runtime image's job
- Private registries (npm Enterprise, internal PyPI)

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

Two input shapes are supported: **primitive** (text/JSON) and **file** (binary — image/PDF/audio).

**Primitive inputs**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Input field name |
| `type` | enum | Yes | `string`, `number`, `boolean`, `object`, `array` |
| `required` | boolean | No | Default: `true` |
| `description` | string | No | Human-readable description |
| `default` | any | No | Default value |

**File inputs** (image / PDF / audio)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Input field name |
| `type` | const | Yes | Must be `file` |
| `media` | enum | Yes | `image`, `document` (PDF), or `audio` |
| `mime_types` | string[] | No | MIME allowlist (e.g. `[image/jpeg, image/png]`). Defaults below. |
| `max_size` | integer | No | Max bytes per file. Defaults below. |
| `max_count` | integer | No | Max number of files in this field (1 = single file, >1 = array). Default: `1` |
| `required` | boolean | No | Default: `true` |
| `description` | string | No | Human-readable description |

**Defaults per `media`**

| Media | Default `mime_types` | Default `max_size` |
|-------|---------------------|---------------------|
| `image` | `image/jpeg`, `image/png`, `image/webp`, `image/heic` | 5 MB |
| `document` | `application/pdf` | 25 MB |
| `audio` | `audio/wav`, `audio/mp3`, `audio/mp4`, `audio/m4a`, `audio/webm` | 25 MB |

> **Capability check at deploy/push**: if any `file` input declares a `media` type the chosen model (or its fallback) cannot process — e.g. `media: audio` with `model: anthropic/claude-3-7-sonnet` — `skrun push` and `skrun deploy` refuse the operation with a clear error before any network call. The matrix lives in `@skrun-dev/schema/capability.ts`. Self-hosted models bypass the check (operator's responsibility).

**Wire format on `POST /run`**: file inputs always use an array of source descriptors — see [API → Uploading input files](api.md#uploading-input-files). The SDK auto-uploads `Blob` / `File` / `Uint8Array` values transparently.

**Examples**

```yaml
inputs:
  # Primitive
  - name: question
    type: string
    required: true

  # Single image (e.g., a screenshot)
  - name: screenshot
    type: file
    media: image
    mime_types: [image/png, image/jpeg]
    max_size: 5_000_000
    required: true

  # Up to 20 receipt photos
  - name: receipts
    type: file
    media: image
    max_count: 20
    description: Receipt photos to read and tabulate.

  # A PDF report
  - name: report
    type: file
    media: document
    mime_types: [application/pdf]
    max_size: 25_000_000

  # Voice memo (Gemini / gpt-4o-audio only)
  - name: memo
    type: file
    media: audio
    max_size: 10_000_000
```

### `outputs` (required)
- **Type**: array (min 1)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Output field name |
| `type` | enum | Yes | `string`, `number`, `boolean`, `object`, `array` |
| `description` | string | No | Human-readable description |

**Runtime validation.** At the end of every run, Skrun validates the agent's final JSON output against the declared `outputs`. All declared top-level fields must be present with the declared type; extra top-level keys are allowed. Nested arrays/objects accept any internal shape.

If validation fails, Skrun emits an `output_validation_warning` event and issues a single isolated repair call to the LLM with the validation errors. The retry's token usage is summed into the final `usage` regardless of outcome. If the repair output still fails validation (or is not valid JSON), the run terminates with `run_error` and `error.code: OUTPUT_SCHEMA_INVALID` — no `run_complete` is emitted.

### `environment` (optional)

Defines how and where the agent runs — networking, filesystem access, execution constraints. All fields have defaults; the entire section can be omitted.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `networking.allowed_hosts` | string[] | `[]` | Outbound host allowlist (see below) |
| `filesystem` | enum | `read-only` | `none`, `read-only`, `read-write` |
| `secrets` | string[] | `[]` | Required secret names (injected as env vars) |
| `timeout` | string | `300s` | Max execution time (format: `Ns`) |
| `max_cost` | number | - | Cost cap per run in USD |
| `sandbox` | enum | `strict` | `strict` or `permissive` |

**Networking modes** (inferred from `allowed_hosts`):

| `allowed_hosts` | Mode | Behavior |
|----------------|------|----------|
| `[]` (default) | Blocked | All outbound blocked. Remote MCP connections refused. |
| `["api.github.com", "*.slack.com"]` | Allowlist | Only matching hosts. Glob `*` matches subdomains (`*.github.com` matches `api.github.com` but not `github.com`). |
| `["*"]` | Unrestricted | All non-private hosts allowed. |

Private/internal IPs (127.*, 10.*, 192.168.*, localhost, etc.) are **always blocked**, even in unrestricted mode.

Enforcement: MCP remote connections are checked before connect. Tool scripts receive `SKRUN_ALLOWED_HOSTS` env var (advisory — real TCP enforcement comes with container-based execution).

**Script environment variables**: tool scripts receive the following env vars automatically:

| Env var | Value | Purpose |
|---------|-------|---------|
| `SKRUN_ALLOWED_HOSTS` | Comma-separated allowed hosts | Network allowlist (advisory) |
| `SKRUN_OUTPUT_DIR` | Path to output directory | Write files here to produce deliverables (see [Files API](api.md#files-api)) |

**Per-run override**: callers can override any environment field in the POST /run request body (see [API docs](api.md#post-run)).

> **Migration from v0.4.0**: `permissions` and `runtime` top-level fields were replaced by `environment` in v0.5.0. See [CHANGELOG](../CHANGELOG.md) for the migration guide.

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

environment:
  networking:
    allowed_hosts: ["googleapis.com", "*.target-site"]
  filesystem: read-only
  secrets: [GSC_API_KEY]
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
