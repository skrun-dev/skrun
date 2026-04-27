# Q2 Engineering Roadmap

A 6-slide deck prepared for the all-hands. Skim before reading line-by-line.

## What we shipped

- Streaming SSE + async webhooks (POST /run with `Accept: text/event-stream`)
- TypeScript SDK v1 (`@skrun-dev/sdk`) with `run`, `stream`, `list`
- Operator dashboard at `/dashboard` — agents, runs, stats, playground
- Persistent SQLite for local dev (zero external deps)

> Speaker notes — emphasize that streaming was a top-3 customer ask and shipped 2 weeks ahead of plan.

## What's coming

- Cloud deploy (Fly.io machines + container image)
- Marketplace v1 — discover and call agents from other creators
- SOC2 type 1 audit kickoff

> Speaker notes — cloud deploy is the gating item. Don't promise the marketplace before SOC2 is at least in motion.

## How we measure success

- Time-to-first-deploy under 5 minutes for a new user
- 95p run latency under 8s for typical agents
- Two paying customers by end of Q3

## What I need from you

- Help recruiting two senior engineers (cloud + marketplace)
- Beta testers — please intro me to your engineering manager friends
- Feedback on the dashboard playground — what's missing?

# Thanks

Questions?
