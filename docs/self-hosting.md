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

If you'd rather not operate it yourself, a managed version runs at `skrun.sh` — same runtime, our infra, hosting by subscription: see its [quick start](https://skrun.sh/docs/quickstart).

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

- **Node.js ≥ 22.19** (LTS recommended)
- **pnpm ≥ 9** (`npm install -g pnpm`)
- **Git** to clone the repo
- A domain name + TLS certificate if exposing publicly (use a reverse proxy — see below)
- Optional: a Supabase project for production-grade storage (free tier works)
- Optional: a GitHub OAuth App for multi-user authentication

---

## Storage

**Run tracking**: every `POST /run` call creates a record in the `runs` table with agent, version, model, status, input/output, token usage, cost, duration, and files. This data powers the dashboard and is available for your own billing or observability pipeline.

Skrun ships with 3 storage backends, implementations of its `DbAdapter` interface. Pick one:

### SQLite (default, zero-config)

If you don't set any database env vars, Skrun uses SQLite — a file-based database (`skrun.db` in the working directory). Agents, runs, API keys, and users survive process restarts.

```bash
# Just start the registry — SQLite auto-initializes
pnpm dev:registry
```

**Good for**: local dev, single-node self-hosting, small teams. The file lives wherever you run the registry; back it up regularly.

**Limitations**: single-writer (fine for most self-hosted cases), no multi-region, no horizontal scaling. If you outgrow it, switch to Postgres.

**SQLite migrations**: handled automatically at startup — the `SqliteDb` constructor detects missing columns via `PRAGMA table_info` and runs idempotent `ALTER TABLE` statements. Nothing to do manually.

### Postgres (production)

For multi-node deployments or when SQLite isn't enough. Skrun talks to any **standard Postgres ≥ 14** — managed hosts (Supabase, Fly Postgres, RDS, Neon, Render) or your own cluster:

```bash
export DATABASE_URL=postgres://user:password@host:5432/skrun
pnpm dev:registry
```

The auto-detection picks `PostgresDb` when `DATABASE_URL` starts with `postgres://` or `postgresql://`. **Migrations apply automatically on boot** — the api-server runs the `migrations-runner` which tracks applied filenames in a `_skrun_migrations` table and replays the rest. `pg_advisory_lock` serialises concurrent boots so rolling deploys don't race.

#### Fresh install

Just set `DATABASE_URL` and start the registry. The applicator creates the schema from its migrations on first boot. No manual SQL Editor steps needed.

#### Choosing a connection string

| Host | Recommended URI |
|------|-----------------|
| **Supabase** | **Session Pooler URL on port 5432** ("Connect" → "ORMs" or "Connection string" → "Session pooler" → URI). Example: `postgres://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres`. Session mode preserves session state (advisory locks, prepared statements) — required by our migrations-runner's `pg_advisory_lock` concurrent-boot safety. The Direct connection (port 5432 on `db.<ref>.supabase.co`) is IPv6-only and would require Supabase's $4/mo IPv4 add-on as a safety net; Transaction Pooler (port 6543) breaks `pg_advisory_lock` because Supavisor reassigns the backend connection after each COMMIT in transaction mode. |
| **Fly Postgres** | Copy from `flyctl postgres connect` output. |
| **RDS / Neon / Render** | Use the host's standard "external" connection string. |
| **docker-compose local** | Built for you from `POSTGRES_PASSWORD`: `postgres://skrun:$POSTGRES_PASSWORD@postgres:5432/skrun`. **Set it in `infra/.env` — there is no default.** The compose stack used to fall back to `skrun-dev-only`, a password published in this repository; Postgres now refuses to start on an empty password rather than pick one for you. Generate one with `openssl rand -hex 16`. |

**On Supabase, close the Data API to Skrun's tables.** Skrun reads and writes its database through the connection string above, as the `postgres` user that owns its tables; it uses none of the project's API keys. A Supabase project also serves the tables of the `public` schema — where Skrun's migrations create them — over its Data API, to the `anon` and `authenticated` roles, which many projects grant new tables there by default (the default grants differ from project to project, depending on when it was created and its Data API settings); the key that reaches them, the publishable key (formerly `anon`), is public by design. Close that path in one of these ways:

- **Turn the Data API off** in the project's Data API settings, if nothing else uses it: none of its endpoints then respond.
- **Enable row level security on every table of `public`, with no policy.** Through the Data API those tables then read and write nothing; Skrun, connecting as their owner, is not affected. Tables a later migration creates need it too: Supabase's event trigger that enables row level security on each new table of `public` (*Event triggers* guide, "auto enable Row Level Security") does it once you create it. The Security Advisor then lists each table under `rls_enabled_no_policy` ("No access rules defined") — the intended state here; a policy that grants rows to `anon` or `authenticated` would open them.
- **Revoke `anon`'s and `authenticated`'s privileges** on those tables, and the default grants on new ones (Supabase's *Securing your API* guide).

Do this on the project, never in Skrun's migrations: a deployment that connects with a role that does not own the tables would then read nothing.

#### Migration applicator behaviour

- **On every boot**, the runner takes a `pg_advisory_lock`, ensures `_skrun_migrations` exists, applies any unseen `.sql` files in lexicographic order, and releases the lock.
- **Each migration file** runs inside its own transaction. If the file's SQL fails, the runner rolls that file back and aborts the boot.
- **Lint at boot**: migration files must NOT contain top-level `BEGIN;` / `COMMIT;` (the runner wraps them) AND must use idempotent DDL constructs (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.) — guarantees mid-crash re-apply safety.
- **Cloud backfill probe**: if the schema exists (e.g., from a cloud deployment older than this runner, whose migrations were applied by hand via Supabase MCP) but `_skrun_migrations` doesn't, the runner records the filename rows without re-executing the SQL.

The boot log surfaces counts: `migrations applied=N backfilled=M skipped=K`.

#### Backups

Skrun ships no backup of its database: use your host's, or a scheduled `pg_dump`. A database restored from a copy brings back what was deleted after the copy was taken — accounts, revoked API keys and sessions among them. Leave the data of the `sessions` and `device_codes` tables out of the copy (`pg_dump --exclude-table-data=public.sessions --exclude-table-data=public.device_codes`): after a restore, everyone signs in again. For accounts and API keys, keep a deletion journal (`SKRUN_DELETION_JOURNAL`, see [Environment variables reference](#environment-variables-reference)), and delete them again before anyone reaches the restored server:

1. List the journal's objects under `_deletions/` with their dates, and keep those written after the copy began, or up to an hour before it: an account deletion writes its record before it deletes anything, and the hour is this guide's margin for it, not a measured duration — widen it if one of your account deletions can take longer.
2. For each `_deletions/account/<id>`, read the account's username on the restored database — `SELECT username FROM users WHERE id = '<id>';`, no row: nothing to do. Start the server on the restored database where nobody else can reach it — its port not published (`-p 127.0.0.1:4000:4000` with Docker) and your reverse proxy's route to it closed — and delete the account with an administrator's account-wide API key that carries every operation, created before the copy was taken — a key created after it is not in the restored database, and no session is, so keep such a key for this: `curl -X DELETE http://127.0.0.1:4000/api/admin/accounts/<id> -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"confirm": "<username>"}'`. The account goes the way it went the first time, its stored bundles included (see [Deleting an account](#deleting-an-account)).
3. For each `_deletions/api-key/<id>`, on the restored database: `DELETE FROM api_keys WHERE id = '<id>';` — after the accounts, in case the administrator's key is among them.
4. Open the server to its users.

### Memory (tests only)

`MemoryDb` lives in `packages/api/src/db/memory.ts` and is used by the test suite. Don't use it in production — everything is lost on restart.

### Script dependency cache

When agents declare a `package.json` / `requirements.txt` / `pyproject.toml` at the bundle root, a server running the `local` runtime resolves the deps on first call and caches them under `~/.skrun/deps/<hash>/` (or `$SKRUN_DEPS_DIR` if overridden). On the cloud runtime (`SKRUN_RUNTIME=flyio`) this cache is not used: each sandbox installs its own run's dependencies — see [agent-yaml.md → In the cloud sandbox](agent-yaml.md#in-the-cloud-sandbox). The cache is **content-addressable** — two agents whose manifests have identical text share the same cache entry, so 5 agents using `pandas==2.2.3` only consume ~80 MB of disk once. Because the hash depends on the manifest's text only, a shared mount (`SKRUN_DEPS_DIR`) can serve one install to several servers, across pushes of the same agent, without re-downloading.

**Disk planning**: typical Python data agents (pandas, matplotlib, reportlab) resolve to ~80–100 MB per unique manifest hash. Heavy ML stacks (`transformers` + `torch`) reach several GB. Plan ~500 MB / 1 GB of headroom for typical mixed deployments; more if your fleet runs many distinct ML manifests.

**Operator tools**:

```bash
skrun cache list           # hash + size + package count + last-used per entry
skrun cache clear          # delete all entries (prompts above 100 MB)
skrun cache clear --yes    # bypass the prompt for cron / CI cleanups
```

The cache is **safe to delete** at any time — the runtime re-resolves on the next call. Only `~/.skrun/deps/.tmp-*/` directories represent in-flight installs from a crashed previous run; `cache clear` removes them silently.

### Storage configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `INPUT_FILES_MAX_SIZE_MB` | `25` | Max upload size per file |
| `INPUT_FILES_RETENTION_S` | `86400` (24 h) | How long uploaded input files are kept; expired files are deleted by a sweep every five minutes. An upload a stopped server left is removed ten to fifteen minutes past its deadline, provided a server runs on that temp directory — see *Temporary files and restarts* [below](#environment-variables-reference). At most `3153600000` (100 years): a larger value is read as 100 years |

---

## Authentication

Skrun auto-detects the auth mode based on environment variables.

### Mode 1: Dev-token (local dev, never production)

The `dev-token` shortcut treats any `Bearer dev-token` caller as **admin** in the `dev` namespace — zero-friction for local dev, but it grants admin to **anyone who can reach the server**, so it has **no user isolation and must never be exposed publicly**.

It is **fail-secure: off by default**. Enable it explicitly with `SKRUN_DEV_AUTH=1` (`1`/`true`/`on`/`yes`), and only on `localhost` or a trusted private network. `pnpm dev:registry` sets it for you. Two guardrails:

- The api-server **refuses to boot** if `SKRUN_DEV_AUTH` is enabled without OAuth on a server whose `NODE_ENV` is neither `development` nor `test`, unset included (`pnpm dev:registry` sets `development`): any real deployment must use OAuth (Mode 2) or API keys (Mode 3).
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
   - **Homepage URL**: `https://your-domain.com` (or `http://localhost:4000` for testing)
   - **Authorization callback URL**: `https://your-domain.com/auth/github/callback`

2. Set env vars — in `.env` at the repository root for the bare-metal install, in `infra/.env` for the [Docker Compose stack](./self-hosting-docker.md), which hands that whole file to the API:

   ```bash
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

3. Restart the registry — on the Docker Compose stack, `docker compose -f infra/docker-compose.yml up -d`, which recreates the API with the new values (`restart` would keep the old ones). Users visit `/login`, click "Sign in with GitHub", and their namespace is their GitHub login in lowercase by default (e.g., `alice`) — see **Namespaces** below. The same `agent.yaml` (slug-only `name`) pushed under different OAuth users lands under different namespaces — no per-environment yaml edits needed.

**Namespaces.** A new account's namespace is its GitHub login in lowercase, by default. If another account already holds that name, the new one gets `<login>--2`, then `--3`, and so on. A login with a character outside `a-z`, `0-9` and `-` — the underscore of accounts managed by a GitHub organization, for instance — is sanitized: each such character becomes `-`, repeated hyphens merge into one, leading and trailing hyphens go, and the result is cut at 64 characters. The namespace is fixed when the account is created and **never changed afterwards** — not when the user renames their GitHub account — so the addresses their clients call keep working. It is first come, first served, which has a price worth knowing: a managed account `alice_acme` that signs up first holds `alice-acme`, and the GitHub user whose login really is `alice-acme` gets `alice-acme--2` when they sign up after. Two accounts created by GitHub sign-in never share a namespace, on every database backend (on SQLite and the in-memory backend, a second sign-in under a name already held used to get the same one). Dev tokens are another matter: they work only without OAuth and take their namespace from the token itself, so `dev-token` and `dev-ci` both act in `dev`.

**CLI login (`skrun login`)** uses an OAuth 2.0 Device Authorization Grant (RFC 8628) once OAuth is configured — there is nothing extra to set up, and because it runs no local callback server it works over SSH and inside containers. It prints a one-time code + a verification URL; that URL is built from the `X-Forwarded-Proto` / `Host` headers (automatic behind Fly / Caddy / nginx) **unless `SKRUN_PUBLIC_URL` is set, which takes precedence over both**. If you expose the api-server **directly** (no reverse proxy), make sure the public scheme/host reach the server or the printed URL may be wrong — or set `SKRUN_PUBLIC_URL`, which is the fix for exactly that: the server then stops deriving its own address from headers the caller sends. Tune the code lifetime with `SKRUN_DEVICE_CODE_TTL_S` (default 600 s; at most `3153600000`, 100 years — a larger value is read as 100 years); `skrun login` waits for the sign-in as long as the code lives, 15 minutes at most. Without OAuth, `skrun login` falls back to a token prompt.

**Restricting who can sign up (private instance / closed beta).** By default anyone with a GitHub account can sign in and get a namespace — the right default for a public instance. To run a **private** instance (your team only) or a **curated closed beta**, set `SKRUN_ALLOWED_GITHUB_USERS` to a comma-separated allowlist; only listed accounts may then sign in — **every** login, web **and** `skrun login` — and anyone else gets a generic "not authorized" page (no account is created). Each entry is a **username** (case-insensitive) or `id:<NNN>`, the immutable GitHub numeric id, which survives a username rename — e.g. `SKRUN_ALLOWED_GITHUB_USERS=alice,bob,id:90123`. **Leave it unset for open signup** (the default). Two caveats: (1) **include yourself** — on an OAuth instance there is no `dev-token` escape (that shortcut only works when OAuth is unset), so a self-lockout is fixed only by editing the env var and restarting (on the Docker Compose stack, `infra/.env` and `up -d`); (2) it gates **new logins**, so removing someone blocks their next login but an **active session** keeps working until it expires (7 days by default — see `SESSION_TTL_S`, at most `34560000` seconds, 400 days: a larger value is read as 400 days) and any API key they hold works until you revoke it. Sessions live in the database and **survive a restart**, so bouncing the registry no longer signs anyone out; to cut someone off immediately, delete their session rows (`DELETE FROM sessions WHERE user_id = '<their user id>';`) and revoke the API keys they hold — or delete their account, which takes both with everything else it owns (see **Deleting an account** below). The allowlist is operator config (an env var / secret), never editable from inside the app, and governs **who gets an account** — not what a delegated API key can do (that is API-key scopes).

### Mode 3: API keys (programmatic)

Once OAuth is set up, users create API keys for CI/CD and the CLI:

```bash
# In a browser, signed in — create a key
curl -X POST https://your-domain.com/api/keys \
  -H "Cookie: skrun_session=<your-session>" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI deploy"}'

# Response: {"key": "skrun_sk_3f9a…", ...}  ⚠ shown once

# Use it
skrun login --registry https://your-domain.com --token skrun_sk_3f9a…
```

The `Content-Type` header is not decoration: a change-making request that carries the session cookie, sends a form-style body and shows no browser signal is refused with `403`, because that is indistinguishable from a request another site forged. Naming a non-simple type is enough to pass; so is using an API key, which is what this command exists to create.

The cookie's name depends on how the server runs. Outside production it is `skrun_session`. In production with no session cookie domain — the shipped image and compose stack, which set `NODE_ENV=production` — it is `__Host-skrun_session`. In production with `SKRUN_SESSION_COOKIE_DOMAIN` set it is `__Secure-skrun_session` (see below). Only the current name is read: sending another one gets `401`.

The `__Host-` prefix is what a deployment that configures nothing gains. A browser accepts a cookie of that name only from the exact host that sets it, with `Secure`, `Path=/` and no `Domain` — so another host of your DNS zone (a compromised or third-party subdomain) can no longer plant a session cookie this API will read.

**Upgrading a production deployment that sets no cookie domain renames the cookie.** Every signed-in user signs in once more, once. A web sign-in (up to 5 minutes) or a `skrun login` (up to 10 minutes) in progress at deploy time fails and has to be started again. A script that sends `Cookie: skrun_session=…` to such a server now gets `401`: send `__Host-skrun_session`, or better, an API key. Rolling back to an earlier release reverses the rename and costs one more sign-in.

Keys start with `skrun_sk_`, followed by 36 characters of `0-9A-Za-z`, the last six a checksum — its encoding is in the [API reference](api.md#api-keys). They're stored as SHA-256 hashes — the server never sees the raw key after creation. Revoke via the dashboard or `DELETE /api/keys/:id`.

**Upgrading to 2.0.0 refuses every API key minted before it.** Keys of the old format, `sk_live_…`, are refused with `401` "Invalid API key", like any invalid key, and a 2.0.0 server mints `skrun_sk_…` keys only. An earlier server mints the old format only, so a replacement can be minted only after the upgrade — and between the upgrade and the hand-over of its replacement, the calls of whoever holds an old key fail. The old keys stay listed, under the names that tell you whom each was handed to, until you revoke them:

1. **Before upgrading, list the keys.** `GET /api/keys` returns each key's name, operations, scope and expiry; `skrun keys list` prints its id, prefix, name, scope and expiry. No route returns the agents a restricted key is bound to: find them in the `api_key_agents` table, or ask the key's holder. Each account lists, mints and revokes only its own keys, so on a server with several accounts every account replaces its own: to find the accounts that still hold an old key, read the `api_keys` table — the rows whose `key_prefix` does not start with `skrun_sk_`, by `user_id`.
2. **Upgrade.**
3. **For each old key, mint a replacement with the same scope** — `skrun keys create` with the same `--agent` and `--run-only`, or `POST /api/keys` with the same `scopes`, `scope_kind` and `agents` — and hand it to the old key's holder.
4. **Revoke the old key** — `skrun keys revoke <id>`, or `DELETE /api/keys/:id`.

The key your own CLI saved at `skrun login` is refused too: run `skrun login` again.

#### Scoped keys (restricted credentials)

A key can be **restricted** along two axes — an **operation** scope (`agent:run` / `agent:push` / `agent:verify`) and a **resource** scope (`account`, or `agents` bound to specific agents you own). The headline use is handing a customer a **run-only key scoped to one agent** — they run that agent and nothing else, without a Skrun account:

```bash
skrun keys create --name client-acme --agent dev/my-agent --run-only
skrun keys list            # account / scoped, per key
skrun keys revoke <id>
```

A delegated or run-only key cannot mint/revoke keys, change visibility, delete, pull source, read your run history or run detail, read your usage stats, or list the server's agents directory (`403 KEY_SCOPE_FORBIDDEN`) — key management, and those reads, require an account-wide *full* key (or a session, or `dev-token`). A run-only key without `--agent` still lists an agent's versions, without their `config_snapshot` (the parsed `agent.yaml`: model, tools, MCP servers); a delegated key does not list them. Either reads only its own files: the files it uploaded — the only ones it can delete or pass as a run input — and the outputs of the runs it launched. Every run records the calling key (`runs.api_key_id`) for per-key metering. See `docs/concepts.md` → "API-key scopes". Minting via the API: `POST /api/keys` with `{ "name": "...", "scope_kind": "agents", "agents": ["dev/my-agent"], "scopes": ["agent:run"] }`.

> ⚠️ **To a third party, hand a delegated key** (`--agent`), never an account-wide key with every operation: that key shares the owner's own **agent state** notebook and already gives the whole account. On a stateful agent with the default `scope: per_caller`, the account (session, `dev-token`, a full account-wide key) has one notebook and every other key has its own; revoking a key deletes its notebooks. See `docs/concepts.md` → "State".

### Admin role

Every `users` row carries a `role` column (`admin` or `user`, defaults to `user`). Admin-gated routes:

- `PATCH /api/agents/:ns/:name/versions/:version/verify` — flip a version's verified flag (the runtime gate consumes this).
- `DELETE /api/agents/:ns/:name` and `DELETE /api/agents/:ns/:name/versions/:version` — namespace owner OR admin (admin can delete any agent/version across namespaces, for moderation).
- `DELETE /api/admin/accounts/:id` — delete another account (see **Deleting an account** below).
- `PUT /api/admin/accounts/:id/plan` — assign an account's plan, with a full-access credential (see [Quotas per plan](#quotas-per-plan)).

The role belongs to the person; what an admin may do beyond their own account also depends on the credential they present. Reading, listing and running another account's agents, overriding another agent's environment, verifying any version, and reading the pool status (`GET /api/admin/pool`) take a **full-access credential** — a session, `dev-token`, or an account-wide key with every operation. An admin's restricted key (fewer operations) or delegated key (some agents) answers as the same key of any other account would: another account's agent answers the opaque `404`, the agent list holds the admin's own agents only, and the pool status answers `404`. A key an admin narrows for one job, or hands to a client, carries none of the role.

Promotion to admin is a **manual SQL update** — there is no HTTP endpoint for role elevation by design. Pick the operator(s) you trust to mint the verified trust signal and promote them once:

```bash
# SQLite (default)
sqlite3 skrun.db "UPDATE users SET role='admin' WHERE username='you'"

# Postgres
psql $DATABASE_URL -c "UPDATE users SET role='admin' WHERE username='you';"
```

In `dev-token` mode (`SKRUN_DEV_AUTH` enabled, OAuth not configured), the caller is granted admin role automatically — local-dev workflows need no extra setup.

### Deleting an account

Two routes delete an account, with the same effects: `DELETE /api/account`, where a user deletes their own, and `DELETE /api/admin/accounts/:id`, where an administrator deletes someone else's by its internal `id` (the `id` column of `users`, which `GET /api/me` also returns). Both take a full-access credential — a session, `dev-token`, or an account-wide key with every operation — and the account's username as a JSON body, `{"confirm": "<username>"}`. A non-admin calling the admin route gets the same `404` as every admin route.

```bash
# Find the account, then delete it
sqlite3 skrun.db "SELECT id, username FROM users WHERE username='bob'"
curl -X DELETE \
  -H "Authorization: Bearer skrun_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"confirm": "bob"}' \
  https://your-domain.com/api/admin/accounts/<id>
```

The account, its keys, sessions, agents, versions, bundles, notebooks and attached model keys are deleted; its runs, every run of its agents, and the runs left by agents it had deleted before (found by the namespace their version names, unless that namespace is shared) stay — cleared and detached, the version they name reduced to `@<version>` — so usage numbers survive; no record of the deletion is kept in the database, and the one `account_deleted` log line names nobody — unless you keep a deletion journal (`SKRUN_DELETION_JOURNAL`), which keeps the account's internal id in the bundles' store, for a restore (see [Backups](#backups)). What each part means, what a `503` leaves and what is not reached (other instances' copies until they expire, logs, backups) is in [API → Delete your account](api.md#delete-your-account).

- **The last administrator.** Nothing stops an administrator from deleting their own account, even the last one: the role is set in SQL (see **Admin role** above), and an instance can end up with no administrator. Promote someone else first if you need one.
- **The name is free at once.** No tombstone is kept in the database: the next account created with that GitHub login gets the namespace back, empty. One narrow race remains: a new holder who signs up **and** pushes in the few milliseconds after a deletion, while it clears what is left under the name, can lose the object of that push — the push succeeded, and its pulls and runs answer a bundle-not-found error until a new version is pushed.
- **Its duration.** The database part is one transaction that locks every run the account and its agents have, and reads the version text of the runs no agent is left for: it grows with those numbers. On an instance with a long run history, expect a deletion to hold those rows for longer.
- **Object storage.** Bundles are deleted from the store the server was started with; on the cloud runtime, the output files runs left under `_runs/` are deleted too. If the store refuses a delete, the deletion stops before touching the database and answers `503`: send the same request again.
- **`dev-token` mode.** Deleting with `dev-token` removes the dev account's row; the next request with the token creates a new, empty one.

#### Delete an account (admin only)

```
DELETE /api/admin/accounts/:id
```

**Response** `200` `{ "deleted": true }`. The caller's session is left alone — unless the `id` is the caller's own: an administrator who deletes their own account this way loses the session cookie, as with [Delete your account](api.md#delete-your-account).

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `CONFIRMATION_MISMATCH` | No JSON body, no `confirm`, or a `confirm` that is not that account's username. Nothing was deleted |
| `401` | `UNAUTHORIZED` | No credential |
| `403` | `KEY_SCOPE_FORBIDDEN` | An administrator's key without full access |
| `404` | `NOT_FOUND` | The caller is not an administrator, or holds a delegated key — the same `404` as [`GET /api/admin/pool`](#pre-warm-pool-status-admin-only), whatever it sends; an `id` that is not a UUID; no account with that `id` |
| `503` | `STORAGE_UNAVAILABLE` | As for [Delete your account](api.md#delete-your-account): the account still exists, send the same request again |

### Verification policy

`SKRUN_VERIFICATION_POLICY` chooses **who may attest an agent version** and **whether runs are gated on verification**. It is read once at boot, so **changing it requires a restart/redeploy**. An invalid value fails the boot fast (the server refuses to start) so a typo can't run with an undefined gate.

| Policy | Run gate | Who can verify | Best for |
|--------|----------|----------------|----------|
| `admin` *(default)* | unverified versions return `403 AGENT_NOT_VERIFIED`, before any model call, tool or script | instance admins only | single-operator / curated instances; this is the legacy behavior, so an unset value changes nothing |
| `owner` | no gate — a private agent runs for its owner, scripts included | the agent **owner** (or an admin) | multi-tenant hosting, where one operator can't vet everyone's agents: the owner is the trust authority for their own agents and safety rests on the per-run sandbox machine of the cloud runtime (`SKRUN_RUNTIME=flyio`) + reactive abuse — on the `local` runtime there is no per-run sandbox: scripts run as child processes of the API server |
| `disabled` | no gate — every version runs, scripts included | owner or admin (flag is inert) | a trust-all single-user instance that doesn't want a verification step |

Verification never filters what a run does: a version that may run, runs whole — there is no mode where an unverified version runs without its scripts.

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
| **`skrun_sk_…` API key** | `apiKeys.user_id` → `users.id` | inherits the owning user's role | same as the owning user — but an admin's key widens to every account only with every operation and account-wide scope (a restricted key lists the admin's own agents; a delegated key cannot list) | same as the owning user, with the same exception: an admin's restricted or delegated key gets the opaque `404` on another account's agent |

The `dev-token` row is what makes the self-host experience seamless: in single-user dev/test, you're the operator AND the only user, so the auto-admin role means the filter doesn't narrow anything. You see all agents in the dashboard and CLI as before.

The OAuth row is what activates the actual filter: a non-admin user pushing to `alice/foo` won't see `bob/bar` in their dashboard list, can't `skrun pull bob/bar`, and `GET /api/agents/bob/bar` returns `404 NOT_FOUND` with a body identical to a genuine "agent not found" response.

#### Why the opaque 404 (not a 403)

Read endpoints return `404 NOT_FOUND` rather than `403 FORBIDDEN` on a cross-tenant access attempt. The two response bodies are byte-identical to a "the agent really doesn't exist" 404 — a caller cannot distinguish whether the namespace contains an agent of that name. This is the GitHub Private Repo / Stripe API / Linear pattern: the namespace itself (by default your GitHub login) is public, but the slugs you push under it may carry strategic signal — exposing existence via a 403 would let a competitor probe your namespace for telltale agent names.

Write endpoints (`DELETE /api/agents/...`, `PATCH /api/agents/.../verify`) keep `403 FORBIDDEN` — when a user is performing an action, they need to know why it failed so they can switch accounts or contact an admin.

#### Promoting an operator to admin (multi-tenant ops)

Admins bypass the read filter — useful when you need to inspect or moderate agents across all namespaces from a single account. Promote via the same SQL pattern as the verification gate:

```bash
sqlite3 skrun.db "UPDATE users SET role='admin' WHERE username='ops-account'"
```

The promoted user's session, or their account-wide API key with every operation, then sees all agents instance-wide — a key they restricted or delegated does not (see **Admin role** above).

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
  -H "Authorization: Bearer skrun_sk_..." \
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

Attach / inspect (namespace owner or admin, with an account-wide credential — in production that's a session or a full API key; the `dev-token` shortcut is off):

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

## Your own site in front of the API

When a website of your own signs people in and publishes your terms, privacy policy and docs — the API on `api.example.com`, the site on `example.com`, say — five settings send the API's sign-in and its links there. **Each is off until you set it**: an instance that sets none behaves as one without them, and an empty value, or one made only of blanks, counts as not set. They are read once, at startup: a change takes a restart, and an open dashboard shows it once reloaded. A value outside its form stops the start, with a message that names the variable, the form it expects and the value it received, credentials masked.

| Variable | What it changes | Form |
|----------|-----------------|------|
| `SKRUN_LOGIN_RETURN_PATH` | Where a finished browser login lands on your site — `/` by default | A path; **requires `SKRUN_SESSION_COOKIE_DOMAIN`** |
| `SKRUN_LOGIN_PAGE_URL` | `GET /login` answers a temporary redirect (`302`) to your page — by default, this server's own page | An absolute address that is not a page of this server leading back to `/login` |
| `SKRUN_TERMS_URL`, `SKRUN_PRIVACY_URL` | A line under the GitHub button of `/device` and `/login`, and links at the foot of the dashboard's sidebar — nothing by default | An absolute address, or a path on this server's host |
| `SKRUN_DOCS_URL` | Where the two "Read docs" links of the dashboard's home page lead — by default `/docs`, this server's API reference | The same |

**Where a sign-in returns.** The return needs a session your site shares, so it starts with `SKRUN_SESSION_COOKIE_DOMAIN` — read its row in the [environment variables reference](#environment-variables-reference), and the note under that table, before you set it. With the domain set, a sign-in leaves the API for the site at the cookie domain itself — the scheme of `SKRUN_PUBLIC_URL`, that domain, no port — at `SKRUN_LOGIN_RETURN_PATH`, `/` by default. A browser sign-in that succeeds lands there with no query. A sign-in that fails comes back to the same address with `?login=failed`, whatever the cause — the marker does not tell —, and one the signup allowlist refuses with `?login=denied`. A `skrun login` ends on this server's own page instead, which sends the user back to the terminal, when it succeeds and when its one-time code is no longer valid. Without a cookie domain, a sign-in never leaves the API — a success lands on `/dashboard` — so a path set there would be ignored: the server refuses to start instead. Nothing of the request — no `return_to`, no `next` — decides where a sign-in goes.

**Your own sign-in page.** With `SKRUN_LOGIN_PAGE_URL` set, `GET /login` answers a temporary redirect to it, carrying nothing of the request, whether or not GitHub sign-in is configured on this server. The dashboard sends a visitor who is not signed in to `/login`, and so does signing out: both now reach your page. **If one page of your site does both** — signs people in, and receives them when they come back — set both settings to it, the page at the cookie domain itself: `SKRUN_LOGIN_PAGE_URL=https://example.com/signin` and `SKRUN_LOGIN_RETURN_PATH=/signin`.

**No loop through `/login`.** Your page sends a visitor on to the dashboard only once `GET /api/me`, sent with that visitor's session cookie, answers `200`. Otherwise a visitor who is not signed in goes from your page to the dashboard, from the dashboard to `/login`, and from `/login` back to your page, without end. Make that check from your site's server, forwarding the cookie: the API's cross-origin answers carry no `Access-Control-Allow-Credentials`, so a script on your page that sends the cookie cannot read the answer. The server refuses to start on a sign-in page that is itself a page of this server that sends a browser that is not signed in back to `/login` — judged on the host and port of `SKRUN_PUBLIC_URL`, under `http` or `https` alike (a front that redirects `http` to `https` serves the same pages under both), and on the path as this server routes it. Without `SKRUN_PUBLIC_URL` that check is skipped: the server's only other source for its own origin is the `Host` header, which the caller chooses.

**Writing a path.** A path — `SKRUN_LOGIN_RETURN_PATH`, or a link that starts with `/` up to its first `?` or `#` — has a single leading `/` and is written already in the form a URL parser gives it: a path that parsing would change is refused, never repaired. Percent-encode what the parser would encode — `/%C3%B6`, not `/ö`. A return path takes no query and no fragment. A link may add `?query` and `#fragment` after its path, with no blank or control character.

**An absolute address** — `SKRUN_LOGIN_PAGE_URL`, or a link that does not start with `/` — starts with `http://` or `https://` in any letter case, holds no blank, no control character and no credentials (`user:pass@`), is one a URL parser reads, and is served as that parser normalises it: `HTTPS://Example.com/terms` is served as `https://example.com/terms`, an internationalised host in its ASCII form.

**A path on this server's host.** A link written as a path points at the host that serves `/login`, `/device` and the dashboard — this server. The API serves none of your pages: a path it does not serve itself answers `404`, unless your reverse proxy routes it to your site.

**Terms and privacy policy.** With either set, the device-login consent page (`/device`, which `skrun login` opens) and `/login` show a line under their GitHub button — "By continuing, you agree to the Terms and acknowledge the Privacy Policy.", or the half of it for the one set — and the dashboard's sidebar shows **Terms** and **Privacy**, each when set, at its foot under "API Docs". `/login` has the GitHub button only when GitHub sign-in is configured here. **Docs**: `SKRUN_DOCS_URL` moves the two "Read docs" links of the dashboard's home page; every other link to the docs stays on this server's API reference, `/docs`. Each of these links opens in a new tab and sends no referrer.

**What the dashboard reads.** The dashboard reads the three links from [`GET /api/instance`](api.md#instance-links), once when it loads — never from its build —, so they appear a moment after the page. A read that fails, or an answer without them, leaves `/docs` and no terms or privacy link.

---

## Environment variables reference

Set them in `.env` at the repository root for the bare-metal install, or in `infra/.env` for the Docker Compose stack, which hands that whole file to the API except the names its compose file fixes for the `api` service (see [Operator `.env` template](self-hosting-docker.md#operator-env-template)).

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | Registry HTTP port |
| `NODE_ENV` | — | Set to `production` to enable strict mode (forces `CORS_ORIGIN`, requires HTTPS webhooks, refuses private-IP `webhook_url`) |
| `CORS_ORIGIN` | `*` in dev, **required in prod** | CORS allowed origin. When `NODE_ENV=production`, the API fails fast at startup if unset (no implicit `*`). Set e.g. `https://app.example.com`. |
| `WEBHOOK_SIGNING_KEY` | — (**required for webhook delivery**) | HMAC-SHA256 key used to sign `POST /run` webhook callbacks (`X-Skrun-Signature: sha256=...`). Without it, webhook delivery refuses to fire. Generate with `openssl rand -hex 32`. |
| `BUNDLE_MAX_DECOMPRESSED_MB` | `50` | Cap on what an `.agent` bundle decompresses to — its tar stream, tar headers included, not the sum of its files (gzip-bomb defense). A push past it is refused `413 BUNDLE_DECOMPRESSED_TOO_LARGE`, before anything is stored; a run of a version stored past it — pushed under a higher value, or stored before the push refused it — `422 BUNDLE_DECOMPRESSED_TOO_LARGE`, before the run starts (see [API → Error codes](api.md#error-codes)). Raise it together with `SKRUN_PUSH_MAX_BODY_MB` (below), and only for legitimately larger artefacts. Must be a positive decimal number of MB (`50`, `0.5` — a fraction is counted in whole bytes), read as `SKRUN_PUSH_MAX_BODY_MB` is — the server refuses to boot on anything else, an empty value, `0`, `1e3`, `0x10` or a value under one byte included, rather than fall back silently. `skrun pull` reads the same variable from its user's environment, as its own cap, the same way — on a malformed value it stops before downloading anything; `skrun build` warns past `50`, the default — it does not know your setting. |
| `SKRUN_PUSH_MAX_BODY_MB` | `50` | Cap on the **compressed** push request body — over it, `POST /api/agents/:ns/:name/push` returns `413 BUNDLE_TOO_LARGE`. Judged on a declared `Content-Length` before anything is read; a body without one is counted as the route reads it, after the caller is authenticated, and refused at the first chunk past the cap. Distinct from `BUNDLE_MAX_DECOMPRESSED_MB` above, which bounds what the archive expands to; both apply. Raise the two together: a bundle `skrun build` makes unpacks to about its compressed size or more, so raising this one alone lets almost no larger bundle through — only an archive padded in its gzip header unpacks to much less —; the refusal's message names both. Behind the Docker Compose stack, Caddy's `max_size` (`infra/Caddyfile.example`, `50MiB`) bounds the same body first: raise it with this one, in `MiB`. Must be a positive decimal number of MB (`50`, `0.5`) — the server refuses to boot on anything else, an empty value, `1e3`, `0x10` or a value under one byte included, rather than fall back silently. |
| `SKRUN_MAX_BODY_MB` | `1` | Cap on the request body of every route without a cap of its own — over it, `413 REQUEST_TOO_LARGE`, whose message names the cap. The routes with their own: the push (above), `POST /api/files` (`INPUT_FILES_MAX_SIZE_MB` plus 1 MB of multipart framing) and `POST /run` (about 6.33 MB, fixed, inline files included — about 4.7 MB of them when the rest of the request is small); see [Request size](api.md#request-size). Applied as the push cap is: the cap itself reads nothing, and a route reads its body after its own checks — its authentication, where it has one (the device-login routes have none). Must be a positive decimal number of MB (`1`, `0.5`) — the server refuses to boot on anything else, an empty value, `1e3`, `0x10` or a value under one byte included. |
| `DATABASE_URL` | — | Standard Postgres URI (`postgres://user:pass@host:port/db`). When set, uses PostgresDb + auto-applies migrations on boot. Otherwise SQLite. For Supabase: use the **Session** Pooler URL on port 5432 — see the Postgres section above (transaction mode on port 6543 breaks `pg_advisory_lock`). |
| `SKRUN_DB_STATEMENT_TIMEOUT_MS` | `10000` | Postgres only: how long one statement the server sends its database may run before the database stops it, in milliseconds — a whole number from `1000` to `600000`; any other value refuses to start, naming the variable. A statement that reaches the bound is stopped by the database; a connection that gets no answer at all is given up on 5 s after the bound (15 s by default) and replaced. A request that meets either answers `503 DATABASE_TIMEOUT` (see [API → Error codes](api.md#error-codes)). Migrations run at startup on a connection of their own, without this bound; a run's admission under a bound on runs in progress, compute time or fast runs keeps its own (2 s for a lock, 5 s for a statement), and once it holds its connection, the database not answering it in time — the connection gone silent included — refuses the run `503 CAPACITY_EXHAUSTED` instead. Raising it lets a slow statement hold one of the process's 10 connections, and its locks, that long, and lengthens a stop: each attempt at a run's final status waits up to this bound — 5 s more on a connection that gets no answer —, three attempts at most, within the 20 s the stop gives its runs |
| `SKRUN_DELETION_JOURNAL` | `false` | Set to `true` to keep a record of each account deletion and each API key revocation, so that a database restored from an earlier copy can have them done again: an empty object per deletion, `_deletions/account/<id>` or `_deletions/api-key/<id>`, in the store the server keeps bundles in (`S3_BUCKET`, or the local bundles directory), named by the internal id alone. Written once the request is checked and before the database is changed: an account deletion whose record cannot be written is refused `503 STORAGE_UNAVAILABLE`, and sending it again resumes; a revocation waits for its record 5 seconds at most — one whose record cannot be written within them goes ahead, and logs `api_key_revocation_journal_failed`, its record possibly landing after the key is gone. Nothing deletes these objects: give the `_deletions/` prefix a lifecycle rule as long as you keep copies of the database, plus two days. Any value other than `true` or `false` refuses to start |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App client ID. If set, enables OAuth auth mode. |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret |
| `SKRUN_ALLOWED_GITHUB_USERS` | — (open signup) | Comma-separated GitHub signup allowlist for a private instance / closed beta — `username` (case-insensitive) or `id:<NNN>` (immutable id). When set, only listed accounts may sign in (every login, web + CLI); others get a "not authorized" page, no account created. Unset = open (default). Include yourself — no `dev-token` escape on an OAuth instance. |
| `SKRUN_PUBLIC_URL` | — (derived from `X-Forwarded-Proto` / `Host`) | The canonical public origin of this deployment, e.g. `https://api.example.com` (a port is allowed; a path, query or fragment is not). When set it is the **first** source for every URL the server hands out — the GitHub OAuth `redirect_uri`, the device-login verification URL, and the `servers` entry of the published schema — so those stop depending on a `Host` header the caller chooses. The server refuses to boot on a malformed value rather than guess. **Required** as soon as `SKRUN_SESSION_COOKIE_DOMAIN` is set. |
| `SKRUN_SESSION_COOKIE_DOMAIN` | — (host-only cookie) | Registrable domain to scope the browser session cookie to, e.g. `example.com`, so a dashboard on one host and the API on another share one sign-in. Leave unset — the default — and the cookie stays host-only, named `__Host-skrun_session` in production (see "Mode 3" above). When set, the value must be a registrable domain of which the canonical host is the domain itself or a subdomain (`api.example.com` under `example.com`), never a public suffix (`co.uk`, `fly.dev`) and never a bare IP; anything else is a boot failure with a message naming what it got and what it expected. **Two consequences to plan for.** In production the cookie is renamed to `__Secure-skrun_session`, so everyone signs in once more, once; and a finished browser login is redirected to that domain itself — the scheme of `SKRUN_PUBLIC_URL`, without the API's port — at the path `SKRUN_LOGIN_RETURN_PATH` sets, its root by default, instead of `/dashboard` (see [Your own site in front of the API](#your-own-site-in-front-of-the-api)). Changing the domain later leaves every signed-in browser with a cookie on the old scope that this server can no longer erase — and while both cookies are present the API refuses cookie sign-in as a planted duplicate, for up to the cookie's lifetime: users clear it by hand, or sign out before the change. |
| `SKRUN_LOGIN_RETURN_PATH` | `/` | The path where a finished browser login lands on your site, at the cookie domain itself. **Requires** `SKRUN_SESSION_COOKIE_DOMAIN`: the server refuses to boot on it alone. This row and the four below: see [Your own site in front of the API](#your-own-site-in-front-of-the-api). |
| `SKRUN_LOGIN_PAGE_URL` | — (this server's page) | Your own sign-in page: `GET /login` answers a temporary redirect to it. |
| `SKRUN_TERMS_URL` | — (nothing shown) | Your terms: a line under the GitHub button of `/device` and `/login`, and a link at the foot of the dashboard's sidebar. |
| `SKRUN_PRIVACY_URL` | — (nothing shown) | Your privacy policy, shown where the terms are. |
| `SKRUN_DOCS_URL` | `/docs` (this server's API reference) | Where the two "Read docs" links of the dashboard's home page lead. |
| `SKRUN_API_KEY_TTL_DAYS` | `90` | Lifetime of a key minted by `skrun login`, in days from creation. `0` = those keys never expire. Applies **only** to the CLI login flow: a key created through `POST /api/keys` expires only if the caller passes `expires_at`. Never retroactive — keys that already exist keep no expiry. A malformed or negative value falls back to 90 rather than disabling expiry. At most `36500` (100 years): a larger value is read as 36500, and `0` still means no expiry. |
| `SKRUN_OUTPUT_DIR` | `/tmp/skrun-outputs` | Base dir for agent-produced files (Files API) |
| `SKRUN_DEPS_DIR` | `~/.skrun/deps` | Script-deps cache root of this server (one per host, unless several servers share it through a mount), used when it runs agent scripts itself (`SKRUN_RUNTIME=local`). On the cloud runtime (`SKRUN_RUNTIME=flyio`) it is not used: each sandbox runner installs the dependencies inside the sandbox when its run starts, without a compiler, and keeps nothing for the next run — see [agent-yaml.md → In the cloud sandbox](agent-yaml.md#in-the-cloud-sandbox). |
| `SKRUN_ALLOWED_HOSTS` | — | Not a server setting: the server never reads it. The runtime sets it for each tool script, to the agent's `allowed_hosts` (see [agent-yaml.md → environment](agent-yaml.md#environment-optional)) |
| `SKRUN_AGENTS_DIR` | — | Dashboard scan directory for importing agents via UI. Listing it (`GET /api/agents/scan`) and importing from it (`POST /api/agents/scan/:name/push`) take a full-access credential, and the listing gives each agent's path relative to this directory — never the server's path. **Fixed by the shipped compose stack**, empty (`infra/docker-compose.yml`): its container has no agents directory |
| `SKRUN_DASHBOARD` | `on` | Serve the operator dashboard at `/dashboard`. Set `off`/`false`/`0` for a headless, API-only server. |
| `SKRUN_DASHBOARD_DIR` | `../web/dist` (bare-metal) · `/opt/skrun-web/dist` (image) | Path to the built dashboard SPA; override to serve a custom build. |
| `LOG_LEVEL` | `info` | pino log level: `debug`/`info`/`warn`/`error` |
| `BUNDLE_CACHE_TTL` | `600` | How long the server keeps what it read of a bundle for runs (seconds), cached by the bundle's content (its SHA-256), so a version deleted and published again with other bytes never runs the old one. An entry holds the text of the agent's `SKILL.md`, `agent.yaml` and `AGENTS.md`, nothing else of the bundle — and on the local runtime (`SKRUN_RUNTIME=local`) the bundle's extraction to the temp directory, which its scripts run from; the cloud runtime writes nothing of the bundle to the server's disk, the sandbox fetching its own copy. A sweep every five minutes removes expired entries: an extraction leaves the disk at most this long plus five minutes after it was made — unless a local run still uses it, in which case it goes when that run ends |
| `BUNDLE_CACHE_MAX` | `50` | Max cached bundles, counted in entries; what they weigh is bounded by `BUNDLE_CACHE_MAX_MB`. Like `BUNDLE_CACHE_TTL` and `BUNDLE_CACHE_MAX_MB`, read as the whole number its value starts with (`12.9` reads `12`, `1e3` reads `1`); a value that does not start with a positive whole number — empty, `abc`, `0`, a negative — falls back to the default without a word, and the server starts |
| `BUNDLE_CACHE_MAX_MB` | `256` | What the cached bundles may weigh together, in MB: the text of their `SKILL.md`, `agent.yaml` and `AGENTS.md`, counted one byte per character for a text all in ASCII and two otherwise — never less than the server's memory holds of it. Past it, the least recently used entries leave first, as past `BUNDLE_CACHE_MAX` — an extraction a local run still uses leaves the disk when that run ends; an entry heavier than the whole budget is not kept: its run is served, and the next run of that version reads the bundle again. A whole number of MB, read as `BUNDLE_CACHE_MAX` is; unset, or not starting with a positive whole number, `256`. It bounds what the cache keeps, not what runs in progress hold: each holds its own agent's text until it ends |
| `MCP_CACHE_TTL` | `600` | MCP connection cache TTL (seconds) |
| `MCP_CACHE_MAX` | `20` | Max cached MCP connections |
| `MCP_CONNECT_TIMEOUT_MS` | `120000` | Per-connect timeout for MCP servers (stdio spawn / SSE / streamable-HTTP), plumbed to the MCP SDK via `client.connect(transport, { timeout })`. On expiry the runtime logs `event=mcp_connect_timeout`, tears down the half-open transport, and the run **fails** with `502 MCP_CONNECT_FAILED`. Stdio cold-starts via `npx -y @some/mcp` can take 60-120s on first run after a fresh registry process (`@playwright/mcp` measured at ~70s on a warm chromium cache). Bump to `180000`+ if your runner fetches large MCP packages from cold. `@playwright/mcp` itself downloads no browser — see the Windows notes below. |
| `FILES_MAX_SIZE_MB` | `10` | The largest output file a run keeps, in MiB; a larger one is left out, and counted in the run's `files_excluded`. At most `1024`: a larger value is read as 1024; zero, a negative or an unreadable value gives the default. Both runtimes apply it — on the cloud runtime, the run's sandbox with the value this server sends it, then this server again (see the cloud-runtime note below). What a run keeps, and in which order: [Output files](api.md#output-files) |
| `FILES_MAX_COUNT` | `20` | The most output files a run keeps. At most `10000`: a larger value is read as 10000; zero, a negative or an unreadable value gives the default. Applied as `FILES_MAX_SIZE_MB` is |
| `FILES_RETENTION_S` | `3600` | How long agent-produced files are kept (seconds). Expired files are deleted by a sweep that runs every five minutes, and a directory no running server holds is removed, at boot and at every sweep, ten minutes past its deadline (see *Temporary files and restarts* below) — the window is a deletion bound, not just an availability. On the cloud runtime (`SKRUN_RUNTIME=flyio`) the same window also bounds the files a run leaves in object storage: the run records a deadline when it completes, and a purge that runs at startup and then every five minutes deletes those objects once the deadline has passed — a server that was stopped at the deadline catches up when it starts again. What that purge does not cover: see the cloud-runtime note below. At most `3153600000` (100 years): a larger value is read as 100 years |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `MISTRAL_API_KEY` / `GROQ_API_KEY` / `XAI_API_KEY` | — | Server-side LLM keys (optional — callers can provide their own) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | — | When both set, the `push` / `run` rate limiter uses Upstash Redis so the per-IP limit is **shared across instances** (multi-instance deployments). Unset → in-memory limiter (correct for a single instance). Each rate-limited route keeps its own counter in that store (`push`, `run`, the two device-login mounts), so exhausting one never spends another. On a Redis outage the limiter falls back to in-memory rather than failing open or closed. |
| `SKRUN_TRUST_PROXY` | — (off) | Set (`1`/`true`/`on`) when the server sits behind a reverse proxy / load balancer, so the rate-limit client address is read from a forwarded header instead of the socket. **Both shipped compositions already carry it** on the `api` service — `docker-compose.yml` sets it, and the `docker-compose.minimal.yml` overlay inherits it (the overlay keeps Caddy in front). In both, the api is reachable only through Caddy, and the shipped `Caddyfile.example` **overwrites** `X-Forwarded-For` with the address it saw — that overwrite is what makes the header trustworthy. Leave unset when the server is directly exposed: the header is then ignored, because a caller would otherwise choose their own rate-limit key. If your own gateway **appends** to `X-Forwarded-For` instead of overwriting it, do not stop here — set `SKRUN_TRUST_PROXY_HEADER` too. |
| `SKRUN_TRUST_PROXY_HEADER` | — (use `X-Forwarded-For`) | Name of the header your gateway writes the client address into itself — take the name from that gateway's own documentation (`Fly-Client-Ip` on Fly.io, `CF-Connecting-IP` behind Cloudflare, whatever your load balancer documents). Set it when your gateway **appends** to `X-Forwarded-For` rather than overwriting it: the first hop of that header is then the value the caller sent, so keying the limit on it lets one caller mint a fresh counter per request by varying what it sends. Case-insensitive. Read only when `SKRUN_TRUST_PROXY` is on. When the variable is set but the header is missing from a request, that request did not arrive through the named gateway: the limiter falls back to the socket address — degraded (one counter for every caller on that path) but never caller-controlled. It never falls back to `X-Forwarded-For`, which would hand the key back to the caller. **Fixed by the shipped compose stack**, empty: its Caddy overwrites `X-Forwarded-For`, and a header Caddy does not overwrite would let each caller pick its own counter |
| `RUNTIME_IMAGE_TAG` | — (**required when `SKRUN_RUNTIME=flyio`**) | Runner image the api-server spawns per run. No silent default — the server fails fast at boot if unset in cloud mode. Use `:edge` (latest build, always resolvable), `:latest` (latest stable), or a pinned `:vX.Y.Z` (reproducible). **Fixed by the shipped compose stack**, empty for the api: there the variable of `infra/.env` only picks the tag of the stack's own image (a tag alone, `edge` or `v0.9.0`), and the stack fixes `SKRUN_RUNTIME=local` |
| `SKRUN_RUNNERS_APP` | — (**required when `SKRUN_RUNTIME=flyio`**) | Fly app the sandbox runners are spawned into. Deliberately not `FLY_APP_NAME`, which Fly injects as the *current* app's name. |
| `SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL` | — (off) | Set to `true` to let the server's own LLM key be sent to an endpoint an agent declares in `model.base_url`. Off by default: otherwise any agent author on the instance could redirect the server's key to a host they control. Enable only where every agent is yours. |
| `SKRUN_ALLOW_LOCAL_MODEL_HOSTS` | — (off) | Set to `true` to let `model.base_url` point at a private or loopback address, or redirect to one — the documented Ollama / vLLM / LocalAI case. Off by default, because an agent-declared endpoint is otherwise a request-forgery primitive against your internal network. |
| `SKRUN_ALLOW_LOCAL_WEBHOOKS` | — (off) | Set to `true` to let `webhook_url` resolve to a private address. Local development only — leave off on any instance others can reach. |
| `SKRUN_PRIMARY_FAILOVER_MS` | `45000` | How long one call of a primary model may go unanswered before the declared fallback takes over — as long as no tool of the run has been called: once one has, the fallback never takes over. A whole number of milliseconds from 1 to 2147483647; any other value — `0`, negative, not a number — refuses to start. No effect on agents that declare no fallback. |
| `SKRUN_RUNNER_POOL_SIZE` | `0` (off) | How many sandbox machines to keep ready in advance. See "Pre-warm pool" below. `0` — the default — keeps none: every run builds its own machine, exactly as before. The machine maintenance runs whatever the size (see "Machine maintenance" below). |
| `SKRUN_QUOTA_CONCURRENT_RUNS` | — (no bound) | An account's runs in progress, per plan. See [Quotas per plan](#quotas-per-plan) for the form every quota variable takes and what refuses the start. |
| `SKRUN_QUOTA_COMPUTE_SECONDS` | — (no bound) | An account's compute seconds per window, per plan. Needs `SKRUN_QUOTA_WINDOW_S`. |
| `SKRUN_QUOTA_WINDOW_S` | — | The compute window's length, in seconds — one number for every plan, dividing a day (`86400`); the windows are aligned on UTC. |
| `SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS` | — (no bound) | Runs in progress on the whole instance, every account together — one number. The lever that bounds what runs cost: see [Capacity levers](#capacity-levers). |
| `SKRUN_RUN_MAX_TIMEOUT_S` | — (no bound) | The longest `timeout` a run may declare, in seconds — one number. An agent that declares none runs up to the 300 s default: under 300, it is refused too. A push of an agent that declares more is refused as well. With a pre-warm pool it also sets how long a server spares a running pooled machine it does not hold — see "Pre-warm pool" below. |
| `SKRUN_QUOTA_FAST_RUNS_PER_HOUR` | — (every run entitled) | An account's runs per rolling hour that may take a machine of the pre-warm pool, per plan, `0` allowed. Applies only while the pool runs; a run past them is never refused — it builds its own machine. See [Quotas per plan](#quotas-per-plan). |
| `SKRUN_QUOTA_STORAGE_MB` | — (no bound) | An account's bundle storage, per plan, in MB of 1,048,576 bytes: a push past it is refused. See [Quotas per plan](#quotas-per-plan). |
| `SKRUN_QUOTA_INPUT_FILES` | — (no bound) | An account's live uploads to `POST /api/files`, per plan: the next one is refused. Counted by each server process. See [Quotas per plan](#quotas-per-plan). |

> **Temporary files and restarts.** Run output directories, uploaded input files and, on the local runtime, bundle extractions live under the server's temp directory. At boot, and after every five-minute sweep, the server removes what no running server holds there — what a stopped server left, or the output directory of a run that failed before its files were recorded. A file's modification time says when anyone may remove it: a recorded output or upload carries its deadline (when it was recorded plus `FILES_RETENTION_S` or `INPUT_FILES_RETENTION_S`), an extraction its cache expiry (`BUNDLE_CACHE_TTL`), and a file a run still holds now plus its window, set again at every sweep. A file is removed only once ten minutes (two sweeps) have passed that time, and a server never removes what it holds itself. That is what lets two instances share one temp directory, whatever windows each is set to, their long runs included; it holds only if they share a clock — the same host. That time only guides this pass: a file's retention is its server's, and the sweep deletes it on time. The pass runs in the background, starting once the server listens, never two at once, and removes at most 20,000 entries each time — more than a stopped server can leave at the default cache sizes. A larger stock goes over the passes that follow, 20,000 every five minutes: the extractions earlier versions never removed can number tens of thousands on a persistent disk, and 100,000 of them take about 20 minutes to go, while the server serves requests. The bound that follows for a file a stopped server left, once such a stock is gone: ten to fifteen minutes past its deadline — counted from when it was recorded, not from the stop — provided a server runs on that temp directory. A file a run still held when its server stopped goes at most its window plus fifteen minutes after the later of that server's last sweep and the moment the run took the file. Two limits remain. The pass recognises a run's output directory by its name, `skrun-outputs-` then a uuid: another program that creates such directories under the same temp directory — an embedding of `@skrun-dev/runtime` whose local adapter makes its own output directory, for instance — would see them removed ten minutes after their last write. And on a filesystem that refuses a modification time in the future, a live file can be removed ten minutes after its last write.

> **Before you set `SKRUN_SESSION_COOKIE_DOMAIN`.** A cookie scoped to a parent domain is only as safe as the whole zone: **every** host under that domain can set a cookie the server will receive, so sharing a session across `example.com` is sound only if you control every host in that zone and delegate none of it — one compromised or third-party sibling host is enough to plant a session cookie for the others. It is also a **production** configuration: outside production the cookie travels without the `Secure` flag, no name prefix applies, and the server does not detect a planted duplicate. Leave the variable unset if the dashboard and the API share a host; you lose nothing.

> **Cloud-runtime (`SKRUN_RUNTIME=flyio`) operators.** The sandbox runner's outbound traffic is contained automatically — each runner image enforces an IPv4 **and** IPv6 egress allowlist (default-DROP; permitted: the agent's `allowed_hosts` — each named host's resolved addresses, or every public address under `["*"]` — and the hosts the runner itself needs, the object store it fetches the bundle from and the package registries script dependencies install from; the blocked address ranges are dropped before any of the agent's hosts), so there is nothing to configure, and the default `local` / api-server self-host (no sandbox machines) needs no action. When you upgrade, **roll out the new runner image (`RUNTIME_IMAGE_TAG`) before the api-server**: the api mints a per-run RPC token that the runner authenticates, so deploying the image first guarantees every live machine already carries the IPv6 egress containment and can accept the token by the time the api starts sending it.
>
> **Run output files in the bucket.** On this runtime a run's output files are uploaded to `S3_BUCKET` under `_runs/<run_id>/`, and the server deletes them once `FILES_RETENTION_S` has passed (see the table above). It rebuilds their keys from the file names the run recorded and never lists the bucket, so it deletes only what the database knows about — not what an upload that failed half-way left behind, not the files of a run whose completion was never recorded, not an object that a write cut by the upload's time budget stored when deleting it right after failed (logged as `outputs_interrupted_object_left`), and not a file whose name it will not act on (one with a `.` or `..` segment, for instance, which it logs) — a name the upload refuses too, with the same rule, so it writes none. A lifecycle rule on the `_runs/` prefix is the floor for those, and it is **your decision** — the server never sets one. No namespace can start with `_`, so a rule scoped to that prefix never reaches a bundle. Each pass handles a bounded number of runs, oldest deadline first, so a backlog after a long stop drains over several passes. The file names and sizes stay in the run's history once the objects are gone. Objects that earlier versions wrote under `runs/<run_id>/…` are not deleted either: delete them by hand, and only keys of the form `runs/<uuid>/outputs/…` or `runs/<uuid>/outputs.tar.gz` — never a bundle key, which has exactly three segments and ends in `.agent`.
>
> **What the server takes from a run's sandbox.** It reads every answer of the sandbox within a bound of bytes and of time, and follows no redirect. **Output files**: with each run, the server sends the sandbox its `FILES_MAX_SIZE_MB` and `FILES_MAX_COUNT`; the sandbox lists only the files within them, and the server applies the same limits again to what it lists — its own code, not the agent's, decides what is kept (see [Output files](api.md#output-files)). It then reads the kept files one after the other, each into a buffer the size of `FILES_MAX_SIZE_MB` — reserved first on a budget of **256 MiB per server process**, shared by every run: past it, an upload waits for room rather than failing (25 files read at once at the default limit; with a limit above 256 MiB, one at a time — and a buffer that large for each file). The upload of a run's files has **120 seconds**: past them, the file under way and those after it are left out, and the run completes with the files already stored. The run fails — `EXECUTION_FAILED`, `The run's output files could not be stored.` — only when the sandbox's file list cannot be read (an error, past 30 seconds, past its bound — 1 MiB at the default limits —, or not in its shape), or when a write to `S3_BUCKET` or the signing of a link fails before those 120 seconds are spent. Across an upgrade, a sandbox image from before this version lists every file, and the server still keeps the run's files within the limits; a server from before it sends no limits, and this version's sandbox applies the defaults. Roll out the sandbox image first all the same (above): the runner of earlier images can stop after serving an output file, and the server then reads none of the files after it (`pull_failed`). An upload logs a `warn` line for what it leaves out: `outputs_file_excluded` (the file's position in the list, its size, the reason) — at most `FILES_MAX_COUNT` of them, then one `outputs_files_excluded_unlogged` that counts the rest by reason, since the list is the sandbox's to write —, `files_count_exceeded`, `outputs_runner_excluded` (the counts the sandbox reports), `outputs_upload_budget_exhausted` (the step it stopped at). One that ends with the run's files then logs one `info` line `"event":"outputs_uploaded"` — files, bytes, the count left out, the duration. One that fails the run logs no such line: the run's `error` line, `"event":"run_failed"`, gives `"error_name":"OutputsUploadError"`, the step that failed as `error_code` — `outputs_list`, `outputs_reserve`, `outputs_put` or `outputs_presign` — and the class of the error that step failed with as `cause_name`, never its message, which can quote a file's key. None of these lines names a file. **Tool results**: the sandbox cuts a tool's result — a script's or an MCP server's — to 1 MiB, and the model reads a marker at the end of it (see [agent-yaml → tools](agent-yaml.md#tools-optional)); the server refuses a larger answer, which the model then reads as a failed tool call. On either runtime, a run keeps at most 8 MiB of tool results in all, and a result that would pass that sum reaches the model as a marker instead (same section). The `info` line `"event":"tool_result"` the server writes for each tool call says, in `kept`, what the run kept of its result — `whole`, `cut` (by the sandbox, or by the server on `local`) or `replaced` by that marker —, never the result itself. A local (`stdio`) MCP server's message larger than 10 MiB is not cut: on both runtimes its connection closes, every call waiting on it fails with an error that names the limit and is not retried — the tool may already have run —, and a `warn` line `"event":"mcp_message_too_large"` says so (the server's name, the limit, the error's class, never the message), written by the sandbox on this runtime and by the server itself on `local`. The failed call returns once the MCP server has been started again. One that does not start — a `warn` line `"event":"mcp_connect_failed"` or `"event":"mcp_connect_timeout"` says why — leaves the run's later calls to it failing with `MCP server not connected` (on `local`, the next run starts it again); on this runtime, one slow to start can hold the call past the server's wait for the sandbox's answer, and the model then reads that the call timed out, not the limit. A remote MCP server has no such limit.
>
> **What a burst of cold runs waits for.** A server creates the machines of its runs and of its pre-warm pool in the runners app (`SKRUN_RUNNERS_APP`) at the rate Fly documents for an app: at most 3 at once, then 1 per second. It lists that app's machines at the same rate, counted apart. A burst of N cold runs therefore waits up to N − 3 seconds more for its last machine, and that wait is part of the run's `create_api_ms` phase (see the `runner_spawned` event in the API reference). Each server process keeps that rate for itself: two or more servers creating in the same runners app share Fly's budget without knowing it, and Fly refuses the excess. A refusal (HTTP 429) is waited out — as long as Fly asks, capped at 10 seconds, or 1, 2, 4 then 8 seconds — up to four times, and each one is logged as a `warn` line with `"event":"fly_api_rate_limited"` (the action, the attempt, the wait — never Fly's answer). Seeing that line means more is created or listed in that app than it allows — most often by more than one server.
>
> **How long a run waits for its machine.** A run has one budget to get its machine ready — waking a pooled one, creating its own when none serves, up to the machine's answer to the run's `/init`: the longest the server waits on a creation at Fly's rate (its slot, Fly's refusals, the searches by label), the boot budget (90 s) and the wait for `/init` (300 s). Without `SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS`, that is 513 seconds — 123 s for the creation, counted for Fly's burst of 3 at once. With it, the server may be asked for as many creations at once as the cap lets it hold runs — plus one when a pre-warm pool runs, whose refill creates one machine at a time —, and each one beyond 3 waits a second more for its slot: the budget grows by that much, 530 seconds for a cap of 20, 531 with a pool. A burst's wait for its slot (above) is spent from it. Past it, the call under way is cut, a machine already made is destroyed, and the run fails `MACHINE_SPAWN_FAILED` — `The machine for this run was not ready within its acquisition budget (513s).`, the budget it had. A caller who disconnects, or a stop of the server, ends the wait the same way, at once. The pool's claims and the cold path share the budget: two slow claims can spend it before the run creates its own machine. No variable sets it directly. The same budget, plus two minutes for the outputs upload, is how long past its `timeout` a run's place stays held when its server dies before writing its end (see [Quotas per plan](#quotas-per-plan)).
>
> **The label on every machine.** Every machine a server creates carries a label in its metadata (`config.metadata`, which the Machines API returns and filters on): `skrun_run_id=<run id>` on a run's machine, `skrun_pool_id=<pool id>` on a pooled one, which carries no value of a run until one is assigned to it: once its runner has answered the assignment, the server writes on it, in the background, the run's label and the end of its life (`skrun_lifetime_end`, an instant), which the [machine maintenance](#machine-maintenance-cloud-runtime) judges it on — the two are written apart, a write that fails on a machine still in service is logged `pool_metadata_write_failed` (`warn`) — one that fails once the server has asked for the machine's destruction (its `/init` failed, or its run ended) is no labelling failure, a `debug` line `pool_metadata_write_moot` —, and a machine that lacks either is judged by the pool's reconciliation as one that carries none, and on the key it does carry as below. The label is how a creation whose outcome is unknown — the connection cut once the request left, a response that never came, a `408` or `5xx` from Fly — is found again rather than doubled: the server looks for the machine by its label, five times a second apart — a read Fly answers with a `5xx` or a `408`, or that the network cuts, is read again, three times at most, and a search that still fails fails the creation without sending anything again, destroying any machine of its label it saw on the way —, and adopts it when it is on its way to running; a machine found in another state (stopped, failed, …) is destroyed and the run fails, and one already being destroyed counts as none. Only when none appears is the creation sent once more, never a third time. A request that provably never reached Fly — connection refused, host not resolved, connection timed out — is simply sent again, three times at most. If that second request crosses a first one still in flight, Fly can make two machines with the same name and label: a run whose creation was sent twice destroys every machine of its label when it ends, or when its start fails, and a pre-warm pool's refill destroys every machine of its own label but the one it keeps, when the refill ends, ready or failed. That cleanup is one listing, best effort: if it fails, it is logged (`duplicate_search_failed` for a run, `pool_duplicate_search_failed` for a refill) and the second machine stays until it is reclaimed — a pooled one by the pool, once abandoned; a run's one, which carries the run's name and label, by the machine maintenance a grace after the run's end (see [Machine maintenance](#machine-maintenance-cloud-runtime)).
>
> **A creation cut mid-flight** — by the run's budget, its caller or a stop — may still have made a machine. Once the run's error is out, the server looks for it by its label in the background: a read every second, at least five and until one leaves 10 seconds after the creation's last request was sent — a creation sent a second time makes its machine with that one —, fifteen at most, each read and each destruction cut at 10 seconds — 75 seconds at most. It destroys every machine of the run it finds, and logs `"event":"abandoned_create_cleanup"` with the counts found and destroyed. It is best effort: a stop of the server waits for it only within its 20 seconds (see [Stopping the server](#stopping-the-server)), a search that fails is logged as `abandoned_create_cleanup_failed`, and a machine it missed — named and labelled for the run — is destroyed by the machine maintenance a grace after the run's end (see [Machine maintenance](#machine-maintenance-cloud-runtime)).

> **Upgrading to 2.0.0 empties agent state.** The table that holds agents' state notebooks takes a new shape — one notebook per caller, deleted with its agent — and starts empty: on Postgres, migration `019` applies at boot; on SQLite, the server recreates the table when it opens the file. To keep a copy, export it before upgrading (`SELECT * FROM agent_state`).
>
> **Several instances on one Postgres database: upgrade them all together.** Once one 2.0.0 instance has applied `019`, an instance still on 1.x fails every run of a stateful agent: its state read passes the agent's name where the table now holds the agent's id, and Postgres refuses it (`22P02`, invalid input syntax for type uuid).

> **Upgrading from a previous version?** See [`CHANGELOG.md`](../CHANGELOG.md) for breaking changes and one-shot migration steps.

### Scan agent directory

```
GET /api/agents/scan
```

Lists the agent directories — each a subdirectory holding an `agent.yaml` — found one level under the directory configured by the `SKRUN_AGENTS_DIR` env var. The directory is the server's disk: listing it takes a full-access credential — a session, `dev-token`, or an account-wide key with all three operations; any other key gets `403 KEY_SCOPE_FORBIDDEN`. The answer names no path of the server: each `path` is relative to the configured directory — the agent's directory name.

**Response** `200`
```json
{
  "configured": true,
  "agents": [
    { "name": "email-drafter", "path": "email-drafter", "registered": false },
    { "name": "code-review", "path": "code-review", "registered": true }
  ]
}
```

`registered` says whether the caller's namespace already holds an agent of that name. If `SKRUN_AGENTS_DIR` is not set: `{ "configured": false, "agents": [] }`. If it names a directory that does not exist: `{ "configured": true, "agents": [], "error": "Directory not found: the configured agents directory" }` — the configured value is not repeated.

**Response** `403` — `KEY_SCOPE_FORBIDDEN`: the key does not carry full access.

### Push scanned agent

```
POST /api/agents/scan/:name/push
```

Reads agent files from the scanned directory and registers the agent under the authenticated user's namespace. Version is read from `agent.yaml`.

Building from the server's agents directory takes full access, like the scan: a session, `dev-token`, or an account-wide key with all three operations. Any other key gets `403 KEY_SCOPE_FORBIDDEN` before anything is read — the same answer whatever the name, and whether or not `SKRUN_AGENTS_DIR` is set.

**Response** `200` — agent metadata (same format as push).

**Response** `400` — `NOT_CONFIGURED` (`SKRUN_AGENTS_DIR` is not set), `INVALID_AGENT_NAME`, or `INVALID_AGENT` (the directory holds no `agent.yaml`); or, as for a [push](api.md#push-an-agent), `INVALID_VERSION_FORMAT` (the version read from the raw text of `agent.yaml` — the first `version:`, up to a quote or the end of its line — is not strict semver: an unquoted version followed by a comment is), `BUNDLE_CORRUPT` (a file whose path in the bundle passes 1,024 bytes, or one of whose names passes 255 bytes), `MISSING_CONFIG` (an empty `agent.yaml`) or `INVALID_CONFIG` (one that is not YAML, or that the schema refuses — or that takes the server longer than 2 seconds to read, the message saying it is too complex to read); then `INVALID_CONFIG` for a configuration that holds U+0000 or a lone surrogate, the field named; then `MODEL_BASE_URL_REQUIRED`, `UNSUPPORTED_FIELD` or `TIMEOUT_OUT_OF_RANGE` — a setting no code honours, or a timeout no timer can hold, refused whatever bounds the server sets —, then `TIMEOUT_ABOVE_LIMIT`.

**Response** `403` — `KEY_SCOPE_FORBIDDEN`: the key does not carry full access.

**Response** `413` — as for a [push](api.md#push-an-agent): `BUNDLE_DECOMPRESSED_TOO_LARGE`, the bundle built from the directory unpacks past `BUNDLE_MAX_DECOMPRESSED_MB`; `CONFIG_TOO_LARGE`, its `agent.yaml` weighs more than 128 KB; `STORAGE_QUOTA_EXCEEDED`: this build is held to the account's bundle storage too.

**Response** `404` — `NOT_FOUND`: no directory of that name.

**Response** `503` — `PUSH_BUSY`, as for a [push](api.md#push-an-agent): the server already has as many `agent.yaml` reads waiting as it lets a push wait behind; nothing is stored, and `Retry-After` says when to send it again.

### Runtime selection (`SKRUN_RUNTIME`)

Skrun supports two runtime modes for executing `POST /run`. The server reads `SKRUN_RUNTIME` at startup and picks one for the lifetime of the process; runs cannot mix modes within a single instance.

| `SKRUN_RUNTIME` | Behaviour | Use case |
|-----------------|-----------|----------|
| `local` (default) | The agent loop runs in the same Node process that received the request. Tool calls (script + MCP) execute as in-process subprocesses. | Self-host single-tenant, local dev. |
| `flyio` | Each run spawns a dedicated Fly.io machine from a hardened sandbox image. The harness drives the LLM loop; tool calls are forwarded to the machine over a private network. The machine is destroyed after the run completes (or the SSE connection closes); one its server could not destroy is destroyed by the machine maintenance of a server on the same database (see *Machine maintenance* [below](#machine-maintenance-cloud-runtime)). | Multi-tenant cloud (`skrun.sh`). |

In cloud mode the server requires **six** variables and refuses to start if any one of them is missing — the error names every absent variable at once:

| Variable | What it is |
|----------|------------|
| `FLY_API_TOKEN` | Fly deploy token scoped to the runners app |
| `SKRUN_RUNNERS_APP` | The app where per-run machines are spawned — deliberately **not** named `FLY_APP_NAME`, because Fly injects that name into every running machine as *its own* app, which would silently override a value pointing at the runners app |
| `RUNTIME_IMAGE_TAG` | The sandbox image to spawn. No silent `:latest` default — an unpublished tag would otherwise fail at machine-create instead of at boot |
| `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY` · `S3_BUCKET` | S3-compatible storage for bundles + outputs (`S3_ENDPOINT` / `S3_REGION` / `S3_ACCOUNT_ID` are optional) |

The hardened sandbox image hosts every agent run with no model, database or storage credential. What the machine receives is what its runner needs: the bundle download URL and the outputs upload URL (both presigned and short-lived), the configured `allowed_hosts`, the hosts the runner itself must reach (the object store and the package registries scripts' dependencies install from), its port and time limit, and a per-run token with which it checks that requests come from this server. The LLM API keys live in the harness only. See [.env.example](../.env.example) for the cloud variable list.

If you self-host with Docker Compose, the default `SKRUN_RUNTIME=local` is what you want — the included `docker-compose` stack (API + Postgres + MinIO + Redis + Caddy) gives you prod-parity without per-run machine cost. Cloud mode shines when you need strong per-run isolation between multiple tenants.

### Machine maintenance (cloud runtime)

On the cloud runtime (`SKRUN_RUNTIME=flyio`) every server runs a machine maintenance, whatever the pre-warm pool's size — `0`, the default, included: a pass when it starts, then one a minute, each listing the machines of the runners app once. It is what destroys a machine its own server could not: a destruction that failed, a server killed or asleep before it ended its runs, a creation whose machine nobody was left to look for. A run's machine — one created for the run, or a pooled one assigned to it — has three guardians: the run that asked for it, which destroys it as it ends; this maintenance, which judges it on the run's row; and the machine itself, which ends at its lifetime (below) whether a server runs or not.

**A run's machine is judged on its run's row.** Each pass reads, in the database this server uses, the run of every machine named `skrun-run-<run id>` — the run named by its label (`skrun_run_id`), or by its name —, and of every pooled machine that carries the label of the run it was assigned to (see *The label on every machine* above). The machine is destroyed once its run ended more than a grace ago — five minutes —, or, for a run still `running`, once the deadline of its place passed more than a grace ago (see [What counts](#quotas-per-plan)): a run in progress before its deadline keeps its machine, whichever server serves it. A machine younger than a run's acquisition budget (see *How long a run waits for its machine* above) is not read: its run may still be getting it — a pooled one is aged from its last update on the platform, which the writing of its label moved to its assignment: its creation dates only its stocking. A run whose row is absent, or does not say its end or its deadline, has its machine destroyed only past the lifetime that machine declares, plus the grace (below) — a pooled one past the end of life it declares, plus the grace, and, declaring none, never: its age says nothing of its run. **A row that cannot be read spares its machine**: a database fault is never taken for a run that does not exist. Each pass logs every destruction, `"event":"run_machine_swept"` with the run, the machine, its state and the reason (`finished`, `deadline`, `no_row`, `no_deadline`); every row it could not read, `run_machine_sweep_read_failed` (`warn`, the error's class); every destruction that failed, `run_machine_sweep_destroy_failed` (`warn`).

**The lifetime a run's machine declares.** Every machine created for a run carries `RUNNER_LIFETIME_S` in its environment, in whole seconds: how long its run's place is held — the run's `timeout`, plus the acquisition budget and two minutes — plus the grace. It is read from outside the machine — by the maintenance, for a machine whose run's row cannot judge it, and by [`skrun admin cleanup-machines`](#skrun-admin-cleanup-machines), which reads no row — and inside it (below). A machine that declares none — made by a server of an earlier version — is judged by the maintenance, when its run's row cannot judge it, on the lifetime a run of the default `timeout` gets: 1,233 seconds; the command leaves it, unless you give it an age. A server of an earlier version records no deadline in its runs' rows either, so the maintenance judges the machine of such a run still in progress on those 1,233 seconds alone: while such a server still serves runs next to this version — on one database —, a run of it that lasts longer loses its machine. Upgrade every server of a database together (see above). A pooled machine carries none in its environment: it is handed its lifetime when it is assigned to a run, counted from then, and declares its end in its metadata (see *The label on every machine* above); until then the pool's reconciliation judges it (see *Pre-warm pool* below).

**The machine ends itself at its lifetime.** The root loop that keeps the machine's firewall rules arms the lifetime when a machine created for a run starts, or, for a pooled one, when it is assigned, and starts the machine's guardian: a root process of its own, which starts no other process from then on and is out of reach of the agent's code, running as another user — a process table that code has filled does not stop it, nor do hosts slow to resolve. It logs `lifetime_guardian` with its process, the runner's, and its `oom_score_adj` — `-1000`, out of the out-of-memory killer's reach, where the machine lets root lower it. The guardian checks the deadline against the machine's uptime every second; once it has passed, it sends the runner `TERM`, then `KILL` if it is still there 15 seconds later — a frozen runner never handles `TERM` —, and logs `lifetime_reached` (and `lifetime_kill` for the second). A lifetime the loop cannot read arms nothing, and it logs `lifetime_invalid`; one it cannot arm — the machine's uptime unreadable, or a guardian it could not start — arms nothing either, and it logs `lifetime_unarmed` with the reason (`uptime-unreadable`, `guardian-unstarted`). The machine stops, and the platform destroys it: every runner machine is created with `auto_destroy`, so **a runner machine is destroyed once its process exits** — its run's end, its lifetime, a crash. An operator's gesture is no exception: `flyctl machine stop` or `flyctl machine restart` of a running runner machine destroys it. A pooled machine's pause, its wake, and the cold start the platform makes of a paused machine it stopped are not exits; a machine created and never started has no process to exit, and the maintenance judges it like any other. So a machine nobody destroys — its server killed or asleep, no maintenance running on its database — still ends at its lifetime, some 15 seconds past it for a runner that ignores `TERM`. A runner image from before this version arms nothing.

**Each pass is bounded, and one runs at a time.** Its listing, the pool's reconciliation and retirements, and this sweep share 10 minutes: past them, what is in flight is cut, the rest waits for the next pass, and a `warn` line `pool_pass_cut` says so. A pass that finds the previous one still at that work skips it, and logs `pool_pass_skipped`; the pool's refill has a bound of its own (see *Pre-warm pool* below). A destruction Fly answers `404` counts as done (`machine_already_gone`, `info`): two servers, or a server and a run, may ask for the same one. What each pass did is counted in [`GET /api/admin/pool`](#pre-warm-pool-status-admin-only).

**One runners app per database.** The maintenance takes every machine of `SKRUN_RUNNERS_APP` for one of its own deployment's, and judges it on its own database. Servers that share a runners app must share one database: a server pointed at another one finds no row for the other deployment's runs, judges their machines on their lifetime alone, and treats the other deployment's pooled machines as a stock its own deployment left. Give each deployment its own runners app.

#### skrun admin

Operational commands for cloud-runtime operators. Not used by agent authors — these talk to the Fly.io Machines API directly, so they need the same Fly credentials your API server uses: `FLY_API_TOKEN` and `SKRUN_RUNNERS_APP` (the app where per-run machines are spawned).

The app name resolves in this order: **`--app`** → **`SKRUN_RUNNERS_APP`** → **`FLY_APP_NAME`**.

> ⚠️ **Prefer `--app` or `SKRUN_RUNNERS_APP`; `FLY_APP_NAME` is a fallback with a trap.** Inside a Fly machine, Fly sets `FLY_APP_NAME` to *that machine's own* app — so a cleanup scheduled there (see the cron pattern below) would sweep the app it runs in rather than your runners app, find no sandbox machines, and report a perfectly healthy `scanned=0 cleaned=0`. The command warns when it falls back to `FLY_APP_NAME`, and every run names the app it swept in the `PASS` line, so a zero count can be told apart from a wrong target.

#### skrun admin cleanup-machines

Reap orphan sandbox machines. Each `POST /run` in cloud mode spawns a dedicated Fly.io machine; the run destroys it as it ends, and the server's machine maintenance destroys one whose server could not (see [Machine maintenance](#machine-maintenance-cloud-runtime)). While a server runs, its maintenance already does this command's work; the command is for when none runs on the runners app — a deployment taken down, a server that will not start — or for a pass of your own: it lists the machines matching the `skrun-run-*` naming convention and destroys each one past the lifetime it declares.

**What it judges on.** The command reads the platform's listing of machines, never the runs: it cannot tell whether a run is on a machine. So, without `--older-than`, it destroys only a machine whose listing shows no run can be on it, and names, without destroying it, one it cannot judge. A run's machine carries its lifetime in its environment (`RUNNER_LIFETIME_S`): how long its run's place is held, plus a grace. The command destroys it once it is older than that lifetime plus the grace again — five minutes —: a run still in flight is within it, since a server stops a run at the deadline of its place. A machine that declares none was made by a server of an earlier version, which may still be serving a run on it: the command leaves it, at any age, and says so (see *Output*). While a server of this version runs on the same database, its machine maintenance — which reads the runs — judges such a machine on its run's row; when none runs, the decision is yours, and `--older-than` is how you make it. There is no fixed age: `--older-than` replaces what the listing shows only when you give it. A machine the command would judge on a time its listing does not give is never destroyed, `--older-than` or not: it is named and left.

```bash
skrun admin cleanup-machines --dry-run          # preview only — no destroy call
skrun admin cleanup-machines                    # each machine past the lifetime it declares
skrun admin cleanup-machines --older-than 1800  # every machine older than 30 minutes, whatever it declares
```

**Options:**
| Flag | Description |
|------|-------------|
| `--dry-run` | Print what would be destroyed without calling the destroy API. Sending no destruction, it cannot know how one would end: a machine the platform would refuse to destroy — spared — or fail to destroy is printed `[dry-run] would destroy` and counted in `cleaned=` too. |
| `--older-than <seconds>` | Judge on this age what the listing alone does not settle: a per-run machine older than it is destroyed, whatever it declares — one of a run still in flight included —; under `--include-pool`, a pre-created one never started once created that long ago, and a started one once untouched 4 times as long, whatever end of life it declares. Unset — the default — no age replaces what the listing shows: one it cannot judge is named and left. |
| `--app <name>` | The runners app to sweep. Overrides `SKRUN_RUNNERS_APP` / `FLY_APP_NAME` — use it wherever the environment sets an app name you don't control. |
| `--token <token>` | Fly.io deploy token. Overrides `FLY_API_TOKEN`. |
| `--include-pool` | Also destroy pre-created machines. **Off by default** — see below. For taking a deployment down for good. |

**Pre-created machines are left alone.** If the server keeps a pool of machines ready in advance, those (`skrun-pool-*`) are **not** touched by this command, at any age. They are live stock: the server that created them holds the only record of which are spoken for, and the servers' machine maintenance reclaims the ones nobody holds (see [Pre-warm pool](#pre-warm-pool-cloud-runtime-optional)). Age says nothing here — a pooled machine is old by design, because its creation time is when the pool was stocked, not when a run touched it.

Pass `--include-pool` only when you are decommissioning a deployment and want nothing left behind. It judges each pooled machine on what the platform lists — its state, and for a started one the end of life it declares: **suspended, stopped or failed** — no run is on it — at any age, destroyed only if still not running when the command gets to it: the platform refuses to destroy one its server woke for a run since the listing, and the command spares it — or, when it cannot read the refusal's reason, fails it and says so (see *Output*); **never started** (`created`) — the platform destroys it only with force, and the server that made it may be starting it — only when you give `--older-than`, once created that long ago; and **started** — it may be serving a run. One a server assigned to a run declares the end of its life, which that server writes on it once its runner has answered (see [Machine maintenance](#machine-maintenance-cloud-runtime)): past that end plus the grace — five minutes —, no run can still be on it, and it is destroyed, with force; within it, it is counted `within it`. One that declares none — still in stock, or its end never written — the listing cannot judge: it goes only when you give `--older-than`, once untouched on the platform — since its wake, for one serving a run — for 4 times that age. Given, `--older-than` judges every started one that way, whatever end it declares, so a run on it that has lasted that long is cut. Without `--older-than`, a never-started one, and a started one that declares no end, are named and left; one in any other state — between two states, a terminal one, or one the client does not know — is named and left either way.

**Safe by default**: without `--older-than`, the command destroys only a machine whose listing shows no run can be on it, and names every machine it leaves; only machines matching `skrun-run-*` (and `skrun-pool-*` under `--include-pool`) are eligible — the API server itself and any non-Skrun apps in the Fly account are untouched —; and a single destroy failure does NOT abort the loop (best-effort).

**Output**: the command prints the criterion it judged on, a line per machine it leaves and per machine it destroys — or would, with `--dry-run` —, and ends with a machine-readable PASS line for CI / cron scripts. Each machine it lists under its two name prefixes (`skrun-run-`, `skrun-pool-`) ends in exactly one place — a machine named under neither is not looked at, nor counted in `scanned=` —: destroyed — counted in `cleaned=` —, spared, failed, left — counted in `left=` —, not yet past its time, which the summary line of its kind counts (`within it`, the lifetime or the end of life it declares; `younger`, than `--older-than`), or, without `--include-pool`, a pre-created one, left alone without being judged — counted in its summary line (`Found <n> pre-created machine(s); left alone …`) and in `scanned=`, never in `left=`. A machine it leaves prints a `left` line that says why: `left <id> (name=…, state=…, age=…s): declares no lifetime — this command does not read the runs and cannot tell whether one is on it; pass --older-than to judge it on its age`; for a pre-created one, `started and declaring no end of life, it may be serving a run` (with `idle=…s`) or `never started — the platform destroys it only with force` …; `its listing gives no time to judge it on`; or, for a pre-created one, `a state this command does not act on`. A destruction that fails prints `FAILED to destroy <id> (name=…): <error>` — the status the platform answered and its answer, or why none came —, and the command goes on to the next machine; for a machine listed not running that the platform refused (`412`) without a reason the command reads — a `412` it did not read as a refusal in the machine's state: its body never read, or another text —, the line adds `refused without a reason this command reads: woken since it was listed, it may be serving a run; check it before destroying it by hand`. Under `--include-pool`, a machine listed not running that the platform refused to destroy in its current state — the refusal read — prints `spared <id> (name=…, state=…, idle=…s): the platform refused to destroy it in its current state — woken since it was listed, it may be serving a run`. A machine left, spared or failed is not counted in `cleaned=`.

```text
Found 4 runner machine(s); 2 past the lifetime it declares plus a grace of 300s, 1 within it, 1 left — without --older-than this command destroys only a machine its listing shows no run can be on: it does not read the runs.
left 3d8e0f12a7b9c4 (name=skrun-run-old, state=started, age=5400s): declares no lifetime — this command does not read the runs and cannot tell whether one is on it; pass --older-than to judge it on its age
destroyed e286037be1d128 (name=skrun-run-abc, state=started, idle=1874s)
destroyed 91e7d62c34a3d6 (name=skrun-run-xyz, state=stopped, idle=2905s)
PASS cleanup-machines: scanned=4 cleaned=2 left=1 app=my-runners
```

A machine counted in `left=` bills until a server's machine maintenance judges it done, a run of the command takes it — with `--older-than`, for one it judges only on an age; once it has left that state, for one in a state it does not act on —, or you destroy it yourself: a script that reads only the `PASS` line can alert on it.

**Operator pattern**: it can run on a schedule — a periodic cron, or a Fly machine on a 5-minute interval: without `--older-than` it destroys only a machine whose listing shows no run can be on it. While a server runs, its maintenance already passes every minute, and judges what the command leaves on what it reads: a schedule is a second net, and the one left when no server runs — then a `left=` above 0 is a decision for you.

```bash
# crontab(5) example — every 5 minutes
*/5 * * * * skrun admin cleanup-machines >> /var/log/skrun-cleanup.log 2>&1
```

With no credentials at all the command refuses to run and names what is missing. That guard catches an **absent** app name, never a **wrong** one — which is why the `PASS` line carries `app=`: check it matches your runners app the first time you wire the cron up, and a later `scanned=0` means what it says.

### Pre-warm pool (cloud runtime, optional)

Building a sandbox machine takes most of a minute, and nearly all of it is the host pulling the image and the runner starting up. A pre-warm pool pays that in the background instead: the server keeps a few machines built, booted and paused, and a run wakes one. Measured on our own cloud, that is the difference between a caller waiting **~53 s** and **~1.3 s** before the agent starts.

**It is off by default** (`SKRUN_RUNNER_POOL_SIZE=0`): the server keeps no machine in advance, and every run builds its own, as it always has. The [machine maintenance](#machine-maintenance-cloud-runtime) runs all the same, at any size.

```bash
SKRUN_RUNNER_POOL_SIZE=3      # keep three machines ready
```

**Nothing about isolation changes.** A pooled machine is built blank — no agent bundle, no run credential, no agent network rules — and it serves **exactly one run**, then is destroyed like any other. A stock of never-used machines is not a stock of recycled ones: no run ever inherits anything from another.

**Choosing a depth.** The pool answers a burst of size N and then refills, one machine at a time, taking about a minute each. A run arriving when the pool is empty is not an error — it builds its own machine, exactly as with the pool off, and completes normally, even while the pool is building one of its own at the same moment: each creation is a request of its own and gets a machine of its own. The refill takes its creations from the same rate as the runs (see *What a burst of cold runs waits for* above). So the depth to pick is roughly "how many runs might arrive close together before the pool can restock", and the cost of guessing low is slower runs, never failed ones.

**Cost.** Pooled machines are paused, not running. Fly documents that a suspended machine costs what a stopped one does — storage only, no CPU or RAM —, without saying whether the memory snapshot it holds counts in that storage: confirm the total on your invoice. What the server guarantees is the **count**: never more than the configured depth once each refill has ended — a refill whose creation had to be sent twice destroys the second machine Fly may have made (see *The label on every machine* above) —, except when that cleanup cannot destroy the second machine, its search or the destruction failing: that is logged, and the second machine runs until the pool reclaims it as abandoned, once untouched for the window below. Each machine serves one run and is destroyed. A machine the pool retires — below — is replaced by a full boot that serves no run.

**A ready machine expires.** One that no run has taken six hours after the server made it is destroyed and replaced, and counted in `drains`.

**What the pool reclaims.** Each pass of the maintenance also judges the pooled machines this server does not hold — another API machine's, or those a stopped server left — on what the platform lists, never on "this server does not know it": another API machine may be using one. One that carries both the label of the run it was assigned to and the end of its life is not among them, whatever its state: the sweep judges it on that run's row (see [Machine maintenance](#machine-maintenance-cloud-runtime)). A machine listed as not running — paused, stopped, failed, or never started — is destroyed once untouched for six hours, and at the first pass already when it was created before this server started and either the pool is parked at 0 or the machine was built from another image than this server's. The listing is old by the time each destruction is sent, and another API machine may wake one of these for a run in between, so the server asks the platform to destroy it only if it is still not running: one listed paused, stopped or failed that the platform refuses — woken since — is spared, logged `pool_orphan_spared` (`info`), unless the server could not read the refusal's reason — a `412` it did not read as a refusal in the machine's state: its body never read, or another text —: then it is a failed destruction, whose `pool_destroy_failed` line says to check the machine before destroying it by hand; one listed as never started, which the platform does not destroy that way, is destroyed only once created longer ago than a refill can hold a machine (see *A refill is bounded* below) — no refill can start it any more —, and left to a later pass until then. Only what the platform destroyed is counted. A running one that lacks either may still be serving another API machine's run — its label or its end not written yet, or a write that failed —: it is taken for abandoned only once untouched on the platform — for a machine serving a run, since its wake — for a window: 20 minutes, or, with `SKRUN_RUN_MAX_TIMEOUT_S` set and when it is longer, that timeout plus the margin of a run's place (the acquisition budget and two minutes) and the five-minute grace. A machine between two states is left to a later pass.

**Parking the pool at 0 empties it.** Set `SKRUN_RUNNER_POOL_SIZE=0` and restart: the stopping server destroys the ready machines it holds (see [Stopping the server](#stopping-the-server)), and the next one destroys, at its first pass, every pooled machine created before it started that is still not running — what a server killed without a stop left included; one never started, once a refill's bound is behind it (above). A pooled machine serving a run — one woken after the listing included — is left to that run: judged by the sweep on the run's row once it carries the run's label, and on the window of a running one until it carries its end too.

**A deploy replaces the stock.** At its first pass, a server destroys the pooled machines an earlier server built from another image — not running, created before it started, on the terms above —, each counted in `drains` once destroyed; a machine whose image the platform's listing does not give is left. Only the newer server acts: during a rolling deploy or a rollback, a server never touches the stock of one that started after it. So a deploy cannot serve runs on superseded code — including a deploy that *reverts* an image, which is what makes rollback boring: point `RUNTIME_IMAGE_TAG` back, and the stock built from the bad image goes at the next server's first pass while a new one fills. A `@sha256:` digest the listing adds to an image that `RUNTIME_IMAGE_TAG` names without one is set aside. Expect a short window after any deploy where runs take the cold path. After a deploy, `drains` moves only for a stock its own server did not destroy — a server killed or out of time at its stop, or one still running next to the new one: a server that stops cleanly destroys its ready machines itself (`pool_destroyed` in its `server_shutdown` line), and the next one finds nothing to replace.

**More than one API machine.** Each server holds only the machines it made. A paused one that another API machine wakes for a run after the listing is spared by the platform's refusal (above); a running one it does not hold is judged by the sweep on its run's row once it carries the run's label, whichever API machine serves it, and on the window above until it carries its end too. Without `SKRUN_RUN_MAX_TIMEOUT_S`, that window is 20 minutes: a run that lasts longer on a pooled machine another API machine woke, and whose label or end could not be written, is destroyed under it — its `pool_metadata_write_failed` line names the machine. With a pool and two or more API machines, set `SKRUN_RUN_MAX_TIMEOUT_S`.

**A refill is bounded.** The pool makes one machine at a time, each within one bound — its creation, its boot and its pause together, about 12 minutes at the defaults: a platform call that never answers is cut there, and a machine its cut creation may have made is looked for by its label in the background and destroyed. A failure that bound did not cut is cleaned up before the refill goes on — the machine it made destroyed, a second machine of its label looked for and destroyed —, each step cut at 10 seconds, three at most. A refill therefore holds one machine 753 seconds at most at the defaults, never longer.

**Watch it with `GET /api/admin/pool`** (admin only — see [Pre-warm pool status](#pre-warm-pool-status-admin-only) below for every counter). The number that matters is `hits` against `misses`: a pool that has silently stopped working still looks healthy from outside, because runs keep succeeding by falling back. A miss also counts a run that failed by its own fault at a pooled machine's `/init` — its bundle, an MCP server that refuses it —, which no machine could have served: its `spawn_failed` line names the step. `infraHostsChanged` above 0 says a paused machine woke with a rule gone stale (below).

**A paused machine's own hosts.** A pooled machine opens its firewall to what its runner needs — the object store, the package registries — when it boots, and nothing resolves those hosts again while it waits: a host whose address moves in the meantime is out of the machine's reach until the machine is replaced — a ready machine expires after six hours. Each assigned machine measures it: once the run's rules are in place, it resolves those hosts again, in the background, and says at its `/init` whether one moved. The server counts, in `GET /api/admin/pool`, the assigned machines that said so — `infraHostsChanged`: a host that now resolves to an address the machine's boot opened no rule for, one count per machine however many of its hosts moved — and those that had nothing to say — `infraHostsUnmeasured`: not measured yet, a host that resolved to nothing, or a runner image too old to measure —, and logs each machine that said so as a `warn` line, `pool_infra_hosts_changed`, with the run, the machine and where it was read (`ready`, or `init-rpc` for an `/init` that failed). No rule moves for it. What a stale rule costs: the run's bundle download waits on an address it cannot reach until its connection times out, and the run then takes the cold path; an install of the agent's dependencies from a registry that moved can fail. The counters start from zero at each restart; the log lines stay.

**Runs sent past the pool on purpose.** With `SKRUN_QUOTA_FAST_RUNS_PER_HOUR` set, a run past its account's fast runs of the hour takes the cold path without touching the pool — it takes no ready machine and asks for no refill — and creates its own machine, even while the pool is creating one of its own: two creations, two machines. Such runs are counted in `skipped`, never in `misses`: a pool that quotas send runs around is not a pool that fails to serve. See [Quotas per plan](#quotas-per-plan).

**Do not schedule `skrun admin cleanup-machines` against a live pool without reading its docs** — by default it now leaves pooled machines alone precisely because they are stock rather than waste, but the flag that sweeps them exists and would empty the pool.

**If your image tags are pruned on a schedule**, note that a pooled machine holds its image reference for hours rather than for one run. Pruning a tag underneath the pool does not disturb machines that already exist, but new ones stop being built — and because runs keep being served from the remaining stock, the first symptom is a slowly emptying pool rather than an error.

#### Pre-warm pool status (admin only)

```
GET /api/admin/pool
```

**Restricted to an admin on a full-access credential** (`users.role = 'admin'`, and a session, `dev-token`, or an account-wide key with all three operations). Anyone else — an admin's restricted or delegated key included — gets a `404` indistinguishable from a route that does not exist, matching the opaque reads used elsewhere.

The pool's state lives in the server's memory — there is no database row for it — so this endpoint is the only way to see it without reading platform logs. That matters more than it sounds: a pool that has quietly stopped working looks exactly like a healthy one from the outside, because runs keep succeeding by falling back to building their own machine. The counters are how you tell. They are this server process's, from its start: each API machine has its own, and a restart sets them back to zero.

**Response** `200` on the cloud runtime (`SKRUN_RUNTIME=flyio`), whatever the pool's size — `0` included, with `"enabled": false` and every counter:

```json
{
  "enabled": true,
  "size": 3,
  "filling": 0,
  "ready": 3,
  "claimed": 0,
  "draining": 0,
  "fillErrors": 0,
  "drains": 0,
  "orphansDestroyed": 0,
  "hits": 42,
  "misses": 1,
  "skipped": 5,
  "destroyFailures": 0,
  "skippedPasses": 0,
  "vanished": 0,
  "sweepPasses": 120,
  "sweepDestroyed": 0,
  "sweepReadFailures": 0,
  "infraHostsChanged": 0,
  "infraHostsUnmeasured": 0
}
```

**Response** `200` on the `local` runtime, which runs no pool and no machine: `{"enabled": false}`.

Reading it:

- **`enabled`** says whether the pool keeps a stock — `size` above 0. At 0 the machine maintenance still runs, and its counters still move.
- **`hits`**, **`misses`** and **`skipped`**: see *Watch it* and *Runs sent past the pool on purpose* [above](#pre-warm-pool-cloud-runtime-optional).
- **`ready: 0` with `fillErrors: 0`** and nothing else moving means the pool is not stocking at all, as opposed to failing to stock.
- **`fillErrors` climbing** means machines cannot be prepared — a bad image reference is the usual cause.
- **`drains`** counts the pooled machines retired for their age or their image, each once the platform destroyed it: a ready one of this server no run took within six hours; and, while the pool keeps a stock, a machine an earlier server left from another image. A destruction that fails is counted in `destroyFailures` instead. After a deploy it moves only for a stock its own server did not destroy — a server killed or out of time at its stop, or one still running next to this one: a server that stops cleanly destroys its ready machines itself, and its `server_shutdown` log line counts them.
- **`orphansDestroyed`** counts the other pooled machines this server did not hold that the pool reclaimed and the platform destroyed — see *What the pool reclaims* [above](#pre-warm-pool-cloud-runtime-optional). One the platform refused to destroy because another API machine woke it since the listing is spared, and counted nowhere — unless the server could not read the refusal's reason, counted then in `destroyFailures` (below).
- **`destroyFailures`** counts every destruction this server asked for that failed, whatever the machine — a run's or a pooled one — and whatever asked for it — a run, the pool, the sweep, the stop. Two kinds of destruction are not in it: those of the search that finds a creation whose outcome was unknown (see *The label on every machine* [above](#environment-variables-reference)), logged only; and a pooled machine listed as not running — paused, stopped or failed — that the platform refused to destroy because it was woken since the listing — spared on purpose, not a failure. A refusal whose reason the server could not read — a `412` it did not read as a refusal in the machine's state: its body never read, or another text — is counted, though: its `pool_destroy_failed` line says the machine may have been woken, to check before destroying it by hand. Each failure leaves a machine billing until a later pass of the maintenance takes it.
- **`skippedPasses`** counts the maintenance passes that found the previous one still at work, and skipped it. A rising count means a pass outlasts the minute between two.
- **`vanished`** counts the pooled machines this server held that the platform stopped listing without this server destroying them — counted once two listings in a row have missed one.
- **`sweepPasses`** counts the sweeps of the run machines: one per pass whose listing succeeded and that its bound had not already cut — a sweep the bound cuts midway is counted all the same. A sweep that fails is logged (`pool_sweep_failed`) and not counted. A count that stops moving while the server runs is a sweep that no longer runs: the listing failing, the passes cut before the sweep, or the sweep failing — read the log lines.
- **`sweepDestroyed`** counts the run machines the sweep destroyed — a run's own, or a pooled one assigned to a run, whose server could not. Above zero, read the `run_machine_swept` log lines: each gives the run and the reason.
- **`sweepReadFailures`** counts the run machines the sweep spared because their run's row could not be read — a fault of the database, never taken for a run that does not exist — or because the pass's bound cut that read.
- **`infraHostsChanged`** counts the pooled machines that reported, at a run's `/init`, a host of their own infrastructure — the object store, a package registry — resolving now to an address their boot opened no rule for: a rule gone stale while the machine was paused, which nothing resolves again. Each is also a `warn` log line, `pool_infra_hosts_changed`, with the run, the machine and `phase` — `ready` for a run the machine served, `init-rpc` for an `/init` that failed. No rule moves for it. See *A paused machine's own hosts* [above](#pre-warm-pool-cloud-runtime-optional).
- **`infraHostsUnmeasured`** counts the pooled machines that had nothing to say of those hosts at a run's `/init`: their measurement not written yet, a host that resolved to nothing, or a runner image too old to measure. An `/init` that got no answer is counted in neither, and a machine created for its run measures nothing.

---

## Quotas per plan

Eight variables bound what each account consumes and what the instance runs at once. **Each is off until you set it**: an instance that sets none behaves as one without quotas — no run, push or upload refused for them, no `X-Quota-*` header, nothing read before a run's record is written. They are read once, at startup: changing a value takes a restart (see [Stopping the server](#stopping-the-server) for what a restart does to the runs in progress). What a caller sees — the refusals, `Retry-After`, the account's numbers in headers — is in [API → Quotas](api.md#quotas).

| Variable | Bounds | Form | Over it |
|----------|--------|------|---------|
| `SKRUN_QUOTA_CONCURRENT_RUNS` | An account's runs in progress | Per plan, at least 1 | `429 CONCURRENCY_LIMIT_REACHED` |
| `SKRUN_QUOTA_COMPUTE_SECONDS` | An account's compute seconds per window | Per plan, at least 1; needs `SKRUN_QUOTA_WINDOW_S` | `429 COMPUTE_QUOTA_EXCEEDED` |
| `SKRUN_QUOTA_WINDOW_S` | The length of the compute window, in seconds | One number, at least 1, that divides a day (`86400`) | — |
| `SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS` | Runs in progress on the whole instance, every account together — and the runs of a `dev-token` whose account could not be recorded | One number, at least 1 | `503 CAPACITY_EXHAUSTED` |
| `SKRUN_RUN_MAX_TIMEOUT_S` | The longest `timeout` a run may declare, in seconds — in its agent or its `environment` override. An agent that declares none runs up to the 300 s default, so a value under 300 refuses every such agent. A push of an agent that declares more is refused too | One number, at least 1 | `400 TIMEOUT_ABOVE_LIMIT` |
| `SKRUN_QUOTA_FAST_RUNS_PER_HOUR` | An account's runs per rolling hour that may take a machine of the pre-warm pool — only while the pool runs | Per plan, at least 0 | Nothing is refused: the run builds its own machine |
| `SKRUN_QUOTA_STORAGE_MB` | The bundles an account's agents hold, every version, in MB of 1,048,576 bytes | Per plan, at least 1 | `413 STORAGE_QUOTA_EXCEEDED`, at the push |
| `SKRUN_QUOTA_INPUT_FILES` | An account's live uploads to `POST /api/files` — neither expired nor deleted | Per plan, at least 1 | `429 INPUT_FILES_LIMIT_REACHED` |

**Storage.** A push is checked against the account's storage before anything is stored — the bundles its agents hold, at the size each was pushed, plus this one: past the plan's value, no agent is created for it and no object written. The account makes room by deleting a version, or an agent. The check reads the account's bundles from the database at each push, and the account's pushes take turns in the server process, from the check for a version already pushed to the version's row: one process never lets an account past its storage. The turns are taken whether or not storage is bounded — they are also what answers the second of two pushes of one version at once `409 VERSION_EXISTS`, the version keeping the first one's bundle. Each process keeps its own turns: with N API instances, pushes of one account that reach different instances at the same moment can together go over by up to N − 1 bundles, and two pushes of one version can both pass the check for a version already pushed — one is answered `500`, and the version can be left with one push's checksum over the other's bundle, every pull and run of it refused `BUNDLE_INTEGRITY_FAILED` until it is deleted. The longest timeout is checked at the push as well — an agent published before you set it is refused when run.

**Live uploads.** An upload counts against its account from the moment it is stored until it expires (`INPUT_FILES_RETENTION_S`) or is deleted; with the plan's number live, the next one is refused before its body is read, told to wait until the oldest expires — or, for an account that holds more than its plan now allows (its plan lowered), until enough of them have. The count lives in the server process, as the uploads do — on its temp directory: an instance counts only the uploads it holds, so with several instances an account holds its number on each, and a restart, which loses every upload, starts the count again.

**Fast runs.** With a [pre-warm pool](#pre-warm-pool-cloud-runtime-optional) running, `SKRUN_QUOTA_FAST_RUNS_PER_HOUR` decides which runs may take one of its ready machines: a run admitted while fewer of its account's runs of the rolling hour hold that right than its plan gives. A run admitted while at least that many hold it is still admitted, as any other, and builds its own machine, as when the pool is empty — about a minute slower —, and the server logs an `info` line `"event":"run_cold_by_quota"` with the run, the account's internal id and the plan. The right is given when the run is admitted, and given back once the run's machine is ready if no pooled machine was taken for the run — the pool was empty, say; a pooled machine counts as taken once the run's handoff begins — its URLs signed, then its assignment, then its `/init` —, and one that would not wake or answer its health check does not. A run whose machine never got ready keeps its right spent. Only the runs that keep it count: at most the plan's number per rolling hour keep it — more only for an account whose plan or bound was lowered within the hour, until those runs leave it; with the pool empty, every run whose machine gets ready gives its right back. Unset, every run may take a pooled machine, as before; `0` keeps the pool for the other plans. A run that counts against no account always may. Without a pool — the local runtime, or `SKRUN_RUNNER_POOL_SIZE=0` — the variable does nothing: no right is given, no header sent, no line logged. An account reads its fast runs left, and when the next one comes back, in [`GET /api/usage`](api.md#usage).

**The per-plan form.** A comma-separated list of `plan=value` entries; a bare number is the value of `free`, the plan of every account that has none. `"2"`, `"free=2"` and `"2,pro=5"` all give `free` 2. Spaces around entries, names and values are ignored, as is an empty entry; a plan name is read in lower case and is made of `a-z`, `0-9` and `-`. Every list needs a value for `free`. Values are whole numbers. The windows are fixed and aligned on UTC: `21600` (6 hours) renews every account's compute at 00:00, 06:00, 12:00 and 18:00 UTC.

**What refuses the start.** A value the server cannot apply stops it, with a message that names the variable and the value it got — never a guess, never a bound silently off: a variable set but empty; a value that is not a whole number (a sign, a fraction, an exponent) or is under the minimum; a plan given twice — a bare number is `free`'s; an entry with no plan name, or no value; a plan name outside `a-z`, `0-9` and `-`; a list that names plans without a value for `free`; a `plan=value` entry in one of the variables that take one number; a window longer than a day, or that does not divide it; compute seconds without a window. Unset a variable to leave its bound off.

**Several plans.** To add a plan, add its key to each per-plan variable; no code change. A plan exists once a per-plan variable names it, and a plan a variable does not name gets that variable's `free` value. Three plans:

```bash
SKRUN_QUOTA_CONCURRENT_RUNS="free=2,pro=5,team=10"
SKRUN_QUOTA_COMPUTE_SECONDS="free=3600,pro=14400,team=43200"
SKRUN_QUOTA_WINDOW_S=21600
SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS=20
SKRUN_RUN_MAX_TIMEOUT_S=900
```

**Assigning a plan.** An account's plan is the `plan` column of `users` — `GET /api/me` returns it, and an account with none gets `free`'s thresholds. A `dev-token` caller always gets `free`'s, and `GET /api/me` says `free` to it: its requests carry no plan, even when its account has been assigned one — the plan applies to the account's sessions and API keys. An administrator with a full-access credential assigns it with [`PUT /api/admin/accounts/:id/plan`](#assign-an-accounts-plan-admin-only), which takes only a plan the server knows (`400 UNKNOWN_PLAN` otherwise, the known plans listed). Or in SQL:

```bash
# SQLite (default)
sqlite3 skrun.db "UPDATE users SET plan='pro' WHERE username='bob'"

# Postgres
psql $DATABASE_URL -c "UPDATE users SET plan='pro' WHERE username='bob';"
```

SQL takes any name: an account whose plan no variable names gets `free`'s thresholds — never none —, and, when the variables name plans of their own, each of its runs and pushes, each of its uploads while `SKRUN_QUOTA_INPUT_FILES` is set, and each read of its usage (`GET /api/usage`), logs a `warn` line `"event":"quota_plan_unknown"` with the plan and the account's internal id. Either way, the account's next request with a session or an API key reads the new plan: nothing caches it, and no restart is needed.

**What counts.** A run counts against the account of the credential that sends it, not the agent's owner. It holds its place from its admission to its final status — at the latest until its `timeout` plus a margin has passed: the cloud runtime's acquisition budget and two minutes, on both runtimes (see *How long a run waits for its machine* above). A run still in progress then is stopped by its server — its status written, `failed` with `DEADLINE_EXCEEDED`, its machine destroyed on the cloud runtime (see [API → Run an agent](api.md#run-an-agent)); a streamed run whose client stopped reading its events is the one that gets there, its stream closed ten seconds later. If its server dies before writing its status, the run holds its place until that deadline. Its compute time is its wall-clock time from admission to final status, in the window it was admitted in — while in progress, its time so far; a run stopped at its deadline is charged up to it; a run whose machine never got ready, or that the server's stop ended, is charged nothing, and so is a run still `running` past that deadline, whose server died or whose database failed as it ended: the account does not pay for the server's failure. Each refusal logs an `info` line `"event":"quota_refused"` with the account's internal id, the bound (`concurrency`, `compute`, `instance`, `busy` — the database did not answer the run's admission in time —, `max_timeout` — a `timeout` above `SKRUN_RUN_MAX_TIMEOUT_S`, at a run or a push —, `storage` — a push past the account's storage —, or `input_files` — an upload past its live uploads) and the plan.

**Choosing a compute quota.** The quota is checked when a run is admitted, never during it: a run admitted just under it runs to its end. An account can therefore go over its quota in a window by up to its runs in progress × (`SKRUN_RUN_MAX_TIMEOUT_S` + the acquisition budget + 2 minutes) at worst. Set the quota above that, or it no longer bounds anything.

### Assign an account's plan (admin only)

```
PUT /api/admin/accounts/:id/plan
```

Sets the plan of the account whose internal `id` is given — the `id` `GET /api/me` returns. An account's plan chooses the thresholds its [Quotas](api.md#quotas) are read under; `GET /api/me` returns it as `plan`. For an instance administrator (`users.role = 'admin'`) with a full-access credential, checked in the order of [Delete an account](#delete-an-account-admin-only).

**Body** (required): `{"plan": "<name>"}` — a plan the server knows: `free`, and every plan its operator's per-plan quota settings name (see *Quotas per plan* [above](#quotas-per-plan)). The name is compared without surrounding spaces and in any letter case, and written in lower case. A server that sets no per-plan quota knows `free` only. No plan is created by this route: a name the server does not know is refused.

```bash
curl -X PUT \
  -H "Authorization: Bearer skrun_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"plan": "pro"}' \
  https://your-domain.com/api/admin/accounts/5b4e7a0b-b3db-402f-baee-bbfe4c1f1f88/plan
```

**Response** `200`

```json
{ "id": "5b4e7a0b-b3db-402f-baee-bbfe4c1f1f88", "plan": "pro" }
```

The account's next request with a session or an API key reads the new plan: nothing caches it, and no restart is needed. A `dev-token` request always gets `free`'s thresholds: it carries no plan. The change is logged as `account_plan_changed`, with the administrator's and the account's internal ids and the plan before and after.

**Errors**

| Status | Code | When |
|--------|------|------|
| `400` | `UNKNOWN_PLAN` | No JSON body, no `plan`, a `plan` that is not a string, or a plan the server does not know. The message lists the plans it knows, `free` first. Nothing was written |
| `401` | `UNAUTHORIZED` | No credential |
| `403` | `KEY_SCOPE_FORBIDDEN` | An administrator's key without full access |
| `404` | `NOT_FOUND` | The caller is not an administrator, or holds a delegated key — the same `404` as [`GET /api/admin/pool`](#pre-warm-pool-status-admin-only), whatever it sends; an `id` that is not a UUID; no account with that `id` |

## Capacity levers

What one instance can serve is bounded by several levers, of which this server reads only some. They are listed in the order to raise them: the platform's machine limit first, since every machine the levers below it add counts against it.

| Lever | What it bounds | What it costs | What breaks at it |
|-------|----------------|---------------|-------------------|
| **Your platform's machine limit** (cloud runtime; on Fly.io, the organization's) | Every machine at once: each run's, each pooled one, and anything else in the organization | Nothing until used | Creations are refused: runs fail `MACHINE_SPAWN_FAILED` at phase `create`. No variable of this server reads it — ask your provider to raise it |
| **The pre-warm pool** (`SKRUN_RUNNER_POOL_SIZE`) | How many runs start in about a second rather than most of a minute | Each pooled machine's stopped storage, and a full boot to replace every machine a run takes from it — the one that serves the run, and any it destroys instead of using: stale, or failing to wake or to take the run — and every machine the pool retires for its age or its image | Nothing: a run that finds the pool empty builds its own machine |
| **The instance cap** (`SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS`) | Runs in progress at once, every account together | Up to the cap × a machine's hourly price, while the cap is full | Runs are refused `503 CAPACITY_EXHAUSTED`. Keep it within the platform's limit less the pool and whatever else runs there |
| **The API's own machines** (and the requests each accepts — on Fly.io, `[http_service.concurrency]`) | Requests and streams served at once; each process creates machines at Fly's rate for itself (see *What a burst of cold runs waits for* above) | Each machine's price | Requests queue or are refused by the platform. Quotas and the instance cap are counted in the database, so they hold across processes; the per-address rate limit needs the shared store (`UPSTASH_REDIS_REST_*`) |
| **Database connections** | Each server process opens at most 10 Postgres connections — no variable sets it; each run's admission holds one while it checks | Your database plan must allow 10 per process | Requests wait up to 5 s for a connection, then answer `503 DATABASE_TIMEOUT`; an admission that cannot take its lock in time (2 s) is refused `503 CAPACITY_EXHAUSTED` |
| **The per-plan quotas** (above) | What each account consumes: fairness between accounts, and the shape of each plan | Nothing | An account that has reached one of them is refused — a run or an upload `429`, a push that would take it past its storage `413` —; a run admitted just under its compute time may still take it past (see *Choosing a compute quota*); its fast runs are not refused: a run past them starts on a machine of its own. They do not bound the bill (below) |

**Database size** is a lever of its own: a hosted database's plan can cap it, and some free plans turn the database read-only when it is full — sign-ins, sessions and runs then fail. A run's record keeps at most 8 KiB of its input and of its error, and 32 KiB of its output (see [API → Get run detail](api.md#get-run-detail)); every run still keeps its row.

**What bounds the bill**, on the cloud runtime. The instance cap bounds the machines that run the runs: at most the cap × a machine's hourly price — a run's machine is destroyed as the run ends, its status written, whether or not its client reads its last event, and a run still in progress at the deadline of its place is stopped and its machine destroyed, ten seconds later for a streamed run whose client stopped reading (see *What counts* above); a machine its server could not destroy goes once its run's end or deadline is a grace behind, at the next pass of the [machine maintenance](#machine-maintenance-cloud-runtime) of a server on the same database — and, with none running, at its lifetime, which the machine ends itself at. With a pool, two more terms that the cap does not bound: the replacement of every machine a run takes from the pool, whether it serves the run or is destroyed instead, and of every machine the pool retires for its age or its image — a full boot each, one at a time per API process, so bounded by the number of API machines — and the pool's stopped machines' storage, bounded by `SKRUN_RUNNER_POOL_SIZE`. The per-plan quotas shape who gets what within these bounds; they never raise them.

---

## Stopping the server

On `SIGTERM` — what `docker compose stop` and most platforms' deploys send — or `SIGINT` (Ctrl+C), the server stops in this order: it takes no new connection — and refuses, `503 SERVER_STOPPED`, any run sent on a connection kept alive across the signal, before the run starts —; it abandons every run still in progress; it gives those runs 3 seconds to end by themselves, then writes `failed` for each one still going, with the error `The server stopped while this run was in progress.` (`SERVER_STOPPED`, see [Error codes](api.md#error-codes)); it waits for the runs to end — each one's final status written, or its last attempt at writing it over — and, on the cloud runtime, for their machines to be destroyed — and for the runs whose row was being written as the stop began, which it ends the same way without starting them — 20 seconds at most after the signal —; it exits with `0`. A run that completes before the exit replaces that failure with its success; any other end of an abandoned run keeps the stop's failure. A second signal during the stop exits at once, with `1`. The line `"event":"server_shutdown"` says what the stop did — runs in flight and runs being admitted at the signal (`admitting`), abandoned and written, the drain's length, and what was still going at the exit (`unsettled`, `admissions_pending`, `cleanups_pending`). No variable sets any of it. Both entry points stop this way, the published image's server and `pnpm dev:registry`.

**On the cloud runtime the stop takes the pool's machines with it.** First, before any run is abandoned, it stops the [machine maintenance](#machine-maintenance-cloud-runtime) and the pool's refill: a refill under way finishes the machine it is making and starts no other. Last, once the runs are done with their machines and within what is left of the 20 seconds, it destroys the ready pooled machines it holds — once the process is gone they serve no one, and paused they bill their storage. `server_shutdown` then also gives `pool_destroyed`, the machines it destroyed, and `pool_destroy_failed`, those whose destruction failed or that the end of the 20 seconds cut — each failure also logged `pool_destroy_failed` (`warn`, with `at_stop: true`). What the stop leaves — a machine still being made, a destruction that failed, every machine of a server killed without a stop — is the maintenance's of the next server, or of another on the same database: a pooled one as the pool reclaims any machine it does not hold (see [Pre-warm pool](#pre-warm-pool-cloud-runtime-optional)), a run's one — or a pooled one assigned to a run — on its run's row.

**Give the process 30 seconds before it is killed.** The stop needs about 3-4 seconds to write the state of its runs — up to 5 more when the database cannot take a write for a moment: the same write is made again a second, then four seconds later — and up to 20 to let them end; a process killed sooner leaves its runs as the kill found them — `running` before the write. On Postgres, a write the database is too slow to make is stopped at `SKRUN_DB_STATEMENT_TIMEOUT_MS` (10 s by default), and a write on a connection that gets no answer at all is given up on 5 s later (15 s by default). At the defaults the first attempt fits in the stop either way, save a write on a silent connection that first waited for one of the server's database connections; the next attempts do not, and such a run's row can stay `running`. Docker waits 10 seconds by default: the shipped `infra/docker-compose.yml` sets `stop_grace_period: 30s` on the `api` service, and the `docker-compose.minimal.yml` overlay inherits it. Any other supervisor must allow as long.

**On the `local` runtime, a run is not interrupted.** The engine cannot abandon a run: it goes on, its success still replaces the stop's failure within the 20 seconds, and past them the process exits under it. On the cloud runtime the stop ends a run at once while its machine is being made ready or its agent loop runs: the loop stops and its machine is destroyed — or, for a machine still being made, looked for (*A creation cut mid-flight*, above). Not once its loop has ended: the upload of its output files (two minutes at most) and the write of its state are not interrupted. A run whose upload and state write end within the 20 seconds completes, its success replacing the stop's failure; past them, the process exits under it, and its machine is not destroyed by this server — the [machine maintenance](#machine-maintenance-cloud-runtime) of the next one, or of another on the same database, destroys it a grace after the end its run's row records — or after the run's deadline, when no end is recorded.

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

**Example log line** (formatted for readability):

```json
{
  "level": 30,
  "time": 1713225600000,
  "name": "skrun:api",
  "run_id": "a1b2c3d4-...",
  "agent": "dev/code-review",
  "agent_version": "1.2.0",
  "event": "run_complete",
  "msg": "Agent run completed",
  "durationMs": 3200,
  "cost": 0.00025
}
```

**`LOG_LEVEL` env var** controls verbosity (default: `info`):

| Level | What it shows |
|-------|---------------|
| `debug` | Everything — verbose internal state |
| `info` | Run lifecycle, tool calls, LLM calls (default) |
| `warn` | Fallback triggers, cost exceeded, parse failures |
| `error` | Execution failures, webhook exhaustion |

```bash
# Human-readable in dev
pnpm dev:registry | npx pino-pretty

# Production: pipe to a file or log backend
pnpm dev:registry >> /var/log/skrun.jsonl

# Suppress info logs in production (only warn + error)
LOG_LEVEL=warn pnpm dev:registry
```

Every log entry during a POST /run includes `run_id`, `agent`, and `agent_version` automatically (via pino child logger bindings).

### Caching

Repeated POST /run calls reuse what the server read of an agent's bundle, and MCP connections. Both caches are in-memory with TTL eviction. A bundle's entry holds the text of its `SKILL.md`, `agent.yaml` and `AGENTS.md` — on the local runtime, with the bundle's extraction on disk; the cloud runtime writes none — and is cached by the bundle's content (its SHA-256), never by the agent's name and version: an agent deleted and published again under the same version number never runs its old content, and two versions with the same bytes share one entry. The bundle cache is bounded twice: by its count of entries (`BUNDLE_CACHE_MAX`) and by what that text weighs (`BUNDLE_CACHE_MAX_MB`, 256 MB by default) — `SKILL.md` and `AGENTS.md` have no size limit of their own.

MCP connections automatically reconnect on error (retry once) — except when a local (`stdio`) MCP server sends a message larger than 10 MiB: its connection is replaced, but the call is not retried, since the tool may already have run (see [agent-yaml → tools](agent-yaml.md#tools-optional)). Cached entries are cleaned up on eviction (an extraction's directory removed, MCP connections closed) — or, for an extraction a local run still uses, when that run ends.

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
- **Path separators**: the code uses `node:path` everywhere, so `\` vs `/` shouldn't bite you. Don't hard-code Unix paths in `scripts/` references.
- **Node script-dep install**: agents that ship a `package.json` (with or without a lockfile) install their dependencies automatically on first call. Skrun spawns `npm` / `pnpm` / `yarn` through the OS shell on Win32 so the `.cmd` shims resolve cleanly — no manual setup needed. Python (`requirements.txt`, `pyproject.toml`) works the same way.
- **SQLite on network drives**: avoid. SQLite's file locking is finicky on SMB/NFS. Use a local disk or switch to Supabase.
- **Reverse proxy**: IIS works but Caddy/nginx on WSL2 is simpler. Or use the built-in tools if you're already on IIS.
- **Headless Chrome / MCP servers**: `npx @playwright/mcp` runs on Windows, but it does not download a browser. By default (as of `@playwright/mcp` 0.0.83) it drives the Google Chrome installed on the machine, and fails with `Browser "chrome" is not installed` when there is none: install one first with `npx @playwright/mcp install-browser chrome`, the command its error message names.

---

## Managed cloud alternative

`skrun.sh` — the same runtime, our infrastructure. To start, follow its [quick start](https://skrun.sh/docs/quickstart).

- Zero setup — push your agent, get a URL.
- Hosting by subscription — you pay for the infrastructure your agents run on.
- Your own model keys — the service never puts a model key of its own on your runs.
- A marketplace for published agents may come later; nothing about it is decided yet.

Self-hosting stays first-class and fully-featured forever. MIT. No vendor lock-in.
