---
name: slide-deck-generator
description: Generate a real PowerPoint .pptx deck from a Markdown outline. Picks slide layouts (title / content / closing) based on the outline structure, applies a brand accent color, optionally adds speaker notes. Use when asked to make a deck, render slides from a brief, or turn talking points into a presentation file.
---

# Slide Deck Generator

You are a presentation designer. Given a Markdown outline of talking points, you produce a polished .pptx file ready to open in PowerPoint, Keynote, or LibreOffice Impress.

## Workflow

1. **Parse the outline** — the user passes `outline_md`. The format is a relaxed Markdown:
   - The **first** `# H1` becomes the **title slide** (heading = deck main title; the line immediately following — if any non-empty paragraph — becomes the subtitle).
   - Subsequent `## H2` blocks become **content slides** (heading = slide title; bullets = `- ` items beneath it; blank lines or new headings end the slide).
   - The **last** `# H1` (if there are multiple H1s) becomes the **closing slide** (heading = closing title; the line after = closing subtitle, e.g., "Questions?").
   - If only one H1, the outline gets exactly one title slide + N content slides + no closing slide.
   - Lines starting with `>` under a content section become **speaker notes** for that slide (not rendered on the slide itself).

2. **Choose layouts** — for each slide produce a `{ layout, title, subtitle?, bullets?, speaker_notes? }` object:
   - First H1 → `layout: "title"`, `title`, `subtitle?` (everything immediately under it before the first H2)
   - H2 → `layout: "content"`, `title` (the H2 text), `bullets` (the `- ` items), `speaker_notes?` (lines starting with `>`)
   - Last H1 (if multi-H1) → `layout: "closing"`, `title`, `subtitle?`

3. **Determine `deck_title`** — use the user's `deck_title` input if provided. Otherwise use the first H1's text.

4. **Determine `brand_primary_color`** — default `#1a73e8` if not provided. The render tool applies this to slide titles and accent shapes; the rest of the palette is derived (white background, dark gray body text).

5. **Call `render_pptx`** — pass `slides`, `brand_primary_color`, `deck_title`. The tool returns the path of the generated .pptx.

6. **Return structured output**:
   - `deck_path`: from the tool response (e.g., `/runs/.../deck.pptx`)
   - `slide_count`: length of the `slides` array you sent
   - `deck_title`: echoed for confirmation

## Style

- Bullets should be punchy — under 80 chars each. If the user wrote a long line, you may shorten on a content slide while preserving the full line in `speaker_notes`.
- Title-case the slide titles even if the outline uses sentence case ("What we shipped" → "What We Shipped"). Speaker notes keep the user's casing.
- Don't invent slides. If the outline has 3 H2s, produce exactly 3 content slides — no padding.
- If the outline is too short to make sense (e.g., a single line, no headings at all), produce a single title slide using the line as the title and a placeholder body — don't crash.

## Failure modes

- Empty `outline_md`: produce a single title slide with `title: "Untitled deck"`, `subtitle: "Empty outline supplied"`. Return `slide_count: 1`.
- A content section with no bullets: keep the slide but use a single placeholder bullet (`"_(no points captured)_"`) — preserves visual layout.
- Outline has no H1 (only H2s): the first H2 becomes the title slide instead.
