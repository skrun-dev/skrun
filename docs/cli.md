# CLI Reference

> **Windows (PowerShell):** use `curl.exe` for the curl examples. Windows PowerShell 5.1 aliases `curl` to `Invoke-WebRequest`, which accepts different arguments. The PowerShell examples below send JSON from a UTF-8 file to avoid native-command quoting differences.

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

The generated `agent.yaml` carries only the slug — the namespace is assigned by the registry at push time from your auth context (your GitHub login in lowercase by default on cloud — `<login>--2` if it is taken —, `dev` for the local `dev-token`).

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

The dev server validates the agent, starts an HTTP server, and watches for file changes. It serves one route, `POST /run`, which reads the agent's input from the body's `input` field and refuses, as the API does and in its words: a body without an `input` (`{}` included), with an `input` that is `null`, or that is not a JSON object, with `400 INVALID_REQUEST`; an `input` that is a string, a number or a boolean, with `400 INVALID_INPUT_TYPE`; then each input the agent declares, in its order — one it requires that is missing (not a field of the `input`'s own, `null`, or — a `file` one — an empty list), with `400 MISSING_INPUT`; then one of another type than declared, with `400 INVALID_INPUT_TYPE`, an optional one sent as `null` being accepted, its type not judged —; of a `file` input it judges only its absence — never what it holds: it reads no file. It checks nothing else of the request — not its headers (no credential, no model key), its `version`, the depth of its `input`, nor an `environment` override — and answers in one JSON response, never an event stream or a webhook. It returns **mock responses** — no model is called, no cost. Use this to iterate on your SKILL.md prompt and to try a client that posts to `/run` (curl, a frontend) without spending tokens; the SDK's `client.run()` and `skrun run` call a deployed agent's run route and read its event stream, which this server does not serve. For a real run, deploy the agent (`skrun deploy`), then call it with [`skrun run`](#skrun-run).

## skrun test

Check tests against simulated outputs (no model call).

```bash
skrun test
```

Reads the `tests` array from agent.yaml and runs each test against simulated outputs: no model is called, and no model key is needed. Each test checks that its input carries each input the agent requires — one missing as the API judges it (not a field of its own, `null`, or an empty list for a `file` input) fails the test with `Missing required input: <name>`; no type is checked —, then evaluates its assertion against placeholder outputs — `"mock_value"` for a `string` output, `0` for a `number`, `true` for a `boolean`, `{}` and `[]` for an `object` and an `array`. The command says so once, after the line that announces the tests and before the first result:

```
ℹ Outputs are simulated — no model is called. Each test checks that its input carries each input the agent requires — null, or an empty list for a file input, counts as missing —, then its assertion against placeholder outputs. For a real run: skrun deploy, then skrun run.
```

Exits with code 1 if any test fails. An assertion checks the placeholder, never what the model would answer: `output.result != null` always passes on a `string` output, `output.status == "success"` never does. For a real run, deploy the agent (`skrun deploy`), then call it with [`skrun run`](#skrun-run).

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
| `--output <path>` | Output directory (default: the agent's directory). Created, with its parents, if it does not exist; a file at that path is refused by name |

Creates a `{slug}-{version}.agent` tar.gz archive containing SKILL.md, agent.yaml, scripts/, references/, and assets/. Excludes node_modules, .git, .env, and hidden files.

**Size**: `build` prints both of the bundle's sizes — `Size: <compressed> compressed, <unpacked> unpacked`. The unpacked size is the one a server's decompression cap judges at push: the length of the bundle's tar stream, tar headers included, not the sum of its files — many small files unpack to far more than they weigh. `build` never refuses a bundle for its size: it does not know the limits of the server you push to. Past those of a server with the default settings — 50 MB compressed (`SKRUN_PUSH_MAX_BODY_MB`), 50 MB unpacked (`BUNDLE_MAX_DECOMPRESSED_MB`) — it warns, and still writes the bundle: such a server refuses its push with `413 BUNDLE_TOO_LARGE` or `413 BUNDLE_DECOMPRESSED_TOO_LARGE` (see [API → Push an agent](api.md#push-an-agent)), and the server's operator may have set other limits. Under both, past 10 MB compressed, it recommends a smaller bundle. To shrink one, leave out the files the agent does not need when it runs. An `agent.yaml` over 128 KB gets a warning of its own, and the bundle is still written: every server refuses its push with `413 CONFIG_TOO_LARGE` — a fixed limit, no server setting raises it. `agent.yaml` holds the agent's configuration; put long content (instructions, context, data) in `SKILL.md`, `AGENTS.md` or other files of the agent. `skrun deploy` builds the same way, and a push the server refuses ends it with `Push failed (413): …`, as it ends `skrun push`.

**Validation warnings**: the agent is validated first. Errors stop the build, each printed with its file and its message — among them the settings `agent.yaml` accepts but that are refused by name: an MCP server's `auth` other than `none` or a `secrets` list that names a secret (`UNSUPPORTED_FIELD`), `meta` without a `model.base_url` or as a fallback's provider (`MODEL_BASE_URL_REQUIRED`), a `timeout` outside `1s` to `2147483s` (`TIMEOUT_OUT_OF_RANGE`) — the codes of `validateAgent`'s result (see [Refused settings](agent-yaml.md#refused-settings)). Warnings do not stop it, and are printed one per line with their code — for example `RETIRED_FIELD` (a field in `agent.yaml` that has no effect any more) `SCRIPTS_NO_MANIFEST` (a script imports a package, but no `package.json`, `requirements.txt` or `pyproject.toml` declares it), or `YAML_WARNING` (the YAML reader warns about `agent.yaml` — an unresolved tag, say: the file reads, but a value may not be the one meant; the first three, each with its line and column, then how many more). `skrun push`, `skrun deploy`, `skrun test` and `skrun dev` (at start, and at each reload) validate the agent and print the same warnings.

## skrun deploy

One-command deployment: validate, build, push, get the run URL.

```bash
skrun deploy
skrun deploy -m "Fixed tool calling edge case"
```

**Options:**
| Flag | Description |
|------|-------------|
| `-m, --message <text>` | Attach a note to this version (passed through to `skrun push`). Same rules as `skrun push -m`. |

Requires authentication (`skrun login` first): the agent goes to the server the CLI is using (see [`skrun login`](#skrun-login)). Runs the full pipeline, then prints the run URL — `POST <server>/api/agents/<namespace>/<name>/run`, with `Auth: Bearer <your-token>` where your token goes: the CLI never prints the token itself — and two lines to try the agent:

```text
  Try it — save this input as input.json:
    {"query":"hello"}
  then run:
    skrun run alice/my-agent -f input.json
  or, in bash or zsh:
    skrun run alice/my-agent -i '{"query":"hello"}'
```

They carry no token and no address: `skrun run` takes both from the CLI's session, by the same resolution as the `deploy` that printed them, and reads the run's event stream, so they work on every runtime. The `-f` line works in every shell, Windows PowerShell 5.1 included, whatever encoding it writes `input.json` in (see `skrun run` below); the `-i` line is for bash and zsh — PowerShell 5.1 strips the inner quotes of such an argument. The example input is that of the agent's first test (`tests[0].input` in `agent.yaml`), else an example value for each required input — `"hello"`, `1`, `true`, `{}` or `[]` by its type, `{}` when no input is required. A required `file` input has no example a command line can carry: it is left out, and a line names it — `Not in this example: "<name>", which takes a file (a file_id, base64 data or a URL).`

After the push it reads the server's verification policy and prints the same note as `skrun push` (below): under `admin`, the version must be verified before it can be called, and `deploy` does not call it live — the lines to try it come under `Once the version can be called (see above), try it — save this input as input.json:`; under `owner` or `disabled`, it is live at once. The bundle is built by the same code as `skrun build`, in the same process, so `skrun deploy` works from any directory. It is built every time, from the `agent.yaml` just validated: a bundle already built for this version, which may predate your last edit, is replaced, never pushed as it is. (`skrun push`, below, sends the bundle you built.)

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

**Post-push note**: every pushed version lands at `verified=false`. Whether that stops it from running depends on the server's verification policy (`SKRUN_VERIFICATION_POLICY`), which the CLI reads from `GET /api/me` after a successful push and states in its note:

| Policy | The note says |
|--------|---------------|
| `admin` (default) | The version must be verified before it can be called — you can run `skrun verify <ns>/<name>@<version>` if you are an admin on that server; otherwise an admin must. |
| `owner` | The version can be called now; verifying it is optional (`skrun verify` records that you vouch for it). |
| `disabled` | The version can be called now; the server does not gate runs on verification. |

If the server does not say (an older registry, or the request fails), the note is the generic reminder: `skrun verify <ns>/<name>@<version>` (admin only) before the version can be called. Pushes never fail because of trust state — the note is informational only.

## skrun pull

Download an agent from the registry.

```bash
skrun pull acme/seo-audit
skrun pull acme/seo-audit@1.0.0
```

Downloads and extracts the agent into a local directory, `./<name>/`. The archive is read and checked whole first — its size, and every entry: a link, a path out of the directory, or an entry that cannot be written out, as a push refuses it (two entries that contradict each other, a name too long, a device, a hard link with no file before it — see [Push an agent](api.md#push-an-agent)), is refused —, and the directory is made only then: a refused pull writes nothing. Two paths that differ only by case (`A` and `a/y`) are not refused: on a disk that ignores case (macOS, Windows), the pull can fail on them, the files written before them left in place.

A bundle that decompresses to more than 50 MB — a server's default cap — is refused before anything is written, unless `BUNDLE_MAX_DECOMPRESSED_MB` in your environment sets another cap: a positive decimal number of MB, read as the server reads its own. A malformed value — empty, `0`, `1e3`, `80MB` — stops `skrun pull` before it downloads anything, with exit code 1: `BUNDLE_MAX_DECOMPRESSED_MB must be a positive decimal number of MB (got "1e3"). Unset it to use the 50 MB default.` A bundle a server accepted under a higher cap pulls with the same value here: `Failed to extract bundle: The bundle decompresses to more than 50 MB, the most skrun pull unpacks. Set BUNDLE_MAX_DECOMPRESSED_MB to a larger number of MB to pull it.`

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

# Your own model key, read from an environment variable (repeat the flag for more providers)
skrun run acme/seo-audit -f input.json --llm-key-env google=GOOGLE_API_KEY

# ...or piped in on stdin (the input then comes from -i or -f)
my-secret-manager get google-key | skrun run acme/seo-audit -f input.json --llm-key-stdin google

# Consent to the endpoint an agent declares in its model.base_url (here https://api.moonshot.ai/v1), so your key may
# go there (repeatable, one per provider): it never changes where the model is called, and an agent that declares none refuses it
skrun run acme/kimi-agent -f input.json --llm-key-env openai=MOONSHOT_API_KEY --llm-base-url openai=https://api.moonshot.ai/v1
```

**Flags**: `-i, --input <json>` (inline JSON), `-f, --file <path>` (file path), `--stdin` (read fd 0). Mutually exclusive — pick one. The input must be a JSON **object**; arrays and primitives are rejected.

**Encoding**: `-f` and `--stdin` read the input by its byte order mark — UTF-8 behind `ef bb bf` (the mark dropped), UTF-16 behind `ff fe` (little-endian) or `fe ff` (big-endian) — and as UTF-8 when it has none. That is what Windows PowerShell 5.1 writes: `'<json>' > input.json` and `Out-File` in UTF-16 LE, `Set-Content -Encoding UTF8` behind the UTF-8 mark, `-Encoding BigEndianUnicode` in UTF-16 BE — each one read. What no reader can repair: a character outside ASCII piped from Windows PowerShell 5.1 (`… | skrun run --stdin`) reaches the CLI as `?` — the shell replaced it, and the JSON stays valid, so nothing tells. Write such an input to a file and use `-f`.

**Your model key**: `--llm-key-env <provider>=<VARIABLE>` (repeatable, one per provider) reads the key from that environment variable; `--llm-key-stdin <provider>` reads it from stdin, and cannot be combined with `--stdin` (stdin carries one thing). The key travels in the `X-LLM-API-Key` header — see [Caller-provided API keys](api.md#caller-provided-api-keys) — and is **never taken as an argument**: a key typed on the command line would land in the shell history, so, as with `skrun llm-key`, the CLI reads it only from a variable or from stdin, and prints it nowhere. `<provider>` is one of the model providers of `agent.yaml`, in any letter case, as with `skrun llm-key`. Without a key option, the run uses the agent owner's creator key or the server's own key, if either exists; with no key at all, it is refused with `400 LLM_KEY_REQUIRED` before it starts.

**Your key's endpoint**: `--llm-base-url <provider>=<URL>` (repeatable, one per provider, with or without a key option) consents to the endpoint an agent declares in its `model.base_url`, so that your key for `<provider>` may be sent there. It never changes where the model is called — the agent's `model.base_url` does. It is sent in the `X-LLM-Base-URL` header as a JSON object of provider to address — the address as you typed it: the server compares origins. An agent that declares its own `model.base_url` gets your key there only when you name that endpoint's origin, and refuses any other entry; an agent that declares none refuses any entry — both with `403 CALLER_BASE_URL_NOT_CONSENTED`. Neither applies when you run your own agent on an account-wide credential: the header is not checked there. See [Where your key is sent](api.md#where-your-key-is-sent). `<provider>` follows the rule of `--llm-key-env`; the address must be an absolute `http://` or `https://` address, with no user name, password, query or fragment. A pair that is not `<provider>=<URL>`, an unknown provider, an address of another form, or a provider given twice is refused before anything is sent, in a message that never repeats the address.

**Output**: the run's result as pretty-printed JSON on stdout — its output files in `files`, and in `files_excluded` how many were left out and why (see [Output files](api.md#output-files)) — exit 0 when its `status` is `completed`, exit 1 when it is `failed` (a run that started and failed; the JSON, with its `error`, is printed all the same). A request refused before the run starts prints `<code>: <message>` to stderr and exits 1. The CLI never prints the raw response body on error — it only surfaces the typed `error.code` + `error.message` so internal details can't leak.

**Every runtime, the `flyio` one included**: `skrun run` reads the run's event stream and prints the result once the run ends — the same JSON a blocking call returns, save for a run the server's stop ended, or its deadline, which it prints `failed` where the blocking call answers `503 SERVER_STOPPED` or `504 DEADLINE_EXCEEDED`. Only the raw API's blocking call (a `POST /run` with neither `Accept: text/event-stream` nor a `webhook_url`) is refused on `flyio`, with `400 SYNC_MODE_UNSUPPORTED`, before the run starts — nothing of it is written, and no run appears in the history. See [Runtime selection](self-hosting.md#runtime-selection-skrun_runtime).

**Verification gate**: under the server's default verification policy (`admin`), a resolved version that is not verified is refused with `403 AGENT_NOT_VERIFIED`, and the CLI prints:

```
✗ Agent acme/seo-audit@1.0.0 is not verified.
✗ Ask an admin to verify it, or run `skrun verify acme/seo-audit@1.0.0` if you are admin.
```

Without a pinned version, the CLI prints the server's message instead, which names the version it resolved (`Agent acme/seo-audit version 1.0.0 must be verified by an admin before it can run.`), then the same advice.

Under the `owner` and `disabled` policies, verification never gates a run (see `skrun verify` below).

**Security**: prefer `-f` or `--stdin` over `-i '<inline>'` when the input contains secrets — the inline form is preserved in shell history (`~/.bash_history`, etc.). The CLI does not write input or output to disk by default.

## skrun verify

Mark a specific version of an agent as verified. What that does, and who may do it, is the server's verification policy (`SKRUN_VERIFICATION_POLICY`, see [self-hosting → Verification policy](self-hosting.md#verification-policy)):

| Policy | An unverified version | Who may run `skrun verify` |
|--------|-----------------------|----------------------------|
| `admin` *(default)* | is refused whole: `POST /run` returns `403 AGENT_NOT_VERIFIED`, before any model call, tool or script | an admin only |
| `owner` | runs, scripts included — verifying records that you vouch for the version | the agent's owner, or an admin |
| `disabled` | runs, scripts included — the flag is inert | the agent's owner, or an admin |

Anyone else gets a clear `403` error. After `skrun push`, the CLI states which case applies on that server.

```bash
# Verify v1.0.0 of acme/seo-audit
skrun verify acme/seo-audit@1.0.0

# Symmetric — revoke verification
skrun unverify acme/seo-audit@1.0.0
```

**Syntax**: `<namespace>/<name>@<version>` — the `@<version>` is required; verification is per version, not per agent. Pushing a new version creates a row at `verified=false` regardless of the agent's other versions — under `admin`, each version must be verified before it can run.

**Why admin under the default policy**: pre-v0.8.0, any namespace owner could verify their own agents — a self-served trust signal. Under `admin`, only the `admin` role can flip the flag. Promotion to admin is a manual SQL update on the `users` table (see [self-hosting → Admin role](self-hosting.md#admin-role)). The `owner` policy makes the owner the trust authority for their own agents, on purpose.

**Dev mode**: where `dev-token` is accepted — a development server with `SKRUN_DEV_AUTH` on and OAuth not configured, see [Mode 1](api.md#mode-1-local-dev-dev-token) —, the local caller is auto-admin so `skrun verify` works without setup — preserves zero-friction local development.

**Audit trail**: every successful verify/unverify writes a structured pino log entry on the server (`event: "agent_version_verify"`) with the actor identity and target version. Pipe the registry's stdout to your log aggregator for a forensic record.

## skrun unverify

Revoke verification on a specific version. Symmetric with `skrun verify`, and allowed to the same callers. Under the `admin` policy, `POST /run` on that version then returns `403 AGENT_NOT_VERIFIED` until a re-verify; under `owner` and `disabled`, the version keeps running.

## skrun visibility

Set an agent's visibility. Every agent is **private** by default — only its owner (or an admin) can `POST /run`.

```bash
# Keep an agent private (owner-only)
skrun visibility acme/seo-audit private
```

The argument is `<namespace>/<name>` (visibility is per-agent, so no `@version`). The hosting model is **private-only** for now, so only `private` is accepted — `public` is rejected for now. Namespace ownership required (admin override); a non-owner gets a `403`.

## skrun login

Sign in to a Skrun server. The CLI remembers it: later commands go there until you sign in elsewhere. Supports three modes, auto-detected based on the server and arguments:

```bash
skrun login --registry https://skrun.example.com    # interactive: OAuth if supported, else token prompt
skrun login                                         # again, later: the server the CLI is using
skrun login --token dev-token                       # local dev (non-interactive), on this machine's server
skrun login --registry https://skrun.example.com --token skrun_sk_...   # API key (non-interactive)
```

**Options:**
| Flag | Description |
|------|-------------|
| `--registry <url>` | The server to sign in to, e.g. `https://skrun.example.com` — an absolute `http://` or `https://` address, with no user name, password, query or fragment. Once signed in, it is the CLI's current server: later commands go there. |
| `--token <token>` | API token or key (skip interactive flow). Use `dev-token` for local dev, `skrun_sk_...` for a key. The server checks it before it is saved. |

**Interactive flow (no `--token`)** — an OAuth 2.0 Device Authorization Grant (RFC 8628) + PKCE, the same pattern as `gh`/Vercel:

1. The CLI asks the server for a device code (`POST /auth/device/code`). If the server has no OAuth configured, it responds `404` and the CLI falls back to a token prompt (step 3).
2. **If OAuth is supported**: the CLI prints a short one-time code + a verification URL and opens your browser there. You confirm the code and sign in with GitHub, then the CLI polls until it receives the token — **delivered in the response body, never through a URL**. Your namespace is your GitHub login in lowercase by default (`<login>--2`, `--3`… if it is taken), and it never changes afterwards. The CLI waits as long as the server keeps the code — 10 minutes by default, 15 minutes at most; 2 minutes from a server that does not say. No local server is started, so it works over SSH / in containers (open the URL on any device).
3. **If OAuth is not supported** (e.g., local dev with `dev-token` mode): the CLI prompts for a token, naming the server — `dev-token` is offered by default only to a server on this machine (`localhost`, `127.0.0.0/8`, `[::1]`) — and the server checks it before it is saved. With no terminal to type it in (a script, a CI job), there is no prompt: `login` fails and gives the command with `--token`. And when the server is the current one, inherited from your session rather than named by `--registry` or `SKRUN_REGISTRY_URL`, `login` fails too, giving `skrun login --registry <address> --token <token>`: a token is never typed for a server you did not name.

**A token you give** — with `--token`, or typed at the prompt — is checked first: the CLI sends it to `GET /api/me`, and saves it only on a `2xx`, with the namespace the server names (`Logged in to <address> as <namespace>`). Such a token goes to `--registry`, else to `SKRUN_REGISTRY_URL`, else to the default — **never to the current server**, which may be another instance than the one that issued it: to give a key of another server, name it with `--registry`. An empty `--token` is refused before anything is sent. The browser sign-in sends no token — it receives one — so it does go to the current server when neither is given: signing in again once your key has expired needs no address.

**Every failure ends with exit 1, and saves nothing** — a session already saved for that server stays as it was, so `skrun login && skrun deploy` stops there. Each message names the server: one that cannot be reached (`Could not reach <address> (<cause>). Nothing was saved. To sign in elsewhere: skrun login --registry <url>`), a token it refuses (`The server at <address> refused this token (HTTP <status>). Nothing was saved.`), a redirect, which the CLI never follows (`The server at <address> answered with a redirect to <origin>, which the CLI does not follow.` — then, when the target is on the same host, as an `http://` address sent on to `https://`, how to use that server), any other answer to the device code, and a browser sign-in that times out or is not completed (`Login to <address> timed out or was not completed. Run: skrun login --registry <address>`). An address that is not one is refused before anything is sent (`--registry must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com`), without repeating the value.

Tokens are saved to `~/.skrun/config.json`, one session per server — on Linux and macOS, a file and a directory only you can read. A file written by an earlier CLI, or one that cannot be read, sends nothing: a command that needs a session stops and says to sign in again (`Signed in with an older CLI — sign in again: skrun login --registry <url>`, or, for a file that cannot be read, `The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>`); `skrun login` replaces the file, `skrun logout` removes it.

**The key the interactive flow mints expires.** Its lifetime is the instance's `SKRUN_API_KEY_TTL_DAYS` — 90 days unless the operator changed it (at most 36500 days, 100 years), or none if they set `0`. Past it, commands fail with `401` ("API key has expired"); run `skrun login` again to get a fresh key. A key you pass yourself with `--token` is unaffected: a key created through the API or the dashboard expires only if it was given an expiry, and `dev-token` never expires.

**Which server the CLI talks to** — every command resolves it in the same order: `--registry` (on `skrun login`), then `SKRUN_REGISTRY_URL` (env, empty counting as unset), then the CLI's current server (set by `skrun login`, cleared by `skrun logout`). When none of these sets the server, the CLI talks to its default, `http://localhost:4000`. A token you give at `skrun login` skips the current server (above). Each token is saved under the server it was obtained from, and a command sends only the token saved for the server it talks to, never another: a server with no session gets nothing, and the command stops with `Not logged in to <address>. Sign in: skrun login --registry <address>`. Addresses are saved and compared in one form — scheme and host in lower case, the default port and trailing slashes dropped. The env var wins, which is the switch to use in CI or when driving several instances from one machine — it changes the target without touching the stored config: a `skrun login` under it alone saves that server's session **without making it the current server**, so other shells keep going where they went. When the server comes from the variable, the sign-in the CLI advises names no address — `skrun login (SKRUN_REGISTRY_URL names this server)` —, since `--registry` would make that server the current one.

## skrun logout

Sign out of the server the CLI is using: remove its saved session, and no other.

```bash
skrun logout
```

The server is resolved as for every command (see [`skrun login`](#skrun-login)): `SKRUN_REGISTRY_URL`, else the current server, else the default. Its session is removed — `Logged out of <address>.` — and if it was the current server, none is current any more: the next command goes to the variable or the default, and no other session takes its place. With no session for that server, `logout` says `No session for <address> — nothing to remove.` and exits 0. A sign-in file of an earlier CLI, or one that cannot be read, is removed whole (`Removed the sign-in saved by an older CLI.`). `logout` sends nothing.

## skrun whoami

Print the server the CLI is using, and the namespace it is signed in as there — the server even when you are not signed in to it, so a sign-in to the wrong server shows before anything is sent.

```bash
skrun whoami
```

```text
ℹ Namespace: alice
ℹ Registry:  https://skrun.example.com
```

The server is resolved as for every command (see [`skrun login`](#skrun-login)). Not signed in to it, `whoami` prints the server, then `✗ Not logged in. Sign in: skrun login --registry <address>`, and exits 1; with a sign-in file of an earlier CLI, or one that cannot be read, it prints the server, then the message that says to sign in again, and exits 1. The namespace is `dev` for `dev-token`, whatever else the config file holds. For any other token, it is the namespace the server returned at `skrun login` (by default your GitHub login), saved with that server's session in `~/.skrun/config.json`; failing that, the CLI asks the server once (`GET /api/me`) and saves its answer.

When `skrun pull` answers `404`, run it to check which account the CLI is logged in with.

## skrun keys

Manage your API keys: the `skrun_sk_…` credentials a script, a CI job or a client uses instead of your login. The headline use is a restricted key for a client, one that runs a single agent of yours and nothing else. What each scope allows: [concepts → API-key scopes](concepts.md#api-key-scopes).

Managing keys takes an account-wide credential: a session, `dev-token`, or an account-wide key with every operation. A key scoped to agents, or limited to running, can neither create, list nor revoke keys (`403 KEY_SCOPE_FORBIDDEN`).

### skrun keys create

Create a key. The key itself is printed once: save it then, it cannot be shown again.

```bash
skrun keys create --name ci
skrun keys create --name client-acme --agent acme/seo-audit --run-only --expires-in 90
```

**Options:**
| Flag | Description |
|------|-------------|
| `--name <name>` | Key name (required) |
| `--agent <ns/name>` | Scope the key to one agent you own; the registry refuses any other agent (`403`). Without it, the key covers your whole account |
| `--run-only` | Restrict the key to running agents: no push, no verify — and, like any key without full access, no reading of run history, stats, the account's usage or an agent's source (`403`); it reads only the files it uploaded and the outputs of the runs it launched |
| `--expires-in <days>` | Expire the key after this many days: a whole number from 1 to 36500 (a hundred years), written in digits. Any other value is refused before anything is sent |

**Without `--expires-in`, the key never expires**, as with `POST /api/keys`, and the command says so. After the key, it prints the key's id, which `skrun keys revoke` takes, then its expiry:

```text
✓ API key created — save it now, it won't be shown again:
ℹ skrun_sk_…
ℹ id: 0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b
ℹ expires: 2026-12-27T12:00:00.000Z
```

Without `--expires-in`, the last line reads `This key never expires; pass --expires-in <days> to give a key an expiry.`

### skrun keys list

List your keys, one line each: the id, the key's prefix (never the key itself), its name, its scope (`account`, or `scoped` for a key limited to agents) and its expiry, or `never`.

```bash
skrun keys list
```

```text
ℹ 3f5b8c1e-0d2a-4c6e-9b7a-1e2f3a4b5c6d  skrun_sk_1a2B3c4D…  ci  [account]  expires: never
ℹ 0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b  skrun_sk_9F8e7D6c…  client-acme  [scoped]  expires: 2026-12-27T12:00:00.000Z
```

With no key, it prints `No API keys.`

### skrun keys revoke

Revoke (delete) a key by its id: the first column of `skrun keys list`, also printed by `skrun keys create`.

```bash
skrun keys revoke 0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b
```

From then on, a request made with that key is refused (`401`). An id that is not one of your keys is refused (`404`).

## skrun llm-key

Manage the creator LLM keys attached to one of your agents. With a key attached for a provider, your callers can run the agent without bringing their own key: you cover the inference. How a run picks its key, and what the caller-key policy means: [concepts → LLM keys](concepts.md#llm-keys).

Every subcommand takes `--agent <ns>/<name>` (required). It needs an account-wide credential (a session, `dev-token`, or an account-wide key with every operation), and the agent's namespace must be yours, unless you are an admin. An attached key is never shown again: the registry encrypts it before storing it, and returns only its last four characters.

### skrun llm-key set

Attach your key for a provider to the agent, or replace the one already attached.

**Your fallback may run on your key.** A key you attach for your fallback's provider also serves the runs whose caller brought a key for your primary model only: when their key fails — on purpose or not — and no tool has run yet, your fallback runs on yours. To prevent it, attach no key for that provider.

```bash
skrun llm-key set anthropic --agent acme/seo-audit < anthropic-key.txt
skrun llm-key set openai --agent acme/seo-audit --key-env OPENAI_API_KEY
```

**Options:**
| Flag | Description |
|------|-------------|
| `--agent <ns/name>` | The agent you own (required) |
| `--key-env <var>` | Read the key from this environment variable instead of stdin |

The key is read from stdin, or from the variable `--key-env` names, never from an argument: it stays out of your shell history. The command refuses an empty key, and a provider that is not one of the model providers of `agent.yaml` (in any letter case), before sending anything. No message of `skrun llm-key` repeats a value that may be a key typed in the wrong place: a refused provider or policy is not quoted, and an empty variable is named only when its name is written the conventional way — capitals, digits and underscores, like `OPENAI_API_KEY` — a form no provider's keys take. The registry refuses:

- a provider `agent.yaml` does not know — the list the command checks, `meta` included (`400 INVALID_LLM_PROVIDER`);
- a key shorter than 16 characters (`400 INVALID_LLM_KEY`);
- any key at all when the instance has no `SKRUN_SECRETS_ENCRYPTION_KEY` to encrypt it with (`500 ENCRYPTION_NOT_CONFIGURED`).

### skrun llm-key list

Print the agent's caller-key policy, then each provider with a key attached, showing only the key's last four characters.

```bash
skrun llm-key list --agent acme/seo-audit
```

```text
ℹ policy: open
ℹ anthropic  ••••x9Qz
```

With no key attached, the second line reads `No LLM key attached.`

### skrun llm-key rm

Remove your key for a provider from the agent. A provider that is not one of the model providers of `agent.yaml` is refused before anything is sent.

```bash
skrun llm-key rm anthropic --agent acme/seo-audit
```

### skrun llm-key policy

Set the agent's caller-key policy: `open` or `creator-only` (`creator_only` is accepted too, in any letter case). The command refuses any other value before sending anything.

```bash
skrun llm-key policy creator-only --agent acme/seo-audit
```

What each policy does: [concepts → LLM keys](concepts.md#llm-keys).

## skrun logs

> **⚠️ Planned**: the `skrun logs` CLI command exists, but the backend endpoint (`GET /api/agents/:ns/:name/logs`) is not yet implemented in the registry. Running this command today returns `Agent not found or no logs available`. Execution logs are currently available via the **operator dashboard** at `/dashboard` (Runs page) or via the structured JSON logs on stdout (see [self-hosting.md → Structured logs](self-hosting.md#structured-logs)). This CLI command will be wired up in a later release.

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

Manage the script-dependency cache of this machine, at `~/.skrun/deps/<hash>/` (override with `SKRUN_DEPS_DIR`) — the one a server running here installs into when it runs agent scripts itself (the `local` runtime). A cloud sandbox installs into its own, for one run; this command never reaches it.

When an agent declares a `package.json` / `requirements.txt` / `pyproject.toml` at its bundle root, such a server resolves the dependencies on first call and caches the result by content hash. Identical manifests across agents share the same cache entry. See [agent-yaml.md → Script dependencies](agent-yaml.md#script-dependencies) for the full lifecycle.

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

Operational commands for cloud-runtime operators, not used by agent authors — described in the self-hosting guide: see [skrun admin](self-hosting.md#skrun-admin).

### skrun admin cleanup-machines

Reaps orphan sandbox machines of the cloud runtime — see [skrun admin cleanup-machines](self-hosting.md#skrun-admin-cleanup-machines) in the self-hosting guide.

## Common Workflows

### New agent from scratch
```bash
skrun init my-agent && cd my-agent
# Edit SKILL.md and agent.yaml
skrun dev          # Iterate on prompt (mock, free)
skrun test         # Check the tests on simulated outputs (no model call)
skrun deploy       # Ship it — then skrun run calls the model
```

### Import existing skill
```bash
skrun init --from-skill ./my-existing-skill
skrun test         # Simulated outputs, no model call
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
skrun test         # Check the tests (simulated: no model, no tool is called)
skrun deploy       # Scripts bundled in .agent archive; a real run (skrun run) calls them
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

skrun test         # Check the tests (simulated: the MCP server is not started)
skrun deploy       # npx installs MCP server at runtime; a real run (skrun run) uses its tools
```

### Update a deployed agent
```bash
# Edit SKILL.md or agent.yaml
skrun test                                    # Check the tests (simulated outputs)
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

### Test POST /run from PowerShell

Start `skrun dev` in your agent directory first. Replace `url` below with the input fields declared in your `agent.yaml`. The dev server returns mock responses and needs no registry token.

```powershell
$body = @{
  input = @{
    url = "https://example.com"
  }
} | ConvertTo-Json -Depth 10

# UTF-8 without a BOM works in both Windows PowerShell 5.1 and PowerShell 7.
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$PWD/input.json", $body, $utf8)
curl.exe -X POST http://localhost:3000/run `
  -H "Content-Type: application/json" `
  --data-binary "@input.json"
```

### Call a deployed agent from PowerShell

Replace the registry URL and `acme/seo-audit` with your registry and agent. Set `SKRUN_API_TOKEN` in your environment to a registry token authorized to run that agent. Its inputs must match `agent.yaml`; this example assumes a `url` field. The registry also needs an available model key — see [Caller-provided API keys](api.md#caller-provided-api-keys). Any verification requirement configured by the registry must be satisfied before calling it.

```powershell
$registryUrl = "https://your-registry.example"
$body = @{
  input = @{
    url = "https://example.com"
  }
} | ConvertTo-Json -Depth 10

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$PWD/input.json", $body, $utf8)
curl.exe -X POST "$registryUrl/api/agents/acme/seo-audit/run" `
  -H "Authorization: Bearer $env:SKRUN_API_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary "@input.json"
```

Both examples write `input.json` in the current directory. Remove it after use if it contains sensitive input.
