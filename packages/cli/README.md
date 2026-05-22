# @skrun-dev/cli

Official CLI for [Skrun](https://github.com/skrun-dev/skrun) — deploy any Agent Skill as an API via `POST /run`.

## Install

```bash
npm install -g @skrun-dev/cli
```

## Quick start

```bash
skrun init my-agent                            # scaffold SKILL.md + agent.yaml (slug-only `name`)
cd my-agent
skrun build && skrun push                      # the registry assigns the namespace from your auth at push
skrun verify dev/my-agent@1.0.0                # admin step; dev-token = auto-admin
skrun run dev/my-agent -i '{"query":"hello"}'  # invoke via registry URL form <namespace>/<slug>
```

The `agent.yaml` carries the slug only (`name: my-agent`). The registry
URL form on `skrun run` / `skrun verify` / `skrun push` confirmation
prefixes the slug with your namespace: `dev` for the local `dev-token`,
your GitHub username after `skrun login`.

## Commands

| Command | Description |
|---------|-------------|
| `skrun init [dir]` | Create a new agent |
| `skrun init --from-skill <path>` | Import an existing SKILL.md as an agent |
| `skrun dev` | Local development server with hot-reload |
| `skrun test` | Run agent tests (real LLM) |
| `skrun build` | Package the agent into a `.agent` bundle |
| `skrun push -m "note"` | Push to the registry (optional version note) |
| `skrun pull <ns>/<name>[@<v>]` | Download a bundle |
| `skrun run <ns>/<name>[@<v>]` | Invoke an agent — see input flags below |
| `skrun verify <ns>/<name>@<v>` | Mark a version as verified (admin only) |
| `skrun unverify <ns>/<name>@<v>` | Revoke verification on a version |
| `skrun deploy -m "note"` | `build` + `push` in one step |
| `skrun login --token <t>` | Authenticate against a registry |
| `skrun logout` | Clear stored credentials |
| `skrun logs` | Stream execution logs |
| `skrun cache list/clear` | Inspect / clear the local script-deps cache |

## `skrun run`

Invoke an agent against the registry and print the output to stdout.

```bash
# Latest version
skrun run acme/my-agent -i '{"query":"hello"}'

# Pinned version
skrun run acme/my-agent@1.0.0 -i '{"query":"hello"}'

# Input from a file (recommended for secrets — avoids shell history)
skrun run acme/my-agent -f input.json

# Input from a pipe
cat input.json | skrun run acme/my-agent --stdin
```

**Flags**: `-i, --input <json>` (inline), `-f, --file <path>`, `--stdin` (read fd 0). Mutually exclusive; pick one. Input must be a JSON object — arrays and primitives are rejected.

**Errors**: only `<code>: <message>` is printed to stderr — the CLI never surfaces the raw response body. On `AGENT_NOT_VERIFIED`:

```
Error: Agent acme/my-agent version 1.0.0 is not verified.
Ask an admin to verify it, or run `skrun verify acme/my-agent@1.0.0` if you are admin.
```

## `skrun verify` / `skrun unverify`

Verification is **per version** and admin-only. Each pushed version
lands at `verified=false`; an admin runs `skrun verify` to make it
runnable. `POST /run` returns `403 AGENT_NOT_VERIFIED` for any
unverified version.

```bash
skrun verify acme/my-agent@1.0.0
skrun unverify acme/my-agent@1.0.0
```

Promotion to admin is a manual SQL update on the registry's `users`
table (no HTTP endpoint for elevation by design). `dev-token` mode
(local dev) auto-grants admin so single-user flows just work.

Every successful verify/unverify writes a structured pino log line
server-side (`event: "agent_version_verify"`) with the actor identity
and target version — the forensic trail until a UI ships.

## License

MIT
