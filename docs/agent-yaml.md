# agent.yaml Specification

The `agent.yaml` file is Skrun's extension to the Agent Skills standard. It declares runtime configuration, I/O contracts, environment, state, and tests for a deployable agent.

It holds configuration only, and may weigh at most **128 KB** (131,072 bytes) — a fixed limit of every server, no setting raises it. A push past it is refused with `413 CONFIG_TOO_LARGE` before the file is parsed, and `skrun build` warns. Long content — instructions, context, reference data — belongs in `SKILL.md`, `AGENTS.md` or other files of the bundle.

YAML aliases are not accepted: a value written `*name`, repeating the one an anchor `&name` marks — a merge key `<<: *name` included —, is refused (`400 INVALID_CONFIG` at push, an error of `skrun build` and of every command that validates the agent). Write the value out wherever it is used. An anchor that no alias repeats is accepted.

`agent.yaml` is read as YAML 1.2 — a fixed choice, which a later version of YAML does not change. A `%YAML` directive that declares another version — `%YAML 1.1`, say — is refused the same way: remove the line. A value YAML 1.1 reads otherwise is then read as YAML 1.2 reads it — `yes` and `no`, for one, are strings there, not booleans. `%YAML 1.2` and `%TAG` directives are accepted. The tag `!!omap`, YAML 1.1's ordered map, is refused the same way, under any name it is written with (`!<tag:yaml.org,2002:omap>`, a `%TAG` handle): write a mapping instead.

At push, the server may take at most **2 seconds** to read `agent.yaml` — a fixed budget of every server, no setting changes it. An ordinary `agent.yaml` reads in a few milliseconds, but some shapes of YAML take the parser far longer than their size: lines of deeply nested lists written compact (`- - - … 1`), for one. A push whose `agent.yaml` takes longer is refused with `400 INVALID_CONFIG`, the message saying it is too complex to read: simplify it. `skrun build` and the other commands read it on your machine, with no budget, and do not warn. A run reads it the same way as the push, within the same 2 seconds, once for as long as the server keeps the agent's bundle in its cache: a version pushed before this budget whose `agent.yaml` takes longer gets `500 INVALID_CONFIG` at its runs.

A value or a key that holds U+0000, the NUL character — an escape such as `\0` or `\u0000` in a double-quoted string, or the character itself —, or a lone surrogate — half of a UTF-16 pair without its other half, an escape such as `\uD800` in a double-quoted string, written without its other half — is refused at push with `400 INVALID_CONFIG`, the message naming the field: the server records a version's configuration, and a Postgres database stores neither. A whole character written as its two escapes (`\uD83D\uDE00`) is accepted. In a single-quoted string, a backslash is a backslash: these escapes stay as written. `skrun build` and the other commands do not check it.

## Fields

### `name` (required)
- **Type**: string
- **Format**: slug — lowercase letters, digits, and hyphens. Same shape as `SKILL.md`'s `name`. Examples: `email-drafter`, `seo-audit`.
- **Regex**: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (no leading or trailing hyphen, no consecutive hyphens, length ≥ 1).
- **No namespace prefix.** The namespace under which the agent is published is determined by the registry at push time from your auth context (your GitHub login in lowercase by default on cloud, `<login>--2` if it is taken; `dev` for the dev-token in self-host). The bundle's yaml only carries the slug.

> **Migrating from `<namespace>/<slug>` format:** earlier Skrun versions required the form `name: dev/email-drafter`. The slash-prefixed form is no longer accepted — edit your `agent.yaml` to drop the prefix (`name: dev/email-drafter` → `name: email-drafter`) and re-run `skrun push`. The registry derives the namespace from your auth at push, so the bundle stays portable across namespaces (fork, transfer, white-label) without re-editing the yaml.

### `version` (required)
- **Type**: string
- **Format**: semver (e.g., `1.0.0`)

### `model` (required)
- **Type**: object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | enum | Yes | `anthropic`, `openai`, `google`, `mistral`, `groq`, `xai`, `meta` — `meta` only with a `base_url`, and never for a `fallback` (see below) |
| `name` | string | Yes | Model name (e.g., `gemini-3.8-flash`). A model on the list of retired models (`RETIRED_MODELS`, exported by `@skrun-dev/schema`) — one its provider has retired, or has announced the day it retires — stays valid, and `skrun build` warns `MODEL_RETIRED`, naming the day and a replacement when there is one — a model of the same provider, in the capability matrix, that takes every input the retired one took. A retired model the list does not name gets no warning. |
| `temperature` | number | No | 0-2, controls randomness. Some models refuse any value but their default, and Google's ignore it from Gemini 3.6 Flash on — Google has deprecated the setting and says its next models will refuse it; the runtime acts on the ones the capability matrix (`packages/schema/src/capability.ts`) marks — for instance Claude Sonnet 5.5, Claude Opus 4.7, GPT-5, GPT-6.1 Sol and Gemini 3.8 Flash: it does not send it to them (their default applies) and `skrun build` warns `TEMPERATURE_UNSUPPORTED`, naming the model. A model outside the matrix receives it as declared, whether it accepts one or not, when it is called at the agent's `base_url` (the primary model only) or when its provider is Mistral, Groq or xAI; an Anthropic, Google or OpenAI model called at its provider's own API gets none, with the same warning — their latest models refuse or ignore one. |
| `base_url` | string | No | Custom API endpoint (for self-hosted models — Ollama, vLLM, LocalAI). Any OpenAI-compatible endpoint. Required with `provider: meta`. |
| `fallback` | object | No | Backup model: takes over when a call of the primary model fails, or goes unanswered (45 s by default), before any tool has run — never once one has: the run then fails. A creator key you attach for its provider also serves a run whose caller's key for the primary model fails (see [Concepts → LLM keys](./concepts.md#llm-keys)) |
| `fallback.provider` | enum | Yes (if fallback) | Same as provider, save `meta` (see below) |
| `fallback.name` | string | Yes (if fallback) | Same as name |

**Custom endpoints**: set `base_url` to use any OpenAI-compatible API. Works with self-hosted models, Chinese providers, and inference platforms.

**`meta` has no endpoint of its own.** An agent whose `provider` is `meta` sets `base_url` to the OpenAI-compatible endpoint that serves the model; without one, validation refuses the agent, `MODEL_BASE_URL_REQUIRED`. A `fallback` is called at its provider's own endpoint — it takes no `base_url` —, so a fallback whose provider is `meta` is refused the same way, whatever the primary model declares: pick another provider for it. See [Refused settings](#refused-settings).

> **Use the final URL — one that does not redirect.** If your `base_url` answers with a redirect to another origin (`http://` → `https://`, another port, another host), the `Authorization` header is dropped on the redirected request, as the fetch standard requires, and the provider answers `401` even though your key is right. Check with `curl -sI <base_url>/chat/completions`: a `301`/`302`/`307` there means you should write the target URL in `base_url` instead.

```yaml
# Self-hosted (Ollama, vLLM, LocalAI)
# Needs SKRUN_ALLOW_LOCAL_MODEL_HOSTS=true on the server — see below.
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

### Which key goes to your `base_url`

A custom `base_url` is chosen by whoever writes the `agent.yaml`. The key on the
request may belong to someone else — so the rule the runtime enforces is:

> **A key is only sent to an endpoint chosen by that key's owner.**

| Key | Who owns it | What happens |
|-----|-------------|--------------|
| **Creator key** attached to the agent | you, the author | Used with your `base_url`. Nothing to configure — you chose both. |
| **Caller key** (`X-LLM-API-Key`), caller is you | you | Same: used with your `base_url`. This is the normal local/self-host flow. |
| **Caller key**, caller is *someone else* | the caller | With a key for your primary model's provider — the one key sent to your `base_url` — they must name the origin they expect, in `X-LLM-Base-URL` (e.g. `{"openai": "https://api.deepseek.com"}`). Otherwise the run is refused with `403 CALLER_BASE_URL_NOT_CONSENTED`, which names your endpoint so they can decide. Compared by origin — the path need not match. A key for your `fallback`'s provider, when it is another one, is never sent to your `base_url` and needs no origin named. Every origin they do name must be where that provider's key goes, whether they send keys or not: yours, for your primary model's provider, and none for any other provider — your `fallback`'s included, since you declare no endpoint for it. Anything else is refused the same way. |
| **Server key** (`OPENAI_API_KEY` etc. on the host) | the operator | **Not sent to a custom `base_url` by default.** An operator running only their own agents can opt in with `SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true`. |

*(Before v1.0 the server key was paired with any agent-declared `base_url`
automatically. On a multi-tenant host that let an agent author direct the
operator's credential at a host of their choosing, so it is now opt-in.)*

### Local inference endpoints

`base_url` values on private or loopback addresses — `http://localhost:11434/v1`,
`127.0.0.1`, `192.168.x.x`, link-local — are **refused by default**, because the
LLM loop runs in the server process rather than in the agent sandbox, so the
agent's `allowed_hosts` rules do not constrain it. So is a redirect from your
`base_url` to such an address.

Running Ollama / vLLM / LocalAI on the same host is exactly what the feature is
for, so an operator enables it explicitly:

```bash
SKRUN_ALLOW_LOCAL_MODEL_HOSTS=true
```

Leave it off on any host that runs agents you did not write.

**Models per provider** (capabilities: image / document / audio / cache). Source of truth: `packages/schema/src/capability.ts`. Refreshed against the providers' docs on 2026-10-28: each row is an id the provider's API takes, for a text model the runtime calls on its chat endpoint; a retired model is no longer listed. Models are grouped by identical capability flags. Snapshot / dated model IDs (e.g. `claude-opus-4-7-20260416`) resolve to their base entry via longest-prefix matching, so they don't need their own row here.

The `cache` column indicates whether the model supports the runtime's prompt-caching wire-up (Anthropic explicit `cache_control`, OpenAI / Mistral / xAI `prompt_cache_key`, Gemini implicit, Groq implicit on selected models). When `cache=✓`, repeated calls with stable system + tools content benefit from 30-90% input-token discount automatically — no agent.yaml change required. See [docs/concepts.md → Cost & caching](./concepts.md#cost--caching) for the full story.

| Provider | Model | image | document | audio | cache |
|----------|-------|-------|----------|-------|-------|
| anthropic | claude-opus-5-5 / claude-sonnet-5-5 / claude-fable-5-2 / claude-mythos-5-2 / claude-fable-5-1 / claude-mythos-5-1 / claude-fable-5 / claude-mythos-5 / claude-opus-5 / claude-sonnet-5 / claude-opus-4-8 / claude-opus-4-7 / claude-opus-4-6 / claude-opus-4-5 / claude-sonnet-4-6 / claude-haiku-5-5 / claude-haiku-4-5 | ✓ | ✓ | — | ✓ |
| google | gemini-4-argon / gemini-3.8-flash / gemini-3.6-flash / gemini-3.5-flash-lite / gemini-3.1-pro-preview / gemini-3-flash-preview / gemini-2.5-pro / gemini-2.5-flash / gemini-2.5-flash-lite | ✓ | ✓ | ✓ | ✓ |
| openai | gpt-6.1-sol / gpt-6.1-terra / gpt-6-astra / gpt-6-sol / gpt-6-luna / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano / gpt-5.2 / gpt-5 / gpt-5-mini / gpt-5-nano / gpt-4o / gpt-4o-mini | ✓ | ✓ | — | ✓ |
| openai | gpt-audio-1.5 | — | — | ✓ | — |
| mistral | mistral-medium-2604 / mistral-large-4 / mistral-large-2512 / mistral-large-latest / mistral-small-2603 | ✓ | — | — | ✓ |
| groq | openai/gpt-oss-120b / openai/gpt-oss-20b / openai/gpt-oss-safeguard-20b | — | — | — | ✓ |
| xai | grok-4.7 / grok-4.6 / grok-4.5 / grok-4.3 / grok-4.20-0309-reasoning / grok-4.20-0309-non-reasoning / grok-build-0.1 | ✓ | — | — | ✓ |

Notes:
- Snapshot IDs (e.g. `claude-opus-4-7-20260416`, `gpt-5.5-2026-04-23`, `gemini-3-flash-preview-001`) resolve to the base entry via longest-prefix matching — declare them in your `agent.yaml` as-is.
- Anthropic PDF support: every Claude model listed accepts PDFs via the `document` content block (URL / base64 / Files API).
- OpenAI PDF support: vision-capable models accept PDFs via the Files API (`purpose: user_data`); the system extracts text+images server-side. `gpt-audio-1.5` is text/audio only.
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

**How it works**: you create a `scripts/` directory, write your tools (Node.js, TypeScript, or Python — read JSON args from stdin, write result to stdout), and declare them in `tools`. At runtime, Skrun passes `input_schema` to the LLM as the tool spec. When the LLM calls the tool, Skrun validates the arguments against the schema (via Ajv) **before** spawning the script. Invalid arguments return an error to the LLM (which can self-correct) and do NOT execute the script. Arguments nested more than 100 levels deep — objects and arrays inside one another — are refused the same way for every tool, a script's or an MCP server's: the tool is not called, and the LLM reads an error that names the bound.

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

> **A tool result over 1 MiB, and a run's 8 MiB of tool results.** On both runtimes, each tool call — a script's or an MCP server's — answers the model in at most 1 MiB (1,048,576 bytes of UTF-8 of its JSON answer, escapes included). A larger result reaches the model cut, between two characters, and ending with `[Result truncated: it was larger than 1 MiB. Only the beginning is shown.]`; an error result stays an error. On the cloud runtime the sandbox cuts it; on the `local` runtime the server cuts it once the tool has answered. What a tool may hand back before the cut is bounded apart, the same on both runtimes: a script's standard output and error output, up to 5 MiB each — past either, the call fails with an error that names that cap, and its result is otherwise its standard output, or, when it fails, its error output (the failure's own message when that output is empty); a local (`stdio`) MCP server's result as long as its whole message — the result inside its JSON-RPC envelope — stays within 10 MiB; no bound on a remote MCP server's. Until it is cut, the whole result is held by the sandbox on the cloud runtime, and by the server process on `local`. A run keeps at most 8 MiB of tool results in all, counted as the bytes of UTF-8 of the tools' results the model reads, errors included: a result that would take it past 8 MiB is replaced by `[Result not kept: with it, the tool results of this run would weigh more than 8 MiB, the most a run keeps. This call's result is left out.]`, which the model reads in its place — an error keeps the code it starts with (`[CODE] `) in front of it —, and the run goes on; a smaller result that still fits later is kept, and no result the model has read is changed. The run's `tool_result` events carry what the model reads. On both runtimes, a local MCP server that writes a message larger than 10 MiB — counted as it writes it, JSON-RPC envelope included — has its connection closed: every call waiting on that connection fails with an error that names the limit, and is not retried, since the tool may already have run. The failed call returns once the server has been started again for the calls that follow; if it does not start, those calls fail with `MCP server not connected` for the rest of the run — on the `local` runtime, the next run starts it again. On the cloud runtime, a server slow to start again can make the call outlast the time the sandbox has to answer it, and the model then reads a timeout instead of the limit. A tool whose result can grow that large should write it to a file instead (see [Output files](api.md#output-files)) and return what the model needs.

<a id="bounds-of-a-run"></a>

> **The bounds of a run.** Whatever the model — an endpoint you declare in `model.base_url` answers what it likes —, a run is held to these, on both runtimes. They are fixed: no setting changes them.
> - **10 model calls in the tool loop.** When the tenth answer still asks for tools, those tools run, then the loop stops without calling the model again, and the run's output becomes `{ "result": "[Max tool iterations reached — agent may need fewer tool calls or a higher iteration limit]" }`. An agent whose only output is a `result` string — the output `skrun init` writes — ends there, with that text; any other output schema refuses it, and the output repair, which sees the conversation up to the last tool results and may call no tool, has one try to give a valid output.
> - **128 tool calls in one answer.** More, and none of them runs: the run fails with `TOO_MANY_TOOL_CALLS`.
> - **4 MiB per response of a `model.base_url`**, counted once decompressed, and read within what is left of the run's `timeout`: past it, `MODEL_RESPONSE_TOO_LARGE`. Such an endpoint answering `429` or `5xx` is asked at most three times in all, within about 1.5 s, whatever its `Retry-After` says. A provider called at its own API is not bounded this way: the model's own output limit bounds it.
> - **4 MiB of the model's answers in a run**, the output repair included — each answer counted as the conversation keeps it, as the provider returned it: its text, its reasoning and its tool calls: past it, `MODEL_OUTPUT_BUDGET_EXCEEDED`.
> - **1 MiB for the JSON object of the final answer**, before it is parsed: past it, `OUTPUT_TOO_LARGE`.
> - **8 MiB of tool results**, the box above, and **100 levels of nesting** for the input, the output, the state and a tool call's arguments.
>
> A run stopped on one of these codes fails as a run over its `max_cost` does (see [API → SSE Streaming](api.md#sse-streaming), *About `COST_EXCEEDED`*). When the first answer of the primary model asks for more than 128 tool calls, or when a response of its `model.base_url` is larger than 4 MiB, a `fallback` you declare takes over instead, as it does for any call that fails before a tool has run — unless that refused answer alone cost more than the run's whole `max_cost`: the run then fails on `TOO_MANY_TOOL_CALLS`.

> **Note — verification never filters scripts.** Whether a version that is not verified may run is the operator's verification policy (`SKRUN_VERIFICATION_POLICY`), and it decides for the whole run, scripts included: under `admin` (the default), an unverified version is refused before anything runs — `403 AGENT_NOT_VERIFIED`, no model call, no tool, no script; under `owner` and `disabled`, every version runs, scripts included. Where a script runs is the runtime's choice, not verification's: on the `flyio` runtime, inside the run's own sandbox machine; on the `local` runtime, as a child process of the API server, on its host. Verification is per version, flipped with `PATCH /api/agents/:ns/:name/versions/:version/verify` (see [Verify a version](api.md#verify-a-version)); who may flip it is set by the same policy. In dev mode (`dev-token`) the caller is an admin: it can verify its own versions (`skrun verify`), and under `admin` it still has to before a run.

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

Some models refuse a forced tool choice altogether — `required`, a named tool, or a subset — and answer `400` to every such request: Claude Opus 5.5, Sonnet 5.5, Fable 5.2, Mythos 5.2, Fable 5.1 and Mythos 5.1, whose thinking is always on, each marked in `packages/schema/src/capability.ts`. The runtime sends `auto` to them instead, with the same structured warning, and `skrun build` warns `TOOL_CHOICE_UNSUPPORTED`, naming the model: the model may then answer without calling the tool, so an agent that depends on it should pick another model.

### Script dependencies

If your `scripts/` import third-party libraries, declare them in a standard manifest file at the bundle root. Skrun's runtime detects the manifest and installs the dependencies where your scripts run: on a server that runs them itself (the `local` runtime), once, cached at `~/.skrun/deps/<hash>/` for every subsequent run; in the cloud sandbox, at the start of each run, for that run only — see [In the cloud sandbox](#in-the-cloud-sandbox). Node scripts can `import` or `require` what they declare.

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

Resolved dependencies live at `~/.skrun/deps/<sha256>/`, where the hash is `SHA-256(<ecosystem>\n<manifestKind?>\n<manifestContent>\n[lockfileKind?]\n[lockfileContent])`. The hash is **content-only** — two bundles with identical manifest text on different machines produce the same hash, so cache entries are shareable across hosts (a shared `SKRUN_DEPS_DIR` mount, for instance). This cache belongs to the server that runs your scripts; the cloud sandbox has its own, which lasts one run.

Manage the cache with the [`skrun cache`](cli.md#skrun-cache) CLI subcommands (`list`, `clear`).

#### Install network policy

The installers fetch packages from fixed public registries (not user-configurable in v1):

- `registry.npmjs.org` (npm / pnpm)
- `registry.yarnpkg.com` (yarn)
- `pypi.org` + `files.pythonhosted.org` (pip / uv / poetry)

That list says where packages come from; it is not a network of its own, separate from your agent's `environment.networking.allowed_hosts`:

- **`local` runtime**: the registries are passed to each installer through its environment. Nothing at the system level confines an installer — nor a package's own install script — and your agent's `allowed_hosts` is advisory for scripts (see [`environment`](#environment-optional)).
- **Cloud sandbox**: one firewall covers every process of the run, installers and scripts alike. It keeps these registries reachable for the whole run — your scripts can reach them too, after the install — beside what your agent's `allowed_hosts` lets through.

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

On the cloud runtime, lock with `package-lock.json` instead: see [In the cloud sandbox](#in-the-cloud-sandbox).

#### Build-time exclusions

`skrun build` automatically excludes `node_modules/`, `venv/`, `.venv/`, `__pycache__/`, and `.pytest_cache/` from the produced `.agent` tar. Only the manifest + lockfile travels in the bundle; the install happens where the scripts run — on the server that runs them, or inside the run's sandbox in the cloud, when the run starts. Nothing is installed into an image ahead of time.

If your `scripts/` directory contains imports beyond the language stdlib but no manifest is found, `skrun build` emits a `SCRIPTS_NO_MANIFEST` warning so you can add the manifest before deploy.

#### Cold start vs warm cache

| Run | Behavior | Latency |
|-----|----------|---------|
| First run for a given hash | Resolver downloads + installs deps | ~30s for typical Python (pandas) / ~5s for Node (jszip) |
| Subsequent runs | Cache hit, path lookup only | < 5 ms |

This table describes a server that runs your scripts itself. In the cloud sandbox, every run is a first run (below).

#### In the cloud sandbox

On the cloud runtime, your scripts run in a sandbox that serves a single run, and the install happens there too:

- **When**: as the run's sandbox is prepared, before your agent's first tool call — a slow install never counts against the time limit of a tool call. The time it took is reported as `init_deps_ms` in the `runner_spawned` event (see [api.md](api.md)).
- **Not shared between runs**: the sandbox lasts one run, and so does its install. Each run that declares dependencies pays for installing them.
- **No compiler**: a package that needs compiling to install — no prebuilt wheel for the sandbox's platform, for Python — fails to install, with `SCRIPT_DEPS_INSTALL_FAILED`. For the same reason, pip there prefers a version that has a prebuilt wheel over a newer one it would have to build: with a requirement that is not pinned, the sandbox may install an older version than a server with a compiler would.
- **npm only, for Node**: the sandbox's image has `npm`, not `pnpm` or `yarn`. Lock a Node bundle with `package-lock.json` (or no lockfile); a `pnpm-lock.yaml` or `yarn.lock` bundle fails to install there, with `SCRIPT_DEPS_INSTALL_FAILED`. The same holds for a server running the published Docker image.
- **Same registries**: the install reaches the registries listed under [Install network policy](#install-network-policy). A package that downloads something from another host while it installs reaches that host only if your agent's `allowed_hosts` does. Otherwise its connection is dropped, not refused: it waits, and the install fails on its time limit (see [Failure handling](#failure-handling)).

#### Failure handling

If the install fails (registry down, package not found, network error), the runtime raises `SCRIPT_DEPS_INSTALL_FAILED` and the script does **not** spawn. The error surfaces to the LLM tool-call loop with `isError: true`. The failed install is **memoized** for the lifetime of the runtime instance — subsequent calls return the cached rejection without retrying (avoids hammering the registry on persistent failure). In the cloud sandbox, a failed install does not stop the run from starting: the first call to one of your scripts returns it.

An install has **180 seconds** in total, on every runtime — not a setting. Past that, the command still running is stopped together with every process it started, and the install fails with `SCRIPT_DEPS_INSTALL_FAILED`, saying it timed out. In the cloud sandbox the usual cause is a package that downloads something, while it installs, from a host the sandbox does not let through.

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
| `auth` | enum | No | `none` (default), the one value accepted. `api_key` and `oauth2` are not yet supported — no credential would be sent to the server —, so validation refuses either, on any transport, `UNSUPPORTED_FIELD` (see [Refused settings](#refused-settings)) |

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
| `required` | boolean | No | Default: `true`. An input sent as `null` counts as missing: refused when required; when optional, accepted, its type not judged, and the prompt carries it as `null` |
| `description` | string | No | Human-readable description |
| `default` | any | No | Default value |

An `object` or `array` input accepts any shape inside, up to 100 levels of nesting — objects and arrays inside one another, the run's whole input counting as the first level: a run whose input is nested deeper is refused with `400 INVALID_INPUT_TYPE` before it starts, whatever the declared types.

**File inputs** (image / PDF / audio)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Input field name |
| `type` | const | Yes | Must be `file` |
| `media` | enum | Yes | `image`, `document` (PDF), or `audio` |
| `mime_types` | string[] | No | MIME allowlist (e.g. `[image/jpeg, image/png]`). Defaults below. |
| `max_size` | integer | No | Max bytes per file. Defaults below. |
| `max_count` | integer | No | Max number of files in this field (1 = single file, >1 = array). Default: `1` |
| `required` | boolean | No | Default: `true`. A file input sent as `null` or as an empty list counts as missing: refused when required, left out when optional — the run goes ahead without it |
| `description` | string | No | Human-readable description |

**Defaults per `media`**

| Media | Default `mime_types` | Default `max_size` |
|-------|---------------------|---------------------|
| `image` | `image/jpeg`, `image/png`, `image/webp`, `image/heic` | 5 MB |
| `document` | `application/pdf` | 25 MB |
| `audio` | `audio/wav`, `audio/mp3`, `audio/mp4`, `audio/m4a`, `audio/webm` | 25 MB |

> **Capability check at deploy/push**: if any `file` input declares a `media` type the chosen model (or its fallback) cannot process — e.g. `media: audio` with `model: anthropic/claude-sonnet-5-5` — `skrun push` and `skrun deploy` refuse the operation with a clear error before any network call. The matrix lives in `@skrun-dev/schema/capability.ts`. Self-hosted models bypass the check (operator's responsibility).

**Wire format on `POST /run`**: a file input takes a list of source descriptors, or one descriptor alone for a single file (an empty list counts as missing) — see [API → Uploading input files](api.md#uploading-input-files). The SDK auto-uploads `Blob` / `File` / `Uint8Array` values transparently, and never deletes those uploads: on a server that bounds an account's live uploads, each counts until it expires (see [API → Quotas](api.md#quotas)).

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

  # Voice memo (Gemini / gpt-audio-1.5 only)
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

**Runtime validation.** At the end of every run, Skrun validates the agent's final JSON output against the declared `outputs`. All declared top-level fields must be present with the declared type; extra top-level keys are allowed. Nested arrays/objects accept any internal shape, up to 100 levels of nesting — objects and arrays inside one another, the output itself counting as the first level: an output nested deeper fails validation, whatever its declared types.

If validation fails, Skrun emits an `output_validation_warning` event and issues a single repair call that sends the LLM the validation errors, continuing the first call's conversation: the repair is asked of the model that answered — the primary, or the fallback when it took over —, never of a fallback, and if that model fails, the run fails. The retry's token usage is summed into the final `usage` regardless of outcome. If the repair output still fails validation (or is not valid JSON), the run terminates with `run_error` and `error.code: OUTPUT_SCHEMA_INVALID` — no `run_complete` is emitted.

### `environment` (optional)

Defines how and where the agent runs — networking, execution constraints. All fields have defaults; the entire section can be omitted.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `networking.allowed_hosts` | string[] | `[]` | Outbound host allowlist (see below) |
| `secrets` | string[] | - | Not yet supported — no secret is injected into a run. An empty list is accepted; a list that names a secret is refused by validation, `UNSUPPORTED_FIELD` (see [Refused settings](#refused-settings)) |
| `timeout` | string | `300s` | Max execution time (format: `Ns`), from `1s` to `2147483s` (about 24.8 days): a run given `0s`, or more than a timer can hold, would end at once. A value outside that range is refused by validation, `TIMEOUT_OUT_OF_RANGE` (see [Refused settings](#refused-settings)) — and, at push and in a run's override, before the server's longest timeout is looked at: refused for the range, never for that limit. A server that sets a longest timeout (`SKRUN_RUN_MAX_TIMEOUT_S`) refuses to run an agent that declares more — `400 TIMEOUT_ABOVE_LIMIT`, before any machine starts (see [API → Quotas](api.md#quotas)) — and refuses its push the same way, before anything is stored. An agent that declares none runs up to the `300s` default, and a server whose longest timeout is under it refuses it the same way |
| `max_cost` | number | - | Cost cap per run in USD — **enforced**: the run aborts with a `run_error`/`COST_EXCEEDED` terminus once the aggregate estimated cost crosses it (omit for no cap) |

**Retired: `sandbox` and `filesystem`.** `environment.sandbox` (`strict` / `permissive`) and `environment.filesystem` (`none` / `read-only` / `read-write`) are no longer part of `agent.yaml`: no runtime ever read either, so neither ever selected an isolation level or a filesystem mode. An `agent.yaml` that still carries one stays valid — the field is ignored, and validation reports a `RETIRED_FIELD` warning that names it (`environment.filesystem has no effect and is ignored — remove it.`); remove the line. In the `environment` override of `POST /run`, the same fields are refused with `400 RETIRED_FIELD`.

**Networking modes** (inferred from `allowed_hosts`):

| `allowed_hosts` | Mode | Behavior |
|----------------|------|----------|
| `[]` (default) | Blocked | All outbound blocked. Remote MCP connections refused. |
| `["api.github.com", "*.slack.com"]` | Allowlist | Only matching hosts. Glob `*` matches subdomains (`*.github.com` matches `api.github.com` but not `github.com`) — `local` runtime only, see below. |
| `["*"]` | Unrestricted | Every public address. Never a private or reserved one. |

Wherever the list is enforced (see below), private and reserved addresses are **always blocked**, even under `["*"]`, on both families: `localhost` and loopback, the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local (cloud metadata endpoints included), carrier-grade NAT, multicast, and the ranges reserved for documentation, benchmarking or future use — a name that resolves to one of them included.

What each runtime enforces:

- **`local`** — remote MCP connections and file inputs fetched by URL are checked by the API server before it connects; host patterns (`*.slack.com`) are honoured there. Tool scripts run as child processes of the server and only receive the list in `SKRUN_ALLOWED_HOSTS`: for them it is advisory.
- **`flyio`** — scripts and MCP servers run in the run's sandbox machine, whose firewall enforces the list for every connection. Beside the list, the sandbox always reaches what the runner itself needs: the object store it fetches the bundle from, and the package registries of [Install network policy](#install-network-policy). Named hosts are resolved when the machine is set up for the run, then followed as their addresses change. `["*"]` opens every public address except outbound TCP port 25 (SMTP), refused at once; a list of named hosts has no such restriction. The sandbox filters addresses, never a port or a path: it reads `"*"`, a host name (letters, digits, dots, hyphens and underscores) and an IPv6 literal, bare or in brackets, and nothing else. Any other entry — a host pattern (`*.slack.com`), a host with a port, a URL or a path, for instance — cannot be enforced there: a run whose list holds one — in `agent.yaml` or in the request's `environment` override — is refused before it starts, before any machine, with `400 EGRESS_HOST_UNSUPPORTED`, the message naming each entry by its form; validation (`skrun build`, `skrun push`) warns with the same code. Name each host alone — the sandbox allows a host on every port —, or use `["*"]`; in a list that already holds `"*"`, such an entry adds nothing — remove it.

**An IPv6 literal is its address, however it is written.** Bare or in brackets, its zeros compressed or not, an entry such as `2606:4700::1111` matches a URL that names that address — on both runtimes, and on the cloud runtime whether the run's machine was made for it or taken from the pre-warm pool. A `*.` pattern never matches an IPv6 literal.

**Redirects are held to the same list.** A file input fetched by URL — by the API server, on both runtimes — and a remote MCP server are checked again at every redirect: one that leads to a host outside `allowed_hosts`, or to a private or reserved address however it is written, is refused — `403 URL_NOT_ALLOWED` for a file input, a failed connection for an MCP server. If your URL redirects to another host (a CDN, a storage host), list that host too, or use the final URL.

**Script environment variables**: tool scripts receive the following env vars automatically:

| Env var | Value | Purpose |
|---------|-------|---------|
| `SKRUN_ALLOWED_HOSTS` | Comma-separated allowed hosts | Network allowlist (advisory on the `local` runtime; enforced by the sandbox's firewall on `flyio`) |
| `SKRUN_OUTPUT_DIR` | Path to output directory | Write files here to produce deliverables (see [Output files](api.md#output-files)) |

**Per-run override**: the agent's owner — or an administrator —, on a full-access credential, can override environment fields in the POST /run request body (see [Run an agent](api.md#run-an-agent)). The override is judged as sent, before it is merged: a retired field — `sandbox`, `filesystem` — is refused with `400 RETIRED_FIELD`, a `secrets` list that names a secret with `400 UNSUPPORTED_FIELD`, a `timeout` outside `1s` to `2147483s` with `400 TIMEOUT_OUT_OF_RANGE`. An override that carries none of them never gets a version refused for what its own `agent.yaml` declares.

> **Migration from v0.4.0**: `permissions` and `runtime` top-level fields were replaced by `environment` in v0.5.0. See [CHANGELOG](../CHANGELOG.md) for the migration guide.

### `context_mode` (optional)
- **Type**: enum
- **Default**: `skill`
- **Values**: `skill` (use SKILL.md), `persistent` (use AGENTS.md)

### `state` (optional)
- **Default**: `{ type: "none", scope: "per_caller", ttl: "30d" }` — an agent keeps no state unless it says `type: kv`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | enum | `none` | `kv` (persistent key-value) or `none` |
| `scope` | enum | `per_caller` | `per_caller`: each caller reads and writes only its own notebook — the account's for its own credentials (session, `dev-token`, an account-wide key with every operation), its own for any other key. `shared`: one notebook for every caller of the agent |
| `ttl` | string | `30d` | How long a notebook is kept after its last write (format: `Nd`), from `1d` to `365d` — see below |

A notebook is deleted with its agent, and a caller's notebook with the key it was written under. Deleting an
account (`DELETE /api/account`, or an administrator's `DELETE /api/admin/accounts/:id`) also deletes the
notebooks written under that account and under its keys, and those of its agents. See
[Concepts → State](./concepts.md#state).

**What `_state` may be.** The `_state` an answer carries is a JSON object of keys and values, nested at most 100 levels deep — the object itself is the first level —, or `null` for no state. An empty string, `0` or `false` count as no state too. Anything else — another string or number, `true`, a list — or a deeper object fails the run's output validation: the output repair is asked for once — the `_state` its answer carries, `null` or another empty value included, replaces the first answer's, one that carries none keeps it, and a valid repaired answer ends the run normally —; otherwise the run fails `OUTPUT_SCHEMA_INVALID`, and nothing is written. `_state` is never part of the run's output. An agent of `type: none` keeps no state: the `_state` its answer carries, whatever it is, is set aside.

> ⚠️ **`scope` needs a Skrun server ≥ 2.0.0.** An earlier server drops the field without a word: it shares
> one notebook among every caller of the agent, and an agent with no `type` gets that server's default, `kv`.

**`ttl` counts from the last write.** Each run that succeeds with a `_state` writes the notebook and moves its
deadline; a run that only reads it moves nothing. Past the deadline the notebook reads as absent — the next
run starts without it — and the server deletes it: a sweep runs at startup, then every hour, on every
instance, and a server that was stopped at the deadline deletes it when it starts again. A new version that
changes `ttl` moves a notebook's deadline only at its next write.

Validation refuses a `ttl` outside `1d` to `365d`, whatever the `type`: `skrun build`, `push`, `deploy`
and `test` stop on the error, whose message names the bounds (its code in `validateAgent`'s result, from
`@skrun-dev/schema`: `STATE_TTL_OUT_OF_RANGE`). So does `skrun dev` when it starts; once running, it prints
the error on a reload and keeps serving the previous configuration. Only the CLI validates: a version pushed
straight to the API — with the SDK or `curl`, or imported from the dashboard — is published with such a value, as is one published before
2.0.0. Such a version runs: the server reads the value as the nearest bound — `0d` as one day, anything
above `365d` as 365 days. A server before 2.0.0 does not apply `ttl` at all. For an agent that should keep
nothing, set `type: none`.

### `tests` (optional)
- **Type**: array
- **Default**: `[]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Test name |
| `input` | object | Yes | Test input matching inputs schema |
| `assert` | string | Yes | Assertion expression (e.g., `output.score >= 0`) |

## Refused settings

A few values the fields above can take are refused, each by its name and a code, because no code honours them — or, for `timeout`, because no timer can hold them: `model.provider: meta` without a `model.base_url`, and a `fallback` whose provider is `meta` (`MODEL_BASE_URL_REQUIRED`); an MCP server's `auth` other than `none`, and a `secrets` list that names a secret (`UNSUPPORTED_FIELD`); a `timeout` outside `1s` to `2147483s` (`TIMEOUT_OUT_OF_RANGE`). They are refused at validation **and at push**. `skrun build`, `push`, `deploy` and `test` stop on the error — its code in `validateAgent`'s result, from `@skrun-dev/schema`; its message names the field —, and so does `skrun dev` when it starts. And the registry refuses a push whose `agent.yaml` declares one — sent by the CLI, the SDK, `curl` or the dashboard —, before anything is stored, whatever bounds the server sets: `400`, the code of the first, the message naming each (see [API → Push an agent](api.md#push-an-agent)). That is unlike `state.ttl`, which only the CLI validates (see [`state`](#state-optional)). A version published before 2.0.0 that declares one is not refused when it runs: it runs as it did, the setting having no more effect than it had — save a `meta` model without a `model.base_url`, which no key serves: a run only it could serve is refused before it starts, `400 LLM_KEY_REQUIRED`. In a run's `environment` override, `secrets` and `timeout` are refused the same way (see [`environment`](#environment-optional)).

## Full Example

```yaml
name: seo-audit
version: 1.0.0

model:
  provider: anthropic
  name: claude-sonnet-4-6
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
    allowed_hosts: ["mcp.gsc.io", "searchconsole.googleapis.com"]
  timeout: 300s
  max_cost: 0.50

context_mode: skill

state:
  type: kv
  scope: per_caller
  ttl: 30d

tests:
  - name: basic-audit
    input:
      website_url: "https://example.com"
    assert: output.score >= 0
```
