# Self-hosting Skrun

Deploy Skrun on your own infrastructure. Works on any cloud (AWS, GCP, Fly.io, Hetzner…) or on-premise.

> → Just want to try Skrun locally? Start with [Getting Started](./getting-started.md) — no setup needed.
> → New to the vocabulary? Read [Concepts](./concepts.md) first.

---

## Why self-host

- **Privacy / compliance** — your data and agent executions stay in your infrastructure. No third party sees prompts, outputs, or LLM keys.
- **Cost** — you pay cloud infra only (~$5-50/mo for small scale). No SaaS fees, no per-run markup.
- **Control** — pick your storage backend (SQLite or any Postgres), your LLM providers (any of 6 first-class providers + any OpenAI-compatible endpoint), your authentication, your monitoring.
- **MIT license** — fork it, modify it, run it forever.

If you'd rather not operate it yourself, a managed version at `skrun.sh` is coming soon — same runtime, our infra, plus billing and marketplace.

---

## Two ways to self-host

| Path | When to pick it |
|------|-----------------|
| 🐳 **Docker Compose** (recommended) — see [self-hosting with Docker](./self-hosting-docker.md) | Production self-host, prod-parity with `skrun.sh` (Postgres + MinIO + Redis + Caddy), one-command `docker compose up`. |
| 🛠️ **Bare-metal install** (below) | Local dev, machines without Docker, or fine-grained control over each component. |

If you're new here, start with the Docker path — it ships every sandbox hardening control (read-only rootfs, non-root uid, cap-drop, no-new-privileges) by default and matches the cloud topology, so migrating to `skrun.sh` later is a config swap.

---

<a id="bare-metal-install"></a>

> _The rest of this guide covers the **bare-metal install** path — Node + pnpm directly on the host. Skip ahead to the [Docker guide](./self-hosting-docker.md) if you'd rather not manage component lifecycles by hand._

## Requirements

- **Node.js ≥ 20** (LTS recommended)
- **pnpm ≥ 9** (`npm install -g pnpm`)
- **Git** to clone the repo
- A domain name + TLS certificate if exposing publicly (use a reverse proxy — see below)
- Optional: a Supabase project for production-grade storage (free tier works)
- Optional: a GitHub OAuth App for multi-user authentication

---

## Storage

Skrun ships with 3 storage backends. Pick one:

### SQLite (default, zero-config)

If you don't set any database env vars, Skrun uses SQLite — a file-based database (`skrun.db` in the working directory). Agents, runs, API keys, and users survive process restarts.

```bash
# Just start the registry — SQLite auto-initializes
pnpm dev:registry
```

**Good for**: local dev, single-node self-hosting, small teams. The file lives wherever you run the registry; back it up regularly.

**Limitations**: single-writer (fine for most self-hosted cases), no multi-region, no horizontal scaling. If you outgrow it, switch to Postgres.

### Postgres (production)

For multi-node deployments or when SQLite isn't enough. Skrun talks to any **standard Postgres ≥ 14** — managed hosts (Supabase, Fly Postgres, RDS, Neon, Render) or your own cluster:

```bash
export DATABASE_URL=postgres://user:password@host:5432/skrun
pnpm dev:registry
```

The auto-detection picks `PostgresDb` when `DATABASE_URL` starts with `postgres://` or `postgresql://`. **Migrations apply automatically on boot** — the api-server runs the `migrations-runner` which tracks applied filenames in a `_skrun_migrations` table and replays the rest. `pg_advisory_lock` serialises concurrent boots so rolling deploys don't race.

#### Fresh install

Just set `DATABASE_URL` and start the registry. The applicator creates the schema from migrations 001..009 on first boot. No manual SQL Editor steps needed.

#### Choosing a connection string

| Host | Recommended URI |
|------|-----------------|
| **Supabase** | **Session Pooler URL on port 5432** ("Connect" → "ORMs" or "Connection string" → "Session pooler" → URI). Example: `postgres://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres`. Session mode preserves session state (advisory locks, prepared statements) — required by our migrations-runner's `pg_advisory_lock` concurrent-boot safety. The Direct connection (port 5432 on `db.<ref>.supabase.co`) is IPv6-only and would require Supabase's $4/mo IPv4 add-on as a safety net; Transaction Pooler (port 6543) breaks `pg_advisory_lock` because Supavisor reassigns the backend connection after each COMMIT in transaction mode. |
| **Fly Postgres** | Copy from `flyctl postgres connect` output. |
| **RDS / Neon / Render** | Use the host's standard "external" connection string. |
| **docker-compose local** | Built for you from `POSTGRES_PASSWORD`: `postgres://skrun:$POSTGRES_PASSWORD@postgres:5432/skrun`. **Set it in `.env` — there is no default.** The compose stack used to fall back to `skrun-dev-only`, a password published in this repository; Postgres now refuses to start on an empty password rather than pick one for you. Generate one with `openssl rand -hex 16`. |

#### Migration applicator behaviour

- **On every boot**, the runner takes a `pg_advisory_lock`, ensures `_skrun_migrations` exists, applies any unseen `.sql` files in lexicographic order, and releases the lock.
- **Each migration file** runs inside its own transaction. If the file's SQL fails, the runner rolls that file back and aborts the boot.
- **Lint at boot**: migration files must NOT contain top-level `BEGIN;` / `COMMIT;` (the runner wraps them) AND must use idempotent DDL constructs (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.) — guarantees mid-crash re-apply safety.
- **Cloud backfill probe**: if the schema exists (e.g., from pre-#007 cloud deployments where migrations were applied via Supabase MCP) but `_skrun_migrations` doesn't, the runner records the filename rows without re-executing the SQL.

The boot log surfaces counts: `migrations applied=N backfilled=M skipped=K`.

### Memory (tests only)

`MemoryDb` lives in `packages/api/src/db/memory.ts` and is used by the test suite. Don't use it in production — everything is lost on restart.

### Script dependency cache

When agents declare a `package.json` / `requirements.txt` / `pyproject.toml` at the bundle root, Skrun resolves the deps on first call and caches them under `~/.skrun/deps/<hash>/` (or `$SKRUN_DEPS_DIR` if overridden). The cache is **content-addressable** — two agents whose manifests have identical text share the same cache entry, so 5 agents using `pandas==2.2.3` only consume ~80 MB of disk once.

**Disk planning**: typical Python data agents (pandas, matplotlib, reportlab) resolve to ~80–100 MB per unique manifest hash. Heavy ML stacks (`transformers` + `torch`) reach several GB. Plan ~500 MB / 1 GB of headroom for typical mixed deployments; more if your fleet runs many distinct ML manifests.

**Operator tools**:

```bash
skrun cache list           # hash + size + package count + last-used per entry
skrun cache clear          # delete all entries (prompts above 100 MB)
skrun cache clear --yes    # bypass the prompt for cron / CI cleanups
```

The cache is **safe to delete** at any time — the runtime re-resolves on the next call. Only `~/.skrun/deps/.tmp-*/` directories represent in-flight installs from a crashed previous run; `cache clear` removes them silently.

---

## Authentication

Skrun auto-detects the auth mode based on environment variables.

### Mode 1: Dev-token (local dev, never production)

The `dev-token` shortcut treats any `Bearer dev-token` caller as **admin** in the `dev` namespace — zero-friction for local dev, but it grants admin to **anyone who can reach the server**, so it has **no user isolation and must never be exposed publicly**.

It is **fail-secure: off by default**. Enable it explicitly with `SKRUN_DEV_AUTH=1` (`1`/`true`/`on`/`yes`), and only on `localhost` or a trusted private network. `pnpm dev:registry` sets it for you. Two guardrails:

- The api-server **refuses to boot** if `SKRUN_DEV_AUTH` is enabled in production (`NODE_ENV=production`) without OAuth — any real deployment must use OAuth (Mode 2) or API keys (Mode 3).
- Namespaces are assigned at push time: the `dev` prefix isn't declared in `agent.yaml` (the slug-only `name:`, e.g. `name: email-drafter`, is stamped on `skrun push`).

```bash
# .env
# (no GITHUB_* vars)
SKRUN_DEV_AUTH=1            # localhost / trusted LAN only — never a public host

# Login
skrun login --token dev-token
```

> **Upgrading a previously-exposed instance**: if your registry was reachable without OAuth before `dev-token` became opt-in, the `users` table may hold synthetic `dev-<hash>` rows created from arbitrary tokens. They're harmless once `SKRUN_DEV_AUTH` is off (they match no admin path) but can be pruned.

### Mode 2: GitHub OAuth (self-hosted production)

For real users with isolated namespaces:

1. Create a GitHub OAuth App at [github.com/settings/developers](https://github.com/settings/developers):
   - **Homepage URL**: `https://your-domain.com`
   - **Authorization callback URL**: `https://your-domain.com/auth/github/callback`

2. Set env vars:

   ```bash
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

3. Restart the registry. Users visit `/login`, click "Sign in with GitHub", and their username becomes their namespace (e.g., `alice`). The same `agent.yaml` (slug-only `name`) pushed under different OAuth users lands under different namespaces — no per-environment yaml edits needed.

**CLI login (`skrun login`)** uses an OAuth 2.0 Device Authorization Grant (RFC 8628) once OAuth is configured — there is nothing extra to set up, and because it runs no local callback server it works over SSH and inside containers. It prints a one-time code + a verification URL; that URL is built from the `X-Forwarded-Proto` / `Host` headers (automatic behind Fly / Caddy / nginx). If you expose the api-server **directly** (no reverse proxy), make sure the public scheme/host reach the server or the printed URL may be wrong. Tune the code lifetime with `SKRUN_DEVICE_CODE_TTL_S` (default 600 s). Without OAuth, `skrun login` falls back to a token prompt.

**Restricting who can sign up (private instance / closed beta).** By default anyone with a GitHub account can sign in and get a namespace — the right default for a public instance. To run a **private** instance (your team only) or a **curated closed beta**, set `SKRUN_ALLOWED_GITHUB_USERS` to a comma-separated allowlist; only listed accounts may then sign in — **every** login, web **and** `skrun login` — and anyone else gets a generic "not authorized" page (no account is created). Each entry is a **username** (case-insensitive) or `id:<NNN>`, the immutable GitHub numeric id, which survives a username rename — e.g. `SKRUN_ALLOWED_GITHUB_USERS=alice,bob,id:90123`. **Leave it unset for open signup** (the default). Two caveats: (1) **include yourself** — on an OAuth instance there is no `dev-token` escape (that shortcut only works when OAuth is unset), so a self-lockout is fixed only by editing the env var and restarting; (2) it gates **new logins**, so removing someone blocks their next login but an **active session** keeps working until it expires (~24 h) and any `sk_live` key they hold works until you revoke it. The allowlist is operator config (an env var / secret), never editable from inside the app, and governs **who gets an account** — not what a delegated `sk_live` key can do (that is API-key scopes).

### Mode 3: API keys (programmatic)

Once OAuth is set up, users create API keys for CI/CD and the CLI:

```bash
# In a browser, signed in — create a key
curl -X POST https://your-domain.com/api/keys \
  -H "Cookie: skrun_session=<your-session>" \
  -d '{"name": "CI deploy"}'

# Response: {"key": "sk_live_abc...", ...}  ⚠ shown once

# Use it
skrun login --token sk_live_abc...
```

Keys use the prefix `sk_live_` + 32 hex chars. They're stored as SHA-256 hashes — the server never sees the raw key after creation. Revoke via the dashboard or `DELETE /api/keys/:id`.

#### Scoped keys (restricted credentials)

A key can be **restricted** along two axes — an **operation** scope (`agent:run` / `agent:push` / `agent:verify`) and a **resource** scope (`account`, or `agents` bound to specific agents you own). The headline use is handing a customer a **run-only key scoped to one agent** — they run that agent and nothing else, without a Skrun account:

```bash
skrun keys create --name client-acme --agent dev/my-agent --run-only
skrun keys list            # account / scoped, per key
skrun keys revoke <id>
```

A delegated or run-only key cannot mint/revoke keys, change visibility, delete, pull source, or read your run history (`403 KEY_SCOPE_FORBIDDEN`) — key management requires an account-wide *full* key (or a session). Every run records the calling key (`runs.api_key_id`) for per-key metering. See `docs/concepts.md` → "API-key scopes". Minting via the API: `POST /api/keys` with `{ "name": "...", "scope_kind": "agents", "agents": ["dev/my-agent"], "scopes": ["agent:run"] }`.

> ⚠️ A scoped key does **not** isolate **agent state**: one store per agent, shared by every caller, so two holders of different keys on the same agent read each other's. Use a separate agent per caller, or `state: { type: none }`. See `docs/concepts.md` → "State".

### Admin role

Every `users` row carries a `role` column (`admin` or `user`, defaults to `user`). Admin-gated routes:

- `PATCH /api/agents/:ns/:name/versions/:version/verify` — flip a version's verified flag (the runtime gate consumes this).
- `DELETE /api/agents/:ns/:name` and `DELETE /api/agents/:ns/:name/versions/:version` — namespace owner OR admin (admin can delete any agent/version across namespaces, for moderation).

Promotion to admin is a **manual SQL update** — there is no HTTP endpoint for role elevation by design. Pick the operator(s) you trust to mint the verified trust signal and promote them once:

```bash
# SQLite (default)
sqlite3 skrun.db "UPDATE users SET role='admin' WHERE username='you'"

# Postgres
psql $DATABASE_URL -c "UPDATE users SET role='admin' WHERE username='you';"
```

In `dev-token` mode (`SKRUN_DEV_AUTH` enabled, OAuth not configured), the caller is granted admin role automatically — local-dev workflows need no extra setup.

### Verification policy

`SKRUN_VERIFICATION_POLICY` chooses **who may attest an agent version** and **whether runs are gated on verification**. It is read once at boot, so **changing it requires a restart/redeploy**. An invalid value fails the boot fast (the server refuses to start) so a typo can't run with an undefined gate.

| Policy | Run gate | Who can verify | Best for |
|--------|----------|----------------|----------|
| `admin` *(default)* | unverified versions return `403 AGENT_NOT_VERIFIED` | instance admins only | single-operator / curated instances; this is the legacy behavior, so an unset value changes nothing |
| `owner` | no gate — a private agent runs for its owner | the agent **owner** (or an admin) | multi-tenant hosting, where one operator can't vet everyone's agents: the owner is the trust authority for their own agents and safety rests on sandbox isolation + reactive abuse |
| `disabled` | no gate | owner or admin (flag is inert) | a trust-all single-user instance that doesn't want a verification step |

```bash
# .env — multi-tenant: let creators self-attest their own agents
SKRUN_VERIFICATION_POLICY=owner
```

Each attestation is logged with a `kind` (`admin` or `owner_self`) — the forensic trail for abuse review.

### Multi-tenancy

When a Skrun registry has more than one user (OAuth deployments), each user only sees the agents they own when listing, fetching metadata, downloading bundles, or reading per-agent stats. Cross-tenant **invocation** (`POST /run`) is governed by **run-authorization**: agents are private by default, so only the owner (or an admin) can run them — a non-owner gets the same opaque `404`. Both **reads** and **runs** are tenant-scoped.

#### How the filter behaves per auth mode

| Mode | `user.id` source | `user.role` | List behavior | Per-agent reads |
|------|------------------|-------------|---------------|-----------------|
| **dev-token** (`SKRUN_DEV_AUTH` on, OAuth not configured) | derived from token, persistent across restarts | `"admin"` (auto-granted) | instance-wide (no filter) | full access (admin bypass) |
| **OAuth GitHub session** | `users.id` from DB | `users.role` (default `"user"`) | filtered to own `owner_id` (or instance-wide if admin) | non-owner gets `404 NOT_FOUND` (opaque) |
| **`sk_live_*` API key** | `apiKeys.user_id` → `users.id` | inherits the owning user's role | same as the owning user | same as the owning user |

The `dev-token` row is what makes the self-host experience seamless: in single-user dev/test, you're the operator AND the only user, so the auto-admin role means the filter doesn't narrow anything. You see all agents in the dashboard and CLI as before.

The OAuth row is what activates the actual filter: a non-admin user pushing to `alice/foo` won't see `bob/bar` in their dashboard list, can't `skrun pull bob/bar`, and `GET /api/agents/bob/bar` returns `404 NOT_FOUND` with a body identical to a genuine "agent not found" response.

#### Why the opaque 404 (not a 403)

Read endpoints return `404 NOT_FOUND` rather than `403 FORBIDDEN` on a cross-tenant access attempt. The two response bodies are byte-identical to a "the agent really doesn't exist" 404 — a caller cannot distinguish whether the namespace contains an agent of that name. This is the GitHub Private Repo / Stripe API / Linear pattern: the namespace itself (your GitHub username) is public, but the slugs you push under it may carry strategic signal — exposing existence via a 403 would let a competitor probe your namespace for telltale agent names.

Write endpoints (`DELETE /api/agents/...`, `PATCH /api/agents/.../verify`) keep `403 FORBIDDEN` — when a user is performing an action, they need to know why it failed so they can switch accounts or contact an admin.

#### Promoting an operator to admin (multi-tenant ops)

Admins bypass the read filter — useful when you need to inspect or moderate agents across all namespaces from a single account. Promote via the same SQL pattern as the verification gate:

```bash
sqlite3 skrun.db "UPDATE users SET role='admin' WHERE username='ops-account'"
```

The promoted user's session/API key then sees all agents instance-wide.

#### Verification lifecycle

Verification is **per version** of an agent. Every push creates a new version with `verified=false`; the verification authority (per `SKRUN_VERIFICATION_POLICY` above — an admin by default, or the agent owner under `owner`) then runs `skrun verify <ns>/<name>@<version>` (or hits the PATCH endpoint) to attest that version. Under the `admin` policy the runtime gate on `POST /run` returns `403 AGENT_NOT_VERIFIED` for any version whose flag is `false`; the `owner`/`disabled` policies don't gate runs on it. Pinned callers on prior verified versions are unaffected by newer pushes — pushing a v1.1.0 leaves v1.0.0's verified state intact.

Every successful verify or unverify writes a structured log line (level `info`):

```json
{
  "event": "agent_version_verify",
  "actor": { "user_id": "<uuid>", "namespace": "<ns>", "role": "admin" },
  "target": { "namespace": "<ns>", "name": "<name>", "version": "<X.Y.Z>" },
  "action": "verify" | "unverify",
  "timestamp": "<ISO-8601>"
}
```

Pino writes to stdout — pipe your registry's stdout to your log aggregator (CloudWatch, Loki, Datadog, etc.) and filter on `event:"agent_version_verify"` to see the trust trail. This is the forensic record for "who verified what when" until the audit-log UI ships.

---

## LLM keys

Agents need LLM keys to run. Two provisioning modes:

### Server-side (.env)

Set keys globally on the registry. Any agent runs using the server's keys:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
MISTRAL_API_KEY=...
GROQ_API_KEY=gsk_...
XAI_API_KEY=xai-...
```

Good for: you're the only caller, or you want to absorb LLM costs centrally.

### Caller-provided (X-LLM-API-Key header)

Callers provide their own keys per-request via the `X-LLM-API-Key` header. Operator pays zero LLM costs:

```bash
curl -X POST https://your-domain.com/api/agents/alice/code-review/run \
  -H "Authorization: Bearer sk_live_..." \
  -H 'X-LLM-API-Key: {"google": "AIza..."}' \
  -d '{"input": {...}}'
```

The caller key takes precedence over a creator-attached key and any server-side key for that provider. Caller keys are never logged or persisted.

Good for: marketplace-style deployments, multi-tenant hosts, or when you want each caller to own their costs.

See [API → Caller-provided API keys](./api.md#caller-provided-api-keys) for details.

### Creator-attached (encrypted, per agent)

An agent's owner can attach their **own** LLM key to the agent so callers run it without supplying one — the **creator pays** the inference. Keys are encrypted at rest (AES-256-GCM) and never returned by any endpoint.

Set a 32-byte master key so the server can encrypt them:

```bash
SKRUN_SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

When it's unset, attaching a creator key is refused (`ENCRYPTION_NOT_CONFIGURED`); a malformed value fails the boot fast. Resolution per provider is **caller > creator > server**, so a server-side key still acts as a final fallback.

Attach / inspect (namespace owner or admin, with an account-wide credential — in production that's a session or a full `sk_live_…` key; the `dev-token` shortcut is off):

```bash
printf '%s' "$ANTHROPIC_KEY" | skrun llm-key set anthropic --agent alice/code-review
skrun llm-key list --agent alice/code-review
skrun llm-key policy creator-only --agent alice/code-review   # reject caller-supplied keys
```

Set `creator-only` to require your key for every run — a request carrying `X-LLM-API-Key` is then rejected with `403 CALLER_KEY_NOT_ALLOWED`.

> ⚠️ **Rotating `SKRUN_SECRETS_ENCRYPTION_KEY` without re-encrypting the stored keys** makes every attached creator key undecryptable, and agents relying on them fail at run time. Back the master key up and treat it like a database credential.

---

## Reverse proxy (TLS + SSE)

In production, put a reverse proxy in front of the registry (port 4000). You need TLS and proper handling of long-lived SSE streams (for `POST /run` streaming).

### Caddy (simple, auto-TLS)

`/etc/caddy/Caddyfile`:

```caddy
skrun.yourdomain.com {
    reverse_proxy localhost:4000 {
        flush_interval -1
    }
}
```

`flush_interval -1` disables buffering, required for SSE.

### nginx

```nginx
server {
    server_name skrun.yourdomain.com;
    listen 443 ssl http2;
    ssl_certificate /etc/letsencrypt/live/skrun.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/skrun.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;

        # SSE: disable buffering + long timeouts
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

---

## Environment variables reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | Registry HTTP port |
| `NODE_ENV` | — | Set to `production` to enable strict mode (forces `CORS_ORIGIN`, requires HTTPS webhooks, refuses private-IP `webhook_url`) |
| `CORS_ORIGIN` | `*` in dev, **required in prod** | CORS allowed origin. When `NODE_ENV=production`, the API fails fast at startup if unset (no implicit `*`). Set e.g. `https://app.example.com`. |
| `WEBHOOK_SIGNING_KEY` | — (**required for webhook delivery**) | HMAC-SHA256 key used to sign `POST /run` webhook callbacks (`X-Skrun-Signature: sha256=...`). Without it, webhook delivery refuses to fire. Generate with `openssl rand -hex 32`. |
| `BUNDLE_MAX_DECOMPRESSED_MB` | `50` | Cap on decompressed `.agent` bundle size (gzip-bomb defense). Raise only for legitimately larger artefacts. |
| `DATABASE_URL` | — | Standard Postgres URI (`postgres://user:pass@host:port/db`). When set, uses PostgresDb + auto-applies migrations on boot. Otherwise SQLite. For Supabase: use the **Session** Pooler URL on port 5432 — see the Postgres section above (transaction mode on port 6543 breaks `pg_advisory_lock`). |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App client ID. If set, enables OAuth auth mode. |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret |
| `SKRUN_ALLOWED_GITHUB_USERS` | — (open signup) | Comma-separated GitHub signup allowlist for a private instance / closed beta — `username` (case-insensitive) or `id:<NNN>` (immutable id). When set, only listed accounts may sign in (every login, web + CLI); others get a "not authorized" page, no account created. Unset = open (default). Include yourself — no `dev-token` escape on an OAuth instance. |
| `SKRUN_OUTPUT_DIR` | `/tmp/skrun-outputs` | Base dir for agent-produced files (Files API) |
| `SKRUN_DEPS_DIR` | `~/.skrun/deps` | Script-deps cache root (per-host). Same hash drives cloud Docker BuildKit layer cache. |
| `SKRUN_ALLOWED_HOSTS` | — | Global outbound host allowlist (advisory for scripts) |
| `SKRUN_AGENTS_DIR` | — | Dashboard scan directory for importing agents via UI |
| `SKRUN_DASHBOARD` | `on` | Serve the operator dashboard at `/dashboard`. Set `off`/`false`/`0` for a headless, API-only server. |
| `SKRUN_DASHBOARD_DIR` | `../web/dist` (bare-metal) · `/opt/skrun-web/dist` (image) | Path to the built dashboard SPA; override to serve a custom build. |
| `LOG_LEVEL` | `info` | pino log level: `debug`/`info`/`warn`/`error` |
| `BUNDLE_CACHE_TTL` | `600` | Bundle extraction cache TTL (seconds) |
| `BUNDLE_CACHE_MAX` | `50` | Max cached bundle extractions |
| `MCP_CACHE_TTL` | `600` | MCP connection cache TTL (seconds) |
| `MCP_CACHE_MAX` | `20` | Max cached MCP connections |
| `MCP_CONNECT_TIMEOUT_MS` | `120000` | Per-connect timeout for MCP servers (stdio spawn / SSE / streamable-HTTP), plumbed to the MCP SDK via `client.connect(transport, { timeout })`. On expiry the runtime logs `event=mcp_connect_timeout`, tears down the half-open transport, and the run **fails** with `502 MCP_CONNECT_FAILED`. Stdio cold-starts via `npx -y @some/mcp` can take 60-120s on first run after a fresh registry process (`@playwright/mcp` measured at ~70s on a warm chromium cache). Bump to `180000`+ if your runner needs to download chromium / large MCP binaries from cold. |
| `FILES_MAX_SIZE_MB` | `10` | Max file size for Files API (MB) |
| `FILES_MAX_COUNT` | `20` | Max files per run |
| `FILES_RETENTION_S` | `3600` | How long agent-produced files stay available (seconds) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `MISTRAL_API_KEY` / `GROQ_API_KEY` / `XAI_API_KEY` | — | Server-side LLM keys (optional — callers can provide their own) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | — | When both set, the `push` / `run` rate limiter uses Upstash Redis so the per-IP limit is **shared across instances** (multi-instance deployments). Unset → in-memory limiter (correct for a single instance). On a Redis outage the limiter falls back to in-memory rather than failing open or closed. |
| `SKRUN_TRUST_PROXY` | — (off) | Set (`1`/`true`/`on`) when the server sits behind a reverse proxy / load balancer, so the rate-limit client IP is read from `X-Forwarded-For`. Leave unset when directly exposed — the header is then ignored (it would otherwise be spoofable). |
| `RUNTIME_IMAGE_TAG` | — (**required when `SKRUN_RUNTIME=flyio`**) | Runner image the api-server spawns per run. No silent default — the server fails fast at boot if unset in cloud mode. Use `:edge` (latest build, always resolvable), `:latest` (latest stable), or a pinned `:vX.Y.Z` (reproducible). |
| `SKRUN_RUNNERS_APP` | — (**required when `SKRUN_RUNTIME=flyio`**) | Fly app the sandbox runners are spawned into. Deliberately not `FLY_APP_NAME`, which Fly injects as the *current* app's name. |
| `SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL` | — (off) | Set to `true` to let the server's own LLM key be sent to an endpoint an agent declares in `model.base_url`. Off by default: otherwise any agent author on the instance could redirect the server's key to a host they control. Enable only where every agent is yours. |
| `SKRUN_ALLOW_LOCAL_MODEL_HOSTS` | — (off) | Set to `true` to let `model.base_url` point at a private or loopback address — the documented Ollama / vLLM / LocalAI case. Off by default, because an agent-declared endpoint is otherwise a request-forgery primitive against your internal network. |
| `SKRUN_ALLOW_LOCAL_WEBHOOKS` | — (off) | Set to `true` to let `webhook_url` resolve to a private address. Local development only — leave off on any instance others can reach. |
| `SKRUN_PRIMARY_FAILOVER_MS` | `45000` | How long a primary model may hang before the declared fallback takes over. No effect on agents that declare no fallback. |
| `SKRUN_RUNNER_POOL_SIZE` | `0` (off) | How many sandbox machines to keep ready in advance. See "Pre-warm pool" below. `0` — the default — means every run builds its own machine, exactly as before. |

> **Cloud-runtime (`SKRUN_RUNTIME=flyio`) operators.** The sandbox runner's outbound traffic is contained automatically — each runner image enforces an IPv4 **and** IPv6 egress allowlist (default-DROP; only the agent's resolved `allowed_hosts` are permitted), so there is nothing to configure, and the default `local` / api-server self-host (no sandbox machines) needs no action. When you upgrade, **roll out the new runner image (`RUNTIME_IMAGE_TAG`) before the api-server**: the api mints a per-run RPC token that the runner authenticates, so deploying the image first guarantees every live machine already carries the IPv6 egress containment and can accept the token by the time the api starts sending it.

> **Upgrading from a previous version?** See [`CHANGELOG.md`](../CHANGELOG.md) for breaking changes and one-shot migration steps.

### Pre-warm pool (cloud runtime, optional)

Building a sandbox machine takes most of a minute, and nearly all of it is the host pulling the image and the runner starting up. A pre-warm pool pays that in the background instead: the server keeps a few machines built, booted and paused, and a run wakes one. Measured on our own cloud, that is the difference between a caller waiting **~53 s** and **~1.3 s** before the agent starts.

**It is off by default** (`SKRUN_RUNNER_POOL_SIZE=0`), and off means genuinely unchanged: the pool object is never created and every run takes the same path it takes today.

```bash
SKRUN_RUNNER_POOL_SIZE=3      # keep three machines ready
```

**Nothing about isolation changes.** A pooled machine is built blank — no agent bundle, no run credential, no agent network rules — and it serves **exactly one run**, then is destroyed like any other. A stock of never-used machines is not a stock of recycled ones: no run ever inherits anything from another.

**Choosing a depth.** The pool answers a burst of size N and then refills, one machine at a time, taking about a minute each. A run arriving when the pool is empty is not an error — it builds its own machine, exactly as with the pool off, and completes normally. So the depth to pick is roughly "how many runs might arrive close together before the pool can restock", and the cost of guessing low is slower runs, never failed ones.

**Cost.** Pooled machines are paused, not running, so they are not billed as running machines — but check your provider's invoice rather than a published rate: Fly documents pricing for *stopped* machines (rootfs storage) and running ones, and says nothing about suspended ones, which also hold a memory snapshot. What the server guarantees is the **count**: never more than the configured depth, each machine used once and destroyed, and abandoned ones reclaimed.

**Deploys drain the pool automatically.** A machine built from a previous image is detected as stale and destroyed rather than used, so a deploy cannot serve runs on superseded code — including a deploy that *reverts* an image, which is what makes rollback boring: point `RUNTIME_IMAGE_TAG` back, and the pool built from the bad image drains itself while a new one fills. Expect a short window after any deploy where runs take the cold path, and `drains` to spike on the status endpoint.

**Watch it with `GET /api/admin/pool`** (admin only — see the API reference). The number that matters is `hits` against `misses`: a pool that has silently stopped working still looks healthy from outside, because runs keep succeeding by falling back.

**Do not schedule `skrun admin cleanup-machines` against a live pool without reading its docs** — by default it now leaves pooled machines alone precisely because they are stock rather than waste, but the flag that sweeps them exists and would empty the pool.

**If your image tags are pruned on a schedule**, note that a pooled machine holds its image reference for hours rather than for one run. Pruning a tag underneath the pool does not disturb machines that already exist, but new ones stop being built — and because runs keep being served from the remaining stock, the first symptom is a slowly emptying pool rather than an error.

---

## Health, logs, monitoring

### Health check

```bash
curl https://skrun.yourdomain.com/health
# {"status":"ok"}
```

Use this for load balancer checks and uptime monitoring.

### Structured logs

Skrun emits JSON logs to stdout via [pino](https://getpino.io). Every line is valid JSON, pipeable to Axiom, Datadog, Loki, ELK, CloudWatch, etc.

```bash
# Human-readable in dev
pnpm dev:registry | npx pino-pretty

# Production: pipe to a file or log backend
pnpm dev:registry >> /var/log/skrun.jsonl
```

Every log entry during a POST /run includes `run_id`, `agent`, and `agent_version` automatically. See [API → Structured logging](./api.md#structured-logging) for log levels.

### Key metrics to watch

- **Run failure rate** (`failed_today` / `runs_today` from `GET /api/stats`) — catches LLM provider outages, bad agent changes, quota issues.
- **Average run duration** — regressions here usually mean a bad prompt or tool loop.
- **Token usage** — cost tracking, per-agent and per-user.
- **Cache savings** (`cache_savings_today`, `daily_cache_savings[]` from `GET /api/stats`; `usage_cache_savings_usd` per run) — dollar value of prompt-caching across the workspace. The dashboard's "Cost saved" tile + per-run `saved $X.XX` line render these.
- **Active MCP connections** — leaks would show up here (bounded by `MCP_CACHE_MAX`).

The dashboard at `/dashboard` shows all of this in real time.

> **Note** — the dashboard at `/dashboard` is served in **every** deployment — the bare-metal install (this guide) and the published Docker image alike. Set `SKRUN_DASHBOARD=off` to run a headless, API-only server.

> **Multi-tenancy note**: `GET /api/stats` filters aggregates by the authenticated user. On a single-tenant deploy (dev-token mode or one-user OAuth instance), you see effectively the same instance-wide stats you saw before — the auth middleware synthesizes a deterministic user id, and the filter narrows to that single user. On a shared deploy where multiple operators have API keys, each user sees only their own runs in the dashboard. If you previously relied on shared-instance aggregates with multiple users sharing one API key, that stays unchanged (one key → one user → one bucket).

---

## Windows notes

The codebase is platform-agnostic, but a few details differ on Windows:

- **`.env` sourcing**: PowerShell doesn't auto-source `.env`. Use `pnpm dev:registry` which loads `.env` via Node's `--env-file` flag.
- **Path separators**: the code uses `node:path` everywhere, so `\` vs `/` shouldn't bite you. Don't hard-code Unix paths in `agent.yaml` `secrets` or `scripts/` references.
- **Node script-dep install**: agents that ship a `package.json` (with or without a lockfile) install their dependencies automatically on first call. Skrun spawns `npm` / `pnpm` / `yarn` through the OS shell on Win32 so the `.cmd` shims resolve cleanly — no manual setup needed. Python (`requirements.txt`, `pyproject.toml`) works the same way.
- **SQLite on network drives**: avoid. SQLite's file locking is finicky on SMB/NFS. Use a local disk or switch to Supabase.
- **Reverse proxy**: IIS works but Caddy/nginx on WSL2 is simpler. Or use the built-in tools if you're already on IIS.
- **Headless Chrome / MCP servers**: work fine on Windows via `npx @playwright/mcp`. Playwright auto-downloads a Chromium build.

---

## Managed cloud alternative

Coming soon: `skrun.sh` — the same runtime, our infrastructure.

- Zero setup — push your agent, get a URL.
- Built-in billing — Stripe subscription for hosting, per-run fees for marketplace.
- Team namespaces via GitHub org membership.
- Managed LLM routing — or bring your own keys.
- First offer: **Hosting** (deploy your agent, pay infra) — like Vercel for agents.
- Second offer: **Marketplace** (publish agents, get paid per run, 80/20 split) — coming after hosting stabilizes.

Self-hosting stays first-class and fully-featured forever. MIT. No vendor lock-in.
