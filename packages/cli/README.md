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
your GitHub login by default after `skrun login` (`<login>--2` if it
is taken).

## Commands

| Command | Description |
|---------|-------------|
| `skrun init [dir]` | Create a new agent |
| `skrun init --from-skill <path>` | Import an existing SKILL.md as an agent |
| `skrun dev` | Local development server with hot-reload |
| `skrun test` | Check tests against simulated outputs (no model call) |
| `skrun build` | Package the agent into a `.agent` bundle |
| `skrun push -m "note"` | Push to the registry (optional version note) |
| `skrun pull <ns>/<name>[@<v>]` | Download a bundle |
| `skrun run <ns>/<name>[@<v>]` | Invoke an agent — see input flags below |
| `skrun verify <ns>/<name>@<v>` | Mark a version as verified (who may, and what it gates: the server's verification policy) |
| `skrun unverify <ns>/<name>@<v>` | Revoke verification on a version |
| `skrun visibility <ns>/<name> private` | Set an agent's visibility — `private` only for now |
| `skrun deploy -m "note"` | `build` + `push` in one step |
| `skrun login [--registry <url>] [--token <t>]` | Sign in to a server (e.g. `--registry https://skrun.example.com`): the CLI remembers it, and later commands go there. A token given with `--token` is checked by that server before it is saved |
| `skrun logout` | Sign out of the server the CLI is using: remove its saved session, and no other |
| `skrun whoami` | Show the server the CLI is using — even when not signed in — and the namespace it signs in as |
| `skrun keys create/list/revoke` | Manage API keys: `create --name <n>` (with `--agent <ns>/<name>`, `--run-only`, `--expires-in <days>`; without `--expires-in` the key never expires), `list` shows each key's id and expiry, `revoke <id>` |
| `skrun llm-key set/list/rm/policy` | Attach your LLM key to an agent you own, so its callers need none — read from stdin or `--key-env`, never an argument |
| `skrun logs` | **Planned** — the command exists, but the registry does not serve execution logs yet (the dashboard's Runs page shows them) |
| `skrun cache list/clear` | Inspect / clear the local script-deps cache |
| `skrun admin cleanup-machines` | Cloud-runtime operators: reap orphan Fly.io sandbox machines (`--dry-run`, `--older-than`, `--app`, `--token`). Machines a server keeps ready in advance are left alone unless `--include-pool` |

## `skrun run`

Invoke an agent against the registry and print the result's JSON to stdout — exit 0 when the run completed, 1 when it failed (its JSON is printed all the same).

```bash
# Latest version
skrun run acme/my-agent -i '{"query":"hello"}'

# Pinned version
skrun run acme/my-agent@1.0.0 -i '{"query":"hello"}'

# Input from a file (recommended for secrets — avoids shell history)
skrun run acme/my-agent -f input.json

# Input from a pipe
cat input.json | skrun run acme/my-agent --stdin

# Your own model key, read from an environment variable
skrun run acme/my-agent -f input.json --llm-key-env google=GOOGLE_API_KEY
```

**Flags**: `-i, --input <json>` (inline), `-f, --file <path>`, `--stdin` (read fd 0). Mutually exclusive; pick one. Input must be a JSON object — arrays and primitives are rejected.

**Your model key**: `--llm-key-env <provider>=<VARIABLE>` (repeatable) or `--llm-key-stdin <provider>` (not with `--stdin`) — sent in the `X-LLM-API-Key` header, never taken as an argument, so it stays out of your shell history, and printed nowhere.

**Its endpoint**: `--llm-base-url <provider>=<URL>` (repeatable, with or without a key option) — consent to the endpoint an agent declares in its `model.base_url`, so that your key for that provider may go there; sent in the `X-LLM-Base-URL` header as typed, an absolute `http://` or `https://` address, with no user name, password, query or fragment. It never changes where the model is called, and an agent that declares no `model.base_url` refuses it (`403 CALLER_BASE_URL_NOT_CONSENTED`), unless it is your own and you run it on an account-wide credential.

**Every runtime, the `flyio` one included**: `skrun run` reads the run's event stream and prints the result once the run ends — the same JSON a blocking call returns, save for a run the server's stop ended, or its deadline, which it prints `failed` where the blocking call answers `503 SERVER_STOPPED` or `504 DEADLINE_EXCEEDED`. Only the raw API's blocking call is refused on `flyio` (`400 SYNC_MODE_UNSUPPORTED`, before the run starts — nothing of it is written, and no run appears in the history). See [Runtime selection](https://github.com/skrun-dev/skrun/blob/main/docs/self-hosting.md#runtime-selection-skrun_runtime).

**Errors**: only `<code>: <message>` is printed to stderr — the CLI never surfaces the raw response body. On `AGENT_NOT_VERIFIED` (the server's default `admin` verification policy):

```
✗ Agent acme/my-agent@1.0.0 is not verified.
✗ Ask an admin to verify it, or run `skrun verify acme/my-agent@1.0.0` if you are admin.
```

Without a pinned version, the first line is the server's message, which names the version it resolved.

## `skrun verify` / `skrun unverify`

Verification is **per version**: each pushed version lands at
`verified=false`. What that means is the server's verification policy
(`SKRUN_VERIFICATION_POLICY`):

- **`admin`** (the default): an unverified version is refused whole —
  `POST /run` returns `403 AGENT_NOT_VERIFIED`, before any model call,
  tool or script — and only an admin can run `skrun verify`.
- **`owner`** and **`disabled`**: every version runs, scripts included;
  the agent's owner (or an admin) can verify, which records that they
  vouch for the version.

After `skrun push`, the CLI states which case applies on that server.

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
