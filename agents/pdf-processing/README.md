# pdf-processing

> **Persona**: anyone with a PDF and 30 seconds — researcher, analyst, lawyer, student
> **Skrun strengths shown**: multimodal document input · zero-tool LLM-only flow · structured output
> **Version**: 1.1.0 (vision-native — see [CHANGELOG](#version-history))

## Purpose

Drop a PDF in, ask for `extract` / `summarize` / `analyze`, get the answer back. No upstream OCR, no extraction script, no chunking glue — Gemini reads the PDF directly using its native document capability. The agent is intentionally tiny (one LLM call, no tools) so it doubles as a reference for "what does a multimodal Skrun agent look like at its simplest?"

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key — **Google Gemini** (the agent's model `gemini-2.5-flash` reads PDFs natively; the free tier handles the bundled fixture)
- A PDF up to 25 MB

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/pdf-processing
skrun build && skrun push
skrun verify dev/pdf-processing@1.1.0   # admin step; dev-token = auto-admin

# 2. Upload the PDF and capture the file_id
PDF=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@./fixtures/sample.pdf" | jq -r .file_id)

# 3. Call the agent with the file_id ref
curl -X POST http://localhost:4000/api/agents/dev/pdf-processing/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d "{
    \"input\": {
      \"pdf\": { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$PDF\" },
      \"task\": \"summarize\"
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

const result = await client.run("dev/pdf-processing", {
  pdf: new Blob([readFileSync("./fixtures/sample.pdf")], { type: "application/pdf" }),
  task: "summarize",
});

console.log(result.output.result); // the summary / extract / analysis
console.log(result.output.pages);  // estimated page count
```

## Try it in the playground

The fastest way to see this agent run end-to-end is the dashboard playground:

1. Open `http://localhost:4000/dashboard/agents/dev/pdf-processing`.
2. Click **Run in playground**.
3. Switch to **Form** mode at the top of the Input panel.
4. On the `pdf` field, click **Attach** and select `agents/pdf-processing/fixtures/sample.pdf`.
5. Fill `task` with `summarize` (or `extract` / `analyze`).
6. Click **Run agent**. The Output panel shows the JSON `{ result, pages }` returned by the LLM.

## Tasks supported

| `task` | What you get back in `result` |
|--------|-------------------------------|
| `extract` | The readable text content of the PDF, preserving paragraph and section structure as much as Gemini can reconstruct from the visual layout. |
| `summarize` | A single concise paragraph (3–5 sentences) covering the document's purpose and main points. |
| `analyze` | A short structural analysis: key topics, sections, and any tables/figures detected. |

The `pages` output is the model's estimated page count — useful when you're scanning many PDFs and want a length signal before deciding whether to feed the result downstream.

## Bring your own input (BYOI)

Any PDF up to 25 MB works — scanned docs, born-digital docs, mixed text + images. Gemini's document capability handles both. For multi-PDF workflows, deploy a thin wrapper that calls this agent per file and aggregates the outputs — the agent itself stays single-file by design.

## What you'd customize for production

- Add an `output_format: "markdown" | "html" | "plain"` input for the `extract` task — currently the LLM picks a format based on the visual structure.
- Add a `language` hint when you know the document language in advance — improves extraction quality on non-English PDFs.
- Cap pages with a `max_pages` input for cost control on long documents (the model still gets the whole file; the prompt asks it to stop after N pages).
- For OCR-grade extraction on scanned-only PDFs, wire an MCP `pdftotext`/Tesseract tool as a fallback when Gemini's reading confidence is low.

## Version history

- **1.1.0** (2026-04-15) — vision-native. Accepts a PDF directly via Skrun's multimodal file inputs; the LLM reads it with its native document capability. No tools, no upstream extraction step.
- **1.0.0** — text-mode placeholder. The agent declared an `extract_pdf` tool but the script was a stub returning fixed text — kept around as a structural example only.
