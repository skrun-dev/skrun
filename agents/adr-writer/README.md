# adr-writer

> **Persona**: Léa (OSS maintainer) · Yann (engineering manager / CTO scale-up)
> **Artifact**: numbered `NNNN-<slug>.md` — Architecture Decision Record
> **Skrun strengths shown**: Files orchestration · multi-step LLM (list → compute → format → write)

## Purpose

Your team made an architectural call in a meeting (e.g., "We're moving from Postgres to DynamoDB"). Six months later, no one remembers exactly why — and a new contributor proposes the reverse change because the rationale was never written down. Decision Records (ADRs, the [nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) / [MADR](https://adr.github.io/madr/) convention) fix this — but they're tedious to format consistently, and numbering them right is annoying.

This agent takes structured input (title, context, options, decision) and produces a clean, numbered ADR Markdown file ready to commit. It scans your existing ADR directory to compute the next number, and notes cross-links to related prior decisions.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier — see `.env.example`)
- A directory to read existing ADRs from (can be empty for the first ADR)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/adr-writer
skrun build && skrun push

# 2. Call it (quick-try with the bundled fixture — 2 existing ADRs)
curl -X POST http://localhost:4000/api/agents/dev/adr-writer/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "adrs_dir": "./fixtures/existing-adrs",
      "title": "Switch state store from Memory to SQLite for local dev",
      "context": "Memory state store loses data on registry restart, breaking local test workflows.",
      "options": "- Keep Memory and document the limitation.\n- Switch to SQLite via better-sqlite3.\n- Use libsql/Turso.",
      "decision": "SQLite via better-sqlite3 for local dev. Supabase for production.",
      "consequences": "Local data persists across restarts. Adds one native dep (better-sqlite3 has prebuilds, low risk). Cloud unchanged."
    }
  }'
```

Expected response: `adr_number: 3`, `adr_filename: "0003-switch-state-store-from-memory-to-sqlite-for-local-dev.md"`. Download it via the Files API:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/0003-*.md \
  -H "Authorization: Bearer dev-token" -o new-adr.md
```

## Artifact

A single `NNNN-<slug>.md` file with these sections:

- `# ADR-NNNN: <title>`
- `## Status` — default `proposed`
- `## Context`
- `## Options Considered`
- `## Decision`
- `## Consequences`
- `## Related` — cross-links to existing ADRs whose subject overlaps semantically (omitted if none)
- Trailing `_Date_: YYYY-MM-DD`

## Bring your own input (BYOI)

Point `adrs_dir` at any directory in your repo:

```json
{
  "input": {
    "adrs_dir": "/repo/docs/adr",
    "title": "Adopt OpenTelemetry for distributed tracing",
    "context": "...",
    "options": "...",
    "decision": "..."
  }
}
```

If the directory is empty or doesn't exist, the agent assigns number `0001` and creates the first ADR. The agent never overwrites — if the next-number file already exists, it surfaces an error in the run output.

## What you'd customize for production

- Wire to a Slack `/adr-new` command — the agent.yaml inputs map cleanly to a slash-command form.
- Add a `supersedes` input — when set, the new ADR's `## Related` section links the prior ADR and the agent flips the prior ADR's `Status` to `superseded` (would require a third tool to write back to the existing file).
- Extend `list_adrs` to detect orphan ADRs (number gaps, never-accepted proposals older than 30 days).
- Replace the file output with a PR opened on the repo via a GitHub MCP tool (out of scope here — would require a secondary API key, which this demo deliberately avoids).
