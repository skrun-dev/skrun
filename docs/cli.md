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
| `--name <name>` | Agent slug (non-interactive). Lowercase letters, digits, hyphens. |
| `--description <desc>` | Agent description (non-interactive) |
| `--model <provider/name>` | Model (non-interactive) |

The generated `agent.yaml` carries only the slug — the namespace is assigned by the registry at push time from your auth context (your GitHub username on cloud, `dev` for the local `dev-token`).

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

**Post-push warning**: every pushed version lands at `verified=false`. The CLI prints a stderr warning after a successful push reminding the operator to run `skrun verify <ns>/<name>@<version>` before the version can be invoked via `POST /run`. Pushes never fail because of trust state — the warning is informational only.

## skrun pull

Download an agent from the registry.

```bash
skrun pull acme/seo-audit
skrun pull acme/seo-audit@1.0.0
```

Downloads and extracts the agent into a local directory.

## skrun run

Invoke an agent against the registry and print the output to stdout. The runtime equivalent of `curl POST /api/agents/.../run`, but with proper auth + typed errors. Pushed versions are unverified by default — see `skrun verify` below.

```bash
# Latest version (no pin) — resolves to most recent push
skrun run acme/seo-audit -i '{"url": "https://example.com"}'

# Pinned version
skrun run acme/seo-audit@1.0.0 -i '{"url": "https://example.com"}'

# Input from a file (recommended for secrets — avoids shell history)
skrun run acme/seo-audit -f input.json

# Input piped via stdin
cat input.json | skrun run acme/seo-audit --stdin
```

**Flags**: `-i, --input <json>` (inline JSON), `-f, --file <path>` (file path), `--stdin` (read fd 0). Mutually exclusive — pick one. The input must be a JSON **object**; arrays and primitives are rejected.

**Output**: pretty-printed JSON to stdout on success (exit 0); `<code>: <message>` to stderr on error (exit non-zero). The CLI never prints the raw response body on error — it only surfaces the typed `error.code` + `error.message` so internal details can't leak.

**Verification gate**: if the resolved version is not verified, the call returns `403 AGENT_NOT_VERIFIED` and the CLI prints:

```
Error: Agent acme/seo-audit version 1.0.0 is not verified.
Ask an admin to verify it, or run `skrun verify acme/seo-audit@1.0.0` if you are admin.
```

**Security**: prefer `-f` or `--stdin` over `-i '<inline>'` when the input contains secrets — the inline form is preserved in shell history (`~/.bash_history`, etc.). The CLI does not write input or output to disk by default.

## skrun verify

Mark a specific version of an agent as verified. Admin only — non-admin callers get a clear 403 error.

```bash
# Verify v1.0.0 of acme/seo-audit
skrun verify acme/seo-audit@1.0.0

# Symmetric — revoke verification
skrun unverify acme/seo-audit@1.0.0
```

**Syntax**: `<namespace>/<name>@<version>` — the `@<version>` is required; verification is per version, not per agent. Pushing a new version creates a row at `verified=false` regardless of the agent's other versions — admins re-verify each version they want runnable.

**Why admin only**: pre-v0.8.0, any namespace owner could verify their own agents — a self-served trust signal. From v0.8.0, only the `admin` role can flip the flag. Promotion to admin is a manual SQL update on the `users` table (see [self-hosting → Admin role](self-hosting.md#admin-role)).

**Dev mode**: when OAuth is not configured (`dev-token` mode), the local caller is auto-admin so `skrun verify` works without setup — preserves zero-friction local development.

**Audit trail**: every successful verify/unverify writes a structured pino log entry on the server (`event: "agent_version_verify"`) with the actor identity and target version. Pipe the registry's stdout to your log aggregator for a forensic record.

## skrun unverify

Revoke verification on a specific version. Symmetric with `skrun verify`. After unverify, `POST /run` on that version returns `403 AGENT_NOT_VERIFIED` until a re-verify.

## skrun visibility

Set an agent's visibility. Every agent is **private** by default — only its owner (or an admin) can `POST /run`.

```bash
# Keep an agent private (owner-only)
skrun visibility acme/seo-audit private
```

The argument is `<namespace>/<name>` (visibility is per-agent, so no `@version`). The hosting model is **private-only** for now, so only `private` is accepted — `public` is a marketplace capability and is rejected (`public` ships with the marketplace). Namespace ownership required (admin override); a non-owner gets a `403`.

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

**Interactive flow (no `--token`)** — an OAuth 2.0 Device Authorization Grant (RFC 8628) + PKCE, the same pattern as `gh`/Vercel:

1. The CLI asks the registry for a device code (`POST /auth/device/code`). If the registry has no OAuth configured, it responds `404` and the CLI falls back to a token prompt (step 3).
2. **If OAuth is supported**: the CLI prints a short one-time code + a verification URL and opens your browser there. You confirm the code and sign in with GitHub, then the CLI polls until it receives the token — **delivered in the response body, never through a URL**. Your GitHub username becomes your namespace. Timeout: 2 minutes. No local server is started, so it works over SSH / in containers (open the URL on any device).
3. **If OAuth is not supported** (e.g., local dev with `dev-token` mode): the CLI prompts for a token and saves it.

Tokens are saved to `~/.skrun/config.json`. Use `skrun logout` to clear.

**Which registry the CLI talks to** — resolved in this order: `SKRUN_REGISTRY_URL` (env), then `registry_url` in `~/.skrun/config.json` (written at login), then `http://localhost:4000`. The env var wins, which is the switch to use in CI or when driving several instances from one machine — it changes the target without touching the stored config. Note the token is **not** resolved the same way: it comes from the config file only, so pointing the env var at a different registry does not carry credentials over to it.

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

## skrun cache

Manage the script-dependency cache at `~/.skrun/deps/<hash>/` (override with `SKRUN_DEPS_DIR`).

When an agent declares a `package.json` / `requirements.txt` / `pyproject.toml` at its bundle root, Skrun's runtime resolves the dependencies on first call and caches the result by content hash. Identical manifests across agents share the same cache entry. See [agent-yaml.md → Script dependencies](agent-yaml.md#script-dependencies) for the full lifecycle.

### skrun cache list

List every cached dependency entry with hash, size, package count, and last-used timestamp.

```bash
skrun cache list
```

Output (truncated):

```text
HASH         SIZE       PACKAGES   LAST USED
------------ ---------- ---------- ---------------
1a2b3c4d5e6f 78.4 MB    3          2h ago
9876543210ab 4.2 MB     1          15m ago
------------ ---------- ---------- ---------------
2 entries     82.6 MB    4
```

Empty cache prints `No cache entries.` and exits 0. Package count shows `?` when the entry's layout cannot be identified (corrupted install or unsupported tool).

### skrun cache clear

Delete every entry in the cache (hash directories + any `.tmp-*` orphans from interrupted installs).

```bash
skrun cache clear
skrun cache clear --yes  # skip the confirmation prompt for CI scripts
```

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt above 100 MB |

When the cache exceeds 100 MB, `clear` asks for confirmation (`Cache is X.X GB. Delete all entries? [y/N]`). Below 100 MB, it deletes immediately. Use `--yes` in CI / automation to bypass the prompt regardless of size.

## skrun admin

Operational commands for cloud-runtime operators. Not used by agent authors — these talk to the Fly.io Machines API directly, so they need the same Fly credentials your API server uses: `FLY_API_TOKEN` and `SKRUN_RUNNERS_APP` (the app where per-run machines are spawned).

The app name resolves in this order: **`--app`** → **`SKRUN_RUNNERS_APP`** → **`FLY_APP_NAME`**.

> ⚠️ **Prefer `--app` or `SKRUN_RUNNERS_APP`; `FLY_APP_NAME` is a fallback with a trap.** Inside a Fly machine, Fly sets `FLY_APP_NAME` to *that machine's own* app — so a cleanup scheduled there (see the cron pattern below) would sweep the app it runs in rather than your runners app, find no sandbox machines, and report a perfectly healthy `scanned=0 cleaned=0`. The command warns when it falls back to `FLY_APP_NAME`, and every run names the app it swept in the `PASS` line, so a zero count can be told apart from a wrong target.

### skrun admin cleanup-machines

Reap orphan sandbox machines. Each `POST /run` in cloud mode spawns a dedicated Fly.io machine; the runtime destroys it in a `finally` block plus on caller disconnect, but rare failure paths (process killed mid-destroy, network partitions, panics) can leave machines running. This command lists every machine matching the `skrun-run-*` naming convention older than `--older-than` and destroys them.

```bash
skrun admin cleanup-machines               # default 600 s threshold, real destroy
skrun admin cleanup-machines --dry-run     # preview only — no destroy call
skrun admin cleanup-machines --older-than 1800   # 30-minute threshold
```

**Options:**
| Flag | Description |
|------|-------------|
| `--dry-run` | Print what would be destroyed without calling the destroy API. |
| `--older-than <seconds>` | Minimum machine age before it is eligible. Default `600` (= 2× the configured `MAX_RUN_TIMEOUT_S`). |
| `--app <name>` | The runners app to sweep. Overrides `SKRUN_RUNNERS_APP` / `FLY_APP_NAME` — use it wherever the environment sets an app name you don't control. |
| `--token <token>` | Fly.io deploy token. Overrides `FLY_API_TOKEN`. |
| `--include-pool` | Also destroy pre-created machines. **Off by default** — see below. For taking a deployment down for good. |

**Pre-created machines are left alone.** If the server keeps a pool of machines ready in advance, those (`skrun-pool-*`) are **not** touched by this command, at any age. They are live stock: the server that created them holds the only record of which are spoken for, recycles them on its own schedule, and disposes of ones it no longer recognises when it restarts. Age says nothing here — a pooled machine is old by design, because its creation time is when the pool was stocked, not when a run touched it.

Pass `--include-pool` only when you are decommissioning a deployment and want nothing left behind. Even then a machine that might be serving a run right now is refused: only ones the platform reports as suspended (so nothing can be running on them), or started and untouched for far longer than a run can last, are destroyed.

**Conservative defaults**: in-flight runs are never destroyed (the 600 s default is twice the max run timeout), only machines matching `skrun-run-*` are eligible (the API server itself + any non-Skrun apps in the Fly account are untouched), and a single destroy failure does NOT abort the loop (best-effort).

**Output**: the command prints one line per inspected machine and ends with a machine-readable PASS line for CI / cron scripts:

```text
Found 4 runner machine(s); 2 older than 600s.
destroyed e286037be1d128 (name=skrun-run-abc, age=874s)
destroyed 91e7d62c34a3d6 (name=skrun-run-xyz, age=905s)
PASS cleanup-machines: scanned=4 cleaned=2 app=skrun-cloud-runners
```

**Operator pattern**: schedule this as a periodic cron / Fly machine on a 5-minute interval. The conservative `--older-than` default makes it safe to run aggressively — it'll never touch a running agent.

```bash
# crontab(5) example — every 5 minutes
*/5 * * * * skrun admin cleanup-machines >> /var/log/skrun-cleanup.log 2>&1
```

With no credentials at all the command refuses to run and names what is missing. That guard catches an **absent** app name, never a **wrong** one — which is why the `PASS` line carries `app=`: check it matches your runners app the first time you wire the cron up, and a later `scanned=0` means what it says.

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
