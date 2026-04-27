# Self-hosting Skrun

Deploy Skrun on your own infrastructure. Works on any cloud (AWS, GCP, Fly.io, Hetzner…) or on-premise.

> → Just want to try Skrun locally? Start with [Getting Started](./getting-started.md) — no setup needed.
> → New to the vocabulary? Read [Concepts](./concepts.md) first.

---

## Why self-host

- **Privacy / compliance** — your data and agent executions stay in your infrastructure. No third party sees prompts, outputs, or LLM keys.
- **Cost** — you pay cloud infra only (~$5-50/mo for small scale). No SaaS fees, no per-run markup.
- **Control** — pick your storage backend (SQLite or Supabase), your LLM providers (any of 6 + any OpenAI-compatible endpoint), your authentication, your monitoring.
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

---

## Authentication

Skrun auto-detects the auth mode based on environment variables.

### Mode 1: Dev-token (local dev, never production)

If no OAuth env vars are set, the registry accepts a simple `dev-token`. All agents live in the `dev` namespace. This is zero-friction for local dev but has no user isolation — never expose publicly.

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

3. Restart the registry. Users visit `/login`, click "Sign in with GitHub", and their username becomes their namespace (e.g., `alice`).

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
| `CORS_ORIGIN` | `*` | CORS allowed origin (restrict in production) |
| `DATABASE_URL` | — | Supabase project URL. If set, uses SupabaseDb. Otherwise SQLite. |
| `SUPABASE_KEY` | — | Supabase service role key (required with `DATABASE_URL`) |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App client ID. If set, enables OAuth auth mode. |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret |
| `SKRUN_OUTPUT_DIR` | `/tmp/skrun-outputs` | Base dir for agent-produced files (Files API) |
| `SKRUN_ALLOWED_HOSTS` | — | Global outbound host allowlist (advisory for scripts) |
| `SKRUN_AGENTS_DIR` | — | Dashboard scan directory for importing agents via UI |
| `LOG_LEVEL` | `info` | pino log level: `debug`/`info`/`warn`/`error` |
| `BUNDLE_CACHE_TTL` | `600` | Bundle extraction cache TTL (seconds) |
| `BUNDLE_CACHE_MAX` | `50` | Max cached bundle extractions |
| `MCP_CACHE_TTL` | `600` | MCP connection cache TTL (seconds) |
| `MCP_CACHE_MAX` | `20` | Max cached MCP connections |
| `FILES_MAX_SIZE_MB` | `10` | Max file size for Files API (MB) |
| `FILES_MAX_COUNT` | `20` | Max files per run |
| `FILES_RETENTION_S` | `3600` | How long agent-produced files stay available (seconds) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `MISTRAL_API_KEY` / `GROQ_API_KEY` | — | Server-side LLM keys (optional — callers can provide their own) |

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
- **Active MCP connections** — leaks would show up here (bounded by `MCP_CACHE_MAX`).

The dashboard at `/dashboard` shows all of this in real time.

---

## Windows notes

The codebase is platform-agnostic, but a few details differ on Windows:

- **`.env` sourcing**: PowerShell doesn't auto-source `.env`. Use `pnpm dev:registry` which loads `.env` via Node's `--env-file` flag.
- **Path separators**: the code uses `node:path` everywhere, so `\` vs `/` shouldn't bite you. Don't hard-code Unix paths in `agent.yaml` `secrets` or `scripts/` references.
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
