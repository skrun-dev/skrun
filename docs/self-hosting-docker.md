# Self-hosting Skrun with Docker Compose

The recommended way to run Skrun on your own infrastructure. One
`docker compose up` brings up the API + Postgres + MinIO + Redis +
Caddy reverse-proxy, with every sandbox hardening control enforced by
default.

> → New to Skrun? Read [Getting Started](./getting-started.md) first —
> the SaaS-free local flow that needs no setup.
> → Prefer to install components yourself? See the bare-metal
> [self-hosting guide](./self-hosting.md#bare-metal-install).

> **Note — dashboard UI:** the published image serves the operator dashboard at `/dashboard` out of the box — the same console as the bare-metal install. Set `SKRUN_DASHBOARD=off` for a headless, API-only deployment.

---

## Prerequisites

- **Docker Engine ≥ 24** with the `compose` plugin (`docker compose
  version` should print 2.x).
- **A domain name** if you want TLS. Caddy fetches a Let's Encrypt
  certificate automatically when you point an A/AAAA record at the
  host. For local-only testing, leave the domain unset and the API
  binds to plain HTTP on `:80`.
- **At least one LLM provider API key**: Anthropic, OpenAI, Google,
  Mistral, Groq, or xAI. Multiple keys can coexist; agents pick a
  provider via `model.provider` in their `agent.yaml`.
- **~2 GB RAM, 2 vCPU** is plenty for self-host single-tenant. The
  API server is I/O-bound — agent code runs in spawned sandbox
  machines, not in the API process.

---

## Quick start

```bash
# 1. Clone + copy the env template.
git clone https://github.com/skrun-dev/skrun.git
cd skrun
cp .env.example .env

# 2. Generate the three stack credentials. The stack has NO defaults for
#    these. Forget them and it stops at a `skrun-preflight` container that
#    names the missing variable, rather than booting on a password printed
#    in this repository.
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
  echo "S3_ACCESS_KEY_ID=$(openssl rand -hex 8)"
  echo "S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)"
} >> .env

# 3. Edit .env — fill at least one LLM key.
$EDITOR .env

# 4. Bring up the stack.
docker compose -f infra/docker-compose.yml up -d

# 5. Verify.
curl http://localhost/health        # → {"status":"ok"}
docker compose -f infra/docker-compose.yml logs -f api
```

That's it. The API is running on `:80` (Caddy front), Postgres on
the `postgres` service, MinIO on `minio:9000` (admin console on
`:9001`), Redis on `redis:6379`.

---

## Default vs minimal profile

Two compose files ship in `infra/`. Pick one based on operator scale.

### Default — prod-parity (`docker-compose.yml`)

The full stack: Postgres + MinIO + Redis + Caddy. Matches the
`skrun.sh` cloud topology so a future migration is a config swap, not
a re-architecture. Use this when you care about:

- **Sharing state across multiple API processes** (Postgres is the
  source of truth; you can horizontally scale the API service).
- **Hosting bundles at scale** (MinIO supports presigned URLs, so the
  API doesn't proxy bundle downloads).
- **MCP server connection caching** (Redis-backed in a future release;
  TTL-cached in-memory today).

### Minimal — single-operator (`docker-compose.minimal.yml`)

Strips Postgres / MinIO / Redis, falling back to the API's built-in
SQLite + LocalStorage defaults. Smaller footprint, single-writer DB,
served via the API's own `/api/files/:id/content` proxy instead of
presigned URLs. Use this when:

- You're the only operator on the host.
- You don't expect more than a few hundred runs / day.
- You want a smaller surface to maintain.

```bash
docker compose \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.minimal.yml \
  up -d
```

The overlay file uses Docker Compose's `!reset` syntax to drop the
backing services; everything else (Caddy, hardening, ports) carries
over from the base file.

This path needs **none** of the three stack credentials from step 2 of the
quick start — there is no Postgres and no MinIO to hold them, so the overlay
drops the `preflight` guard along with them.

A CI job asserts both halves on every change, because they pull in opposite
directions: this minimal invocation must render with a completely empty
environment, while the full stack must refuse to come up on one. Two attempts
were needed to get that right, and both failures are the reason the job exists
rather than a comment saying it should be fine — Compose interpolates each file
*before* merging overlays (so a `${VAR:?}` in the base file broke this path),
and MinIO treats an empty `MINIO_ROOT_USER` as unset and boots on
`minioadmin:minioadmin` (so the stack has to refuse on its behalf).

---

## Domain + TLS via Caddy

Caddy fronts the API on `:80` and `:443`. To enable TLS:

```bash
# Set your domain in .env (and add an A/AAAA record at it):
echo "DOMAIN=skrun.example.com" >> .env

# Restart Caddy — it fetches a Let's Encrypt cert automatically.
docker compose -f infra/docker-compose.yml restart caddy
```

The shipped [`Caddyfile.example`](../infra/Caddyfile.example) enables
the directive that matters most for Skrun: `flush_interval -1`. This
disables Caddy's response buffering so every Server-Sent Event written
by the API flushes through immediately. Without it, SSE consumers see
events arrive in batch every ~8 KB / 5 s — breaking the `run_heartbeat`
keep-alive and live streaming.

If you front Skrun with a different reverse proxy (Nginx, Traefik,
Cloudflare Tunnel), make sure SSE is configured similarly:

- Nginx: `proxy_buffering off;` and `proxy_cache off;`
- Traefik: `serversTransport.disableHTTP2` + no buffering middleware
- Cloudflare: SSE is supported out of the box (HTTP/2 flush).

---

## Operator `.env` template

The full list of env vars lives in [`.env.example`](../.env.example).
The minimum to set in production:

```ini
# At least one LLM key
ANTHROPIC_API_KEY=sk-ant-...

# CORS — REQUIRED in production (deny-by-default)
CORS_ORIGIN=https://dashboard.example.com

# Webhook HMAC — REQUIRED for async-mode webhooks
WEBHOOK_SIGNING_KEY=$(openssl rand -hex 32)

# Domain (Caddy uses this for the TLS cert)
DOMAIN=skrun.example.com
```

Postgres / MinIO / Redis credentials default to safe-for-dev values
when unset — override them for production. Compose mounts each
service's data to a named volume so restarts don't lose state.

---

## Operational commands

```bash
# Tail logs (per-service or all)
docker compose -f infra/docker-compose.yml logs -f api
docker compose -f infra/docker-compose.yml logs -f

# Restart one service (e.g. after a Caddyfile edit)
docker compose -f infra/docker-compose.yml restart caddy

# Stop the stack (keeps volumes)
docker compose -f infra/docker-compose.yml down

# Stop + delete volumes (DESTROYS state — be careful)
docker compose -f infra/docker-compose.yml down -v

# Open a shell in the API container (for one-off DB queries etc.)
docker compose -f infra/docker-compose.yml exec api sh
```

---

## Upgrading

```bash
# 1. Pull the latest image.
docker compose -f infra/docker-compose.yml pull api

# 2. Recreate the API with the new image. Other services stay up.
docker compose -f infra/docker-compose.yml up -d api

# 3. Tail logs to verify the boot.
docker compose -f infra/docker-compose.yml logs -f api
```

The image tag defaults to `:latest` (the latest stable release). For the
dev / pre-release line use `:edge` (the always-resolvable latest build); pin a
concrete `:vX.Y.Z` in `.env` for stricter reproducibility:

```ini
RUNTIME_IMAGE_TAG=v0.9.0
```

Database migrations run automatically at API startup; no manual step.
The other services (Postgres / MinIO / Redis) are stateful and don't
need an in-place migration.

---

## What runs where

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `api` | `ghcr.io/skrun-dev/skrun-runtime` | `4000` (internal) | The Hono server. Receives `POST /run`, drives the LLM loop, persists results. |
| `postgres` | `postgres:16-alpine` | `5432` (internal) | Source-of-truth for agents, runs, users, API keys. |
| `minio` | `minio/minio` | `9000` + `9001` (internal) | S3-compatible blob storage for agent bundles + run outputs. |
| `redis` | `redis:7-alpine` | `6379` (internal) | Caching layer (MCP connections, deps resolutions in a future release). |
| `caddy` | `caddy:2-alpine` | `80` + `443` (host) | TLS termination + reverse-proxy with SSE-safe flush. |

All internal services expose ports only on the compose network — they
are NEVER reachable from outside the host. Caddy is the only service
binding to the host network.

---

## Hardening

The `api` service runs with every sandbox control enabled by default:

- `read_only: true` — the container's root filesystem is mounted
  read-only. `/tmp` and `/mnt/session/outputs` are `tmpfs` (RAM-backed,
  wiped on restart).
- `user: "1000:1000"` — runs as a non-root UID `skrun-runner`.
- `cap_drop: [ALL]` — every Linux capability dropped (no privileged
  syscalls).
- `security_opt: ['no-new-privileges:true']` — even a misconfigured
  setuid binary can't escalate inside the container.

If you need to relax any of these for a specific edge case (e.g.
debugging), edit `infra/docker-compose.yml` directly. Don't override
them in a `.env` file — they're not env-driven precisely because they
are security boundaries.

---

## Where next

- [API reference](./api.md) — the `POST /run` contract, SSE event
  payload schemas (including the new `run_heartbeat`).
- [CLI reference](./cli.md) — every command, including
  `skrun admin cleanup-machines` for cloud operators.
- [Bare-metal install](./self-hosting.md#bare-metal-install) — if you
  prefer to skip Docker.
