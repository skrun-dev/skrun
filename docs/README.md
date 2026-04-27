# Skrun Documentation

A quick index of the guides and reference docs.

## Start here

- **[Getting Started](./getting-started.md)** — install, create your first agent, deploy, and explore the dashboard. 10-minute walkthrough.
- **[Concepts](./concepts.md)** — the vocabulary you'll see everywhere: agent, skill, bundle, namespace, version, run, environment, state, verification, MCP.

## Reference

- **[agent.yaml specification](./agent-yaml.md)** — every field of the agent config file, with types, defaults, and examples.
- **[API reference](./api.md)** — HTTP endpoints, authentication, streaming, webhooks, error codes.
- **[CLI reference](./cli.md)** — every command (`skrun init`, `dev`, `build`, `push`, `deploy`, `login`, etc.) with flags and workflows.

## Deploy

- **[Self-hosting guide](./self-hosting.md)** — deploy Skrun on your own infrastructure (Docker, env vars, OAuth, SQLite vs Supabase, reverse proxy).

## Interactive

- `GET /docs` on your running registry — live API explorer (Scalar UI) generated from the OpenAPI schema.
- `GET /openapi.json` — import into Postman, Insomnia, or use for SDK generation.

## Elsewhere in the repo

- [README](../README.md) — project overview and pitch
- [CHANGELOG](../CHANGELOG.md) — release notes
- [CONTRIBUTING](../CONTRIBUTING.md) — how to contribute
- [agents/](../agents/) — 6 demo agents you can run locally
