# knowledge-base-from-vault

> **Persona**: Universal — anyone with a Markdown vault (Obsidian users / OSS doc maintainers / "second-brain" practitioners)
> **Artifact**: `kb.zip` — a self-contained navigable static HTML site
> **Skrun strengths shown**: persistent state (concept graph densifies across runs) · multi-file binary artifact · code execution with a declared npm dependency (`jszip`) · Files API
> **Version**: 0.5.1

## Purpose

You have a folder of Markdown notes — an Obsidian vault, a Notion export, raw repo docs, your "second brain" exports. You want to **publish** it as a navigable site (not a wall of files on GitHub), or just send it to a colleague as a single `kb.zip`. Or — over time — build a richer concept index as you process more vaults.

This agent does that, with three things going for it that a one-shot LLM call can't do:

1. **Code execution** — one script, the `build_knowledge_base` tool, reads the vault, renders every page from its Markdown, and generates a real ZIP file with the HTML pages and a theme stylesheet, through `jszip`, which its `package.json` declares: the runtime installs it, and the script `import`s it.
2. **Persistent state** — across runs, it builds a **concept graph**: terms that appear in multiple vaults gain count and prominence in the index. Run it weekly across different vaults, and the index gets denser without you doing anything.
3. **File output** — bundles N pages + CSS as a single `kb.zip`, served via the Files API.

### How it works

The model does not write the site. `agent.yaml` sets `tool_choice: build_knowledge_base`, so the model's first turn must call that tool, with the run's input (and the previous run's state). The script builds everything and returns the whole answer — `site_zip_path`, `pages_count`, `concept_count`, `link_count`, `runs_processed`, and the state to keep — which the model returns unchanged. Every count comes from the site that was actually built: a vault of 5 notes always gives 6 pages.

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
skrun verify dev/knowledge-base-from-vault@0.5.1   # admin step; dev-token = auto-admin

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
2. Second run — vault B (a different folder where you also discuss event-sourcing). The agent's response will show `concept_count` increased AND the concepts both vaults share now read "2 runs" in the index — they'll appear higher up.

Run both with the same credential: the agent keeps **one concept graph per caller** (`scope: per_caller`). Your own credentials — a dashboard session, `dev-token`, an account-wide key with every operation — share your account's graph; any other key has a graph of its own. For per-team graphs, give each team its own key restricted to this agent (`skrun keys create --name team-a --agent <ns>/knowledge-base-from-vault --run-only`); for a single graph every caller densifies, set `scope: shared` under `state:` in `agent.yaml`. The graph is deleted with the agent, and a team's graph with its key.

## Artifact

`kb.zip` contains:

- `index.html` — site landing with "All notes" + "Concept index" (this run's concepts, ranked by how many runs have seen them, each linked to its pages) + stats footer
- `<note-slug>.html` — one page per Markdown note, rendered HTML, with backlinks section (a note in a subfolder gets a flat name: `concepts/event-sourcing.md` → `concepts-event-sourcing.html`)
- `theme.css` — single stylesheet (light / dark / sepia)

Themes:
- `light` (default) — classic GitHub-style readable
- `dark` — softer than pure black, easier on the eyes
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

Supported markdown features (rendered to HTML by the script; everything else is kept as escaped text):

- H1-H6 headings, each with an anchor; a note without an H1 gets its title as one
- Paragraphs, **bold**, *italics*, ~~strikethrough~~, block quotes, horizontal rules
- Lists — `-`, `*`, `+` and numbered, one level (no nested rendering)
- `[markdown](style)` links — a relative link to a `.md` note points to its page; `http`, `https` and `mailto` links are kept; any other scheme is shown as plain text
- `[[wiki-style]]` links, with `|alias` and `#heading` — resolved by path, file name or title; broken links rendered as visible `<code>` (not crashed)
- Code spans and fences ` ``` ` / `~~~` — escaped HTML
- Images — shown as their alt text: the zip carries no attachments
- YAML frontmatter — `title:` read, stripped from rendered body

## What you'd customize for production

- Wire to a webhook from your Obsidian/Notion sync — every commit triggers `POST /run` and republishes `kb.zip`.
- Add a `publish_to_s3` parameter + an S3 MCP tool to auto-deploy (out of scope here — secondary API key).
- Replace `jszip` with a streaming variant (e.g. `archiver`) for vaults of 1000+ notes.
- Add a `concept_threshold: number` input to filter the index (only show concepts with count > N).
- Persist the concept graph to a separate `state_dump.json` artifact so it can be replayed/audited offline.

## Version history

- **0.5.1** — the retired `filesystem` field and the empty `secrets` list removed from `agent.yaml`.
- **0.5.0** — one concept graph per caller: `agent.yaml` declares `scope: per_caller`. Before, every caller of the agent densified the same graph. Needs a Skrun server ≥ 2.0.0, where per-caller state is also the default; an earlier server ignores the field and keeps one graph for every caller.
- **0.4.0** — the model is Gemini 3.8 Flash, with Gemini 3.5 Flash-Lite as fallback: Google opens Gemini 2.5 only to accounts that have used it before.
- **0.3.0** — one script builds the whole site. On a small model, 0.2 often failed: the model had to write every page's HTML, pass all of them to `build_site_zip` in one call with the right arguments, then count what it had built, and it got each step wrong in turn — a refused call, a site of one or two pages, counts that did not match the zip. The `build_knowledge_base` tool now reads the vault, renders one page per note plus the index from the Markdown, writes `kb.zip`, merges the concept graph, and returns every output; `tool_choice` makes the model's first turn call it, and the model answers with what it returned. `read_vault` and `build_site_zip` are removed. The state takes a new shape — `concepts`, a list — and the 0.2 shape is read on the first run.
- **0.2.2** — `theme` of `build_site_zip` is optional: the script uses `light` when it is missing, where a call without it was refused before the script ran. `SKILL.md` spells out the procedure — one page per note plus the index, in a single `build_site_zip` call — and takes `pages_count` from what that call built.
- **0.2.1** — the retired `sandbox` field removed from `agent.yaml`.
- **0.2.0** (2026-05-02) — `package.json` declares `jszip`; the runtime resolves the dep automatically. Removed the 95-line hand-rolled STORE-method ZIP writer (~5 lines of jszip API in its place). Output is functionally identical.
- **0.1.0** — initial release. Hand-rolled ZIP writer (CRC-32 + STORE method) because the runtime could not bundle or resolve npm deps.
