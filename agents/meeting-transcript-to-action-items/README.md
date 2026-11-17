# meeting-transcript-to-action-items

> **Persona**: Yann (engineering manager / PM at a scale-up)
> **Artifacts**: `actions.csv` (importable to Linear/Asana/Notion) + `recap.md` (paste into Slack)
> **Skrun strengths shown**: persistent state across runs · multi-step LLM orchestration · Files API · multimodal audio input
> **Version**: 0.4.1 (audio-native — see [CHANGELOG](#version-history))

## Purpose

You ran a 30-min Zoom standup. By the time you're done, you have an audio recording (or the in-meeting transcript export from Zoom/Teams/Granola) and zero patience to manually pull out the action items, write a recap, and update your team's task tracker.

This agent does that for you — takes the meeting **audio** directly, transcribes it with Gemini's native audio capability, extracts decisions and action items, drops them into a CSV your task tracker can ingest, and writes a Slack-ready recap. Crucially: it **persists a running ledger across calls**. Run it after each meeting, and the next run knows about prior open actions — when someone says "I finished the design doc" in next week's standup, the agent auto-resolves the matching action without you doing anything.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key — **Google Gemini** (the agent's model `gemini-3.8-flash` reads audio natively; the free tier is fine for the bundled fixture)
- An audio recording of the meeting — WAV, MP3, M4A, OGG, or WebM, up to ~30 minutes of typical compression (25 MB cap)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/meeting-transcript-to-action-items
skrun build && skrun push
skrun verify dev/meeting-transcript-to-action-items@0.4.1   # admin step; dev-token = auto-admin

# 2. Upload the recording and capture the file_id
RECORDING=$(curl -s -X POST http://localhost:4000/api/files \
  -H "Authorization: Bearer dev-token" \
  -F "file=@./fixtures/sample.wav" | jq -r .file_id)

# 3. Call the agent with the file_id ref
curl -X POST http://localhost:4000/api/agents/dev/meeting-transcript-to-action-items/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d "{
    \"input\": {
      \"recording\": { \"type\": \"file\", \"source\": \"id\", \"file_id\": \"$RECORDING\" },
      \"meeting_date\": \"2026-05-18\",
      \"meeting_title\": \"Engineering sync\"
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

const result = await client.run("dev/meeting-transcript-to-action-items", {
  recording: new Blob([readFileSync("./fixtures/sample.wav")], { type: "audio/wav" }),
  meeting_date: "2026-05-18",
  meeting_title: "Engineering sync",
});

console.log(result.output);
```

Download both artifacts via the unified Files API:

```bash
curl http://localhost:4000/api/files/${result.files[0].file_id}/content -o actions.csv
curl http://localhost:4000/api/files/${result.files[1].file_id}/content -o recap.md
```

## Try it in the playground

The fastest way to see this agent run end-to-end is the dashboard playground:

1. Open `http://localhost:4000/dashboard/agents/dev/meeting-transcript-to-action-items`.
2. Click **Run in playground**.
3. Switch to **Form** mode at the top of the Input panel.
4. On the `recording` field, click **Attach** and select `agents/meeting-transcript-to-action-items/fixtures/sample.wav`.
5. Fill `meeting_date` (e.g. `2026-05-18`) and an optional `meeting_title`.
6. Click **Run agent**. When the run completes, the Files block lists `actions.csv` and `recap.md` with Download buttons.

### Demonstrate the cross-meeting state

Run the agent **twice** with two different recordings:

1. First run — meeting on `2026-04-15`. Action item: "Bob will do database backup verification by Monday."
2. Second run — meeting on `2026-04-22`. Bob says: "I finished the database backup verification."

In the second run, the response field `actions_resolved_count` will be `1` and the row in `actions.csv` for that action will have `status: resolved`. The agent inferred this from the persistent ledger.

## Artifacts

- **`actions.csv`** — RFC-4180 compliant. Columns: `action,owner,due,status,source_meeting,this_meeting`. Status values: `new` / `resolved` / `cancelled` / `still_open`. Importable directly to Linear (CSV import), Asana (Project import), Notion (CSV → table).
- **`recap.md`** — narrative format. Sections: Summary, Decisions, Action items (new), Resolved this meeting, Open questions. ~150-250 words for a typical 30-min meeting.

## Bring your own input (BYOI)

Any meeting audio recording works — Zoom local recording, Teams export, a phone voice memo. Gemini transcribes the audio natively, so speaker attribution is inferred from the audio itself (voice patterns + name mentions in conversation). Up to 25 MB, which fits ~30 minutes of typical compression.

## State semantics

The agent keeps **one ledger per caller** (`scope: per_caller`). Your own credentials — a dashboard session, `dev-token`, an account-wide key with every operation — share your account's ledger; any other key has a ledger of its own. So for **per-team** ledgers, give each team its own key restricted to this agent (`skrun keys create --name team-a --agent <ns>/meeting-transcript-to-action-items --run-only`): each team's runs resolve only that team's actions, and revoking its key deletes its ledger.

For one ledger shared by every caller, set `scope: shared` under `state:` in `agent.yaml`. Either way, the ledger is deleted with the agent. The agent declares `ttl: 90d`: the whole ledger expires 90 days after the last run that wrote it — not action by action — and the next run starts with an empty one (see [Concepts → State](../../docs/concepts.md#state)).

## What you'd customize for production

- Add a `slack_channel` input + an MCP Slack tool to post `recap.md` automatically — out of scope here (the demo deliberately avoids secondary API keys).
- Push action items to Linear/Asana via their API — same caveat.
- Add an `assigned_to_filter` input so a per-person view of open actions can be queried via state.
- Swap the LLM-as-judge for a small fine-tuned classifier for the "is this action resolved?" decision — would reduce false positives at scale.

## Version history

- **0.4.1** — the retired `filesystem` field and the empty `secrets` list removed from `agent.yaml`.
- **0.4.0** — one ledger per caller: `agent.yaml` declares `scope: per_caller`. Before, every caller of the agent read and wrote the same ledger. Needs a Skrun server ≥ 2.0.0, where per-caller state is also the default; an earlier server ignores the field and keeps one ledger for every caller.
- **0.3.0** — the model is Gemini 3.8 Flash, with Gemini 3.5 Flash-Lite as fallback: Google opens Gemini 2.5 only to accounts that have used it before.
- **0.2.1** — the retired `sandbox` field removed from `agent.yaml`.
- **0.2.0** (2026-05-01) — audio-native. Accepts a meeting recording directly via Skrun's multimodal file inputs; Gemini transcribes the audio and extracts decisions and action items in a single pass.
- **0.1.0** — text transcript input, removed in 0.2.0: an upstream Whisper or VTT extraction step was needed.
