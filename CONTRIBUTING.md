# Contributing to Skrun

Thanks for your interest in contributing!

## Setup

```bash
git clone https://github.com/skrun-dev/skrun.git
cd skrun
pnpm install
pnpm build
pnpm test
```

## Architecture

```
Monorepo (pnpm workspaces):
  packages/
    schema/    → @skrun-dev/schema   — Parser & validator (Zod)
    cli/       → @skrun-dev/cli      — CLI tool (Commander.js + clack)
    runtime/   → @skrun-dev/runtime  — Agent executor (LLM router, tools, state)
    api/       → @skrun-dev/api      — Registry + POST /run API (Hono)
```

## Code Conventions

### Style
- TypeScript strict mode, ESM modules
- Biome for linting and formatting (`pnpm lint`)
- Zod for all runtime validation

### Naming
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase` (no `I` prefix)
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

### Testing
- Vitest, colocated: `foo.ts` → `foo.test.ts`
- Run: `pnpm test` (all) or `pnpm --filter @skrun-dev/schema test` (single package)

### Git
- Branch: `feature/<epic>-<slug>`, `fix/<slug>`, `chore/<slug>`
- Commit: `type(scope): description` (types: feat, fix, test, refactor, docs, chore)
- Scopes: `schema`, `cli`, `runtime`, `api`, `infra`, `deps`
- One commit per logical change, squash merge into main

## Local E2E Testing

- `pnpm test:e2e` — the end-to-end suite of the quality gate: the API, the SDK and the CLI together, in process, with the model simulated. No key and no server needed; CI runs it on every push.
- `pnpm test:e2e:live` — the demo agents against a real LLM:
  1. Copy `.env.example` to `.env`, set at least one LLM API key
  2. `pnpm test:e2e:live` — starts its own registry on localhost:4000 (it stops whatever holds that port, a `pnpm dev:registry` included) and calls the real model providers
  3. The registry runs on SQLite unless `DATABASE_URL` is set, and the suite refuses to start unless that URL names a Postgres on this machine whose database ends in `_test` (e.g. `postgres://postgres:postgres@127.0.0.1:55432/skrun_test`, a container started for the purpose) — the registry writes to it and applies its migrations

## Questions?

Open an issue on GitHub.
