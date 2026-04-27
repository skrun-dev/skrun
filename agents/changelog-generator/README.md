# changelog-generator

> **Persona**: Léa (OSS maintainer)
> **Artifacts**: `CHANGELOG.md` + `release-notes.md`
> **Skrun strengths shown**: shell tool execution · multi-step orchestration · Files API

## Purpose

You're shipping `v1.5.0` of your OSS project tomorrow. You need a clean `CHANGELOG.md` (Keep a Changelog format) **and** a blog-friendly `release-notes.md` to publish — but writing them by hand from `git log` is tedious and error-prone.

This agent reads your local git history (no GitHub API token needed), groups commits by Conventional Commit type, and produces both artifacts ready to commit.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier — see `.env.example`)
- For real-repo mode: `git` CLI installed and a local git repository to point at
- For quick-try mode: nothing extra (the bundled fixture is a captured git log dump)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/changelog-generator
skrun build && skrun push

# 2. Call it (quick-try with the bundled fixture)
curl -X POST http://localhost:4000/api/agents/dev/changelog-generator/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "repo_path": "./fixtures/sample-repo.git-log.txt",
      "project_name": "my-project"
    }
  }'
```

The response includes a `files` array. Download each artifact via the Files API:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/CHANGELOG.md \
  -H "Authorization: Bearer dev-token" -o CHANGELOG.md
curl http://localhost:4000/api/runs/<run_id>/files/release-notes.md \
  -H "Authorization: Bearer dev-token" -o release-notes.md
```

## Artifacts

- **`CHANGELOG.md`** — Keep-a-Changelog format. Sections grouped: Breaking → Added → Changed → Fixed → Documentation → Other.
- **`release-notes.md`** — narrative blog format. Per-bucket prose paragraphs + closing "Thanks to" line.

## Bring your own input (BYOI)

Two modes:

### Real git repo

Pass a directory path. The agent runs `git log --pretty=format:'%H|%s|%an|%ad'` over the range you specify.

```json
{
  "input": {
    "repo_path": "/absolute/path/to/your/repo",
    "from_tag": "v1.4.0",
    "to_tag": "HEAD",
    "project_name": "my-project"
  }
}
```

### Captured git log dump

Useful when the repo lives outside the runtime's filesystem sandbox, or for CI pipelines that capture the log upstream. Format: one commit per line, `hash|subject|author|date` (see `fixtures/sample-repo.git-log.txt` for an example).

```json
{
  "input": {
    "repo_path": "/path/to/your-repo.git-log.txt",
    "project_name": "my-project"
  }
}
```

When the source is a `.txt` file, `from_tag` / `to_tag` are ignored — the file already contains the desired range.

## What you'd customize for production

- Tighten the Conventional Commit parser (handle scopes, footers, multi-line bodies) in `SKILL.md`.
- Add a `to_branch` parameter and post the `release-notes.md` to a Slack channel via an MCP tool.
- Wire to GitHub Actions: `on: release` triggers a webhook that calls `POST /run` and attaches the artifacts to the release.
