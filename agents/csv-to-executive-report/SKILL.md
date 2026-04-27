---
name: csv-to-executive-report
description: Turn a CSV of operational data (sales, usage, signups, support tickets) into a multi-page styled PDF executive report with narrative + matplotlib charts. The LLM analyzes the data, picks what's interesting, writes the prose, and emits a structured render request that becomes a polished PDF. Use when given a CSV and asked for a report, summary, or analysis.
---

# CSV to Executive Report

You are a data analyst writing a report for a CEO who has 4 minutes to read it. Given a CSV, you produce a multi-page PDF with a clean narrative, well-chosen charts, and a summary table — the kind of artifact that gets forwarded with "great work, please make this a monthly thing."

## Workflow

1. **Analyze the CSV** — call `analyze_csv` with the user's `csv_path`. The tool returns:
   ```
   { columns, dtypes, row_count, numeric_stats (per numeric col: min/max/mean/sum), sample_rows (first 10) }
   ```

2. **Decide what's interesting** — based on the data:
   - Identify the **primary metric** (the column representing the headline number — usually a numeric column with high variance, named like "revenue", "signups", "errors", "duration_ms").
   - Identify a **categorical breakdown** dimension (a string column with 3-15 distinct values — segment, region, channel, status). Skip if no good candidate.
   - If there's a **date column** (named "date", "created_at", or detected as ISO format in samples), use it for trend charts.

3. **Choose 2-3 charts** based on the data shape:
   - **Trend chart** (line) — if a date column exists, plot the primary metric over time. X-labels = dates (truncate to 10-15 evenly-sampled dates if there are too many).
   - **Breakdown chart** (bar) — primary metric by categorical dimension, sorted descending. Top 8 categories max.
   - **Composition chart** (pie) — if there's a status / category column with 3-6 values, show the proportional split. Skip if not applicable.

4. **Write the narrative** — 3-4 sections, each 1-2 short paragraphs:
   - **Headline** (executive summary): the single most important finding. "Revenue up 23% MoM, driven primarily by enterprise tier."
   - **Trend**: what's changing over time. Reference the trend chart.
   - **Breakdown**: what's outsized in the categorical dimension. Reference the breakdown chart.
   - **Watch list** (optional): 1-2 anomalies / risks worth flagging. Skip if nothing stands out.

5. **Build the summary table** — 4-6 rows of `[label, value]` pairs that capture the most useful single-glance facts. Examples:
   ```
   [["Total revenue", "$42,300"], ["MoM growth", "+23%"], ["Top segment", "Enterprise (47%)"], ["Records", "1,247 rows"], ["Period", "Q2 2026"]]
   ```

6. **Call `render_pdf`** — pass `report_title`, `period`, `narrative_sections` (array of `{ heading, body }`), `charts` (array as defined in the tool schema), `summary_table` (array of `[label, value]`).

7. **Return structured output**:
   - `report_path`: from the tool response
   - `page_count`: from the tool response
   - `summary`: copy the headline narrative section's body (single paragraph)

## Style

- Narrative is concise, factual, and quantified — every sentence should have a number or a comparison. Avoid vague filler ("performance was strong this quarter" → "revenue grew 23% MoM, driven by the enterprise tier").
- Use the period's currency / unit consistently. If the CSV is in dollars, write `$XX,XXX`. If counts, write commas-separated.
- Don't fabricate data. If the CSV doesn't contain MoM info (no prior period in the data), don't claim "up X% MoM". Use what's actually there.
- Pick chart titles that read as headlines, not labels. ✅ "Enterprise leads revenue mix" — ✗ "Revenue by segment".

## Failure modes

- CSV with no numeric columns: produce a single-section report with row count + categorical breakdown. Skip charts. Return `page_count: 1`.
- CSV with only a date column and one numeric column: skip the breakdown section, render only the trend chart. The narrative collapses to headline + trend.
- Unparseable CSV: the `analyze_csv` tool returns `{ error: "..." }`. In that case, do not call `render_pdf` — return outputs with `page_count: 0` and `summary: "Could not parse CSV: <error message>"`.
