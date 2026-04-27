# knowledge-base-from-vault

> **Persona**: Universal — anyone with a Markdown vault (Obsidian users / OSS doc maintainers / "second-brain" practitioners)
> **Artifact**: `kb.zip` — a self-contained navigable static HTML site
> **Skrun strengths shown**: persistent state (concept graph densifies across runs) · multi-file binary artifact · code execution (custom ZIP writer) · Files API

## Purpose

You have a folder of Markdown notes — an Obsidian vault, a Notion export, raw repo docs, your "second brain" exports. You want to **publish** it as a navigable site (not a wall of files on GitHub), or just send it to a colleague as a single `kb.zip`. Or — over time — build a richer concept index as you process more vaults.

This agent does that, with three things going for it that a one-shot LLM call can't do:

1. **Code execution** — generates a real ZIP file (custom writer, no `JSZip` dependency) with embedded HTML envelopes and a theme stylesheet.
2. **Persistent state** — across runs, it builds a **concept graph**: terms that appear in multiple vaults gain count and prominence in the index. Run it weekly across different vaults, and the index gets denser without you doing anything.
3. **File output** — bundles N pages + CSS as a single `kb.zip`, served via the Files API.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier)
- A directory of `.md` notes (the bundled fixture has 5)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/knowledge-base-from-vault
skrun build && skrun push

# 2. Call it (quick-try with the bundled vault — 5 notes, light theme)
curl -X POST http://localhost:4000/api/agents/dev/knowledge-base-from-vault/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "vault_dir": "./fixtures/sample-vault",
      "site_title": "Skrun KB demo",
      "theme": "light"
    }
  }'
```

Download and unzip:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/kb.zip \
  -H "Authorization: Bearer dev-token" -o kb.zip
unzip kb.zip -d ./out
open ./out/index.html
```

You'll get a working static site with `index.html`, one page per note, and a `theme.css`.

## Demonstrate the cross-run state densification

Run the agent **twice** with different vaults that share concepts:

1. First run — vault A (the bundled `sample-vault`). Concepts: event-sourcing, cluster-design, quorum, etc. Each gets `count: 1`.
2. Second run — vault B (a different folder where you also discuss event-sourcing). The agent's response will show `concept_count` increased AND existing concepts now have `count: 2` in the index — they'll appear higher up.

The state is keyed by agent name, so `dev/knowledge-base-from-vault` accumulates a single global graph. Deploy under different namespaces if you want per-team graphs.

## Artifact

`kb.zip` contains:

- `index.html` — site landing with "All notes" + "Concept index" + stats footer
- `<note-slug>.html` — one page per Markdown note, rendered HTML, with backlinks section
- `theme.css` — single stylesheet (light / dark / sepia)

Themes:
- `light` (default) — classic GitHub-style readable
- `dark` — softer than #000, easier on the eyes
- `sepia` — paper-warm

## Bring your own input (BYOI)

Point at any directory of `.md` notes. The agent walks subdirectories recursively, ignores hidden files, and treats every `.md` as a note candidate.

```json
{
  "input": {
    "vault_dir": "/home/me/Documents/Obsidian/MyVault",
    "site_title": "My second brain",
    "theme": "dark"
  }
}
```

Supported markdown features (rendered to HTML):

- H1-H6 headings
- Paragraphs, **bold**, lists (`-` only — no nested rendering)
- `[markdown](style)` links — `.md` links rewritten to `.html`
- `[[wiki-style]]` links — resolved against vault slugs; broken links rendered as visible `<code>` (not crashed)
- Code fences ` ``` ` — escaped HTML
- YAML frontmatter — read for metadata, stripped from rendered body

## What you'd customize for production

- Wire to a webhook from your Obsidian/Notion sync — every commit triggers `POST /run` and republishes `kb.zip`.
- Add a `publish_to_s3` parameter + an S3 MCP tool to auto-deploy (out of scope here — secondary API key).
- Replace the manual ZIP writer with a streaming variant for vaults of 1000+ notes.
- Add a `concept_threshold: number` input to filter the index (only show concepts with count > N).
- Persist the concept graph to a separate `state_dump.json` artifact so it can be replayed/audited offline.
