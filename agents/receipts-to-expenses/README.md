# receipts-to-expenses

> **Persona**: Sophie (freelance / consultant — monthly accounting)
> **Artifacts**: `expenses.xlsx` (multi-sheet, importable to accounting tools) + `monthly.pdf` (1-page summary for the accountant)
> **Skrun strengths shown**: multi-file processing · code execution (openpyxl + ReportLab) · multi-step LLM orchestration · Files API

## Purpose

End of month. You're a freelance consultant. Your accountant is asking for the expense report by Friday. You have:

- A folder of receipts (restaurant tickets, Uber, software subscriptions, etc.)
- Maybe a CSV export of your bank statement for reconciliation
- 30 minutes you don't have to spare

This agent reads each receipt, extracts the structured fields (vendor, date, amount, category), optionally reconciles against your bank statement, and produces:
- An Excel workbook with 2 sheets (Line Items + Category Totals) you can import into your accounting tool or share with your accountant
- A 1-page PDF summary suitable for handing in directly

## ⚠ Important — text-mode demo

This demo accepts receipts as **already-extracted text files** (one `.txt` per receipt), not as photos. Skrun's runtime currently relays text only to the LLM. Multimodal inputs (image / file attachment) are on the roadmap — once they ship, this demo will accept image paths directly and do the vision call internally. Until then, the upstream OCR step is the user's responsibility:

- For paper receipts: photo → Tesseract / iPhone "Live Text" / Apple Notes scan → text file
- For PDF receipts: `pdftotext` (poppler) or your preferred PDF text extractor
- For email receipts: copy/paste body to a `.txt` file

The demo is still useful as text-mode because the parsing + reconciliation + reporting work isn't trivial and the artifact (xlsx + pdf) is exactly what your accountant wants.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier)
- **Python 3.11+** locally
- **`pip install -r requirements.txt`** from this directory once before first use

```bash
cd agents/receipts-to-expenses
pip install -r requirements.txt
```

(Deps: openpyxl + reportlab + pandas. ~80 MB resolved. Same footprint as `csv-to-executive-report`.)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/receipts-to-expenses
skrun build && skrun push

# 2. Call it (quick-try with the bundled fixture — 3 receipts + a bank statement)
curl -X POST http://localhost:4000/api/agents/dev/receipts-to-expenses/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "receipts_dir": "./fixtures/sample-receipts",
      "bank_statement_csv": "./fixtures/sample-bank.csv",
      "month": "2026-04"
    }
  }'
```

Download both artifacts:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/expenses.xlsx \
  -H "Authorization: Bearer dev-token" -o expenses.xlsx
curl http://localhost:4000/api/runs/<run_id>/files/monthly.pdf \
  -H "Authorization: Bearer dev-token" -o monthly.pdf
open expenses.xlsx  # Excel / Numbers / LibreOffice Calc
open monthly.pdf
```

## Artifacts

- **`expenses.xlsx`** — 2-sheet workbook:
  - Sheet 1 "Line Items": one row per receipt with vendor, date, amount, currency, category, note, matched bank row.
  - Sheet 2 "Category Totals": aggregated spend per category, with period footer.
  - Header row styled with brand color, auto-width columns.

- **`monthly.pdf`** — 1-page summary:
  - Title + period subtitle
  - Stats line: receipt count + total + reconciliation status
  - Category totals table (sorted by spend descending) with grand total row
  - 1 page for typical monthly inputs

## Bring your own input (BYOI)

Drop `.txt` files into a directory. Each file = one receipt. The format is flexible — the agent parses semi-structured text. Examples that work:

- Receipts photographed with Apple Notes (iOS Live Text auto-extracts to a Note → export as .txt)
- Email receipt bodies copy-pasted (Linear, Stripe, Uber, AWS, etc.)
- Paper receipts run through `tesseract` or any OCR tool
- Hand-typed summaries when an OCR tool isn't available

Optional: provide a CSV bank statement with at least these columns: `date`, `description`, `amount`, `currency`. The agent will fuzzy-match (±0.50 amount tolerance, ±2 days date tolerance) and surface unmatched bank rows so you know what to investigate.

## Categories used

The LLM assigns one of: `meals`, `transportation`, `lodging`, `software`, `office_supplies`, `professional_services`, `entertainment`, `other`. Conservative — `other` for genuinely ambiguous items.

## What you'd customize for production

- **Once Skrun ships multimodal inputs**: swap the `read_receipts` text-only tool for a vision-capable variant that takes image paths directly. The fixture would become photos instead of .txt files.
- Wire to your inbox via an email IMAP MCP tool — auto-process receipts arriving as PDF attachments. (Out of scope here — needs secondary credentials.)
- Replace the LLM-as-judge for category assignment with a static rubric (vendor → category map for known merchants, LLM only for unknowns) — more deterministic at scale.
- Add a `currency_normalize_to: "EUR"` input that converts mixed-currency line items via a rate table — the demo deliberately doesn't do FX (no rate source baked in).
- Add a `to_quickbooks_format` output that produces an IIF / QBO file alongside the .xlsx for direct import to QuickBooks / Xero / Pennylane.
