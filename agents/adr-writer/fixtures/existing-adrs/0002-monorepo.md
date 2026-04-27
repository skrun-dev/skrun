# ADR-0002: pnpm workspaces monorepo (no Turborepo or Nx)

## Status

accepted

## Context

The project ships 5 packages: `schema`, `cli`, `runtime`, `api`, `sdk`. They cross-import via the `@skrun-dev/*` namespace, share a `tsconfig.base.json`, and need a unified test runner. Solo founder + Claude Code workflow — minimizing build orchestration overhead matters more than incremental-build cleverness.

## Options Considered

- pnpm workspaces, plain.
- pnpm workspaces + Turborepo.
- pnpm workspaces + Nx.
- Yarn workspaces.
- Lerna.

## Decision

pnpm workspaces, no Turborepo or Nx. Vitest as the test runner across all packages.

## Consequences

- Build orchestration is `pnpm -r build`. No incremental cache, no DAG optimizer. Acceptable: full builds take under a minute on this codebase.
- If we ever need fan-out CI parallelism, we can layer Turborepo on top without restructuring.
- Cross-package imports use the `@skrun-dev/*` scope — never relative paths across packages. Constitution rule.
- Lockfile is `pnpm-lock.yaml`, committed. Strict installs in CI.

## Related

- ADR-0001: Use TypeScript with strict mode for the entire codebase

---

_Date_: 2026-03-23
