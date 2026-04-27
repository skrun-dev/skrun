# ADR-0001: Use TypeScript with strict mode for the entire codebase

## Status

accepted

## Context

The project will live for years and have multiple contributors. Type safety is the cheapest way to catch refactor regressions and to keep the public API contract clear. We considered Go (better runtime perf, simpler concurrency) and Python (faster onboarding for ML adjacent contributors), but the team's existing depth and the agent runtime's surface (LLM clients, JSON-heavy APIs) point to TypeScript.

## Options Considered

- TypeScript with strict mode + ESM modules.
- Go.
- Python with type hints (strict mypy).
- Plain JavaScript with JSDoc types.

## Decision

TypeScript with `strict: true`, ESM modules (`"type": "module"`), and Zod for runtime validation at every external boundary. Inferred types via `z.infer<>` — schema-first, never type-first.

## Consequences

- Every package needs `tsconfig.json` extending a shared base. One-time cost.
- Runtime validation is duplicated by the type system, but that's the point — Zod catches what the compiler can't.
- New contributors who only know JavaScript will need a short ramp-up.
- Refactors are dramatically safer; rename-symbol works repo-wide.

---

_Date_: 2026-03-22
