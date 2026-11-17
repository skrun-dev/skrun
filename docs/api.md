# API Reference

Base URL: the address of your Skrun server — `$SKRUN_URL` in the examples below.

> **Interactive docs**: visit `GET /docs` on your running server for a live API explorer (Scalar UI). The page loads Scalar's renderer from `cdn.jsdelivr.net` at a pinned version with an integrity hash, so the browser you open it from needs to reach that host; "Try it" requests go straight to your server, never through a third-party proxy.
> **OpenAPI schema**: `GET /openapi.json` — import into Postman, Insomnia, or use for SDK generation.
> **Prefer the SDK?** Use `@skrun-dev/sdk` for a typed client instead of raw HTTP calls: `npm install @skrun-dev/sdk`

## Breaking changes in v0.8.0

v0.8.0 tightened five surfaces that previously had insecure defaults or missing checks. **Self-host operators upgrading from v0.7.x must update their environment + workflows accordingly.** All changes are documented in detail at the referenced sections below.

| # | Change | Action required | Section |
|---|---|---|---|
| 1 | `WEBHOOK_SIGNING_KEY` env required for webhook delivery | Generate via `openssl rand -hex 32` and set in env | [Run an agent — async webhook mode](#run-an-agent) |
| 2 | `CORS_ORIGIN` env required in production | Set to your dashboard / client origin | (API boot — fails fast at startup without it) |
| 3 | Verification is now **per version** + admin-only. Legacy `PATCH /api/agents/:ns/:name/verify` is **removed**. Use the new `PATCH /api/agents/:ns/:name/versions/:version/verify`. `POST /run` returns `403 AGENT_NOT_VERIFIED` for unverified versions. | Promote first admin via SQL: `UPDATE users SET role='admin' WHERE username='you'`, then verify each pushed version | [Verify a version](#verify-a-version) |
| 4 | File-content endpoints require authentication + ownership | Send `Authorization` header on `GET /api/files/:id`, `GET /api/files/:id/content`, `GET /api/runs/:run_id/files/:filename` | [GET /api/files/:id](#get-apifilesid--file-metadata) |
| 5 | All pre-existing `verified=true` agents reset to `verified=false` (migration 007) + agent-level `verified` column dropped (migration 009 — moved to `agent_versions.verified`) | Re-verify each version of trusted agents after upgrade (admin only) | (one-time migrations 007 + 009) |

See `CHANGELOG.md` for the full per-change detail.

## Authentication

Skrun has three authentication modes. The mode follows the server's settings — whether GitHub OAuth is configured and, without it, whether the development fallback, `dev-token`, is on (Mode 1):

```
Development server, SKRUN_DEV_AUTH=1, no OAuth  →  dev-token mode (local dev)
GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET set   →  OAuth mode (self-hosted or cloud)
```

### Mode 1: Local dev (`dev-token`)

Skrun accepts a simple `dev-token` only on a development server without OAuth: `SKRUN_DEV_AUTH=1` set, GitHub OAuth not configured (it is once both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set), and `NODE_ENV` set to `development` (or `test`). `pnpm dev:registry` turns it on by itself: it sets `NODE_ENV=development` and `SKRUN_DEV_AUTH=1` unless you set them. Anywhere else it is off by default, and `dev-token` is refused. A server whose `NODE_ENV` is neither `development` nor `test` refuses to start with `SKRUN_DEV_AUTH` on and OAuth not configured. Use it on a local machine or a trusted private network only. See [Self-hosting → Mode 1: Dev-token](self-hosting.md#mode-1-dev-token-local-dev-never-production).

```bash
# Login
skrun login --token dev-token

# Push an agent (namespace = "dev")
skrun build && skrun push

# Call your agent
curl -N -X POST $SKRUN_URL/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input": {"query": "hello"}}'
```

All agents live in the `dev` namespace. There is no user isolation — this mode is for a single developer working locally.

### Mode 2: Self-hosted (GitHub OAuth)

Setting up GitHub OAuth on a server — the GitHub OAuth App and its two env vars — is the operator's part: see [Self-hosting → Mode 2: GitHub OAuth](self-hosting.md#mode-2-github-oauth-self-hosted-production). Once OAuth is active, `dev-token` is rejected.

**Step 1.** Users sign in:
1. Visit `/login` in a browser — click "Sign in with GitHub"
2. After GitHub authorization, a session cookie is set
3. The user's namespace is their GitHub login in lowercase by default (e.g., `alice`) — `alice--2`, `alice--3`… if that name is already taken — and it never changes afterwards

**Step 2.** Create API keys for programmatic access (CLI, CI/CD):
```bash
# From a browser session — create a key
curl -X POST $SKRUN_URL/api/keys \
  -H "Cookie: skrun_session=<your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI deploy"}'
# Response: {"id": "...", "key": "skrun_sk_3f9a…", ...}
# ⚠️ The key is shown ONCE — save it now.
# The Content-Type above is required, not decoration: a change-making request
# that carries the session cookie, sends a form-style body and shows no browser
# signal is refused with 403 — it is indistinguishable from a forged one.
# The cookie's name depends on the server: skrun_session outside production;
# __Host-skrun_session in production with no session cookie domain (the
# shipped image and compose stack); __Secure-skrun_session in production
# with one. Send the name your server sets — any other is ignored (401).

# Use the API key everywhere
skrun login --registry $SKRUN_URL --token skrun_sk_3f9a…
skrun build && skrun push   # pushes to alice/my-agent

curl -N -X POST $SKRUN_URL/api/agents/alice/my-agent/run \
  -H "Authorization: Bearer skrun_sk_3f9a…" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input": {"query": "hello"}}'
```

### Mode 3: Cloud (skrun.sh)

Same as self-hosted, but hosted by us, by subscription. To start, follow its [quick start](https://skrun.sh/docs/quickstart).

### Transitioning from local to production

When moving from local dev to a self-hosted or cloud instance:

| | Local dev | Production |
|--|-----------|------------|
| Auth | `Bearer dev-token` | `Bearer skrun_sk_...` (API key) or session cookie |
| Namespace (assigned by registry) | `dev` | Your GitHub login in lowercase by default (e.g., `alice`; `alice--2` if it is taken) |
| Registry URL form | `dev/my-agent` | `alice/my-agent` |
| `agent.yaml` `name` | `my-agent` | `my-agent` |

The `agent.yaml` is identical across environments — the slug-only `name` field travels with the bundle, and the registry assigns the namespace at push time based on your auth context. You don't edit `agent.yaml` when switching from `dev-token` to OAuth; just `skrun build && skrun push` and the right namespace is used.

### Namespaces

Your namespace is your GitHub login in lowercase by default — `<login>--2`, `--3`… if that name is already taken when your account is created — and it never changes afterwards, even if you rename your GitHub account. Permissions:

| Action | Who can do it |
|--------|---------------|
| Push, delete | Namespace owner only (`alice` can only push to `alice/*`) |
| Verify a version | Set by `SKRUN_VERIFICATION_POLICY`. Under the default `admin`, an instance admin only; under `owner` and `disabled`, the agent's owner or an admin — see [Verify a version](#verify-a-version) |
| Run an agent | The agent's **owner** (or an admin). Agents are **private by default** and setting one `public` is disabled for now, so `bob` cannot run `alice/my-agent` — he gets a `404` byte-identical to a missing agent. To let an outside caller run one agent, the owner mints an **agent-scoped API key** |
| List / read agents | Filtered to the caller's own namespace; an admin bypasses the filter |

What an admin may do beyond their own account — read, list and run any account's agents, override another agent's environment, verify any version, read the pool status — takes a **full-access credential**: a session, `dev-token`, or an account-wide key with all three operations. An admin's restricted or delegated key answers as the same key of any other account would: another account's agent answers the opaque `404`, and an account-wide key with fewer operations lists the admin's own agents only.

### API keys

API keys start with `skrun_sk_`, followed by 36 characters of `0-9A-Za-z`, 45 in all: 30 random characters, then a 6-character checksum of them. The checksum is the CRC-32 (IEEE, as zlib computes it) of the 30 characters taken as ASCII bytes, written in base62 (digits, then `A-Z`, then `a-z`), most significant digit first, left-padded with `0` to 6 characters. A secret scanner that finds a string of this shape can recompute the checksum and tell a Skrun key from a random match, without calling the server. Keys are stored as SHA-256 hashes — the raw key is shown only once at creation time; `GET /api/keys` shows each key by its first 17 characters, `skrun_sk_` and the first 8 random characters.

Keys created before 2.0.0 have an older format. They are refused with `401` "Invalid API key", like any invalid key, and still appear in `GET /api/keys`, where they can be revoked. To replace them, see [Self-hosting → Mode 3: API keys](self-hosting.md#mode-3-api-keys-programmatic).

Default scopes: `agent:push`, `agent:run`, `agent:verify` (all granted).

**What a key may read.** A key can be narrowed to fewer operations (a *run-only* key carries just `agent:run`) or to some agents of the account (a *delegated* key) — see [API-key scopes](concepts.md#api-key-scopes). Reading follows one rule:

| Read | Full-access credential — a session, `dev-token`, or an account-wide key with all three operations | Any other key — run-only, or restricted to some agents |
|------|------|------|
| Run history and run detail (`GET /api/runs`, `GET /api/runs/:id`), usage stats (`GET /api/stats`, `GET /api/agents/:ns/:name/stats`), the account's usage against its quotas (`GET /api/usage`), an agent's source (`pull`) | yes, for its account | `403 KEY_SCOPE_FORBIDDEN` |
| The agents-directory scan (`GET /api/agents/scan`) | yes — the server's directory, the same for every account; only `registered` depends on the caller's namespace | `403 KEY_SCOPE_FORBIDDEN` |
| An agent's version list (`GET /api/agents/:ns/:name/versions`) | yes, each version with its `config_snapshot` | an account-wide key: the list, each version **without** `config_snapshot`; a delegated key: `403 KEY_SCOPE_FORBIDDEN` |
| An uploaded file (`GET /api/files/:id`, `…/content`, `DELETE /api/files/:id`, a `file_id` input of `POST /run`) | every upload of its account | only the files it uploaded |
| A run's output by its `file_id` (`GET /api/files/:id`, `…/content`) | the outputs of every run of its account | only the outputs of the runs it launched |
| A run's output by the run-scoped routes (`GET /api/runs/:run_id/files/:filename`, `…/link`) | every run of its account | an account-wide key: only the runs it launched; a delegated key: `403 KEY_SCOPE_FORBIDDEN` |

On the per-agent routes (`pull`, the version list, an agent's stats) the ownership check comes first: an agent of another account answers the opaque `404`, whatever the key — unless the caller is an instance admin on a full-access credential, who passes that check and reads the source, the versions (`config_snapshot` included) and the stats of an agent of any account, never another account's runs or files. An admin's restricted or delegated key gets the opaque `404` like any other key. A file the key may not use is refused by each route's own answer: `403 FORBIDDEN` on `/api/files/:id`, the opaque `404 RUN_NOT_FOUND` on the run-scoped routes, and, for a `file_id` input of `POST /run`, `404 FILE_NOT_FOUND` — the answer to an id nobody uploaded. A run whose key has been revoked is read by a full-access credential only.

An agent's metadata is not part of this rule: `GET /api/agents` and `GET /api/agents/:ns/:name` still give any key of the account each agent's `run_count` and `token_count` — the totals of every caller's runs, not the caller's own. A key restricted to some agents reads the metadata of those agents only, and cannot list.

**Expiry.** The two ways of minting a key expire differently, on purpose:

- A key minted by `skrun login` gets the lifetime the operator sets — `SKRUN_API_KEY_TTL_DAYS` days from creation, default `90`, at most `36500` (100 years; a larger value is read as `36500`); `0` means the login flow mints keys that never expire. Re-running `skrun login` issues a fresh one.
- A key created through `POST /api/keys` gets **no** default. Omit `expires_at` and the key never expires; pass an ISO-8601 instant **in the future** and the key stops working after it (a malformed or past value is refused with `400 INVALID_REQUEST`). Such a key is typically handed to a client or wired into someone else's integration, so a lifetime is never imposed on it.

An expired key is refused with `401 UNAUTHORIZED` ("API key has expired"), the same way a revoked one is. `GET /api/keys` returns `expires_at` for every key — `null` when it does not expire. Keys that existed before expiry shipped have no `expires_at`, and are **not** expired retroactively.

### Auth middleware priority

When a request arrives, the middleware checks authentication in this order:

1. **Session cookie** (`skrun_session` outside production; in production `__Host-skrun_session`, or `__Secure-skrun_session` on a server that configures a session cookie domain) — from browser login. Only the current name is read
2. **API key** (`Bearer skrun_sk_...`) — from `POST /api/keys`. A bearer that starts with an API key prefix — the current one, or that of the keys created before 2.0.0, in any letter case — is always read as a key: one that is not a valid key is refused with `401`, never taken as a dev-token
3. **Dev-token** (`Bearer dev-token`) — only where `SKRUN_DEV_AUTH` is on and OAuth is not configured; see [Mode 1](#mode-1-local-dev-dev-token)
4. Otherwise — `401 Unauthorized`

### Auth endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/login` | GET | No | Login page (HTML) — shows "Sign in with GitHub" or dev-token instructions, and, under the GitHub button, a line linking to the operator's terms and privacy policy, each when configured. When the operator configures a sign-in page of their own, answers a temporary redirect (`302`) to it instead, carrying nothing of the request, whether or not OAuth is configured — see [Self-hosting → Your own site in front of the API](self-hosting.md#your-own-site-in-front-of-the-api) |
| `/auth/github` | GET | No | Redirects to GitHub OAuth (returns 404 if OAuth not configured) |
| `/auth/github/callback` | GET | No | Handles OAuth callback — creates user, sets session cookie, then redirects where the server's own configuration says: `/dashboard` by default, or, with a session cookie domain configured, the configured path on the site's origin — its root by default. A login that fails or is refused comes back to that destination with an opaque `login=failed` / `login=denied` marker; with no destination configured it answers `400` / `403` / `500` as before |
| `/auth/logout` | POST | No | Clears the session cookie on every scope and name it may hold, and answers `200 {"ok": true}` — it does not redirect |
| `/api/me` | GET | Yes | Returns current user info: `id`, `username`, `namespace`, `email` (`null` when unknown), `avatar_url` (`null` when unknown), `plan` (`free` when the account has none), `role` (`user` or `admin`) and `verification_policy` (the server's verification policy: `admin`, `owner` or `disabled` — see [Verify a version](#verify-a-version)) |
| `/api/instance` | GET | Yes (any credential) | The instance's links — its docs, the operator's terms and privacy policy —, read by the dashboard. See [Instance links](#instance-links) |
| `/api/keys` | POST | Yes | Create API key — returns a `skrun_sk_...` key (shown once). Optional `expires_at` (ISO-8601, must be in the future); omitted = never expires |
| `/api/keys` | GET | Yes | List your API keys (prefix only, never the full key) — includes `expires_at` (`null` = no expiry) |
| `/api/keys/:id` | DELETE | Yes | Revoke an API key — takes effect immediately. A key that is not yours, or an id the server could not have issued, answers `404` |
| `/api/account` | DELETE | Yes (full access) | Delete your account — body `{"confirm": "<your username>"}`. See [Delete your account](#delete-your-account) |
| `/api/admin/accounts/:id` | DELETE | Yes (admin, full access) | Delete another account — body `{"confirm": "<its username>"}`. See [Delete an account (admin only)](self-hosting.md#delete-an-account-admin-only) |
| `/api/admin/accounts/:id/plan` | PUT | Yes (admin, full access) | Assign an account's plan — body `{"plan": "<name>"}`. See [Assign an account's plan (admin only)](self-hosting.md#assign-an-accounts-plan-admin-only) |

---

## Endpoints

### Health

```
GET /health
```

**Response** `200`
```json
{ "status": "ok" }
```

---

### Run an agent

```
POST /api/agents/:namespace/:name/run
```

Execute an agent and return the result. Supports three modes:
- **Sync** (default, `local` runtime only): blocks until completion, returns full result
- **SSE streaming**: real-time events via Server-Sent Events
- **Async webhook**: returns immediately, delivers result via callback

Sync mode is not available on the `flyio` runtime: a request with neither an `Accept: text/event-stream` header nor a `webhook_url` (an empty `webhook_url` counts as none) is refused with `400 SYNC_MODE_UNSUPPORTED` before the run starts — after the checks of the body's shape, before any key header, the agent or the quota is read. Nothing of the run is written, and an agent that does not exist gets the same `400`; the message names what works. Use SSE streaming (or an async webhook) there. The clients' blocking calls work on both runtimes: the SDK's `client.run()` and the CLI's `skrun run` read the SSE stream and return the sync mode's result, same shape — save for a run the server's stop ended, or its deadline: the blocking call answers it `503 SERVER_STOPPED` or `504 DEADLINE_EXCEEDED`, the clients return it as a `failed` result whose `error` is the stop's message or the deadline's. See [Runtime selection](self-hosting.md#runtime-selection-skrun_runtime).

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |
| `Accept` | No | Set to `text/event-stream` for SSE streaming mode |
| `X-LLM-API-Key` | No | Caller-provided LLM API keys (see [Caller-provided API keys](#caller-provided-api-keys)) |
| `X-LLM-Base-URL` | No | The endpoint your key belongs to. Needed only when you send `X-LLM-API-Key` to an agent you do not own; on such an agent, every entry it holds is checked, with or without a key (see [Where your key is sent](#where-your-key-is-sent)) |

**Request body**

```json
{
  "input": {
    "field_name": "value"
  },
  "version": "1.2.0",
  "environment": {
    "timeout": "600s",
    "max_cost": 10.0
  },
  "webhook_url": "https://your-app.com/callback"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Input fields matching the agent's `agent.yaml`. For a `file`-typed input, pass a list of source descriptors, or one descriptor for a single file — see [Uploading input files](#uploading-input-files); an empty list counts as the input missing. A body without an `input` field (`{}` included), with an `input` that is `null`, or that is not a JSON object is refused with `400 INVALID_REQUEST`, whose message names `input`: the whole body is never taken for the input. An input that is a string, a number or a boolean instead of an object of fields is refused with `400 INVALID_INPUT_TYPE`, whose message names the type received (`Input expected object, got number`). An input nested more than 100 levels deep — objects and arrays inside one another, the input itself the first level — is refused the same way, the message naming the bound. These are the first checks made on the body once it is read, in every mode — nothing of the agent is read and nothing of the run is written. |
| `version` | No | Pin a specific agent version (**strict semver**, e.g. `"1.2.0"`). Omit to target latest. Ranges (`^`, `~`, `*`) and keywords (`"latest"`, `"HEAD"`) are not supported — omit the field for latest. |
| `environment` | No | Environment override — shallow-merged on top of agent.yaml defaults. Accepts any subset of: `networking.allowed_hosts`, `secrets` (an empty list only), `timeout`, `max_cost`. A field retired from `agent.yaml` (`sandbox`, `filesystem`) is refused with `400 RETIRED_FIELD`, never ignored. The override is then judged as sent, before it is merged and before the agent's bundle is read: a `secrets` list that names a secret is refused with `400 UNSUPPORTED_FIELD` — no secret is injected into a run —, a `timeout` outside `1s` to `2147483s` with `400 TIMEOUT_OUT_OF_RANGE`, whatever the server's longest timeout. The merged environment is then validated as an `agent.yaml`'s is — a `timeout` not written `Ns`, a `networking` that is not an object, a value of the wrong type: refused with `400 INVALID_ENVIRONMENT`, whose message names each field. On a server that sets a longest timeout, a `timeout` above it is refused with `400 TIMEOUT_ABOVE_LIMIT` (see [Quotas](#quotas)). |
| `webhook_url` | No | URL to receive the result when execution completes (activates async mode) |

**Note**: `Accept: text/event-stream` and `webhook_url` are mutually exclusive. If both are present, the server returns `400`.

**Body size**: the request body is capped at about 6.33 MB (6,640,982 bytes) — the base64 size of 4 MB, plus 1 MB. The cap bounds the **sum** of a request's inline files (`source: data`) together with the rest of the request: base64 takes 4 bytes for every 3, which leaves about 4.7 MB of inline files when the rest of the request is small — two files of 2 MB each fit —, while each file is still held to 4 MB on its own (`413 INLINE_TOO_LARGE`). A larger body is refused with `413 REQUEST_TOO_LARGE`, whose message names the cap — see [Request size](#request-size). Upload larger files with [`POST /api/files`](#post-apifiles--upload-an-input-file) and pass their `file_id`.

**Quotas**: on a server whose operator sets them, a run is counted against the account of the credential that sends it — its runs in progress, its compute time in the current window — and against the runs the whole server holds at once. A run with no room is refused — `429 CONCURRENCY_LIMIT_REACHED`, `429 COMPUTE_QUOTA_EXCEEDED` or `503 CAPACITY_EXHAUSTED`, each with `Retry-After` —, in every mode the runtime serves, before any machine starts, and nothing of it is written — save one rare case of a database connection gone silent (see [Quotas](#quotas)). A full-access credential also gets the account's numbers in `X-Quota-*` headers, on the refusal and on every response of an admitted run, and can read them at any time from [`GET /api/usage`](#usage). A server that sets no quota refuses nothing and sends no such header. While the server's pre-warm pool runs, a plan may also bound the account's *fast runs* — the runs of the hour entitled to a ready machine; a run past them is not refused, it starts on a machine of its own, about a minute slower. See [Quotas](#quotas).

**Response** `200`

```json
{
  "run_id": "uuid",
  "status": "completed",
  "agent_version": "1.2.0",
  "output": {
    "field_name": "value"
  },
  "usage": {
    "prompt_tokens": 500,
    "completion_tokens": 150,
    "total_tokens": 650,
    "cache_read_tokens": 2048,
    "cache_write_tokens": 1024
  },
  "cost": {
    "estimated": 0.00025,
    "saved": 0.00185
  },
  "duration_ms": 3200,
  "files": [],
  "files_excluded": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string | Unique run identifier |
| `status` | `"completed"` or `"failed"` | Execution result |
| `agent_version` | string | Resolved agent version (semver) that was executed. Always present, whether pinned or resolved-to-latest. |
| `output` | object | Agent output fields (as defined in agent.yaml) |
| `usage.prompt_tokens` | number | Tokens billed at the FULL input rate (cached portion already excluded — see `cache_read_tokens` below) |
| `usage.completion_tokens` | number | Tokens billed at the output rate: the answer, and a thinking model's reasoning where the provider bills it as output. Gemini reports that reasoning apart from the answer; the runtime adds it here. |
| `usage.total_tokens` | number | Sum of `prompt_tokens + completion_tokens` (excludes cached portion — preserves the legacy pre-caching semantic) |
| `usage.cache_read_tokens` | number? | Optional. Tokens served from the provider's prompt cache. Billed at the cached-read rate (typically 0.10× input on Anthropic / GPT-5.x / Gemini 2.5+ / Mistral — less on Claude Opus 5.5, Sonnet 5.5, Fable 5.2, Mythos 5.2, Fable 5.1 and Mythos 5.1 —, 0.5× on Groq gpt-oss / OpenAI gpt-4o). Only present when the provider returned cache activity. |
| `usage.cache_write_tokens` | number? | Optional. Tokens written to the provider's prompt cache. Anthropic only — other providers do not expose a separate cache write surcharge. Billed at the cached-write rate (1.25× input at 5min TTL). |
| `warnings` | string[] | Warnings (only present if non-empty). Reserved for future advisory signals — no specific code is currently emitted. |
| `cost.estimated` | number | Estimated cost in USD. Applies the per-model cached-read rate to `cache_read_tokens` and cached-write rate to `cache_write_tokens` so the value matches what the provider invoice will show within ±5%. |
| `cost.saved` | number? | Optional. Dollar savings (USD) produced by prompt-caching on this run, computed as `cache_read_tokens × (full_input_rate - cached_rate) / 1_000_000`. Surfaced only when > 0 (omitted when no cache activity, model has no caching, or savings round to 0). Aligned with NUMERIC(10,6) DB precision (6 decimals). Same value persisted in the `runs.usage_cache_savings_usd` column. |
| `duration_ms` | number | Total execution time in milliseconds |
| `files` | object[] | The output files the run kept, each with its download `url` — `[]` when there are none. See [Output files](#output-files). |
| `files_excluded` | object | How many of the run's output files are not in `files`, by reason — counts only, never a file name. Always present: `{}` when none was left out, and on a failed run. See [Output files](#output-files). |
| `error` | string | Error message (only when `status` is `"failed"`) |

A run that did not finish because the server stopped is not answered with a `failed` result: it is answered `503`, `SERVER_STOPPED` — running it again makes sense, but its tools may already have run (see [Error codes](#error-codes)). A run sent once the stop has begun is answered the same way in every mode, before it starts (see below).

**When the server stops** — a deploy, a restart —, a run still in progress ends on the stop's terms, in every mode. A few seconds after the stop begins, its row reads `failed` with the stop's error, and from then on the run either completes or is told `SERVER_STOPPED` — a failure of its own is reported as the stop's. A run that completes before the server exits, 20 seconds at most after the stop began, replaces that failure with its success and is answered as completed. A run still going when the server exits gets no answer — no response, no final event, no webhook delivery —: read it with `GET /api/runs/:id`. On the `flyio` runtime the stop ends a run at once — save once its agent loop has ended: the upload of its output files and the write of its state go on, and the run completes if they end in time; on the `local` runtime a run goes on until it ends or the server exits. A `POST /run` sent once the stop has begun — on a connection kept alive across it, which still carries requests — is refused `503 SERVER_STOPPED` before the run starts, in every mode, with `Connection: close`: nothing of it runs and no row is written. A run sent just before the stop, whose row was being written as it began, is not started either: its row reads `failed` with the stop's error, and it is answered the same `503`, with that error. See [Stopping the server](self-hosting.md#stopping-the-server).

**When a run outlives its deadline.** A run holds its place until a deadline: its `timeout`, plus a margin — the time a cloud run's machine may take to get ready (the budget below) and two minutes for the upload of its output files. A run still in progress at that deadline is stopped there, in every mode: its record reads `failed`, with the error "This run was still in progress at its deadline — its timeout, plus the time its machine may take to get ready and its outputs to upload — and was stopped." and the code `DEADLINE_EXCEEDED`, and it is charged its time from its admission to its deadline (see [Quotas](#quotas)); on the `flyio` runtime its machine is destroyed. A synchronous run is answered `504 DEADLINE_EXCEEDED`, a webhook delivery carries the code, and a streamed run whose client still reads ends with a `run_error` of that code. A streamed run whose client has stopped reading its events is the run that reaches its deadline: the server sends no event faster than the client reads, and the run waits for it — its own `timeout` included, which only takes effect when the run moves on. Ten seconds after the deadline, its stream is closed, without a final event — read the run with `GET /api/runs/:id` —, and the run ends. On the `local` runtime, a script of the run still running then goes on to its own end.

**On the `flyio` runtime, getting a run's machine ready has a budget**, from waking a pre-warmed machine or creating one up to the machine's answer to the run's start: 513 seconds on a server that sets no cap on the runs it holds at once, a few seconds more on one that does — 530 seconds for a cap of 20, 531 with a pre-warm pool. Past it, the run ends `failed` with the code `MACHINE_SPAWN_FAILED` — as when its machine cannot be started at all —, its message saying the machine was not ready within its budget. See *How long a run waits for its machine* in the [operator guide](self-hosting.md#environment-variables-reference).

**Version-related errors**

| Status | Code | When |
|--------|------|------|
| `400` | `INVALID_VERSION_FORMAT` | `version` is not strict semver (e.g. `"1.0"`, `"^1.0.0"`, `"latest"`, `""`) |
| `403` | `AGENT_NOT_VERIFIED` | Under the `admin` verification policy (the default) only: the resolved version (pinned or latest) is not verified. Returned before any LLM call, MCP connection, file allocation, or DB write happens. The message includes the resolved version so the caller can either pin a verified version or ask an admin to verify the current one. Catch typed via `SkrunNotVerifiedError` in the SDK. |
| `404` | `VERSION_NOT_FOUND` | Pinned version does not exist. Response body includes `available: string[]` — up to 10 most recent versions (newest first) for quick recovery |
| `422` | `BUNDLE_DECOMPRESSED_TOO_LARGE` | The resolved version's stored bundle decompresses to more than `BUNDLE_MAX_DECOMPRESSED_MB` (default 50 MB), what this server now unpacks — a version pushed under a higher cap, this server's since lowered or another instance's, or stored by a server that did not refuse it at push. Returned once the bundle is read, before the run starts, in every response mode the runtime serves; nothing of the run is written. The message names the agent and its version and says who can act: its creator, by pushing a smaller version, or the server's operator, by raising the setting. The code a push of such a bundle is refused with (`413`, see [Push an agent](#push-an-agent)) |

Example 403:
```json
{
  "error": {
    "code": "AGENT_NOT_VERIFIED",
    "message": "Agent acme/seo-audit version 1.2.0 must be verified by an admin before it can run."
  }
}
```

Example 404:
```json
{
  "error": {
    "code": "VERSION_NOT_FOUND",
    "message": "Version 9.9.9 not found for acme/seo-audit",
    "available": ["1.2.0", "1.1.0", "1.0.0"]
  }
}
```

**Rate limit**: 60 requests per minute per client address, in a 60-second window. Every response — including the successful ones — carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; the 61st request in the window is refused with `429` and `RATE_LIMITED` before the agent runs, with `Retry-After`. This limit is per address, whoever sends; the [Quotas](#quotas) are per account. See [Rate limiting](#rate-limiting) for how the client address is determined behind a proxy.

---

### SSE Streaming

Send `Accept: text/event-stream` to receive real-time events during agent execution.

```bash
curl -N -X POST $SKRUN_URL/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input": {"query": "hello"}}'
```

**Event types**

| Event | Description | Data fields |
|-------|-------------|-------------|
| `run_start` | Agent execution started | `run_id`, `agent`, `agent_version`, `timestamp` |
| `tool_call` | Agent is calling a tool | `run_id`, `tool`, `args`, `timestamp` |
| `tool_call_error` | A tool returned an error result (informational — see note below) | `run_id`, `tool`, `message`, `code?`, `timestamp` |
| `tool_result` | Tool returned a result | `run_id`, `tool`, `result`, `is_error`, `timestamp` |
| `llm_complete` | LLM finished generating | `run_id`, `provider`, `model`, `tokens`, `timestamp` |
| `output_validation_warning` | Final output failed schema validation — repair retry follows (see note below) | `run_id`, `errors`, `timestamp` |
| `run_heartbeat` | Periodic keep-alive during long waits (see note below) | `run_id`, `stage`, `timestamp` |
| `runner_spawned` | Cloud runtime only: per-phase cold-start breakdown, emitted once after `run_start` (see note below) | `run_id`, `phases`, `timestamp` |
| `run_complete` | Execution finished successfully — the same shape as the sync result | `run_id`, `output`, `usage`, `cost` (with `saved` when prompt caching saved something), `duration_ms`, `files` (each with its download `url`, and `file_id` on a local run), `files_excluded` (always present — see [Output files](#output-files)), `timestamp` |
| `run_error` | Execution failed | `run_id`, `error.code`, `error.message`, `timestamp` |

Events follow the W3C SSE spec (`event: <type>\ndata: <json>\n\n`). The stream closes after `run_complete` or `run_error`.

The final event — `run_complete` or `run_error` — is sent once the run's status is written: `GET /api/runs/:id` asked on its receipt reads `completed` or `failed`. The server waits 10 seconds at most for that write — a write its database could not take is made again within them, a second then four seconds later (see [Get run detail](#get-run-detail)) —; past them, or when the write fails, the event goes all the same, and the row may still read `running` — for good, when the write failed. A stream the server ends without either event — the run broke off inside the server, or the server exited under it — leaves the row `failed`: `GET /api/runs/:id` gives the error.

**Forward compatibility**: clients MUST ignore unknown event types. Skrun adds new informational events over time (this happened with `tool_call_error` in v0.8.0 and `run_heartbeat` in v0.9.0); a SSE consumer that crashes on an unrecognised `event:` line will break on every release.

**About `tool_call_error`** (added in v0.8.0): emitted **before** the matching `tool_result` whenever a tool returns `is_error: true`. It is **informational only** — the `tool_result` content still flows back to the LLM, which decides how to react (retry, fallback, graceful failure). Skrun does NOT abort the run on tool failure by default, aligning with the industry permissive contract (AWS Bedrock AgentCore, Claude Managed Agents, Google Vertex Agent Builder all behave the same way). Operators get failure visibility (e.g. red event in the dashboard timeline) without losing the LLM's recovery capability. Its `code`, when present, is read from the very start of the error result: a `[CODE]` of 1 to 64 capital letters and underscores and nothing else, left out of its `message` together with the whitespace that follows it. An error result that starts any other way has no `code`, and its `message` is the whole of it.

**About a large tool result**: the `result` of `tool_result` is what the LLM reads, and for an error the `message` of `tool_call_error` is taken from it. A result over the bound of one tool result arrives cut, with a marker at its end; a result that would take the run's tool results past their bound is replaced by a marker that says so — an error keeps its `code` —, and the run goes on. Both bounds and both markers, the same on both runtimes: [agent-yaml → tools](agent-yaml.md#tools-optional).

**About tool arguments nested too deeply**: a tool call whose arguments are nested more than 100 levels deep — objects and arrays inside one another, the arguments themselves the first level — is not run. The tool is not called; the LLM receives an error result that names the bound (`Arguments nested more than 100 levels deep (…): the tool was not called`), which the `tool_call_error` and `tool_result` events that follow carry, and the run goes on. The `tool_call` event carries `"args": { "_omitted": "<that message>" }` in place of the arguments. A model reached through an OpenAI-compatible endpoint — an agent's `model.base_url` among them — can send such arguments.

**About `output_validation_warning` and `OUTPUT_SCHEMA_INVALID`** (added in v0.8.0): emitted when the LLM's final JSON output fails validation against the agent's declared `outputs` schema (declared top-level fields missing or of the wrong type), or is nested more than 100 levels deep — objects and arrays inside one another, the output itself counting as the first level, whatever the declared types. Skrun then issues a single repair call asking the LLM to re-emit a compliant output, continuing the first call's conversation: the repair is asked of the model that answered — the primary, or the fallback when it took over —, never of a fallback, and if that model fails, the run fails. The retry's token usage is summed into the final `usage` regardless of outcome. If the repair succeeds, the run terminates normally via `run_complete` with the corrected output. If the repair still fails (schema mismatch, nesting past 100 levels, or non-JSON response), the run terminates via `run_error` with `error.code: OUTPUT_SCHEMA_INVALID` — its message names what failed, the 100-level bound included — — same terminus pattern as `TIMEOUT`/`EXECUTION_FAILED`, no `run_complete` is emitted. For an agent with `state: { type: kv }`, the same validation judges the `_state` its answer carries: a JSON object, nested at most 100 levels deep (the object itself is the first level), or `null` for no state. An empty string, `0` or `false` count as no state too. Anything else — another string or number, `true`, a list — or a deeper object is an issue of the output: the repair is asked for once: the `_state` its answer carries, `null` or another empty value included, replaces the first answer's — one that carries none keeps it —, and a valid repaired answer ends the run normally; otherwise the run fails `OUTPUT_SCHEMA_INVALID`, and no state is written. `_state` is never part of the run's output.

**About `COST_EXCEEDED`**: emitted when a run's aggregate estimated cost crosses the agent's declared `environment.max_cost` ceiling. The harness tracks the running cost after each LLM call and aborts the moment it is exceeded, and the run fails, with no `run_complete`: its event stream ends with a `run_error` whose `error.code` is `COST_EXCEEDED`, a webhook delivery carries the same `error`, and a synchronous run answers `200` with `status: "failed"` and the message alone in `error`. No usage is reported at the run's end: the `run_error` carries none, a synchronous answer's `usage` reads zero, and the run's history records none; each `llm_complete` event of the stream carries the tokens of its own call. The four bounds below end a run the same way. Agents that declare no `max_cost` are never cost-gated.

**About `TOO_MANY_TOOL_CALLS`**: emitted when one answer of the model asks for more than 128 tool calls in one turn. None of that turn's calls is run, and the run fails as for `COST_EXCEEDED` above, with `error.code: TOO_MANY_TOOL_CALLS`. On the primary model's first answer, before any tool has run, an agent that declares a `fallback` hands the run to it instead — unless that answer alone cost more than the run's whole `max_cost`: the run then fails on this code. See [agent-yaml → The bounds of a run](agent-yaml.md#bounds-of-a-run).

**About `MODEL_RESPONSE_TOO_LARGE`**: emitted when one response of the endpoint an agent declares in `model.base_url` is larger than 4 MiB (4,194,304 bytes, counted once decompressed). It is not read further, nor asked for again. On the primary model, before any tool has run, a declared `fallback` takes over; otherwise the run fails as for `COST_EXCEEDED` above, with `error.code: MODEL_RESPONSE_TOO_LARGE`. A response that has not finished arriving when the run's `timeout` ends is cut there, and the run ends on its timeout. An error response (`4xx`, `5xx`) is read up to the same 4 MiB, and the run fails on the endpoint's error, `EXECUTION_FAILED`, as before. The message never names the endpoint's address.

**About `MODEL_OUTPUT_BUDGET_EXCEEDED`**: emitted when the answers a run keeps of its model weigh more than 4 MiB in all (4,194,304 bytes of UTF-8), the output repair included — each answer counted as the conversation keeps it, as the provider returned it: its text, its reasoning and its tool calls. The run fails as for `COST_EXCEEDED` above, with `error.code: MODEL_OUTPUT_BUDGET_EXCEEDED`; the fallback never takes over, the answers coming from the model itself. The answers of a primary model the fallback replaced are not counted.

**About `OUTPUT_TOO_LARGE`**: emitted when the JSON object of the model's final answer — from its first `{` to its last `}` — is larger than 1 MiB (1,048,576 bytes of UTF-8): it is not parsed, and the run fails as for `COST_EXCEEDED` above, with `error.code: OUTPUT_TOO_LARGE`. The same holds for the answer of an output repair. A final answer with no such object is kept as text, in `{ "result": … }`, as before.

**About `SERVER_STOPPED`**: the run did not finish because the server stopped while it was in progress — a deploy, a restart. The stream ends with a `run_error` whose `error.code` is `SERVER_STOPPED` and whose `error.message` is "The server stopped while this run was in progress."; `GET /api/runs/:id` reads `failed` with the same error. Unlike a failure of the run itself, running it again makes sense — but its tools may already have run, so an agent whose tools act outside (a message sent, a file written) may have done part of that. A run sent once the stop has begun gets no stream at all: it is refused `503` with this code before it starts, its message "The server is stopping and did not start this run; send it again." — nothing of it ran, so sending it again to a server that runs is safe; the SDK and the CLI treat it as any request refused before the run starts. See [Error codes](#error-codes).

**About `DEADLINE_EXCEEDED`**: the run was still in progress at its deadline — its `timeout`, plus the time its machine may take to get ready and its outputs to upload — and the server stopped it there. The stream ends with a `run_error` of this code; `GET /api/runs/:id` reads `failed` with the same error. A client that stops reading the stream holds the run back — events are sent no faster than they are read —, which is how a run comes to its deadline: such a client's stream is closed ten seconds after the deadline, without this event. See [Run an agent](#run-an-agent).

**About `run_heartbeat`** (added in v0.9.0): periodic keep-alive emitted every ~30 s while the harness is blocked on a slow wait — in cloud mode, acquiring the run's machine (the longest wait of a cold start); an LLM call; tool dispatch; or, in cloud mode, the outputs upload. Without it, idle SSE connections risk being closed by reverse proxies / load balancers / browser timeouts long before the agent finishes. The `stage` field tells you what the harness is currently waiting on:

| `stage` | Meaning |
|---------|---------|
| `acquiring_runner` | Cloud mode only — the run's sandbox machine is being woken or created, up to `runner_spawned`. |
| `waiting_llm` | An LLM provider call is in flight. |
| `waiting_tool` | A tool's `callTool` is running (script or MCP). |
| `uploading_outputs` | Cloud mode only — files produced by the run are being sync-uploaded to object storage. |

Example payload:

```json
{ "type": "run_heartbeat", "run_id": "...", "stage": "waiting_llm", "timestamp": "2026-05-23T12:00:30Z" }
```

Heartbeats are purely informational — your client can ignore them entirely and still receive every `tool_*` / `llm_complete` / `run_complete` event as usual. They are NOT emitted when no long await is in flight (so a fast run sees zero heartbeats). A `stage` value your client does not know must be tolerated the way an unknown event type is: stages are added over time, without a coordinated client release. The TypeScript SDK relies on them to bound a silence rather than a run: the `timeout` of `client.stream()` and `client.run()` is the longest gap allowed between two chunks of the stream, so a run lasts as long as it needs.

**About `runner_spawned`** (cloud runtime only): emitted once, after `run_start` and any `acquiring_runner` heartbeats, when a `SKRUN_RUNTIME=flyio` run's sandbox machine is ready. It carries a `phases` map — per-step startup durations (ms), and the pre-warm pool's indicators, a count among them — so you can see where a slow first run spends its time. The same map is kept on the run as `phase_timings`, returned by `GET /api/runs` and `GET /api/runs/:id`:

- `create_api_ms` — the Fly `create` machine API call, including the wait for the server's creation rate in a burst and, when the outcome of the call was unknown, the search for the machine it made (see the operator guide). On a run served from the pre-warm pool (below) this is the wake call instead, since no machine is created
- `host_schedule_pull_ms` — host-side scheduling + image pull (derived from the machine's boot clock; present only when the runner reports it)
- `vm_boot_ms` — the machine's boot up to the runner listening
- `entrypoint_egress_ms` — the in-machine egress-allowlist setup
- `module_load_ms` — how much of `vm_boot_ms` was the runner loading its own code, as opposed to the kernel booting
- `init_bundle_ms` / `init_extract_ms` / `init_deps_ms` / `init_mcp_ms` — the `/init` steps (bundle download, extract, installing the dependencies the agent's scripts declare, MCP connect). `init_deps_ms` is near zero when the agent declares none; otherwise it is paid on every run, since an install is not shared between runs

When the server keeps a **pre-warm pool** (see the operator guide), a run may be served by a machine created in advance rather than one created for it. Those runs carry four more fields, and **omit `vm_boot_ms`, `host_schedule_pull_ms` and `module_load_ms`** — those describe when the machine was built, not this run, and reporting them here would produce a precise, meaningless number:

- `pool_hit` — `true`: the pool served this run. It is never `false`: every other run omits it — no pool configured, a pool that missed, or a run with no right to one (see [Quotas](#quotas))
- `pool_resume_ms` — waking the machine and seeing it answer
- `pool_claim_ms` — handing it the run's credential and egress rules
- `pool_resumed_from_snapshot` — whether the machine genuinely resumed, or silently cold-booted instead. The platform treats the resume as an attempt rather than a guarantee, and a pool whose machines all cold-boot still works while delivering a fraction of the benefit — so it is reported rather than averaged away. Absent when it cannot be determined

One more field comes only on a run that **started on a machine of its own**, so it is not one of those four:

- `pool_handoffs_failed` — `1` when a pooled machine was taken for this run and then discarded on a failed handoff, before it had its machine. A pooled machine counts as taken once the run's handoff begins: its URLs signed, then its credential and allowed hosts handed over (the assignment), then its `/init`. One that would not wake or answer its health check is not counted, nor one discarded as stale before any claim — the run's handoff had not begun, and the next ready machine is tried. A run hands its agent to one pooled machine at most: once one is lost, the run takes a machine of its own — or, when its `/init` failed by the run's own fault, which any machine would meet again (a bundle that does not match its checksum, an MCP server that refuses the agent), it fails `MACHINE_SPAWN_FAILED` without one, its message naming the step. So the field is `1` or absent — never `0` —, and never comes with `pool_hit`. A run with this field keeps its fast run (see [Quotas](#quotas))

Fields are omitted when an older runner image doesn't report them. Local runs (`SKRUN_RUNTIME=local`) don't spawn a machine and emit no `runner_spawned`. The runner's machine id + private IP are recorded operator-side (on the run record) but are **not** returned by `GET /api/runs/:id`.

Validation errors (401, 400, etc.) return normal JSON responses, not SSE streams.

---

### Async Webhook

Send `webhook_url` in the request body to trigger async execution.

```bash
curl -X POST $SKRUN_URL/api/agents/dev/my-agent/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hello"}, "webhook_url": "https://your-app.com/callback"}'
```

**Response** `202 Accepted`

```json
{
  "run_id": "uuid",
  "agent_version": "1.2.0"
}
```

The server executes the agent in the background and POSTs the full result to `webhook_url` when done.

**Webhook delivery**

- Method: `POST`
- Content-Type: `application/json`
- Body: same format as the sync response (includes `agent_version`, `run_id`, `status`, `output`, `usage`, `cost`, `duration_ms`, and, for a completed run, `files` and `files_excluded`)
- Header `X-Skrun-Signature`: `sha256=<hmac>` — HMAC-SHA256 of the body using the server's signing key
- Retries: up to 3 times with exponential backoff (1s, 4s, 16s) on non-2xx responses

A run in progress when the server stops is delivered as its row reads — `SERVER_STOPPED`, or its success if it completes first (see [Run an agent](#run-an-agent)) —, but only while the server lasts: a delivery still waiting on its retries when the server exits, or a run still going then, is never sent. A run that breaks off inside the server is not delivered either; its row reads `failed`. `GET /api/runs/:id` is authoritative.

**Server requirement: `WEBHOOK_SIGNING_KEY`** (added in v0.8.0)

The server signs every delivery with `WEBHOOK_SIGNING_KEY`. If the env var is unset, the runtime **refuses to deliver** the webhook (no insecure default). Generate one — a 32-byte random hex key — at the end of the server's env file before enabling webhook mode. On the bare-metal install, that file is `.env` at the repository root:

```bash
echo "WEBHOOK_SIGNING_KEY=$(openssl rand -hex 32)" >> .env
```

On the Docker Compose stack, it is `infra/.env`, where its quick start already wrote one; a name set twice takes its last line. Apply it with `docker compose -f infra/docker-compose.yml up -d`:

```bash
echo "WEBHOOK_SIGNING_KEY=$(openssl rand -hex 32)" >> infra/.env
```

The receiver verifies the signature by computing `HMAC-SHA256(body, WEBHOOK_SIGNING_KEY)` and comparing to the `sha256=...` portion of the `X-Skrun-Signature` header.

**Requirements**

- `webhook_url` must be a valid URL
- `webhook_url` must use HTTPS and must not resolve to a private/reserved address (blocks AWS IMDS, localhost services, link-local, IPv4-mapped IPv6) — enforced **by default, fail-closed**, and re-checked against the resolved IP at delivery time (DNS-rebinding-safe)
- To deliver to a local listener (`http://localhost:NNNN/...`) during development, set `SKRUN_ALLOW_LOCAL_WEBHOOKS=true` — this relaxes both the HTTPS and private-host checks for local testing only
- Cannot be combined with `Accept: text/event-stream`
- Server requires `WEBHOOK_SIGNING_KEY` env var (see above)

---

### Caller-provided API keys

Every run needs a model key. Callers can supply their own via the `X-LLM-API-Key` header:

```
X-LLM-API-Key: {"google": "AIza...", "anthropic": "sk-ant-..."}
```

The value is a JSON object mapping provider names to API keys. The clients set it for you: the SDK's `llmKeys` option, and the CLI's `skrun run --llm-key-env <provider>=<VARIABLE>` or `--llm-key-stdin <provider>` — which read the key from an environment variable or from stdin, never from the command line (see the [CLI reference](cli.md#skrun-run)).

**Accepted providers**: those `agent.yaml` knows — `anthropic`, `openai`, `google`, `mistral`, `groq`, `xai`, and `meta` for an agent that declares `model.base_url`, the one endpoint a `meta` key is sent to

**Key priority** (per provider):
1. **Caller key** (`X-LLM-API-Key` header) — takes precedence
2. **Creator key** attached to the agent by its owner, encrypted at rest — this is how a creator covers the inference so their own callers need no key at all
3. **Server key** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … in the host environment) — fallback. Appropriate for a single-tenant self-host that is paying for itself; **deliberately not set on the Skrun cloud**, where open signup would otherwise let any account run inference on the operator's credit
4. **None available** — for the primary model, nor for its fallback (see below) — the run is refused before it starts with `400 LLM_KEY_REQUIRED`. The message names what you can do: send a key in `X-LLM-API-Key`, or ask the agent's owner to attach one (`skrun llm-key set`) — only the latter for an agent whose owner accepts no caller key (`creator_only`), where the header would be refused with `403 CALLER_KEY_NOT_ALLOWED`. For an agent that declares its own `model.base_url`, unless you run your own agent with an account-wide credential, the message names that endpoint's origin and asks for it in `X-LLM-Base-URL` beside a key for the provider of the agent's primary model — the one key sent to that endpoint, which a fallback on the same provider uses too: such a key sent without it is refused with `403 CALLER_BASE_URL_NOT_CONSENTED`. A key for a fallback on another provider needs no origin named (see [Where your key is sent](#where-your-key-is-sent)). The server key is named last, as the operator's setting. Nothing is recorded, no sandbox is started. The same applies when the agent declares its own `model.base_url` and no caller or creator key is available, unless the operator lets the server key go to such an endpoint (`SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true`)

**The primary model or its fallback.** A run is refused only when neither the agent's primary model nor its `fallback` finds a key; the message then names both providers. A primary with no key fails at its first call and the fallback takes over, so a run whose fallback has a key goes ahead and is served by the fallback — send a key for either provider (with the origin in `X-LLM-Base-URL` where the paragraph above says so). A `fallback` without a key does not refuse a run whose primary has one: it is only tried when the primary fails, and fails then as any model call without a key does. The fallback never goes to the agent's own `model.base_url`, so the server's key serves it like any provider.

**A `meta` model without a `model.base_url`** — a version published before validation and the push refused one — is served by no key: a key for `meta` from the caller, the agent's owner or the server is passed over, for the primary model as for the fallback. A run only such a model could serve is refused `400 LLM_KEY_REQUIRED` before it starts, and the message says to set `model.base_url` and publish a new version — then, for a fallback on another provider that has no key, the ways to serve that fallback. A `meta` fallback without a `model.base_url` is left out of the message, which reads as for an agent with no fallback; and once a run has started, its primary failing, such a fallback ends the run on `Unknown provider: "meta"`.

**Behaviour change**: a run with no key used to start, then fail at its first model call — a `run_start` followed by a `run_error` on an event stream, a `failed` result in sync mode, a `202`, then a webhook reporting a failed run. The error now arrives as the HTTP response itself, in every mode the runtime serves: before any event stream opens, and instead of the `202`. A client that read this error from the stream reads it from the response status.

Where a key is allowed to be *sent* is a separate question — see [Where your key is sent](#where-your-key-is-sent).

If a caller-provided key fails (invalid, quota exceeded), the primary model's call fails like any other. If the agent declares a `fallback` and no tool has run yet, the fallback takes over, with the key your `X-LLM-API-Key` carries for its provider — or, without one, the agent owner's creator key for that provider, then the server's, where the operator set one. Once a tool has run, the run fails instead.

**Security**: caller keys are never logged, persisted, or returned in responses. Use HTTPS in production.

**Example**

```bash
curl -N -X POST $SKRUN_URL/api/agents/dev/code-review/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H 'X-LLM-API-Key: {"google": "AIza..."}' \
  -d '{"input": {"code": "function add(a,b) { return a + b; }"}}'
```

### Where your key is sent

An `agent.yaml` may declare its own `model.base_url` — an alternative
OpenAI-compatible provider, or a local inference server. That endpoint is chosen
by the agent's **author**. Your `X-LLM-API-Key` belongs to **you**. When those are
two different people, the server will not send your key to their endpoint unless
you say where your key belongs:

```
X-LLM-Base-URL: {"openai": "https://api.deepseek.com"}
```

Same shape as `X-LLM-API-Key` — a JSON object mapping provider to base URL —
compared by **origin**, so the path need not match.

Only your key for the provider of the agent's **primary** model goes to that
endpoint. A `fallback` model is always called at its own provider's endpoint,
never at the agent's `base_url`: a fallback on the same provider uses that same
key, so the same rule holds; a key for a fallback on another provider is never
sent there and needs no `X-LLM-Base-URL`.

So, as soon as you send `X-LLM-API-Key` or `X-LLM-Base-URL` — either one alone
included — and unless you run your own agent on an account-wide credential (see
below), two rules apply:

- **A key for the provider of the agent's primary model needs the agent's origin
  named** when the agent declares a `base_url`. Sent without an `X-LLM-Base-URL`
  entry for that provider, or with another origin, the key is refused.
- **Every origin you name must be where that provider's key goes**, whatever
  keys you send, none included. For the provider of the agent's primary model,
  when the agent declares a `base_url`, that is its origin. For any other
  provider — its fallback's, or one the agent does not use — there is none: the
  agent declares no endpoint for it, so naming one is refused. An agent with no
  `base_url` calls every provider at its default endpoint, so any entry is
  refused: your declaration would be wrong about where a key of yours goes.

Either refusal is `403 CALLER_BASE_URL_NOT_CONSENTED`, before any model call.

You do not need to know the agent's endpoint in advance. Send your key; if the
agent uses an endpoint you have not named, the run is refused and the error tells
you which one:

```json
{
  "error": {
    "code": "CALLER_BASE_URL_NOT_CONSENTED",
    "message": "This agent sends model requests to https://api.deepseek.com, which you did not choose. Your X-LLM-API-Key would be sent there. To proceed, declare that origin in the X-LLM-Base-URL header, e.g. {\"openai\": \"https://api.deepseek.com\"}."
  }
}
```

When you named another origin, that message ends with the one you declared. When
you named another origin but sent no key for that provider, the message says
instead that the origin you declared is not the agent's, names the agent's, and
lets you name it or leave that provider out of the header. An entry for any other
provider is refused with a message that names that provider and the origin you
declared, and says which entry the agent takes, if any.

**When this does not apply**

- You are running **your own** agent with an account-wide credential (a session,
  a dev-token, or a full API key) — you chose both sides, so nothing changes.
- The agent declares no `base_url` — the overwhelmingly common case — and you
  send no `X-LLM-Base-URL`.
- Your `X-LLM-API-Key` holds no key for the provider of the agent's primary model,
  only one for its `fallback` on another provider — that key goes to its
  provider's own endpoint, never to the agent's `base_url` — and your
  `X-LLM-Base-URL`, if you send one, names only the agent's origin, for its
  primary model's provider.

It **does** apply when you hold a key someone else issued you for their agent
(an agent-scoped API key), which is the case the check exists for: the agent's
author picks the destination, you supply the credential.

SDK equivalent:

```ts
await client.run("acme/summarizer", input, {
  llmKeys: { openai: "sk-..." },
  llmBaseUrls: { openai: "https://api.deepseek.com" },
});
```

---

### Push an agent

```
POST /api/agents/:namespace/:name/push?version=1.0.0
```

Upload an agent bundle to the registry.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/octet-stream` |
| `X-Skrun-Version-Notes` | No | Optional note attached to this version. Percent-encoded UTF-8, max 500 characters, plain text only. Used to describe what changed (like a commit message). The CLI `-m` / `--message` flag sets this header. |

**Body**: raw `.agent` bundle (tar.gz created by `skrun build`), capped at `SKRUN_PUSH_MAX_BODY_MB` (default 50 MB) — and refused past `BUNDLE_MAX_DECOMPRESSED_MB` (default 50 MB) once decompressed (see *Errors*, below).

**Query params**

| Param | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Semver version string (e.g., `1.0.0`) |

**Response** `200`

```json
{
  "name": "my-agent",
  "namespace": "dev",
  "latest_version": "1.0.0"
}
```

**Response headers**

| Header | When |
|--------|------|
| `X-Skrun-Warning: notes-unsupported` | Set only if the client sent `X-Skrun-Version-Notes` but the server version doesn't support it. The push still succeeds but the note is not stored. |

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `MISSING_VERSION` | `version` query param is missing |
| `400` | `INVALID_VERSION_FORMAT` | `version` is not strict semver — three whole numbers separated by dots, the expression `POST /run` holds a version to: `1.0`, `latest`, `1.0.0-beta` or a path are refused. Refused before the bundle is read, nothing stored; the message does not quote the value |
| `400` | `INVALID_NOTES` | `X-Skrun-Version-Notes` is > 500 chars, contains null bytes, or is malformed percent-encoding |
| `400` | `BUNDLE_CORRUPT` | The body is not a readable `.agent` archive — a gzip-compressed tar, as `skrun build` makes it —, or an entry of the archive cannot be written out where an agent runs; the message names the entry and why. Refused before anything is stored, whatever bounds the server sets (see *A bundle that does not load*, below) |
| `400` | `MISSING_CONFIG` | The archive has no `agent.yaml` at its root, or an empty one. Refused before anything is stored, whatever bounds the server sets |
| `400` | `INVALID_CONFIG` | The bundle's `agent.yaml` is not YAML, declares a YAML version other than 1.2, holds a YAML alias (`*name`) or the tag `!!omap`, or the schema refuses it; the message names each issue. Or reading it took the server longer than 2 seconds — a fixed budget of every server, not a setting —: the read is stopped, and the message says the file is too complex to read, nothing of its content. Or its configuration holds U+0000, the NUL character, or a lone surrogate — half of a UTF-16 pair without its other half —, in a value or a key: the server records a version's configuration, and a Postgres database stores neither. The message names the first field that holds one, never its text; judged once the bundle loads, before the settings refused by name. Refused before anything is stored, whatever bounds the server sets |
| `400` | `MODEL_BASE_URL_REQUIRED` | The bundle's `agent.yaml` declares `model.provider: meta` without a `model.base_url`, or a `fallback` whose provider is `meta`: `meta` has no endpoint of its own. Refused before anything is stored, whatever bounds the server sets (see [Refused settings](agent-yaml.md#refused-settings)) |
| `400` | `UNSUPPORTED_FIELD` | The bundle's `agent.yaml` declares an MCP server's `auth` other than `none`, or a `secrets` list that names a secret — settings not yet supported. Refused before anything is stored, whatever bounds the server sets |
| `400` | `TIMEOUT_OUT_OF_RANGE` | The bundle's `agent.yaml` declares a `timeout` outside `1s` to `2147483s`. Refused before anything is stored, whatever bounds the server sets — and before the server's longest timeout is looked at: such a value is never answered `TIMEOUT_ABOVE_LIMIT` |
| `400` | `TIMEOUT_ABOVE_LIMIT` | On a server that sets a longest timeout (`SKRUN_RUN_MAX_TIMEOUT_S`): the bundle's `agent.yaml` declares a `timeout` above it — or declares none, under a longest timeout below the 300 s default. The message gives both values. Checked before anything is stored (see [Quotas](#quotas)) |
| `403` | `FORBIDDEN` | Pushing outside your namespace |
| `409` | `VERSION_EXISTS` | Same version already pushed (bump `version` in `agent.yaml`) — answered before the account's storage is checked: a version already pushed adds nothing, whatever the account holds. Of two pushes of one version at once, the second gets it: an account's pushes are checked one at a time by each server process (see [Quotas](#quotas), *Bundle storage*, for a server run as several instances) |
| `413` | `BUNDLE_TOO_LARGE` | The request body — the **compressed** bundle — exceeds `SKRUN_PUSH_MAX_BODY_MB` (default 50 MB). Refused on a declared `Content-Length` before anything is read; without one, at the first chunk past the cap — the route never reads more than the cap, and reads nothing before the caller is authenticated (see [Request size](#request-size)). This is a different ceiling from `BUNDLE_MAX_DECOMPRESSED_MB`, which bounds what the archive expands to (`413 BUNDLE_DECOMPRESSED_TOO_LARGE`, below); the message names both settings, which the server's operator raises together. `skrun build` does not refuse such a bundle: it warns past 50 MB compressed or unpacked — the defaults, not this server's settings, which it does not know — and the push gets this refusal. |
| `413` | `BUNDLE_DECOMPRESSED_TOO_LARGE` | The bundle decompresses to more than `BUNDLE_MAX_DECOMPRESSED_MB` (default 50 MB), what this server unpacks — counted on the unpacked archive, its tar headers included. Refused first, on the bundle alone, before anything is stored, whatever bounds the server sets. The server stops unpacking at the cap, so it never knows the bundle's full size: the message says it decompresses to *more than* the cap, names the setting, and says what to do — make the agent smaller, leaving out the files it does not need when it runs, or have the server's operator raise the setting |
| `413` | `CONFIG_TOO_LARGE` | The bundle's `agent.yaml` weighs more than 128 KB (131,072 bytes) — a fixed limit of every server, not a setting: `agent.yaml` holds the agent's configuration, and long content (instructions, context, data) belongs in `SKILL.md`, `AGENTS.md` or other files of the bundle. Judged on the file's bytes before it is parsed, whatever bounds the server sets, before anything is stored; the message gives its size and the limit, each to the byte. `skrun build` warns past it, and builds |
| `413` | `STORAGE_QUOTA_EXCEEDED` | On a server that bounds an account's bundle storage (`SKRUN_QUOTA_STORAGE_MB`): the bundles the account's agents hold, this one included, would exceed its plan's. Refused before anything is stored — no agent created for a first version, no object written. A full-access credential is told what the account holds and the cap; deleting a version, or an agent, makes room (see [Quotas](#quotas)) |
| `429` | `RATE_LIMITED` | More than 10 pushes from the same client address inside the 60-second window |
| `503` | `PUSH_BUSY` | The server already has as many `agent.yaml` reads waiting as it lets a push wait behind — 16 per server process, besides the two it reads at once. Refused at once, before anything is stored, with `Retry-After: 3`: send it again then (see *When the server is busy*, below) |

**A bundle that does not load**: a push whose bundle no run could read is refused before anything is stored — no agent created, no object written, no version —, whatever bounds the server sets, and before the version is looked up. It is judged on the bundle alone, in this order: `413 BUNDLE_DECOMPRESSED_TOO_LARGE`, past the decompression cap; `400 BUNDLE_CORRUPT`, not a readable archive; `400 MISSING_CONFIG`, no `agent.yaml` at its root or an empty one; `413 CONFIG_TOO_LARGE`, an `agent.yaml` over 128 KB, never parsed; `400 INVALID_CONFIG`, an `agent.yaml` that is not YAML, that declares a YAML version other than 1.2, that holds a YAML alias or the tag `!!omap`, that the schema refuses, or that takes the server longer than 2 seconds to read. The server reads `agent.yaml` in a thread of its own, so a slow file never holds its other requests; each server process reads at most two files at once, and a push past them waits its turn, its 2 seconds starting when its own read does (see *When the server is busy*, below). A run answers a stored bundle with four of these codes: `422 BUNDLE_DECOMPRESSED_TOO_LARGE`, past the cap the server has when it runs — a version pushed under a higher cap, or stored by an earlier server —, and `BUNDLE_CORRUPT`, `MISSING_CONFIG` and `INVALID_CONFIG` with `500`, for such a bundle stored by an earlier server (see [Error codes](#error-codes)). A run reads `agent.yaml` as a push does — in a thread of its own, within the same 2 seconds —, once for as long as the server keeps the agent's bundle in its run cache: an `agent.yaml` stored by an earlier server that takes longer is `500 INVALID_CONFIG` at its runs, the message saying it is too complex to read. A run never judges the size of `agent.yaml`: a version stored with a larger one, before the push refused it, runs as it did. Only `agent.yaml` is read out of the archive, but the cap judges all of it. An archive is `400 BUNDLE_CORRUPT` too when an entry of it cannot be written out where an agent runs — by the server, by the cloud sandbox's `tar`, by `skrun pull` —, the message naming the entry and why: a path that holds `..`; a file with no name, or whose name ends with `/`; a NUL character in a name; a name over 255 bytes between two `/` — counted in bytes, so 128 `é` are 256 —, or a path over 1,024 bytes; two entries that contradict each other, in either order — a file `x` and an entry under it (`x/y`), or one path both a file and a directory; a character or block device; a hard link with no file to link to before it in the archive — its target absent, placed after it, or a directory. Only `/` separates a path's names: on Linux, where agents run, `\` is a character of a name. Every entry is judged, not only `agent.yaml`, and before `agent.yaml` is looked for. Two files of one path are accepted: every writer keeps the last. So are a FIFO and a hard link to a file written before it. So are two paths that differ only by case (`A` and `a/y`): two names on Linux, where agents run, but one on a disk that ignores case (macOS, Windows), where `skrun pull` can fail on them. A directory entry, which the standard `tar` writes for each directory, makes its directory. `POST /api/agents/scan/:name/push` refuses the same way: the bundle it builds from the directory always unpacks and its files never contradict each other, but a path over 1,024 bytes or a name over 255 bytes is refused `400 BUNDLE_CORRUPT`, and a directory without `agent.yaml` gets its own `400 INVALID_AGENT`, so it meets the cap, an empty `agent.yaml`, one over 128 KB and an invalid one.

**Settings refused by name**: `MODEL_BASE_URL_REQUIRED`, `UNSUPPORTED_FIELD` and `TIMEOUT_OUT_OF_RANGE` are the refusals of validation (`skrun build`), made again at push for a bundle sent without it — by the SDK, `curl` or the dashboard. They are checked once the bundle loads (above), before the server's own bounds and before the version is looked up — and after a configuration that holds U+0000 or a lone surrogate, refused `400 INVALID_CONFIG` first: a bundle that holds both gets that one. A bundle that declares several of these settings gets one `400`: the code of the first, in this order — `meta` as the provider, `meta` as the fallback's, an MCP server's `auth`, `secrets`, `timeout` —, the message naming each. `POST /api/agents/scan/:name/push` refuses them the same way.

**When the server is busy**: each server process reads at most two `agent.yaml` files at once — a push's, or a run's first read of a bundle —, and the others wait their turn, in the order they came. A push that finds 16 reads waiting — a fixed bound of every server, no setting — is refused at once, `503 PUSH_BUSY`, before anything is stored, with `Retry-After: 3` — within one 2-second budget every read in progress has ended and made room: send it again then. It is the server's state, not a fault of the bundle: only files slow to read fill the line, and an ordinary `agent.yaml` reads in a few milliseconds. A run's read waits however many reads wait, and is never refused so. A push whose client hangs up while it waits leaves its place at once, its file never read and nothing stored; once its read has started, the push goes on, and may be stored. The server writes one `warn` line for each push it refuses so, `"event":"push_busy"`, with the agent (`agent`, `agent_version`) and `waiting_at_most`, never the file. `POST /api/agents/scan/:name/push` waits in the same line, and is refused the same way.

**Rate limit**: 10 requests per minute per client address, in a 60-second window. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; the 11th push in the window is refused with `429` and `RATE_LIMITED`. `POST /api/agents/scan/:name/push` (the push-from-a-local-directory path) is counted against the same limit.

**Note**: you can only push to your own namespace. `dev-token` grants access to the `dev` namespace.

---

### Pull an agent

```
GET /api/agents/:namespace/:name/pull
GET /api/agents/:namespace/:name/pull/:version
```

Download an agent bundle. Without `:version`, returns the latest version.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Multi-tenancy**: a caller without access to the agent (non-owner non-admin) receives a `404 NOT_FOUND` indistinguishable from "agent does not exist" — the response body and headers are identical to a genuine not-found. No bundle bytes leak, no `Content-Disposition` header on the 404. An admin on a full-access credential (and dev-token in self-host) bypasses this filter; an admin's restricted or delegated key reads as an ordinary key.

**Full access**: an agent's source is for a full-access credential — a session, `dev-token`, or an account-wide key with all three operations. Any other key gets `403 KEY_SCOPE_FORBIDDEN`, after the check above (see [What a key may read](#api-keys)).

**Response** `200`: binary `.agent` bundle with headers:
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="name-version.agent"`
- `X-Agent-Version: 1.0.0`

**Response** `401`: anonymous caller. Body `{ "error": { "code": "UNAUTHORIZED", ... } }`.

**Response** `403`: `KEY_SCOPE_FORBIDDEN` — the key does not carry full access (a run-only key, or a key restricted to some agents).

**Response** `404`: agent does not exist OR caller is not the owner / admin (opaque).

---

### List agents

```
GET /api/agents?page=1&limit=20
```

List agents. **Authentication required.** Returns the caller's own agents (filtered by `owner_id`); returns all agents instance-wide when the caller is an admin (`users.role = 'admin'`) on a full-access credential — a session, `dev-token`, or an account-wide key with all three operations. An admin's account-wide key with fewer operations lists their own agents only, as any account's would. In self-host with dev-token mode, the caller is auto-granted admin and sees all agents — same UX as before the multi-tenant filter shipped.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `20` | Results per page |

**Response** `200`

```json
{
  "agents": [...],
  "total": 12,
  "page": 1,
  "limit": 20
}
```

The `total` field reflects the **filtered** count (not the global agent count). A user who owns no agents receives `{ "agents": [], "total": 0 }` — no error.

**Response** `401`: anonymous caller.

**Response** `403`: `KEY_SCOPE_FORBIDDEN` — the key is restricted to some agents (a delegated key): it cannot list the account's agents.

---

### Agent metadata

```
GET /api/agents/:namespace/:name
```

Get metadata for a specific agent. **Authentication required.** Non-owner non-admin callers receive `404 NOT_FOUND` indistinguishable from agent-not-found — existence is hidden from non-privileged readers (GitHub Private Repo / Stripe / Linear pattern). An admin reads any account's agent on a full-access credential only; an admin's restricted or delegated key reads as an ordinary key and gets the same `404`.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{
  "name": "code-review",
  "namespace": "dev",
  "latest_version_verified": false,
  "latest_version": "1.0.0",
  "created_at": "2026-04-11T...",
  "updated_at": "2026-04-11T..."
}
```

`latest_version_verified` mirrors the `verified` flag of the most recently pushed version. It's the signal that drives the dashboard listing badge. Older versions may have a different state — fetch `GET /versions` (below) to see the per-version flag.

**Response** `401`: anonymous caller.

**Response** `403`: `KEY_SCOPE_FORBIDDEN` — the key is restricted to some agents (a delegated key), and this agent of the account is not one of them. Checked after the ownership check: an agent of another account answers the `404` below.

**Response** `404`: agent does not exist OR caller is not the owner / admin (opaque body — identical in both cases).

---

An administrator reads the state of the pre-warm pool and of the machine maintenance with `GET /api/admin/pool` — see [Pre-warm pool status (admin only)](self-hosting.md#pre-warm-pool-status-admin-only) in the self-hosting guide.

<a id="verify-a-version-admin-only"></a>

### Verify a version

```
PATCH /api/agents/:namespace/:name/versions/:version/verify
```

Set or unset the `verified` flag on a **specific version** of an agent. What the flag does, and who may set it, is the operator's verification policy (`SKRUN_VERIFICATION_POLICY`, see [Verification policy](self-hosting.md#verification-policy)):

| Policy | What an unverified version does | Who may call this endpoint |
|--------|---------------------------------|----------------------------|
| `admin` *(default)* | Refused whole: `POST /run` returns `403 AGENT_NOT_VERIFIED` before any model call, tool or script | Instance admins only (`users.role = 'admin'`), on a full-access credential. The self-served behaviour — any namespace owner could verify their own agents — was closed in v0.8.0 |
| `owner` | Runs, scripts included — the flag records the owner's attestation | The agent's owner, or an admin |
| `disabled` | Runs, scripts included — the flag is inert metadata | The agent's owner, or an admin |

An admin verifies an agent of another account on a full-access credential only — a session, `dev-token`, or an account-wide key with all three operations. An admin's restricted or delegated key is held to the policy like any key of their account: under `admin` it verifies nothing (`403 FORBIDDEN`), and under `owner` and `disabled` only the admin's own agents.

Verification never filters what a run does: a version that may run, runs whole.

**Per-version, not per-agent**: pushing a new version creates a row at `verified=false` without touching prior versions. Under `admin`, a caller pinning `version: "1.0.0"` keeps running even after a newer v1.1.0 push (until the v1.0.0 row is explicitly unverified). This protects pinned production callers from author iteration.

Promotion to admin is a manual SQL update — there is no HTTP endpoint for role elevation by design: see [Admin role](self-hosting.md#admin-role) in the self-hosting guide.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |
| `Content-Type` | Yes | `application/json` |

**Request body**

```json
{ "verified": true }
```

**Response** `200`: returns the updated version row — with its `config_snapshot` for a session, `dev-token`, or an account-wide key with all three operations, and without the field (absent, not `null`) for any other key, as in [Agent versions](#agent-versions). A key with `agent:verify` but without full access may set the flag on its own account's agents, under the `owner` and `disabled` policies — an admin's included; setting it to the value it already has must not read the configuration.

```json
{
  "version": "1.0.0",
  "size": 12345,
  "pushed_at": "2026-04-11T...",
  "config_snapshot": { "...": "..." },
  "notes": null,
  "verified": true
}
```

**Errors**: `401` if no auth, `403 FORBIDDEN` if the policy does not let the caller verify this agent (see the table above) — its message names the credential an admin needs, full access —, `403 KEY_SCOPE_FORBIDDEN` if the key lacks `agent:verify` or is restricted to other agents, `404` if agent or version not found, `400` if body is invalid.

**Note**: in dev mode (`dev-token`, accepted only where `SKRUN_DEV_AUTH` is on and OAuth is not configured — see [Mode 1](#mode-1-local-dev-dev-token)), the caller is granted admin role unconditionally so `PATCH .../verify` works without any extra setup — this preserves zero-friction local development.

**Structured log**: every successful flip emits a pino `info` line (`event: "agent_version_verify"`) with the actor identity, target version, and action — see [Admin role](self-hosting.md#admin-role) in the self-hosting guide.

**Legacy endpoint removed**: the agent-level `PATCH /api/agents/:ns/:name/verify` (v0.7.x) is gone — calls now return `404`. Migrate to the per-version path above.

---

### Delete an agent

```
DELETE /api/agents/:namespace/:name
```

Permanently delete an agent along with all its versions. Requires authentication and namespace ownership (only the owner can delete).

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{ "success": true }
```

**Errors**: `401` if no auth, `403` if not namespace owner, `404` if agent not found.

Note: past runs for the deleted agent remain in the database with `agent_id: null` (soft reference via `ON DELETE SET NULL`).

---

### Delete a single version

```
DELETE /api/agents/:namespace/:name/versions/:version
```

Permanently delete one version of an agent. Use this when a single push went bad (broken bundle, wrong content) and you don't want to remove the whole agent. Requires authentication and namespace ownership. Cannot delete the last remaining version — use [`DELETE /api/agents/:namespace/:name`](#delete-an-agent) for full removal.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `204` (no body)

**Errors**:
- `401` if no auth
- `403` if not namespace owner
- `404 NOT_FOUND` if the agent does not exist
- `404 VERSION_NOT_FOUND` if the agent exists but the version does not
- `409 LAST_VERSION` if deletion would leave the agent with zero versions

**Example**

```bash
curl -X DELETE \
  -H "Authorization: Bearer dev-token" \
  $SKRUN_URL/api/agents/dev/email-drafter/versions/1.0.5
# → HTTP/1.1 204 No Content
```

Note: past runs referencing the deleted version remain readable. `runs.agent_version` is stored as plain text (not a foreign key), so historical run records keep their version reference even after the version row is gone. The agent's `latest_version` field automatically reflects the new latest after deletion.

---

### Delete your account

```
DELETE /api/account
```

Permanently deletes the caller's account. There is no undo and no grace period.

**Who can call it**: a full-access credential — a session, `dev-token`, or an account-wide API key that carries every operation (`agent:run`, `agent:push`, `agent:verify`). A run-only key or a delegated key gets `403 KEY_SCOPE_FORBIDDEN`.

**Body** (required): `{"confirm": "<your username>"}` — exactly the `username` `GET /api/me` returns.

**From a browser session**, send the body as JSON, with `Content-Type: application/json`: a change-making request carried by the session cookie alone, with no JSON body and no browser signal, is refused by the CSRF guard with `403 Forbidden` before it reaches this route.

```bash
curl -X DELETE \
  -H "Authorization: Bearer skrun_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"confirm": "alice"}' \
  $SKRUN_URL/api/account
```

**Response** `200`

```json
{ "deleted": true }
```

With a session, the response also clears the session cookie under every name and scope it may hold, as `POST /auth/logout` does. Afterwards `GET /api/me` answers `401` to the deleted account's sessions and keys.

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `CONFIRMATION_MISMATCH` | No JSON body, no `confirm`, or a `confirm` that is not your username. Nothing was deleted |
| `401` | `UNAUTHORIZED` | No credential |
| `403` | `KEY_SCOPE_FORBIDDEN` | A key without full access |
| `404` | `NOT_FOUND` | The account has no record (a `dev-token` whose account could not be stored), or another deletion of it finished first |
| `503` | `STORAGE_UNAVAILABLE` | Object storage failed the deletion before any row went: an object of the account could not be listed or deleted — see *A deletion that stops half-way* below —, or, on a server that keeps a deletion journal, the deletion could not be recorded there, nothing being deleted yet |

A run still going never blocks a deletion: there is no `409`.

**What is deleted**: the account; its API keys (the delegated keys it handed to clients included — they stop working at once) and its sessions and device-login codes; its agents, with every version, the bundles in object storage, the model keys attached to them and their notebooks; its environments; the notebooks other agents keep for the account or for one of its keys; the output files that the runs below left in object storage on the cloud runtime; the uploads this server instance holds for it.

**What is cleared and detached**: every run the account made, and every run of its agents whoever made it. Each one stays, with its status, model, usage, duration and timestamps, but its `input`, `output` and `error` become `null`, its `files` `[]`, and it no longer points to the account or to the agent. The version it names loses the namespace and the agent's name — `alice/notes@1.0.0` becomes `@1.0.0`, which is what a run history then shows — except on a run the account made on another account's agent, which keeps that agent's address. A run another account made on one of your agents therefore stays in that account's history, cleared. So does a run of an agent you had deleted before: deleting an agent detaches its runs without clearing them, and deleting the account then clears every run left with no agent whose version starts with your namespace (`alice/…`). Those runs are found by that text alone, their agent being gone — so they are left as they are when the namespace is not yours alone (another account's agent lives under it, or another account carries the same username). Detached and cleared is all it is: its numbers and timestamps remain, and can still be matched against other records.

**What is not kept**: no record of the deletion in the database — no table, no tombstone. The only trace is one log line, `account_deleted`, with counts (agents, versions, keys, runs cleared, objects deleted) and which route was called, and nothing that names the account — unless the server's operator keeps a deletion journal (`SKRUN_DELETION_JOURNAL`, see [Deleting an account](self-hosting.md#deleting-an-account)): the account's internal id, and nothing else of it, is then kept in the server's object storage until the operator's lifecycle rule on that store removes it, so that a database restored from an earlier copy does not bring the account back. The username is free again at once: the next account created with that GitHub login gets it, and agents it publishes answer the addresses the deleted ones had. In the few milliseconds after a deletion, a new holder who signs up and pushes at once can lose the bundle of that push (see *Deleting an account* in [self-hosting](self-hosting.md)).

**What is not reached**:
- copies another instance of the server holds: run output files until `FILES_RETENTION_S` (1 hour by default) and uploads until `INPUT_FILES_RETENTION_S` (24 hours) have passed, removed by the next five-minute sweep;
- what each instance read of a bundle for a run, the one that served the deletion included — the text of the agent's `SKILL.md`, `agent.yaml` and `AGENTS.md` in its memory, and on the local runtime the bundle extracted to its disk (the cloud runtime writes none): it is never served for another content, and leaves the cache, and the disk, at most `BUNDLE_CACHE_TTL` (600 s) plus five minutes after it was read — an extraction later only if a run on the local runtime still uses it, when that run ends;
- what the account's runs wrote in the notebook of an agent declared `scope: shared` that belongs to another account — that notebook belongs to no caller and goes with its agent;
- logs written before the deletion, and backups of the database or the bucket;
- objects the server does not know about: what an upload that failed half-way left, the output files of a run whose completion was never recorded — the bucket's lifecycle rule on `_runs/` is the floor for those (see [self-hosting](self-hosting.md)).

**A run still going** when the account is deleted goes on until it ends or reaches its timeout, on the model key it already received — a model key attached to the deleted agent included. Its caller gets the result (sync response, stream or webhook), but the run's row is not written back: no output, no error, no files, and the output files it uploads are deleted as it completes, so any download link it hands out leads nowhere. Another request of the account that was authenticated before the deletion and writes after it fails with a `500`.

**A deletion that stops half-way.** Objects are deleted before any row, because only the rows know their keys. If one cannot be deleted, the deletion stops there with `503 STORAGE_UNAVAILABLE`: the account still exists, its sessions and keys still work, and the objects deleted before the failure are gone — a version whose bundle went answers `pull` and `POST /run` with an error until the deletion is finished. Send the same request again, with the same credential: it resumes and finishes.

**With `dev-token`**, the deletion removes the dev account's row; the next request with the token signs in as a new, empty account under the same namespace, with another `id`.

---

An administrator deletes another account with `DELETE /api/admin/accounts/:id` — see [Delete an account (admin only)](self-hosting.md#delete-an-account-admin-only) in the self-hosting guide.

An administrator assigns an account's plan with `PUT /api/admin/accounts/:id/plan` — see [Assign an account's plan (admin only)](self-hosting.md#assign-an-accounts-plan-admin-only) in the self-hosting guide.

---

### Agent versions

```
GET /api/agents/:namespace/:name/versions
```

List all published versions of an agent with full metadata. **Authentication required.** Same multi-tenancy gate as the metadata endpoint — non-owner non-admin callers receive `404 NOT_FOUND` with no `versions` array leaked in the body.

**`config_snapshot` takes full access.** A session, `dev-token`, or an account-wide key with all three operations gets each version with its `config_snapshot`. An account-wide key with fewer operations — a run-only key — gets the same list, each version **without** the field (absent, not `null`): the parsed configuration names the model, the tools and the MCP servers, whose URLs may carry a credential. A key restricted to some agents gets `403 KEY_SCOPE_FORBIDDEN`. The answer of [Verify a version](#verify-a-version) follows the same rule.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Response** `200`

```json
{
  "versions": [
    {
      "version": "1.0.0",
      "size": 4523,
      "pushed_at": "2026-04-20T10:00:00Z",
      "notes": "Initial release — Claude primary with GPT-4 fallback",
      "verified": true,
      "config_snapshot": {
        "model": {
          "provider": "anthropic",
          "name": "claude-sonnet-4-6",
          "fallback": { "provider": "openai", "name": "gpt-4o" }
        },
        "tools": [{ "name": "search", "description": "Search the web" }],
        "mcp_servers": [],
        "inputs": [{ "name": "query", "type": "string", "description": "Search query" }],
        "environment": { "timeout": "120s" }
      }
    },
    {
      "version": "1.1.0",
      "size": 4600,
      "pushed_at": "2026-04-22T11:30:00Z",
      "notes": null,
      "config_snapshot": { "...": "..." }
    }
  ]
}
```

**Response fields** (per version object):

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Semver version string |
| `size` | number | Bundle size in bytes |
| `pushed_at` | string (ISO 8601) | When this version was pushed |
| `notes` | string \| null | Optional note attached at push time via `-m` / `--message` (≤ 500 chars, plain text). `null` if not provided. |
| `config_snapshot` | object | Parsed `agent.yaml` from the bundle at push time (model, tools, mcp_servers, inputs, environment, etc.). Used by the dashboard to display metadata and generate playground forms. Absent for a key without full access (see above). |

The `config_snapshot` is populated at push time by parsing the `agent.yaml` from the uploaded bundle. It includes model configuration (with fallback), tools, MCP servers, inputs schema, and environment settings.

---

### Dashboard stats

```
GET /api/stats
```

Returns aggregated metrics for the dashboard home page. Takes a full-access credential — a session, `dev-token`, or an account-wide key with all three operations; any other key gets `403 KEY_SCOPE_FORBIDDEN` (see [What a key may read](#api-keys)).

**Response** `200`
```json
{
  "agents_count": 3,
  "runs_today": 12,
  "tokens_today": 45200,
  "failed_today": 1,
  "runs_yesterday": 10,
  "tokens_yesterday": 38000,
  "failed_yesterday": 0,
  "daily_runs": [5, 8, 10, 12, 9, 10, 12],
  "daily_tokens": [20000, 32000, 38000, 45200, 35000, 38000, 45200],
  "daily_failed": [0, 1, 0, 0, 1, 0, 1],
  "cache_savings_today": 0.42,
  "cache_savings_yesterday": 0.31,
  "daily_cache_savings": [0.05, 0.18, 0.22, 0.31, 0.27, 0.33, 0.42]
}
```

- `runs_yesterday` / `tokens_yesterday` / `failed_yesterday`: previous UTC day totals (for delta computation).
- `failed_today` / `failed_yesterday`: failed run counts for today and yesterday.
- `daily_runs` / `daily_tokens` / `daily_failed`: 7-element arrays (oldest first, index 6 = today). Zero-padded if fewer than 7 days of data.
- `cache_savings_today` / `cache_savings_yesterday` / `daily_cache_savings`: dollar savings (USD, fractional) produced by prompt-caching. Same 7-element array layout for `daily_cache_savings`. Snapshot at run completion via `cache_read_tokens × (full_input_rate - cached_rate)`.
- **Multi-tenancy**: aggregates filter by the authenticated user. Single-tenant self-host (dev-token mode) gets effectively instance-wide stats; cloud / shared deployments isolate per-user.
- "Today" = current UTC day (00:00 to now).

---

### Usage

```
GET /api/usage
```

What your account consumes now, against the [quotas](#quotas) its plan gives it on this server — the figures a run's admission reads, at the instant of the request: a run admitted a moment later can change them. Takes a full-access credential — a session, `dev-token`, or an account-wide key with all three operations; any other key gets `403 KEY_SCOPE_FORBIDDEN` (see [What a key may read](#api-keys)). A `dev-token` whose account could not be stored gets `404 NOT_FOUND`: its runs count against no account, so there is nothing to read. `GET /api/me` carries none of it. From the SDK: `client.usage()`.

**Response** `200`
```json
{
  "plan": "free",
  "quotas": {
    "concurrent_runs": { "limit": 2, "in_use": 1 },
    "compute": {
      "limit_seconds": 3600,
      "used_seconds": 390,
      "window": { "start": "2026-10-18T12:00:00.000Z", "end": "2026-10-18T18:00:00.000Z" }
    },
    "fast_runs": { "limit": 20, "remaining": 14, "resets_at": "2026-10-18T13:10:00.000Z" }
  }
}
```

- `plan`: the plan whose quotas apply — `free` for an account that has none, for a plan the server's settings do not name, and for `dev-token`.
- `quotas`: `null` when the server sets no quota. `concurrent_runs` and `compute` are each `null` when the server leaves their bound unset; `fast_runs` is `null` only while no pre-warm pool runs (below).
- `concurrent_runs`: the account's runs in progress (`in_use`) and how many its plan allows (`limit`).
- `compute`: `used_seconds`, the time charged to the current window's runs in whole seconds, rounded down — a run in progress counted so far; it can exceed `limit_seconds`, since a run is checked when it is admitted, never during it. `window` is the current window, fixed and aligned on UTC: `start` included, `end` excluded.
- `fast_runs`: `null` while the server runs no pre-warm pool — no run has the right to one, and nothing is said of it. While one runs: `limit`, the fast runs per rolling hour; `remaining`, those left now, never below `0` — only the runs of the hour that keep the right count (see [Quotas](#quotas): a run for which no pooled machine was taken gives it back once its machine is ready); `resets_at`, when the next right comes back — the creation of the oldest run of the hour that keeps the right, plus one hour; a run that had none, or gave it back, moves it neither way. An account that holds more of them than its `limit` — its plan, or the bound, lowered since — gets no right back until enough have left the hour to bring it under the `limit`: `resets_at` is then that instant, the creation of the run whose leaving does it, plus one hour. `resets_at` is `null` when no run of the hour keeps the right. While a run of the account still waits for its machine and will give its right back, `remaining` can be one low for it, and `resets_at` later than the right's real return — never earlier. With no fast-run bound set, every run is entitled: `{ "limit": null, "remaining": null, "resets_at": null }`. A plan that includes none: `{ "limit": 0, "remaining": 0, "resets_at": null }`.

---

### Instance links

```
GET /api/instance
```

The links this instance shows — its docs, and the operator's terms and privacy policy —, read by the dashboard once when it loads. Any credential reads it — a session, `dev-token`, an API key of any reach, one restricted to some agents included: the body is the instance's configuration, the same for every caller, and says nothing about the account. A request without a valid credential gets `401 UNAUTHORIZED`, as on every authenticated route. The values are the ones the server validated when it started, in the form its pages serve them — an absolute address normalised, a path on this server as written —, so they change only when it restarts. The operator sets them: see [Self-hosting → Your own site in front of the API](self-hosting.md#your-own-site-in-front-of-the-api). `GET /api/me` carries none of it.

**Response** `200`
```json
{
  "links": {
    "docs": "https://example.com/docs",
    "terms": "https://example.com/legal/terms",
    "privacy": null
  }
}
```

- `docs`: always a string — the operator's docs address, or `/docs`, this server's API reference, when none is configured.
- `terms`, `privacy`: the operator's terms and privacy policy, each `null` when not configured.

An instance that configures none answers `{ "links": { "docs": "/docs", "terms": null, "privacy": null } }`.

---

### Agent stats

```
GET /api/agents/:namespace/:name/stats?days=N
```

Returns aggregated metrics for a specific agent over the requested period. **Authentication required.** Same multi-tenancy gate as the metadata + versions endpoints — non-owner non-admin callers receive `404 NOT_FOUND` indistinguishable from agent-not-found, with no `runs` / `tokens` / `cost` fields leaked. After that check, a key without full access — a run-only key, or a key restricted to some agents — gets `403 KEY_SCOPE_FORBIDDEN` (see [What a key may read](#api-keys)).

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <token>` |

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `days` | `7` | Number of days to aggregate (1-30) |

**Response** `200`
```json
{
  "runs": 42,
  "tokens": 84000,
  "failed": 2,
  "avg_duration_ms": 1200,
  "prev_runs": 38,
  "prev_tokens": 72000,
  "prev_failed": 1,
  "prev_avg_duration_ms": 1350,
  "daily_runs": [4, 6, 8, 5, 7, 6, 6],
  "daily_tokens": [8000, 12000, 16000, 10000, 14000, 12000, 12000],
  "daily_failed": [0, 1, 0, 0, 1, 0, 0],
  "daily_avg_duration_ms": [1100, 1300, 1200, 1150, 1250, 1200, 1200],
  "cache_savings": 1.42,
  "prev_cache_savings": 0.95,
  "daily_cache_savings": [0.10, 0.15, 0.22, 0.18, 0.25, 0.20, 0.32]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `runs` | number | Total runs in the requested period |
| `tokens` | number | Total tokens consumed in the period |
| `failed` | number | Failed runs in the period |
| `avg_duration_ms` | number | Average run duration in milliseconds |
| `prev_runs` | number | Total runs in the previous equivalent period (for delta computation) |
| `prev_tokens` | number | Total tokens in the previous period |
| `prev_failed` | number | Failed runs in the previous period |
| `prev_avg_duration_ms` | number | Average duration in the previous period |
| `daily_runs` | number[] | Runs per day (oldest first, last element = today). Zero-padded if fewer days of data. |
| `daily_tokens` | number[] | Tokens per day (same ordering) |
| `daily_failed` | number[] | Failed runs per day (same ordering) |
| `daily_avg_duration_ms` | number[] | Average duration per day (same ordering) |
| `cache_savings` | number | Total dollar savings (USD) produced by prompt-caching for this agent in the current period. |
| `prev_cache_savings` | number | Cache savings in the previous equivalent period. |
| `daily_cache_savings` | number[] | Daily savings array (USD). Length matches the `days` query param (default 7). |

---

### List runs

```
GET /api/runs
```

Returns recent runs of the caller's account — those of every key of the account included — sorted by most recent first. Takes a full-access credential — a session, `dev-token`, or an account-wide key with all three operations; any other key gets `403 KEY_SCOPE_FORBIDDEN` (see [What a key may read](#api-keys)).

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | — | Filter by agent ID |
| `status` | string | — | Filter by status: `running`, `completed`, `failed`, `cancelled` |
| `limit` | number | 50 | Max results — a whole number from 1 to 100; absent, unreadable or below 1: 50; above 100: 100 |

**Response** `200` — array of run objects.

**Response** `403` — `KEY_SCOPE_FORBIDDEN`: the key does not carry full access.

---

### Get run detail

```
GET /api/runs/:id
```

Returns a single run by ID with all fields. Takes a full-access credential, as [List runs](#list-runs) does: any other key gets `403 KEY_SCOPE_FORBIDDEN`, whatever the run.

**Response** `200`
```json
{
  "id": "run-abc-123",
  "agent_id": "...",
  "agent_version": "dev/my-agent@1.0.0",
  "status": "completed",
  "model": "anthropic/claude-sonnet-4-6",
  "input": { "topic": "AI" },
  "output": { "result": "..." },
  "error": null,
  "usage_prompt_tokens": 200,
  "usage_completion_tokens": 300,
  "usage_total_tokens": 500,
  "usage_estimated_cost": 0.0025,
  "usage_cache_read_tokens": 7143,
  "usage_cache_write_tokens": 0,
  "usage_cache_savings_usd": 0.001928,
  "duration_ms": 1500,
  "created_at": "2026-04-21T10:00:00Z",
  "completed_at": "2026-04-21T10:00:01Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | string \| null | LLM model used for this run, formatted as `"provider/model-name"` (e.g., `"anthropic/claude-sonnet-4-6"`). Populated at POST /run time. `null` if not applicable. |
| `usage_cache_read_tokens` | number | Tokens served from the provider's prompt cache. 0 when no cache activity. Persisted at run completion. |
| `usage_cache_write_tokens` | number | Tokens written to the provider's prompt cache (Anthropic only). 0 for non-Anthropic models or runs without cache activity. |
| `usage_cache_savings_usd` | number | Dollar savings (USD) produced by prompt-caching, snapshot at write time using the model's per-token rates from `cost.ts`. NUMERIC(10,6) precision. 0 for failed runs (no partial accounting). Same value mirrored as `cost.saved` on the live POST /run response. |

**What a run's record keeps of a large input, output or error.** The record keeps a run's `input` whole up to 8 KiB (8,192 bytes) of its JSON text, its `output` up to 32 KiB (32,768 bytes), counted in UTF-8. Beyond, the field holds a marker instead — the size of the whole JSON text, in bytes, and as much of that text's beginning, cut between two characters, as keeps the marker itself within the same limit:

```json
{ "_truncated": { "bytes": 51234, "preview": "{\"report\":\"The quarterly figures show" } }
```

An `error` is kept whole up to 8 KiB; beyond, its beginning followed by `… [truncated: N bytes]`, N the size of the whole error, the two within 8 KiB. In what the record keeps, each NUL character (U+0000) and each lone surrogate — half of a UTF-16 pair, without the other half — is replaced by U+FFFD, the replacement character, before the sizes are counted: a database may refuse to store either. Only the record is bounded: the run is always handed its whole input, and its caller always gets the whole output and error, as they were — in the synchronous result, the stream's events and the webhook delivery. The same applies to the runs [List runs](#list-runs) returns. Runs recorded before this rule keep what they hold. The record's numbers are bounded too, to what their columns hold: each token count and `duration_ms` a whole number from 0 to 2,147,483,647, `usage_estimated_cost` and `usage_cache_savings_usd` from 0 to 9,999.999999 USD, to the millionth — a larger value kept at its bound, a negative one or one that is not a finite number kept as 0 (`duration_ms` as `null`). A model reached through an OpenAI-compatible endpoint — an agent's `model.base_url` among them — reports the usage it likes: a count it reports that is not a whole number of at least 0 counts 0 from the start, in what the run's caller is told too. If the record of a run's end cannot be written all the same, what follows depends on why. When the database could not take the write — a connection it closed, a failover —, the same write is made again a second later, then four seconds after that: a database back within those five seconds records the run whole. When the database says it refused the data the write carried (an SQLSTATE of class 22 or 23), the write is made again at once without the output or the error: the run's status, its end and the time it is charged are recorded, its `output` left `null`, or its `error` reading "This run failed; its error could not be recorded." If the database refuses that one's data too, a last write records only the run's status, its end and the time it is charged — a failure with that same phrase —, no usage and no file list. A run's writes wait twice at most, whichever of them the database could not take: a synchronous run's response and a webhook's delivery wait for them, up to 5 seconds more.

**Response** `403` — `KEY_SCOPE_FORBIDDEN`: the key does not carry full access.

**Response** `404` — run not found, or not of the caller's account (the same answer).

---

A server whose operator sets `SKRUN_AGENTS_DIR` lists the agents of that directory (`GET /api/agents/scan`) and builds one of them (`POST /api/agents/scan/:name/push`) for a full-access caller — see [Scan agent directory](self-hosting.md#scan-agent-directory) and [Push scanned agent](self-hosting.md#push-scanned-agent) in the self-hosting guide.

---

## Error format

All errors follow the same format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

### Error codes

| Code | HTTP | Description |
|------|------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid Authorization header |
| `FORBIDDEN` | 403 | No permission (wrong namespace or non-admin on an admin-gated route), or a file of `/api/files/:id` the caller may not use — another account's, or, for a key without full access, one it did not upload or a run it did not launch produced |
| `KEY_SCOPE_FORBIDDEN` | 403 | The API key's scope does not allow this: an operation it does not carry, an agent outside its resource scope, an account-management action, or a read or build that takes a full-access credential — run history, stats, an agent's source, the agents-directory scan and building from it (see [What a key may read](#api-keys)) |
| `AGENT_NOT_VERIFIED` | 403 | The resolved version (pinned or latest) has `verified=false`, under the `admin` verification policy (the default; `owner` and `disabled` never gate a run on it). `POST /run` returns this before any execution. Catch typed via `SkrunNotVerifiedError` in the SDK. |
| `CALLER_BASE_URL_NOT_CONSENTED` | 403 | `POST /run`, unless you run your own agent on an account-wide credential: an `X-LLM-Base-URL` entry that is not where that provider's key goes — for the provider of the agent's primary model, an origin other than its `model.base_url`'s; for any other provider, or on an agent with no `model.base_url`, any origin — sent with `X-LLM-API-Key` or alone; or, under a declared `model.base_url`, a key in `X-LLM-API-Key` for the primary model's provider without that origin named. Returned before any model call; the message names the provider and the origin at fault, and the entry the agent takes (see [Where your key is sent](#where-your-key-is-sent)) |
| `CALLER_KEY_NOT_ALLOWED` | 403 | `POST /run` with `X-LLM-API-Key` to an agent whose owner accepts no caller key — its caller-key policy is `creator_only`: it runs on the owner's own key. Refused before the run starts; omit the header (see [Caller-provided API keys](#caller-provided-api-keys)) |
| `VERSION_NOT_FOUND` | 404 | Pinned version does not exist. Response includes `available: string[]` for recovery. |
| `INVALID_REQUEST` | 400 | Invalid JSON body, or a body whose fields its route refuses — one it requires missing, or a value it does not take. On `POST /run`, a body that is not a JSON object with an `input` field: a body that is not an object (a number, a string, a boolean, an array, `null`), an object with no `input` (`{}` included), or an `input` that is `null`. Refused first of all once the body is read, in every mode — nothing of the agent is read and nothing of the run is written; the message names `input`. The whole body is never taken for the input |
| `MISSING_INPUT` | 400 | A required input the `input` does not carry: not a field of its own, `null`, or — a `file` input — an empty list; the message reads `Missing required input: <name>`. Judged with the agent's other inputs, each in the order `agent.yaml` declares them — its absence, then its type —, before any file is read. An optional input sent as `null` is accepted, its type not judged, and the prompt carries it as `null`; an optional `file` input sent as `null` or as an empty list is left out, and the run goes ahead without it |
| `INVALID_INPUT_TYPE` | 400 | Input field has wrong type, the `input` is not an object (a string, a number or a boolean — a body that is not an object is `INVALID_REQUEST`), the input is nested more than 100 levels deep, or an element of a `file` input is not a file source (see [Errors at /run for binary inputs](#errors-at-run-for-binary-inputs)) — an input sent as `null` is never a wrong type: it counts as absent (see `MISSING_INPUT`); a `null` inside a list of files is still not a file source |
| `INVALID_LLM_KEY_HEADER` | 400 | Malformed X-LLM-API-Key header |
| `INVALID_LLM_BASE_URL_HEADER` | 400 | Malformed X-LLM-Base-URL header: not a JSON object, or a value that is not a string or not a URL. Checked before the agent is loaded |
| `LLM_KEY_REQUIRED` | 400 | No model key for the agent's primary provider, nor for its fallback's when it has one — none in `X-LLM-API-Key`, no creator key, no server key. A `meta` model without a `model.base_url` — a version published before validation refused one — counts as having none, whatever key is given. `POST /run` returns this before the run starts, in every mode (a synchronous request on the `flyio` runtime gets `SYNC_MODE_UNSUPPORTED` first; see [Caller-provided API keys](#caller-provided-api-keys)) |
| `RETIRED_FIELD` | 400 | The `environment` override of `POST /run` carries a field retired from `agent.yaml` (`sandbox` or `filesystem`, which never had an effect). Refused before any run work, never ignored — remove the field from the request. In an `agent.yaml`, the same field is only a validation warning |
| `UNSUPPORTED_FIELD` | 400 | A setting `agent.yaml` accepts but no code honours yet: an MCP server's `auth` other than `none`, or a `secrets` list that names a secret. A push whose `agent.yaml` declares one is refused before anything is stored, whatever bounds the server sets; on `POST /run`, an `environment` override whose `secrets` names a secret is refused before the agent's bundle is read, nothing of the run written. The message names the field. Validation refuses the same settings with this code (see [Refused settings](agent-yaml.md#refused-settings)) |
| `MODEL_BASE_URL_REQUIRED` | 400 | A push whose `agent.yaml` declares `model.provider: meta` without a `model.base_url`, or a `fallback` whose provider is `meta` — `meta` has no endpoint of its own. Refused before anything is stored, whatever bounds the server sets; the message says which. Validation refuses the same with this code |
| `TIMEOUT_OUT_OF_RANGE` | 400 | A `timeout` outside `1s` to `2147483s` (about 24.8 days): a run given `0s`, or more than a timer can hold, would end at once. A push whose `agent.yaml` declares one is refused before anything is stored; on `POST /run`, an `environment` override that sets one is refused before the agent's bundle is read, nothing of the run written. Judged before the server's longest timeout: such a value is answered with this code, never `TIMEOUT_ABOVE_LIMIT`. Validation refuses it with the same code |
| `INVALID_ENVIRONMENT` | 400 | `POST /run`: the `environment` override is not an object, or the agent's environment once the override is merged is invalid — a `timeout` not written `Ns`, a `networking` that is not an object, a value of the wrong type. The message names each field. Refused before the run starts |
| `TIMEOUT_ABOVE_LIMIT` | 400 | `POST /run`, on a server that sets a longest timeout: the agent — or the run's `environment` override — declares a `timeout` above it, or the agent declares none and the 300 s default is above it. The message gives both values. Refused before any machine starts; no `Retry-After`, waiting changes nothing. A push of such an agent is refused the same way, before anything is stored (see [Quotas](#quotas)) |
| `UNKNOWN_PLAN` | 400 | Assigning an account's plan (`PUT /api/admin/accounts/:id/plan`): no `plan` in the JSON body, or a plan the server does not know. The message lists the plans it knows. Nothing was written |
| `EGRESS_HOST_UNSUPPORTED` | 400 | On the `flyio` runtime, the agent's `allowed_hosts` — after the request's `environment` override — holds an entry the sandbox cannot enforce: anything but `"*"`, a host name (letters, digits, dots, hyphens and underscores) or an IPv6 literal, bare or in brackets — each entry read with its spaces taken out. That is a host pattern (`*.slack.com`), which only the `local` runtime honours, and a host with a port (`example.com:443`), a URL, a path or any other text, which no runtime honours. Refused before the run starts — before any machine; the message names each entry by its form and says what to write instead. Name each host — the sandbox allows a host on every port —, or use `["*"]` (see [Networking](agent-yaml.md#environment-optional)); in a list that already holds `"*"`, such an entry adds nothing — remove it. The `local` runtime refuses none of them |
| `SSE_WEBHOOK_CONFLICT` | 400 | Both SSE and webhook requested in the same call |
| `SYNC_MODE_UNSUPPORTED` | 400 | `POST /run` on the `flyio` runtime: a synchronous request, with neither an `Accept: text/event-stream` header nor a `webhook_url` — that runtime runs an agent through its event stream or a webhook, never as one response. Refused before the run starts: after the checks of the body's shape, before any key header, the agent, its inputs, the `environment` override's settings, the quota or the bundle is read. Nothing of the run is written, and an agent that does not exist gets the same `400`, never a `404`. The message names what works: the event stream (`skrun run` and the SDK's `client.run()` read it and return the one-shot result), or a `webhook_url`. The `local` runtime runs a synchronous request (see [Run an agent](#run-an-agent)) |
| `INVALID_WEBHOOK_URL` | 400 | webhook_url is not a valid URL or not HTTPS |
| `MISSING_VERSION` | 400 | Version query param missing on push |
| `INVALID_VERSION_FORMAT` | 400 | A version that is not strict semver: the `version` of a run's body; a push's `version` query param; or, for `POST /api/agents/scan/:name/push`, the version read from the text of `agent.yaml` — a push is refused before anything is stored |
| `CONFIRMATION_MISMATCH` | 400 | Deleting an account (`DELETE /api/account`, `DELETE /api/admin/accounts/:id`): the JSON body `{"confirm": "<username>"}` is missing, or its `confirm` is not the username of the account being deleted. Nothing was deleted |
| `NOT_FOUND` | 404 | Agent not found in registry |
| `AGENT_NOT_FOUND` | 404 | The model keys or the caller-key policy of an agent (`/api/agents/:namespace/:name/llm-keys`, `/api/agents/:namespace/:name/llm-key-policy` — what `skrun llm-key` reads and sets): no agent of that name in that namespace, as for an agent not deployed yet. Deploy it first |
| `VERSION_EXISTS` | 409 | Version already exists |
| `FILE_EXPIRED` | 410 | A run's output files are no longer kept — asked of `GET /api/runs/:run_id/files/:filename/link` past the run's retention deadline (see [Output files](#output-files)) |
| `RATE_LIMITED` | 429 | Too many requests from one client address — see [Rate limiting](#rate-limiting) for the per-endpoint limits. `Retry-After` gives the seconds until the window resets |
| `CONCURRENCY_LIMIT_REACHED` | 429 | `POST /run`: the account already has as many runs in progress as its plan allows. `Retry-After: 10`. Nothing of the run is written (see [Quotas](#quotas)) |
| `COMPUTE_QUOTA_EXCEEDED` | 429 | `POST /run`: the account used its plan's compute time for the current window. `Retry-After` gives the seconds until the window renews. Nothing of the run is written (see [Quotas](#quotas)) |
| `INPUT_FILES_LIMIT_REACHED` | 429 | `POST /api/files`: the account already holds as many live uploads as its plan allows. `Retry-After` gives the seconds until it holds fewer — when its oldest upload expires, or, for an account holding more than its plan allows (its plan lowered), when enough of them have; nothing of the refused upload is kept (see [Quotas](#quotas)) |
| `BUNDLE_TOO_LARGE` | 413 | Push request body (compressed bundle) over `SKRUN_PUSH_MAX_BODY_MB` (default 50 MB) |
| `BUNDLE_DECOMPRESSED_TOO_LARGE` | 413, 422 | A bundle that decompresses to more than `BUNDLE_MAX_DECOMPRESSED_MB` (default 50 MB), its tar headers counted; the message says *more than* the cap — the server stops unpacking there — and names the setting. A push — `POST /api/agents/:namespace/:name/push`, or from the agents directory — is refused `413`, before anything is stored, whatever bounds the server sets: make the agent smaller, or have the server's operator raise the setting (see [Push an agent](#push-an-agent)). `POST /run` answers `422` for a stored version past the cap the server has when it runs — pushed under a higher cap, or stored by an earlier server —, before the run starts: its creator can push a smaller version, or the operator raise the setting (see [Run an agent](#run-an-agent)) |
| `CONFIG_TOO_LARGE` | 413 | A push — `POST /api/agents/:namespace/:name/push`, or from the agents directory — whose `agent.yaml` weighs more than 128 KB (131,072 bytes), a fixed limit of every server. Refused before the file is parsed, nothing stored: `agent.yaml` holds the agent's configuration — move long content to `SKILL.md`, `AGENTS.md` or other files of the bundle (see [Push an agent](#push-an-agent)). `POST /run` never answers it: a version stored before the limit runs as it did |
| `REQUEST_TOO_LARGE` | 413 | A request body over its route's cap: `POST /run`'s (about 6.33 MB, inline files included — about 4.7 MB of them when the rest of the request is small), or `SKRUN_MAX_BODY_MB` (default 1 MB) on a route without a cap of its own. The message names the cap — see [Request size](#request-size) |
| `STORAGE_QUOTA_EXCEEDED` | 413 | A push — `POST /api/agents/:namespace/:name/push`, or from the agents directory — that would take the bundles the account's agents hold past its plan's storage. Nothing of it is stored; no `Retry-After`, a deleted version makes room — or, for an agent's last version, the deleted agent (see [Quotas](#quotas)) |
| `BUNDLE_CORRUPT` | 400, 500 | A push whose body is not a readable `.agent` archive (a gzip-compressed tar), or an entry of which cannot be written out where an agent runs — two entries that contradict each other, a name too long, a device, a hard link with no file before it (see [Push an agent](#push-an-agent)): `400`, nothing stored. `POST /run`: the stored bundle could not be extracted — it is not a readable archive; it is one such archive, stored before the push refused it; or, on the local runtime, a file or directory of it could not be written out: a full disk, a permission; the server's log says which — `500` |
| `BUNDLE_INTEGRITY_FAILED` | 500 | Bundle checksum (SHA-256) did not match — the stored bundle was modified, or, on a server run as several instances, two pushes of the version reached two of them at once (see [Quotas](#quotas), *Bundle storage*); the registry refuses to serve it |
| `MISSING_CONFIG` | 400, 500 | No `agent.yaml` at the bundle's root, or an empty one. A push is refused `400`, nothing stored; `POST /run` answers `500` for such a bundle stored by an earlier server |
| `INVALID_CONFIG` | 400, 500 | An `agent.yaml` that is not YAML, that declares a YAML version other than 1.2, that holds a YAML alias or the tag `!!omap`, or that the schema refuses. A push is refused `400`, nothing stored, the message naming each issue; `POST /run` answers `500` for such a bundle stored by an earlier server. A push is refused `400` too when its `agent.yaml` takes the server longer than 2 seconds to read, the message saying it is too complex to read; `POST /run` answers `500` for such a file stored by an earlier server. And when its configuration holds U+0000 or a lone surrogate, in a value or a key, the message naming the first field that holds one; `POST /run` does not judge it |
| `CREATOR_KEY_UNREADABLE` | 500 | `POST /run`: a model key the agent's owner attached cannot be decrypted on this server — for instance, its master key (`SKRUN_SECRETS_ENCRYPTION_KEY`) is unset, or is not the one the key was attached under. The run is refused rather than served on another key; once the server has a master key, attaching each of the agent's keys again under it — or removing the ones no longer used — lets its runs go |
| `INVALID_NOTES` | 400 | Version notes header is invalid (>500 chars, contains null bytes, or malformed percent-encoding) |
| `EXECUTION_FAILED` | 502 | Agent execution failed |
| `MCP_CONNECT_FAILED` | 502 | `POST /run` on the `local` runtime: an MCP server the agent declares could not be connected to. Answered in every mode, before the run's row is written. The message and `details.location` name a remote server by its origin only — its scheme, host and port, never its path, its query or its credentials —, a server whose URL has no origin as `a URL with no origin`, and a local (`stdio`) server by its command, without its arguments |
| `TIMEOUT` | 504 | Agent execution timed out |
| `TOO_MANY_TOOL_CALLS` | — | A run's `run_error`: one answer of the model asked for more than 128 tool calls in one turn; none was run. On the primary model's first answer, a declared `fallback` takes over instead, unless that answer alone cost more than the run's whole `max_cost` (see [SSE Streaming](#sse-streaming)) |
| `MODEL_RESPONSE_TOO_LARGE` | — | A run's `run_error`: a response of the endpoint the agent declares (`model.base_url`) was larger than 4 MiB; it was not read further. Before any tool has run, a declared `fallback` takes over instead (see [SSE Streaming](#sse-streaming)) |
| `MODEL_OUTPUT_BUDGET_EXCEEDED` | — | A run's `run_error`: the model's answers in the run weighed more than 4 MiB in all, the output repair included (see [SSE Streaming](#sse-streaming)) |
| `OUTPUT_TOO_LARGE` | — | A run's `run_error`: the JSON object of the model's final answer was larger than 1 MiB; it was not parsed (see [SSE Streaming](#sse-streaming)) |
| `DEADLINE_EXCEEDED` | 504 | The run was still in progress at its deadline — its `timeout`, plus the time its machine may take to get ready and its outputs to upload — and was stopped: its row reads `failed`, with the error "This run was still in progress at its deadline — its timeout, plus the time its machine may take to get ready and its outputs to upload — and was stopped." A synchronous run is answered `504`; a streamed run whose client still reads ends with a `run_error` of this code, and a webhook delivery carries it as `error.code`. A streamed run whose client has stopped reading gets no final event: its stream is closed ten seconds after the deadline. See [Run an agent](#run-an-agent) |
| `SERVER_STOPPED` | 503 | The run did not finish: the server stopped while it was in progress (a deploy, a restart). Its row reads `failed`, with the error "The server stopped while this run was in progress." Running it again makes sense — but its tools may already have run, so a run whose tools act outside (a message sent, a file written) may have done part of that. A synchronous run is answered `503`; a streamed run ends with a `run_error` of this code, and a webhook delivery carries it as `error.code`. Also the answer, in every mode, to a `POST /run` sent once the stop has begun: refused `503` before the run starts, with the message "The server is stopping and did not start this run; send it again." and `Connection: close` — nothing of it ran and no row is written, so sending it again to a server that runs is safe. A run whose row was being written as the stop began is not started either: answered the same `503`, with the stop's error its row reads |
| `STORAGE_UNAVAILABLE` | 503 | Deleting an account: object storage failed before any row went — an object of the account could not be listed or deleted, or, on a server that keeps a deletion journal, the deletion could not be recorded there, nothing being deleted yet. The account and its credentials still work, some of its objects may already be gone — send the same request again to finish |
| `CAPACITY_EXHAUSTED` | 503 | `POST /run`: the server holds as many runs at once as its operator allows, every account's together — or, for a run that a bound on runs in progress, compute time or fast runs applies to, the database did not answer its admission in time once the admission held its database connection: a lock not obtained within 2 s, a statement past 5 s or the transaction left idle that long, or the connection gone silent. `Retry-After: 5`. Nothing of the run is written, save one rare case (see [Quotas](#quotas)). The wait for that connection, and anything else of a `POST /run` the database does not answer in time before the run is admitted, is `DATABASE_TIMEOUT` |
| `PUSH_BUSY` | 503 | A push — `POST /api/agents/:namespace/:name/push`, or from the agents directory — while the server already has as many `agent.yaml` reads waiting as it lets a push wait behind: 16 per server process, besides the two it reads at once. Refused at once, nothing stored, with `Retry-After: 3`: send it again then (see [Push an agent](#push-an-agent)) |
| `DATABASE_TIMEOUT` | 503 | The server's database did not answer in time — a statement past the server's database bound (10 s unless its operator sets another), a connection that went silent, a new connection that got no answer within 5 s, or every database connection of the server busy for 5 s. `Retry-After: 5`. A request that reads is safe to send again; one that changes something may have taken effect, in whole or in part — check before sending it again. The admission of a run that a bound on runs in progress, compute time or fast runs applies to is `CAPACITY_EXHAUSTED` instead, once it holds its database connection (see that code); the wait for that connection, and the rest of a `POST /run` before the run is admitted, are `DATABASE_TIMEOUT`. A session cookie the server cannot check answers `500` |

**About `DATABASE_TIMEOUT`**: the server bounds each statement it sends its database — 10 seconds by default, set by its operator (see [Environment variables reference](self-hosting.md#environment-variables-reference)) — and gives up on a connection that stays silent 5 seconds past that bound. A request that meets either, whose new database connection gets no answer within 5 seconds, or that waits more than 5 seconds for one of the server's database connections, is answered `503 DATABASE_TIMEOUT`, with `Retry-After: 5` — save the admission of a run under a bound on runs in progress, compute time or fast runs, once it holds its database connection: that is `CAPACITY_EXHAUSTED` (see that code). What it had already written may stay written: send a request that changes nothing again as it is, and read the state before sending one that does.

### Warning codes

Warnings appear in the `warnings` array of POST /run responses (not errors — the run still executes). The field is reserved for advisory signals; v0.8.0 emits none by default (the `agent_not_verified_scripts_disabled` soft warning of v0.7.x is gone — an unverified version is now refused whole with `403 AGENT_NOT_VERIFIED` under the `admin` verification policy, and runs whole, scripts included, under `owner` and `disabled`).

### Response warning headers

Some endpoints may emit informational warning headers to signal non-fatal issues:

| Header | When |
|--------|------|
| `X-Skrun-Warning: notes-unsupported` | The client sent `X-Skrun-Version-Notes` but the server doesn't support the feature (version skew). The push still succeeds but the note is not stored. Upgrade the registry to use `-m`. |

---

The server's database (`DATABASE_URL`) is set by its operator: see [Storage](self-hosting.md#storage) in the self-hosting guide.

---

The runtime that executes `POST /run` (`SKRUN_RUNTIME`, `local` or `flyio`) is set by the server's operator: see [Runtime selection](self-hosting.md#runtime-selection-skrun_runtime) in the self-hosting guide.

---

The server's logs (structured JSON on stdout, their level set by `LOG_LEVEL`) and its caches of the bundles read for runs and of MCP connections are set by its operator: see [Structured logs](self-hosting.md#structured-logs) and [Caching](self-hosting.md#caching) in the self-hosting guide.

---

## Uploading input files

For agents that declare `file`-typed inputs (image, PDF, audio — see [agent-yaml.md → File inputs](agent-yaml.md#inputs-required)), there are **three interchangeable ways** to pass each file in the `POST /run` request body. All three are wrapped in a discriminated `source` field. Each file input takes a list of these descriptors — at most `max_count` of them —, or one descriptor alone for a single file. An empty list counts as the input missing: refused `MISSING_INPUT` when it is required, left out when it is optional.

### The three transports

```jsonc
// (1) file_id reference — uploaded ahead of time via POST /api/files
{ "type": "file", "source": "id", "file_id": "fil_a1b2c3..." }

// (2) base64 inline — 4 MB per file, all of them within the run's body cap (about 6.33 MB)
{ "type": "file", "source": "data",
  "media_type": "image/jpeg", "data": "<base64-encoded-bytes>" }

// (3) URL — fetched server-side, subject to allowed_hosts (its redirects too)
{ "type": "file", "source": "url",
  "url": "https://files.example.com/photo.jpg" }
```

Use `source: id` for any payload bigger than ~4 MB or that you'll reuse across multiple runs. Use `source: data` for one-shot small payloads. Use `source: url` for assets already publicly hosted.

A `file_id` must name an upload the caller may use: a full-access credential (a session, `dev-token`, an account-wide key with all three operations) any upload of its account; any other key only the files it uploaded itself. Any other `file_id` is refused as an unknown one, before the model is called.

**Example — agent with `receipts: file/image[]` (max_count: 20)**

```bash
# Upload the 3 files, capture each file_id
RECEIPT_1=$(curl -s -X POST $SKRUN_URL/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-1.jpg" | jq -r .file_id)

RECEIPT_2=$(curl -s -X POST $SKRUN_URL/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-2.jpg" | jq -r .file_id)

RECEIPT_3=$(curl -s -X POST $SKRUN_URL/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@/path/to/receipt-3.jpg" | jq -r .file_id)

# Run with the file_id refs
curl -N -X POST $SKRUN_URL/api/agents/dev/receipts-to-expenses/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{
    \"input\": {
      \"receipts\": [
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_1\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_2\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_3\" }
      ],
      \"month\": \"2026-04\"
    }
  }"
```

The TypeScript SDK auto-uploads `Blob`, `File`, and `Uint8Array` values via `POST /api/files` transparently — pass them directly to `client.run()`, `client.stream()` or `client.runAsync()`. It never deletes those uploads: each is kept until it expires and, on a server that bounds an account's live uploads, counts against the account until then (see [Quotas](#quotas)). To free the place once the run is over, upload with `client.uploadFile()`, run with the `file_id` reference, then `client.deleteFile()`.

### POST /api/files — upload an input file

```
POST /api/files
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Form fields**

| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | The binary file. Filename is derived from the multipart `filename` parameter. |

**Broad media-class allowlist at upload**: `image/*`, `application/pdf`, `audio/*`. Mime types outside these classes return `415 MIME_NOT_ALLOWED` (e.g. `text/plain`, `application/zip`). Strict per-agent `mime_types` validation runs at `/run` time against the agent's `agent.yaml` declaration.

**Response** `201`

```json
{
  "file_id": "fil_a1b2c3d4e5f6789012345678901234ab",
  "size": 524288,
  "media_type": "image/jpeg",
  "purpose": "input",
  "expires_at": "2026-05-02T10:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `file_id` | string | Unified-namespace identifier — use to reference the file in subsequent `/run` calls and `GET /api/files/:id/content`. Format: `fil_<32 hex>`. |
| `size` | number | File size in bytes |
| `media_type` | string | MIME type as detected from the multipart upload |
| `purpose` | `"input"` | Always `input` for caller-uploaded files |
| `expires_at` | string (ISO 8601) | When the file will be evicted from storage. Default TTL: 24 h. |

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `INVALID_MULTIPART` | Body is not valid `multipart/form-data` |
| `400` | `MISSING_FILE` | No `file` field in the form |
| `413` | `FILE_TOO_LARGE` | File size exceeds `INPUT_FILES_MAX_SIZE_MB` (default 25 MB), or the request body exceeds that size plus 1 MB of multipart framing — refused before the upload is read whole (see [Request size](#request-size)) |
| `415` | `MIME_NOT_ALLOWED` | MIME type outside the broad upload allowlist |
| `429` | `INPUT_FILES_LIMIT_REACHED` | On a server that bounds an account's live uploads (`SKRUN_QUOTA_INPUT_FILES`): the account already holds as many uploads that have neither expired nor been deleted as its plan allows. `Retry-After` gives the seconds until it holds fewer — when its oldest one expires, or, for an account holding more than its plan allows (its plan lowered), when enough of them have; deleting uploads frees places at once. Refused before the body is read — or, for an upload whose account's last place another upload of it took while its body was read, once that body is read, before anything of it is kept (see [Quotas](#quotas)) |
| `401` | — | Missing / invalid `Authorization` header |

Nothing of the body is read before the caller is authenticated: an upload without valid credentials is refused with its body unread.

### GET /api/files/:id — file metadata

```
GET /api/files/:id
Authorization: Bearer <token>
```

**Authentication is required.** A full-access credential — a session, `dev-token`, or an account-wide key with all three operations — reads every file of its account: each upload (`purpose: input`) and the outputs of each run (`purpose: output`). Any other key — run-only, or restricted to some agents — reads only the files it uploaded and the outputs of the runs it launched. Any other file returns `403 FORBIDDEN`, another account's included.

**Response** `200`

```json
{
  "file_id": "fil_a1b2c3...",
  "size": 524288,
  "media_type": "image/jpeg",
  "purpose": "input",
  "expires_at": "2026-05-02T10:00:00.000Z"
}
```

For `purpose: output` files (produced by an agent run, see [Output files](#output-files)), the response shape is the same minus `expires_at` (output retention follows `FILES_RETENTION_S`, not `INPUT_FILES_RETENTION_S`).

| Status | Code | When |
|--------|------|------|
| `200` | — | File found |
| `401` | — | Missing / invalid `Authorization` header |
| `403` | `FORBIDDEN` | The caller may not read this file (see above) |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` or TTL expired |

### GET /api/files/:id/content — download binary

```
GET /api/files/:id/content
Authorization: Bearer <token>
```

**Authentication is required** with the same ownership semantics as `GET /api/files/:id` above.

Returns the raw bytes with the recorded `Content-Type` (for an output file, the type of its extension), as a download: `Content-Disposition: attachment`, named after the output file (an input file keeps no name of its own: its `file_id`). Works for both input and output files (unified namespace).

| Status | Code | When |
|--------|------|------|
| `200` | — | Binary content |
| `401` | — | Missing / invalid `Authorization` header |
| `403` | `FORBIDDEN` | The caller may not read this file (see above) |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` or TTL expired |

### DELETE /api/files/:id — delete an input file

```
DELETE /api/files/:id
Authorization: Bearer <token>
```

Removes the file from storage and the cache. Returns `204 No Content` on success. The caller must be one that may use the upload: a full-access credential, any upload of its account; any other key, only the files it uploaded. On a server that bounds an account's live uploads, the upload's place frees at once (see [Quotas](#quotas)). From the SDK: `client.deleteFile(fileId)`.

| Status | Code | When |
|--------|------|------|
| `204` | — | Deleted |
| `403` | `DELETE_OUTPUT_FORBIDDEN` | The `file_id` belongs to a `purpose: output` file. Output files are produced by agents and cannot be deleted by callers. |
| `403` | `FORBIDDEN` | An upload the caller may not use — another account's, or, for a key without full access, another key's |
| `404` | `FILE_NOT_FOUND` | Unknown `file_id` |
| `401` | — | Missing / invalid `Authorization` header |

### Storage configuration

The size an upload may have and how long it is kept (`INPUT_FILES_MAX_SIZE_MB`, `INPUT_FILES_RETENTION_S`) are set by the server's operator: see [Storage configuration](self-hosting.md#storage-configuration) in the self-hosting guide.

The inline files of `POST /run` (`source: data`) have a fixed cap that no variable sets: 4 MB per file, and, together, what the run's body cap of about 6.33 MB leaves them — about 4.7 MB when the rest of the request is small (see [Run an agent](#run-an-agent)). `INPUT_FILES_MAX_INLINE_MB`, listed here by earlier versions of this page, was never read by the server.

### Capability negotiation

When an `agent.yaml` declares `file`-typed inputs, the chosen `model` (and its `fallback`) must support the declared `media`. The check runs at `skrun deploy` / `skrun push` and refuses the operation with a clear error before any network call. The runtime also enforces the same matrix as defense-in-depth — calls reaching the LLM router with unsupported media throw `LLMCapabilityError` (status `422`).

### Errors at /run for binary inputs

| Status | Code | When |
|--------|------|------|
| `400` | `MISSING_INPUT` | Agent declared `required: true` but the field is absent, `null` or an empty list: `Missing required input: photo`. Judged with the agent's other inputs, each in the order `agent.yaml` declares them — before the type of an input declared after it, and before any file of the request is read. Nothing of the run is written |
| `400` | `INVALID_INPUT_TYPE` | An element of the field is not one of [the three transports](#the-three-transports): not an object, no `type: "file"`, an unknown `source`, or a member missing or of the wrong type (a `url` that is not a URL, an empty `file_id`). The message names the field, the element when the field is a list, and what is wrong — never the value sent: `Input 'photo' item 1 is not a file source (url: Invalid URL)`. Nothing of the run is written |
| `404` | `FILE_NOT_FOUND` | `source: id` references an unknown or expired `file_id`, or an upload the caller may not use — another account's, or, for a key without full access, another key's (the same answer) |
| `403` | `URL_NOT_ALLOWED` | `source: url` host is not in the agent's `allowed_hosts` allowlist, or the URL redirects to a host that is not, or to a private or reserved address (SSRF protection) |
| `413` | `INLINE_TOO_LARGE` | `source: data` decodes to more than 4 MB (a fixed cap, per file). Use `source: id` via `POST /api/files` for larger payloads. |
| `413` | `REQUEST_TOO_LARGE` | The request body is over the run's cap (about 6.33 MB), inline files included — about 4.7 MB of them fit when the rest of the request is small. Use `source: id` for some of them |
| `413` | `MAX_COUNT_EXCEEDED` | Field has more elements than `max_count` in `agent.yaml` |
| `415` | `MIME_NOT_ALLOWED` | Resolved file's `media_type` is not in the agent's `mime_types` allowlist |
| `422` | `LLM_CAPABILITY_UNSUPPORTED` | The chosen model does not support the resolved `media` (defense-in-depth — primary gate is at deploy/push) |
| `502` | `URL_FETCH_FAILED` | `source: url` returned non-2xx |

---

## Output files

Agents produce files by writing to the `$SKRUN_OUTPUT_DIR` directory during execution (available to tool scripts and MCP stdio processes). After the run, the files it keeps — within the limits below — appear in the response `files` array and are downloadable via two equivalent paths; `files_excluded` says how many were left out, and why.

**Response format** (sync, SSE `run_complete`, webhook callback):
```json
{
  "files": [
    {
      "name": "report.pdf",
      "size": 524288,
      "url": "/api/runs/<run_id>/files/report.pdf",
      "file_id": "fil_b2c3d4e5..."
    }
  ],
  "files_excluded": { "too_large": 1, "over_count": 5 }
}
```

| Field | Description |
|-------|-------------|
| `name` | The file's path under `$SKRUN_OUTPUT_DIR` — on the cloud runtime, a file in a subdirectory is named by its path (`d/b.csv`) |
| `size` | File size in bytes — on the cloud runtime, the bytes the server received from the run's machine |
| `url` | Download URL — **format depends on the active runtime** (see below). |
| `file_id` | Unified-namespace identifier — use with `GET /api/files/:id/content`. Set in self-host mode; **undefined in cloud mode** (the file lives in object storage only — there's no `/api/files/:id` row hosting the bytes). |

**What a run keeps.** On both runtimes, the run's files are judged in the order of their paths, and a file is left out — counted once, under the first reason that applies — when:

1. `name_refused` — its name is not a plain relative path: empty, starting with `/`, holding a `\`, an empty, `.` or `..` segment, a control character (U+0000 to U+001F, U+007F) or a lone surrogate (half of a UTF-16 pair without the other half, which no URL holds), or longer than 512 bytes of UTF-8;
2. `too_large` — it is larger than `FILES_MAX_SIZE_MB`;
3. `over_count` — `FILES_MAX_COUNT` files are already kept. Neither a refused name nor a file too large takes a place in that count: the run keeps the first `FILES_MAX_COUNT` of the other files.

On the cloud runtime, the server reads each kept file from the run's machine, and a file can still be left out there: `too_large` when it turns out larger than `FILES_MAX_SIZE_MB` as it is read, and two more reasons — `pull_failed`, the server could not read it (an error, an answer cut short — a file that shrank while it was read —, or one still coming 60 seconds after it was asked for); `upload_budget`, the upload of the run's files ran out of its 120 seconds: the file under way and those after it. The run still completes, with the files stored before. The local runtime reads the files at the top of `$SKRUN_OUTPUT_DIR`; the cloud runtime, the files of its subdirectories too. A symbolic link is never an output file.

**`files_excluded`** counts the files left out by reason — `name_refused`, `too_large`, `over_count`, and on the cloud runtime `pull_failed` and `upload_budget` — and never names one. A reason that left no file out is omitted: `{}` when every file was kept. It is always present on a completed run's result, its `run_complete` event and its webhook, and `{}` on a failed run's sync result. It is not kept with the run: `GET /api/runs/:id` does not return it. The SDK's `client.run()` and `skrun run` return it too — `{}` from a server that does not send it.

**`url` format by runtime mode**

- **Self-host (`SKRUN_RUNTIME=local`, default)**: relative path to a run-scoped API route — `/api/runs/<run_id>/files/<name>`. The API proxies the bytes from local disk + enforces auth + owner check on every fetch.
- **Cloud (`SKRUN_RUNTIME=flyio`)**: absolute presigned GET URL pointing at the R2 / MinIO object — `https://<endpoint>/<bucket>/_runs/<run_id>/outputs/<name>?<sig>`. Short TTL (~15 minutes); the bytes flow direct from object storage with no proxy hop through this API. The URL carries a signed `response-content-disposition`, so the store answers with `Content-Disposition: attachment` and the file is saved, never displayed as a page. After expiry, the URL stops working — ask for a fresh one with [`GET /api/runs/:run_id/files/:filename/link`](#get-apirunsrun_idfilesfilenamelink--a-fresh-download-link) while the run's files are kept.

In both modes the URL is opaque to callers — treat it as a black box, don't construct it from parts. Clients that need durable references should download promptly (cloud mode) or hold onto `file_id` (self-host).

### GET /api/runs/:run_id/files/:filename/link — a fresh download link

```
GET /api/runs/<run_id>/files/<filename>/link
Authorization: Bearer <token>
```

Returns a new download link for one of a run's output files, for as long as the run's files are kept (`FILES_RETENTION_S`, below) — the way to download a cloud run's file once its first link has expired, and the way to download from a run's detail, whose stored file list carries no URL.

```json
{ "url": "https://<endpoint>/<bucket>/_runs/<run_id>/outputs/report.pdf?<sig>", "expires_at": "2026-10-01T12:15:00.000Z" }
```

- **Cloud**: `url` is presigned, answers as an attachment, and works until `expires_at` — at most about 15 minutes, and never past the run's retention deadline.
- **Self-host**: `url` is the run-scoped route, `/api/runs/<run_id>/files/<filename>`, which needs your credentials; `expires_at` is `null` — the route has no expiry of its own and serves the file while the server keeps the run's outputs.

`filename` is the name as the run lists it, URL-encoded in the path (`d%2Fb.csv` for `d/b.csv`). It is matched exactly — no case folding, no path normalisation — so a name the run does not list answers `404`. The answer is sent with `Cache-Control: no-store`.

| Status | Code | When |
|--------|------|------|
| `403` | `KEY_SCOPE_FORBIDDEN` | The key is resource-scoped (delegated) |
| `404` | `RUN_NOT_FOUND` | No such run, or one you may not read — another account's, or, for a key without full access, one it did not launch — the same answer either way |
| `404` | `FILE_NOT_FOUND` | The run lists no file of that exact name |
| `410` | `FILE_EXPIRED` | The run's files are no longer kept: past its retention deadline, or already deleted |

**Download — two equivalent paths in self-host mode**:
- `GET /api/files/:id/content` — unified namespace (recommended). Same path for input + output.
- `GET /api/runs/:run_id/files/:filename` — run-scoped (existing route, backward-compatible).

Both paths serve the same `Content-Type` for a given extension, and both answer with `Content-Disposition: attachment` — the file name in a quoted ASCII `filename` and, exactly, in `filename*` (UTF-8), so any name, non-ASCII included, reaches the browser intact. Both paths require authentication. A full-access credential (a session, `dev-token`, an account-wide key with all three operations) downloads the files of every run of its account; any other key, only those of the runs it launched — and a key restricted to some agents only by `GET /api/files/:id/content`, the run-scoped routes refusing it with `403 KEY_SCOPE_FORBIDDEN`. `GET /api/files/:id/content` returns `403 FORBIDDEN` for a file you may not read; the run-scoped `GET /api/runs/:run_id/files/:filename` returns an opaque `404` — identical to a missing run — for a run you may not read, so it doesn't reveal whether another user's run exists. Cloud mode bypasses both — the presigned `url` itself is the auth token (signed for ~15 min, scoped to the exact object).

**`DELETE /api/files/:id` on a `purpose: output` file** returns `403 DELETE_OUTPUT_FORBIDDEN` — output files are owned by the run, not by the caller.

| Env var | Default | Description |
|---------|---------|-------------|
| `FILES_MAX_SIZE_MB` | `10` | The largest output file a run keeps, in MiB; a larger one is left out (`too_large`). At most `1024`: a larger value is read as 1024; zero, a negative or an unreadable value gives the default. On the cloud runtime, the server sends its value to the run's sandbox, which applies it, and applies it again to what the sandbox lists and sends |
| `FILES_MAX_COUNT` | `20` | The most output files a run keeps (`over_count` past it). At most `10000`: a larger value is read as 10000; zero, a negative or an unreadable value gives the default. Applied as `FILES_MAX_SIZE_MB` is, on both runtimes |
| `FILES_RETENTION_S` | `3600` (1 hour) | How long output files are kept for download (on the cloud runtime, each download link expires after about 15 minutes — a fresh one is available until this window ends, see above); expired files are deleted by a sweep every five minutes; what a stopped server left goes as *Temporary files and restarts* in [self-hosting](self-hosting.md) describes. On the cloud runtime (`SKRUN_RUNTIME=flyio`) the same window also bounds the files a run leaves in object storage: the run records a deadline when it completes, and a purge that runs at startup and then every five minutes deletes those objects once the deadline has passed — a server that was stopped at the deadline catches up when it starts again. At most `3153600000` (100 years): a larger value is read as 100 years |

Agents without file output get `files: []` and `files_excluded: {}` in the response (backward compatible).

---

## Request size

Every request body has a cap, set by the route it is sent to:

| Route | Cap | Over it |
|-------|-----|---------|
| `POST /api/agents/:ns/:name/push` | `SKRUN_PUSH_MAX_BODY_MB` (default 50 MB) — the compressed bundle | `413 BUNDLE_TOO_LARGE` |
| `POST /api/files` | `INPUT_FILES_MAX_SIZE_MB` (default 25 MB) plus 1 MB of multipart framing | `413 FILE_TOO_LARGE` |
| `POST /api/agents/:ns/:name/run` | About 6.33 MB (6,640,982 bytes), inline files included — about 4.7 MB of them when the rest of the request is small; see [Run an agent](#run-an-agent) | `413 REQUEST_TOO_LARGE` |
| Any other route | `SKRUN_MAX_BODY_MB` (default 1 MB) | `413 REQUEST_TOO_LARGE` |

The refusal's message names the cap. A body that declares its `Content-Length` is judged on that header, before anything is read. A body sent without one (chunked transfer) is counted as the route reads it, and refused at the first chunk past the cap: the route reads no further. Either way, a route that requires authentication reads nothing of the body before it has authenticated the caller, and no route reads more than its cap. A body refused this way gets the `413`, whatever the route answers for a body it cannot read — `POST /run`'s `400 INVALID_REQUEST` and `POST /api/files`' `400 INVALID_MULTIPART` among others.

## Rate limiting

Rate limits are per client address, counted in a 60-second window (a fixed window on the in-memory limiter, a sliding one on the shared Redis store). Every response on a limited endpoint carries these headers — the refusals as well as the successes:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests in the current window |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

| Endpoint | Limit |
|----------|-------|
| `POST /api/agents/:ns/:name/run` | 60/min |
| `POST /api/agents/:ns/:name/push` | 10/min |
| `/auth/device/*` (the CLI's device login: code, poll) | 120/min |
| `/device` (the device-login consent page) | 30/min |

Over the limit, the request is refused with `429` and `RATE_LIMITED` — before the agent runs, and before a push body is stored. `POST /api/agents/scan/:name/push` is counted against the `push` limit. The refusal carries `Retry-After`: the seconds from now until `X-RateLimit-Reset`. Both are whole seconds, so it can read one more than the window — `61` in a 60-second window.

These limits are per client address, whatever account sends. What an account may consume — its runs in progress, its compute time — is bounded apart, by the [Quotas](#quotas).

**Behind a proxy.** The address is taken from the socket unless `SKRUN_TRUST_PROXY` is set, because a forwarded header is otherwise chosen by the caller. Setting it is not enough on its own: the gateway must supply an address the caller cannot dictate. Either it **overwrites** `X-Forwarded-For` with the connecting address (what the shipped `Caddyfile.example` does), or — if it appends to that header instead, leaving the caller's value in first position — it writes the address into a header of its own, and you name that header in `SKRUN_TRUST_PROXY_HEADER`. A gateway that only appends, trusted on `X-Forwarded-For`, lets one caller mint a fresh counter per request by varying the value it sends: the limit is then bypassable. See [Self-hosting](./self-hosting.md) for both variables, and for the shared-counter setup a multi-instance deployment needs.

## Quotas

A server's operator can bound what each account consumes, by plan, and what the whole server runs at once. Every bound is off until the operator sets it: a server that sets none refuses no run, push or upload for it and sends no `X-Quota-*` header. To set them, see [Quotas per plan](self-hosting.md#quotas-per-plan).

| Bound | What counts | Over it | `Retry-After` |
|-------|-------------|---------|---------------|
| Runs in progress, per account | The account's runs from their admission until their final status | `429 CONCURRENCY_LIMIT_REACHED` | `10` |
| Compute time, per account and per window | The wall-clock time of the account's runs admitted in the current window | `429 COMPUTE_QUOTA_EXCEEDED` | The seconds until the window renews |
| Fast runs, per account and per rolling hour — only while the server's pre-warm pool runs | The account's runs of the last hour that keep the right to a ready machine of the pool — a run for which no pooled machine was taken gives it back once its machine is ready | Nothing is refused: the run starts on a machine of its own, about a minute slower | — |
| Bundle storage, per account | Every version of every agent the account owns, each the size of the bundle pushed | `413 STORAGE_QUOTA_EXCEEDED`, at the push | — |
| Live uploads, per account | The account's uploads to `POST /api/files` that have neither expired nor been deleted | `429 INPUT_FILES_LIMIT_REACHED`, at the upload | The seconds until it holds fewer — its oldest upload's expiry, unless it holds more than its plan allows |
| Runs in progress, on the whole server | Every account's runs together | `503 CAPACITY_EXHAUSTED` | `5` |
| Longest timeout | The `timeout` the agent, or the run's `environment` override, declares — 300 s for an agent that declares none | `400 TIMEOUT_ABOVE_LIMIT`, at the run and at the push | — |

The first five are the account's plan's: `plan` in `GET /api/me`, `free` for an account that has none — an administrator [assigns it](self-hosting.md#assign-an-accounts-plan-admin-only). A plan the operator's settings do not name gets `free`'s. The last two are the same for every plan. An account reads the numbers of its runs at any time with [`GET /api/usage`](#usage).

**Which account a run counts against.** The account of the credential that sends it, not the account that owns the agent: a key you mint for a client spends your account's quotas. A `dev-token` run whose account the server could not record counts against no account — only the server-wide bound applies to it.

**Runs in progress.** A run holds its place from its admission until its final status is written — at the latest until a deadline: its `timeout`, plus a margin — the time a cloud run's machine may take to get ready ([Run an agent](#run-an-agent) gives that budget) and two minutes for the upload of its output files, on both runtimes. A run still in progress at that deadline is stopped there by its server, and its status written then (`DEADLINE_EXCEEDED`, see [Run an agent](#run-an-agent)). A run whose server died before writing its status holds its place until that deadline; past it, it holds no place and is charged nothing (see *Compute time*).

**Compute time.** A run is charged its wall-clock time, from its admission to its final status, cold start included, in the window it was admitted in; a run still in progress counts its time so far, until its deadline (see *Runs in progress*); a run its server stopped at its deadline is charged up to it; a run still recorded as in progress past it — its server died, or its database failed as the run ended — counts nothing, as you do not pay for the server's failure. The windows are fixed, aligned on UTC, of a length the operator chooses that divides a day: with 6 hours, they renew at 00:00, 06:00, 12:00 and 18:00 UTC. A run is charged nothing when its machine never got ready — on the cloud runtime, a machine that could not be created, never answered its boot probe or whose start links could not be signed, or, from the pre-warm pool, would not wake or be claimed —, nor when the server's stop ended it (a run that completes all the same is charged as any other). A run that fails while its machine runs `/init`, where the agent's own MCP servers connect, is charged: the agent's servers can be the cause. The quota is checked when a run is admitted, never during it: a run admitted just under it runs to its end, so an account can go over its quota in a window — by up to what its runs in progress can still take: each one's `timeout`, plus its machine's budget and two minutes.

**The whole server.** Every account's runs count together, and so do the runs that count against no account. No account is at fault: any caller may be refused `503` while the server is full.

**The longest timeout.** A run whose agent declares a longer `timeout` — or declares none, on a server whose longest timeout is under the 300 s default —, or whose `environment` override does, is refused before any machine starts — before its bundle is pulled when the version's recorded configuration declares it and no override is sent, otherwise once the override is merged. Waiting changes nothing: no `Retry-After`. A push of such an agent is refused too, before anything is stored — a push whose `agent.yaml` does not read is refused for that (see [Push an agent](#push-an-agent)); an agent pushed before the server set its longest timeout is checked when it runs.

**Bundle storage.** Every version of every agent an account owns counts against its plan's storage, at the size of the bundle pushed — the compressed `.agent`. A push that would take the account past it is refused `413 STORAGE_QUOTA_EXCEEDED` before anything is stored: no agent created for a first version, no object written. A version already pushed is answered `409 VERSION_EXISTS` before the storage is checked: it adds nothing. Deleting a version (`DELETE /api/agents/:namespace/:name/versions/:version`) makes room — or, for an agent's last version, deleting the agent (`DELETE /api/agents/:namespace/:name`), which deletes its state and its model keys too, and removes it from the keys restricted to it. Waiting changes nothing: no `Retry-After`. The refusal tells sizes rounded to a tenth of a KB or an MB (multiples of 1,024) — or to the byte, when rounding would hide how the account stands against its cap or that the bundle does not fit. An account's pushes are checked one at a time by each server process, its storage bounded or not — the next once the one before has stored its version, been refused or failed —, so on a server run as one process none takes the account past its storage, and of two pushes of one version at once the second is answered `409 VERSION_EXISTS`. On a server run as N instances, pushes of one account that reach different instances at the same moment can together go over by up to N − 1 bundles, and two pushes of one version can both pass the check for a version already pushed: one is answered `500`, and the version can be left with one push's checksum over the other's bundle — every pull and run of it refused `500 BUNDLE_INTEGRITY_FAILED` until it is deleted.

**Live uploads.** An upload to [`POST /api/files`](#post-apifiles--upload-an-input-file) counts against its account — whichever key of the account made it — from the moment it is stored until its `expires_at`, or until it is deleted. With as many live as the account's plan allows, the next upload is refused `429 INPUT_FILES_LIMIT_REACHED` before its body is read, with `Retry-After` the seconds until the oldest one expires; deleting one frees its place at once. An account that holds more than its plan allows — its plan lowered — waits until it holds fewer: `Retry-After` counts to the expiry that brings it back under its number, and as many deletions as it holds over that number, plus one, free a place sooner. The count is the server process's: an upload lives on the instance that stored it, and a server run as several instances counts each instance's uploads apart.

**Fast runs.** Only on the cloud runtime, while the server keeps a [pre-warm pool](self-hosting.md#pre-warm-pool-cloud-runtime-optional): a run that has the right takes a ready machine of the pool when one is ready, and starts in about a second. A run past its account's fast runs of the rolling hour is never refused: it starts on a machine of its own, as when the pool is empty — about a minute slower. The right is given when the run is admitted, and given back once the run's machine is ready, if no pooled machine was taken for the run — the pool was empty, say. A pooled machine counts as taken once the run's handoff begins — its URLs signed, then its assignment, then its `/init` (see `pool_handoffs_failed` under [SSE Streaming](#sse-streaming)); one that would not wake or answer its health check does not. A run a pooled machine served keeps its right, as does one for which a pooled machine was taken and then discarded; a run whose machine never got ready — its start failed, its caller hung up, the server stopped — keeps it spent. Only the runs that keep it count: at most the plan's number of runs per rolling hour keep it — more only for an account whose plan or bound was lowered within the hour, until those runs leave it; with the pool empty, every run whose machine gets ready gives its right back —, and a run admitted exactly an hour ago has left the hour. A run that counts against no account always has it. With no fast-run bound set, every run has it; a plan whose bound is `0` includes none. Without a pool nothing of it applies: no right is given, no fast-run header is sent, and [`GET /api/usage`](#usage) says `fast_runs: null`.

**When a run is checked.** Before its bundle is pulled, against what the account and the server hold at that moment; then again as the run's record is written, which is when it takes its place — of two runs racing for an account's last place, one is admitted. A refused run writes nothing: no record, no entry in the run history, nothing charged — save in one rare case: when the database connection goes silent while the second check commits the run's record, the run is refused `503 CAPACITY_EXHAUSTED` though its record may have been written; such a run is listed `running` and never starts, and holds its place, counting its time, until its deadline — past it, it holds no place and is charged nothing (see *Runs in progress*); while a pre-warm pool runs, it may also count as one of the account's fast runs of the hour. When several bounds refuse, the run is told the first of: compute time, runs in progress, the whole server. When the database does not answer the second check in time, once that check holds its database connection, the run is refused `503 CAPACITY_EXHAUSTED`, with `Retry-After: 5`; the first check, or the wait for that connection, not answered in time is `503 DATABASE_TIMEOUT` (see [Error codes](#error-codes)).

**What a refusal says.** An account's numbers are the account's: only a full-access credential — a session, `dev-token`, or an account-wide key with every operation — is told them. Any other key — reduced to fewer operations, or restricted to some agents, such as a key handed to a client — is told that a limit was reached — the code says which, and `Retry-After` how long to wait —, never by how much.

| Code | A full-access credential is told | Any other key is told |
|------|-----------------------------------|-----------------------|
| `CONCURRENCY_LIMIT_REACHED` | `2 runs in progress on this account; your plan's limit is 2.` | `This account has reached a usage limit; try again later.` |
| `COMPUTE_QUOTA_EXCEEDED` | `3600 s used of 3600 in this window; it renews at 12:00 UTC.` | `This account has reached a usage limit; try again later.` |
| `CAPACITY_EXHAUSTED` | `The service is at full capacity; try again.` | The same |
| `TIMEOUT_ABOVE_LIMIT` | `This agent declares 1800 s; this server accepts at most 900 s.` — or `This run's environment override declares …` when the override sets the timeout, or `This agent runs up to 300 s, the default timeout of an agent that declares none; …` when the agent's timeout is the default | The same |
| `STORAGE_QUOTA_EXCEEDED` | `This account's agents hold 480 MB of the 500 MB of bundle storage its plan allows; this bundle (24.3 MB) does not fit. Delete a version no longer needed (DELETE /api/agents/:namespace/:name/versions/:version) to make room — or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name), which deletes its state and its model keys too, and removes it from the keys restricted to it.` | `This push would take this account past the bundle storage its plan allows; a version deleted from the account makes room — or, for an agent's last version, the agent, which deletes its state and its model keys too, and removes it from the keys restricted to it.` |
| `INPUT_FILES_LIMIT_REACHED` | `50 live uploads on this account; your plan's limit is 50. The oldest expires at 2026-10-19T12:00:00.000Z; an upload deleted (DELETE /api/files/:id) frees its place sooner.` — or, holding more than its limit: `3 live uploads on this account; your plan's limit is 1. A place frees at 2026-10-19T14:00:00.000Z, once the oldest 3 have expired; 3 uploads deleted (DELETE /api/files/:id) free one sooner.` | `This account has reached a usage limit; try again later.` |

**The account's numbers, in headers.** A full-access credential gets them on every response of an admitted run — the synchronous result, the `202` of a webhook run, the opening of a stream — and beside a `429` or `503` of a run's quotas, for each bound the server sets:

| Header | Value |
|--------|-------|
| `X-Quota-Runs-Limit` | The account's runs in progress allowed |
| `X-Quota-Runs-Remaining` | The places left: on an admitted run, once it holds its own; on a refusal, what was left — `0` when this bound refused it |
| `X-Quota-Compute-Limit` | The account's compute seconds per window |
| `X-Quota-Compute-Remaining` | The whole seconds left in the current window, as read when the run was checked — its own time not counted yet |
| `X-Quota-Compute-Reset` | When the current window ends, in Unix seconds — the form of `X-RateLimit-Reset` |
| `X-Quota-Fast-Runs-Limit` | The account's fast runs per rolling hour — sent only while the server's pre-warm pool runs; `0` for a plan that includes none |
| `X-Quota-Fast-Runs-Remaining` | The fast runs left: on an admitted run, once its own right is counted; on a refusal, what was left. Not sent for a plan that includes none — its limit, `0`, says so. As the other headers, it is the admission's figure: a right still held then and given back after this header has left — this run's, once its machine is ready (no pooled machine was taken for it), or another of the account's runs' — is not in it, so the header can be low by one for each such right; as of its admission, it is never high. The current figure is in [`GET /api/usage`](#usage) |

None is sent to any other key, for a run that counts against no account, with `400 TIMEOUT_ABOVE_LIMIT`, with a `503` for a check not made in time, or on a push or an upload. A page on another origin can read `Retry-After`, the `X-RateLimit-*` headers and the `X-Quota-*` headers: the server lists them in `Access-Control-Expose-Headers`.

**From the SDK.** Each refusal is thrown as its own class — `SkrunConcurrencyLimitError`, `SkrunComputeQuotaError`, `SkrunCapacityError`, `SkrunTimeoutAboveLimitError`, `SkrunStorageQuotaError`, `SkrunInputFilesLimitError` —, with `retryAfterSeconds` read from `Retry-After`. An upload's refusal, from `client.uploadFile()` or from `client.run()`, `client.stream()` or `client.runAsync()`, which upload their binary inputs, is the `cause` of the `SkrunFileUploadError` they throw (see the [SDK's typed errors](../packages/sdk/README.md#typed-errors)). Those three never delete what they upload: every binary input of a run holds a place among the account's live uploads until it expires — whatever compute the account has left. `client.deleteFile(fileId)` frees one; the [SDK's README](../packages/sdk/README.md#binary-inputs-and-live-uploads) shows how to upload, run and delete.
