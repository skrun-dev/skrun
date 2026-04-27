# slide-deck-generator

> **Persona**: Sophie (freelance / consultant / biz operator)
> **Artifact**: `deck.pptx` — real PowerPoint deck (also opens in Keynote / LibreOffice Impress / Google Slides)
> **Skrun strengths shown**: code execution (python-pptx) · multi-step LLM orchestration · Files API

## Purpose

You're a freelance consultant. Your client asked for a deck on the project status — they want to forward it to their VP. You write your talking points in a Markdown outline (faster than fighting PowerPoint), and you need a real `.pptx` file, not a Markdown export that looks ugly when opened in Office.

This agent takes a Markdown outline and produces a polished `.pptx` — title slide, content slides with bullets, optional speaker notes, brand accent color. Open it in any office app and it just works.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier)
- **Python 3.11+** locally
- **`pip install -r requirements.txt`** from this directory once before first use

```bash
cd agents/slide-deck-generator
pip install -r requirements.txt
```

(Windows: this agent's tools run under the local Python — Skrun runtime invokes `python` on Windows and `python3` on macOS/Linux. Standard for both.)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/slide-deck-generator
skrun build && skrun push

# 2. Call it (quick-try with the bundled outline — 6-slide Q2 roadmap)
curl -X POST http://localhost:4000/api/agents/dev/slide-deck-generator/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "input": {
    "outline_md": "<paste the contents of fixtures/outline.md here>",
    "deck_title": "Q2 Engineering Roadmap",
    "brand_primary_color": "#0366d6"
  }
}
JSON
```

Download via the Files API:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/deck.pptx \
  -H "Authorization: Bearer dev-token" -o deck.pptx
open deck.pptx  # opens in PowerPoint / Keynote / LibreOffice Impress
```

## Artifact

A real `.pptx` file with:
- A **title slide** — first H1 of your outline + optional subtitle
- N **content slides** — one per `## H2` heading, with `- ` bullets rendered as the slide body
- An optional **closing slide** — last H1 (if multiple H1s exist)
- **Speaker notes** — lines starting with `>` under a content section get attached to that slide's notes
- **Brand accent bar** on the left edge of every slide using `brand_primary_color`
- **`.pptx` metadata** — `deck_title` is set in core properties (visible in PowerPoint's Info pane)

## Bring your own input (BYOI)

The outline format:

```markdown
# Title slide heading
Optional subtitle paragraph immediately after.

## First content slide
- Bullet one
- Bullet two
> Speaker notes for this slide.

## Second content slide
- Different bullets

# Optional closing slide heading
Optional closing subtitle.
```

Tips:
- Single-H1 outlines produce a title slide + content slides, no closing.
- Multi-H1 outlines: the first H1 is the title, the last H1 is the closing.
- The brand color is applied to slide titles and the left accent bar. White background and dark gray body text are derived from the brand for readability — currently not customizable (see "What you'd customize" below).

## What you'd customize for production

- Add a `template_pptx` input — start from your team's PowerPoint template instead of python-pptx's default theme. Would let you embed your team's exact fonts, header/footer layout, slide masters.
- Add an `image` field to slides — embed PNGs/JPGs by URL or base64 (would need a fetch tool with an allowlist if URL-based — out of scope here).
- Generate Google Slides via the Slides API for cloud-native delivery (requires OAuth / service account — secondary API key, deliberately avoided in this demo).
- Ship a `.docx` variant with the same outline format using `python-docx`.

## Dependency note

This demo currently requires `pip install python-pptx` locally. Once Skrun ships a managed cloud or a self-host container with Python deps pre-installed, this step will disappear for hosted runs.
