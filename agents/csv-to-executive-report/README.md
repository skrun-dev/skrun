# csv-to-executive-report

> **Persona**: Sophie (analyst / freelance consultant) and any non-data-team CEO who needs to communicate quarterly results
> **Artifact**: `report.pdf` — multi-page styled PDF with narrative + matplotlib charts + summary table
> **Skrun strengths shown**: code execution (pandas + matplotlib + ReportLab) · multi-step LLM orchestration · Files API

## Purpose

Your CEO wants the Q2 report Monday morning. You have a CSV — sales data, signup funnel, error rates, support tickets, whatever. You don't want to:
- Manually load it in Excel and screenshot pivot tables
- Paste it into ChatGPT and copy back the markdown analysis (looks ugly when forwarded)
- Build a custom dashboard nobody will look at after Monday

This agent gives you a real PDF. Title page, opening narrative with the headline number, charts, breakdown analysis, summary table on the last page. Forward it as-is.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier)
- **Python 3.11+** locally
- **`pip install -r requirements.txt`** from this directory once before first use

```bash
cd agents/csv-to-executive-report
pip install -r requirements.txt
```

(This is the heaviest demo's pip footprint: pandas + matplotlib + reportlab. ~80 MB resolved. Once Skrun ships a managed cloud or a self-host container with Python deps pre-installed, this step disappears for hosted runs.)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/csv-to-executive-report
skrun build && skrun push

# 2. Call it (quick-try with the bundled 50-row revenue CSV)
curl -X POST http://localhost:4000/api/agents/dev/csv-to-executive-report/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "csv_path": "./fixtures/sample-revenue.csv",
      "report_title": "Q2 Revenue Report",
      "period": "Q2 2026"
    }
  }'
```

Download the PDF:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/report.pdf \
  -H "Authorization: Bearer dev-token" -o report.pdf
open report.pdf  # PDF reader of choice
```

## Artifact

A multi-page PDF (~3-5 pages depending on the data shape):

- **Page 1** — Title + period subtitle + headline narrative + the most important chart
- **Pages 2-N** — One narrative section per page, each accompanied by a relevant chart (trend / breakdown / composition)
- **Last page** — Summary table (label / value pairs)

Charts are produced by matplotlib (line / bar / pie) and embedded as PNGs. The PDF itself is laid out by ReportLab using letter pagesize.

## Bring your own input (BYOI)

Point at any CSV. The agent will inspect dtypes, find numeric columns to chart, find a categorical dimension to break down by, and find a date column for trends. It works best when:

- The file has at least one **numeric column** (revenue, count, duration, etc.)
- It has at least one **categorical column** with 3-15 distinct values (segment, region, status)
- Optionally a **date column** named `date`, `created_at`, or in ISO format — enables trend charts

```json
{
  "input": {
    "csv_path": "/repo/data/signups-2026-q2.csv",
    "report_title": "Q2 Signups Funnel",
    "period": "Q2 2026"
  }
}
```

The CSV must be a path the runtime can read. For `skrun dev` running locally, that's any file on your filesystem.

## Failure modes (graceful)

- CSV not parseable → returns `page_count: 0`, `summary` includes the parse error message.
- No numeric columns → produces a single-page report with row count + categorical breakdown, skips charts.
- Only one numeric column + a date → renders only the trend chart (no breakdown).

The agent never crashes silently; failures surface in the `summary` output field.

## What you'd customize for production

- Add a `template_pdf` input — start from your team's PDF template (header, footer, brand fonts) instead of ReportLab default styles.
- Wire to a daily / weekly cron via `POST /run` — auto-generate Monday morning's report and email it via an SMTP MCP tool (out of scope here — would require secondary credentials).
- Add a `compare_with_previous` boolean — if state were enabled, the agent could store the prior period's stats and surface deltas ("revenue +23% vs prior period") in the narrative.
- Replace the LLM-decided chart selection with a static rubric for predictable output across runs (LLM-as-judge can surface different "interesting" findings each call; for stable reports, a deterministic rubric is preferable).
