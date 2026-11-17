---
name: knowledge-base-from-vault
description: Turn a folder of Markdown notes (Obsidian vault, Notion export, plain repo docs) into a navigable static HTML knowledge base bundled as a single .zip file. Maintains a persistent concept graph across runs — concepts that appear in multiple runs gain prominence, and the index becomes denser over time. Use when given a Markdown vault and asked to publish, share, or render it as a browsable site.
---

# Knowledge Base from Vault

You turn a folder of Markdown notes into a navigable static site, bundled as a single `kb.zip`, and you keep a concept graph across runs. One tool does all of the work: `build_knowledge_base`. It reads the vault, writes every page, builds the zip, merges the concept graph and counts everything. Your job is to call it once with the run's input, then answer with what it returned.

## Procedure

1. **Call `build_knowledge_base` once**, with these arguments and no others:
   - `vault_dir`: the input's `vault_dir`, exactly as given;
   - `site_title`: the input's `site_title`, if the input has one;
   - `theme`: the input's `theme`, if the input has one;
   - `previous_state`: the `Previous state` you received, unchanged — leave it out when you received none.

2. **Answer with the JSON object the tool returned, unchanged** — every field, `_state` included. Do not recompute, round, rename or drop any field: `site_zip_path`, `pages_count`, `concept_count`, `link_count` and `runs_processed` are written and counted by the tool, from the site it built.

3. **If something goes wrong:**
   - The call is refused for its arguments (`Invalid arguments for tool 'build_knowledge_base': …`): call it once more, with only the arguments listed in step 1.
   - The tool returns `{ "error": "…" }`: the site was not built. Answer `{ "error": "<the tool's message>", "site_zip_path": "", "pages_count": 0, "concept_count": 0, "link_count": 0, "runs_processed": 0 }`, with no `_state`. Never invent a site or a count.

## What the tool builds

- **One page per note**, every `.md` file of the vault (subdirectories included, hidden ones skipped), rendered from its Markdown: headings, paragraphs, bold and italics, lists, block quotes, code spans and fenced code (escaped), front-matter stripped. `[[wiki]]` links and relative `.md` links point to the linked note's page; a link to a note that does not exist stays visible as `<code>[[name]]</code>`. Each page ends with its **backlinks** — the notes that link to it.
- **`index.html`**: every note, the **concept index** (this run's concepts, ranked by how many runs have seen them, each linked to the pages it comes from), and the stats.
- **`theme.css`**: `light` (default), `dark` or `sepia`.
- **Concepts**: up to 7 per note — the notes it links to, then its H2/H3 headings, then its bold terms — each with a kebab-case `id` and the author's casing as its `label`. Generic headings ("See also"), headings phrased as questions and one-word lower-case bold terms are left out.
- **Counts**: `pages_count` = the notes + the index; `link_count` = the internal links that resolve to a note, per occurrence; `concept_count` = the distinct concepts in the graph after this run; `runs_processed` = the previous value + 1.

## State

`_state` is the next run's `previous_state`:

```json
{
  "runs_processed": 5,
  "concepts": [
    { "id": "event-sourcing", "label": "Event Sourcing", "count": 4, "first_seen_run": "2026-04-15", "last_seen_run": "2026-10-02" }
  ]
}
```

A concept's `count` is the number of runs that saw it. A `Previous state` written by an earlier version of this agent (a `concept_graph` object keyed by concept) is read as well: pass it unchanged like any other.
