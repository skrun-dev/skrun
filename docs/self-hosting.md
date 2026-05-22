# Self-hosting Skrun

Deploy Skrun on your own infrastructure. Works on any cloud (AWS, GCP, Fly.io, Hetzner…) or on-premise.

> → Just want to try Skrun locally? Start with [Getting Started](./getting-started.md) — no setup needed.
> → New to the vocabulary? Read [Concepts](./concepts.md) first.

---

## Why self-host

- **Privacy / compliance** — your data and agent executions stay in your infrastructure. No third party sees prompts, outputs, or LLM keys.
- **Cost** — you pay cloud infra only (~$5-50/mo for small scale). No SaaS fees, no per-run markup.
- **Control** — pick your storage backend (SQLite or Supabase), your LLM providers (any of 6 first-class providers + any OpenAI-compatible endpoint), your authentication, your monitoring.
- **MIT license** — fork it, modify it, run it forever.

If you'd rather not operate it yourself, a managed version at `skrun.sh` is coming soon — same runtime, our infra, plus billing and marketplace.

---

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

**Limitations**: single-writer (fine for most self-hosted cases), no multi-region, no horizontal scaling. If you outgrow it, switch to Supabase.

### Supabase (production)

For multi-node deployments or when SQLite isn't enough:

```bash
export DATABASE_URL=https://your-project.supabase.co
export SUPABASE_KEY=your-service-role-key
pnpm dev:registry
```

The auto-detection picks `SupabaseDb` when `DATABASE_URL` is set. On first run, the connection is established immediately and the tables must already exist — see the migration section below.

#### Initial Supabase setup (fresh install)

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor** → paste the contents of `packages/api/src/db/migrations/001_initial_schema.sql` → run.
3. Set `DATABASE_URL` and `SUPABASE_KEY` (use the **service role** key, not the anon key — server-side only).
4. Start the registry.

#### Upgrading an existing Supabase deployment

Migrations are numbered and cumulative. If you're on an older version, apply the missing ones in order.

| Migration | When it's needed |
|-----------|------------------|
| `001_initial_schema.sql` | Fresh installs only |
| `002_add_model_to_runs.sql` | You were on v0.4.x or earlier — adds `runs.model` column |
| `003_add_version_notes.sql` | You were on v0.5.x or earlier — adds `agent_versions.notes` column |

Run them via Supabase SQL Editor (copy/paste) or the CLI:

```bash
# Example: apply 003 via the Supabase CLI
supabase db push --file packages/api/src/db/migrations/003_add_version_notes.sql
```

All migrations use `IF NOT EXISTS` so they're safe to re-apply.

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

If no OAuth env vars are set, the registry accepts a simple `dev-token`. All agents live in the `dev` namespace — this prefix is **assigned by the registry at push time**, not declared in `agent.yaml`. The bundle's yaml only carries the slug (e.g., `name: email-drafter`); the registry stamps `dev` onto it on `skrun push`. Zero-friction for local dev but has no user isolation — never expose publicly.

```bash
# .env
# (no GITHUB_* vars)

# Login
skrun login --token dev-token
```

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

In `dev-token` mode (OAuth not configured), the caller is granted admin role automatically — local-dev workflows need no extra setup.

### Multi-tenancy

When a Skrun registry has more than one user (OAuth deployments), each user only sees the agents they own when listing, fetching metadata, downloading bundles, or reading per-agent stats. Cross-tenant **invocation** (`POST /run`) remains open — that's the marketplace pattern (any caller can run any verified agent). Only **reads** are filtered.

#### How the filter behaves per auth mode

| Mode | `user.id` source | `user.role` | List behavior | Per-agent reads |
|------|------------------|-------------|---------------|-----------------|
| **dev-token** (OAuth not configured, single-tenant self-host) | derived from token, persistent across restarts | `"admin"` (auto-granted) | instance-wide (no filter) | full access (admin bypass) |
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

Verification is **per version** of an agent. Every push creates a new version with `verified=false`; an admin then runs `skrun verify <ns>/<name>@<version>` (or hits the PATCH endpoint) to make that version runnable. The runtime gate on `POST /run` returns `403 AGENT_NOT_VERIFIED` for any version whose flag is `false`. Pinned callers on prior verified versions are unaffected by newer pushes — pushing a v1.1.0 leaves v1.0.0's verified state intact.

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

The caller key takes precedence over any server-side key for that provider. Caller keys are never logged or persisted.

Good for: marketplace-style deployments, multi-tenant hosts, or when you want each caller to own their costs.

See [API → Caller-provided API keys](./api.md#caller-provided-api-keys) for details.

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
| `DATABASE_URL` | — | Supabase project URL. If set, uses SupabaseDb. Otherwise SQLite. |
| `SUPABASE_KEY` | — | Supabase service role key (required with `DATABASE_URL`) |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App client ID. If set, enables OAuth auth mode. |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret |
| `SKRUN_OUTPUT_DIR` | `/tmp/skrun-outputs` | Base dir for agent-produced files (Files API) |
| `SKRUN_DEPS_DIR` | `~/.skrun/deps` | Script-deps cache root (per-host). Same hash drives cloud Docker BuildKit layer cache. |
| `SKRUN_ALLOWED_HOSTS` | — | Global outbound host allowlist (advisory for scripts) |
| `SKRUN_AGENTS_DIR` | — | Dashboard scan directory for importing agents via UI |
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

> **Upgrading from a previous version?** See [`CHANGELOG.md`](../CHANGELOG.md) for breaking changes and one-shot migration steps.

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
