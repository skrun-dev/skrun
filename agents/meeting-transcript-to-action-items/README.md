# meeting-transcript-to-action-items

> **Persona**: Yann (engineering manager / PM at a scale-up)
> **Artifacts**: `actions.csv` (importable to Linear/Asana/Notion) + `recap.md` (paste into Slack)
> **Skrun strengths shown**: persistent state across runs · multi-step LLM orchestration · Files API

## Purpose

You ran a 30-min Zoom standup. By the time you're done, you have a transcript export from Zoom/Teams/Granola and zero patience to manually pull out the action items, write a recap, and update your team's task tracker.

This agent does that for you — extracts decisions and action items, drops them into a CSV your task tracker can ingest, and writes a Slack-ready recap. Crucially: it **persists a running ledger across calls**. Run it after each meeting, and the next run knows about prior open actions — when someone says "I finished the design doc" in next week's standup, the agent auto-resolves the matching action without you doing anything.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier — see `.env.example`)
- A meeting transcript — text or WebVTT format works fine

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/meeting-transcript-to-action-items
skrun build && skrun push

# 2. Call it (quick-try with the bundled fixture — a 90-second engineering sync)
curl -X POST http://localhost:4000/api/agents/dev/meeting-transcript-to-action-items/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "transcript": "<paste the contents of fixtures/sample-transcript.vtt here>",
      "meeting_date": "2026-04-22",
      "meeting_title": "Engineering sync",
      "attendees": ["Alice", "Bob", "Carol"]
    }
  }'
```

Download both artifacts via the Files API:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/actions.csv \
  -H "Authorization: Bearer dev-token" -o actions.csv
curl http://localhost:4000/api/runs/<run_id>/files/recap.md \
  -H "Authorization: Bearer dev-token" -o recap.md
```

### Demonstrate the cross-meeting state

Run the agent **twice** with two different transcripts:

1. First run — meeting on `2026-04-15`. Action item: "Bob will do database backup verification by Monday."
2. Second run — meeting on `2026-04-22`. Bob says: "I finished the database backup verification."

In the second run, the response field `actions_resolved_count` will be `1` and the row in `actions.csv` for that action will have `status: resolved`. The agent inferred this from the persistent ledger.

## Artifacts

- **`actions.csv`** — RFC-4180 compliant. Columns: `action,owner,due,status,source_meeting,this_meeting`. Status values: `new` / `resolved` / `cancelled` / `still_open`. Importable directly to Linear (CSV import), Asana (Project import), Notion (CSV → table).
- **`recap.md`** — narrative format. Sections: Summary, Decisions, Action items (new), Resolved this meeting, Open questions. ~150-250 words for a typical 30-min meeting.

## Bring your own input (BYOI)

Two main shapes:

### WebVTT export (Zoom, Teams, Granola)

Paste the full `.vtt` contents into the `transcript` field. Speaker labels in `Name:` form work without configuration.

### Plain text

Paste the unstructured text. Provide `attendees` array to help the agent attribute actions correctly.

```json
{
  "input": {
    "transcript": "Alice said she'd write the doc by Friday. Bob will do the backup. Carol mentioned the mobile cut.",
    "meeting_date": "2026-04-22",
    "attendees": ["Alice", "Bob", "Carol"]
  }
}
```

## State semantics

State is keyed by the agent name (`dev/meeting-transcript-to-action-items`). All calls share the same ledger. The state TTL is 90 days — actions older than that are dropped automatically.

If you want **per-team** ledgers, deploy a copy of this agent under a different namespace (e.g., `your-org/meeting-transcript-to-action-items`) — Skrun keys state by full agent name, so each deployment gets its own ledger.

## What you'd customize for production

- Add a `slack_channel` input + an MCP Slack tool to post `recap.md` automatically — out of scope here (the demo deliberately avoids secondary API keys).
- Push action items to Linear/Asana via their API — same caveat.
- Add an `assigned_to_filter` input so a per-person view of open actions can be queried via state.
- Swap the LLM-as-judge for a small fine-tuned classifier for the "is this action resolved?" decision — would reduce false positives at scale.
