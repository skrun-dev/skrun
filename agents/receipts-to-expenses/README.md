# receipts-to-expenses

> **Persona**: Sophie (freelance / consultant — monthly accounting)
> **Artifacts**: `expenses.xlsx` (multi-sheet, importable to accounting tools) + `monthly.pdf` (1-page summary for the accountant)
> **Skrun strengths shown**: multimodal vision · code execution (openpyxl + ReportLab) · multi-step LLM orchestration · Files API
> **Version**: 0.3.0 (vision-native, runtime-resolved deps — see [CHANGELOG](#version-history))

## Purpose

End of month. You're a freelance consultant. Your accountant is asking for the expense report by Friday. You have:

- A folder of receipt photos (restaurant tickets, Uber, software subscriptions, etc.)
- Maybe a CSV export of your bank statement for reconciliation
- 30 minutes you don't have to spare

This agent reads each receipt photo directly using vision, extracts the structured fields (vendor, date, amount, category), optionally reconciles against your bank statement, and produces:
- An Excel workbook with 2 sheets (Line Items + Category Totals) you can import into your accounting tool or share with your accountant
- A 1-page PDF summary suitable for handing in directly

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key — **Google Gemini** (the agent's primary model `gemini-2.5-flash` supports image inputs natively)
- **Python 3.11+** locally

That's it. The agent's `requirements.txt` (openpyxl + reportlab + pandas, ~80 MB resolved) is installed automatically by the Skrun runtime on first call and cached at `~/.skrun/deps/<hash>/` for subsequent runs.

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/receipts-to-expenses
skrun build && skrun push

# 2. Upload each receipt image and capture the file_id
RECEIPT_1=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@./fixtures/sample-receipts/01-restaurant.jpg" | jq -r .file_id)

RECEIPT_2=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@./fixtures/sample-receipts/02-uber.jpg" | jq -r .file_id)

RECEIPT_3=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@./fixtures/sample-receipts/03-saas.jpg" | jq -r .file_id)

# 3. Call the agent with the file_id refs
curl -X POST http://localhost:4000/api/agents/dev/receipts-to-expenses/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d "{
    \"input\": {
      \"receipts\": [
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_1\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_2\" },
        { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECEIPT_3\" }
      ],
      \"bank_statement_csv\": \"./fixtures/sample-bank.csv\",
      \"month\": \"2026-04\"
    }
  }"
```

Or via the SDK (auto-uploads Blobs/Files transparently):

```ts
import { SkrunClient } from "@skrun-dev/sdk";
import { readFileSync } from "node:fs";

const client = new SkrunClient({
  baseUrl: "http://localhost:4000",
  token: "dev-token",
});

const result = await client.run("dev/receipts-to-expenses", {
  receipts: [
    new Blob([readFileSync("./fixtures/sample-receipts/01-restaurant.jpg")], { type: "image/jpeg" }),
    new Blob([readFileSync("./fixtures/sample-receipts/02-uber.jpg")], { type: "image/jpeg" }),
    new Blob([readFileSync("./fixtures/sample-receipts/03-saas.jpg")], { type: "image/jpeg" }),
  ],
  bank_statement_csv: "./fixtures/sample-bank.csv",
  month: "2026-04",
});

console.log(result.output);
```

Download both artifacts using the unified Files API:

```bash
curl http://localhost:4000/api/files/${result.files[0].file_id}/content \
  -o expenses.xlsx
curl http://localhost:4000/api/files/${result.files[1].file_id}/content \
  -o monthly.pdf
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

Any photo of a receipt works — phone snap, scanner output, screenshot of a digital receipt. The agent uses Gemini's vision capability to read amount/vendor/date directly. Supported formats: JPEG, PNG, WebP, HEIC. Up to 20 receipts per call, max 10 MB each.

Optional: provide a CSV bank statement with at least these columns: `date`, `description`, `amount`, `currency`. The agent will fuzzy-match (±0.50 amount tolerance, ±2 days date tolerance) and surface unmatched bank rows so you know what to investigate.

## Categories used

The LLM assigns one of: `meals`, `transportation`, `lodging`, `software`, `office_supplies`, `professional_services`, `entertainment`, `other`. Conservative — `other` for genuinely ambiguous items.

## What you'd customize for production

- Wire to your inbox via an email IMAP MCP tool — auto-process receipts arriving as email attachments. (Out of scope here — needs secondary credentials.)
- Replace the LLM-as-judge for category assignment with a static rubric (vendor → category map for known merchants, LLM only for unknowns) — more deterministic at scale.
- Add a `currency_normalize_to: "EUR"` input that converts mixed-currency line items via a rate table — the demo deliberately doesn't do FX (no rate source baked in).
- Add a `to_quickbooks_format` output that produces an IIF / QBO file alongside the .xlsx for direct import to QuickBooks / Xero / Pennylane.

## Version history

- **0.3.0** (2026-05-02) — runtime-resolved deps. The manual `pip install -r requirements.txt` step disappeared; Skrun's runtime installs `requirements.txt` automatically on first call and caches at `~/.skrun/deps/<hash>/`.
- **0.2.0** (2026-05-01) — vision-native. Receipts are passed directly as image files (JPEG/PNG/WebP/HEIC). The LLM reads each image with its native vision capability. **Breaking**: `receipts_dir: string` input replaced by `receipts: file/image[]`; the upstream OCR step is no longer needed; the `read_receipts` tool was removed.
- **0.1.0** — text-mode. Receipts had to be pre-OCR'd to .txt files; the agent read text via a `read_receipts` tool. Required upstream OCR (Tesseract / iOS Live Text / pdftotext / etc.) before calling.
