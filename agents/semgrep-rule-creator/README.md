# semgrep-rule-creator

> **Persona**: Yann (CTO / engineering manager) — security-conscious team adopting Semgrep
> **Artifacts**: `rule.yml` + `tests.md` + `README.md` (3-file Semgrep rule bundle)
> **Skrun strengths shown**: multi-file artifact bundle · LLM-only orchestration · Files API

## Purpose

A new CVE drops. Your team wants to encode the pattern as a Semgrep rule so it never ships in your codebase again. But the Semgrep YAML schema is fiddly, the metadata fields (CWE, OWASP, severity, confidence/likelihood/impact) need to be picked correctly, and you need tests + a rationale doc to convince reviewers the rule isn't going to spam false positives.

This agent takes a CVE description and a bad-code example, and produces a complete 3-file Semgrep rule bundle ready to drop into your repo's `.semgrep/` directory.

## Prerequisites

- Skrun running (`pnpm dev:registry` from the repo root)
- One LLM API key (Google Gemini works on the free tier — see `.env.example`)
- Familiarity with [Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax/) (helpful for reviewing the output, but the agent handles the syntax for you)

## How to run

From the repo root:

```bash
# 1. Push the agent to your local registry
cd agents/semgrep-rule-creator
skrun build && skrun push

# 2. Call it (quick-try with the bundled SSRF fixture)
curl -X POST http://localhost:4000/api/agents/dev/semgrep-rule-creator/run \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "input": {
    "cve_description": "Server-Side Request Forgery via user-controlled URL passed directly to fetch() without allowlist validation.",
    "bad_code_example": "const url = req.query.url; const res = await fetch(url); res.send(await res.text());",
    "language": "typescript",
    "rule_id_prefix": "internal"
  }
}
JSON
```

Download the 3 artifacts via the Files API:

```bash
curl http://localhost:4000/api/runs/<run_id>/files/rule.yml \
  -H "Authorization: Bearer dev-token" -o rule.yml
curl http://localhost:4000/api/runs/<run_id>/files/tests.md \
  -H "Authorization: Bearer dev-token" -o tests.md
curl http://localhost:4000/api/runs/<run_id>/files/README.md \
  -H "Authorization: Bearer dev-token" -o RULE.md
```

For a richer worked example including the recommended safe code, see `fixtures/sample-cve.md`.

## Artifacts

- **`rule.yml`** — the Semgrep rule. Contains:
  - `id` — `<prefix>.<short-slug>` (e.g., `internal.ssrf-via-user-input`)
  - `message` — one-line developer-facing description
  - `severity` — `ERROR` / `WARNING` / `INFO` (LLM picks based on impact)
  - `languages` — single language matching your input
  - `metadata` — `category: security`, full `cwe` mapping, OWASP Top 10 category, `confidence`/`likelihood`/`impact` triple, `references` link to CWE
  - `pattern-either` — generalized AST pattern matching the bad code (uses metavariables, not string literals)
  - `pattern-not` — optional, generated only if `good_code_example` was provided

- **`tests.md`** — two code blocks (should match / should NOT match) — useful for code review and for adding to a manual test corpus.

- **`README.md`** — rationale (what / why / how to fix) + references. This is the rule's own doc, separate from this agent's README.

## Bring your own input (BYOI)

Minimum required:

```json
{
  "input": {
    "cve_description": "<paste the description from the advisory or your team's understanding>",
    "bad_code_example": "<a concrete code snippet exhibiting the issue>",
    "language": "typescript"
  }
}
```

Optional refinements:

- `good_code_example`: a safe alternative — improves the rule's `pattern-not` and the `tests.md` "should not match" section.
- `rule_id_prefix`: your team's namespace (e.g., `acme.security`) — keeps custom rules from colliding with upstream Semgrep registry rules.

Supported languages: `javascript`, `typescript`, `python`, `go`, `java`, `ruby`.

## What you'd customize for production

- Wire to a Slack `/semgrep-rule` slash command — the input fields map cleanly.
- Add a `pre_existing_rules_dir` input to detect overlap with the team's existing ruleset (would require a `list_rules` tool similar to `adr-writer`'s `list_adrs`).
- Pipe the output to a PR opened against `your-repo/.semgrep/` via a GitHub MCP tool (out of scope here — the demo deliberately avoids secondary API keys).
- Replace the LLM-as-judge for severity selection with a static rubric (CWE → severity table) for more deterministic output at the cost of nuance.
