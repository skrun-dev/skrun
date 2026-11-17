# seo-audit

> **Artifacts**: a JSON SEO report with a 0-100 score, and the trend since the last audit · `fetched-page.json`, the page as the tool read it
> **Skrun strengths shown**: a script tool that reads the web · `allowed_hosts: ["*"]` · persistent state across runs · a run file
> **Version**: 1.3.1

## Purpose

Give it a URL; it reads the page and audits it — title, meta description, heading outline, redirects, status, links — then scores it. Run it again later and it compares with the previous audit (improving, declining, stable), thanks to its key-value state.

## How it reads the page

The agent carries one tool, `fetch_page` (`scripts/fetch_page.py`, Python standard library only, so there is no manifest and nothing to install). Its first model turn must call it (`tool_choice: fetch_page`); the instructions tell the model to judge only what the tool returned.

The tool is bounded on purpose:

- `http` and `https` only, redirects included;
- a host that resolves to a private, loopback, link-local or otherwise reserved address is refused — each connection resolves the host once and connects to the address it checked, so a name that changes its answer between the check and the connection reaches nothing; `https` still verifies the certificate against the host name, and no proxy is used;
- at most 1 MB of the page is read, and the request gives up after 15 seconds.

What the tool read is saved among the run's files as `fetched-page.json`: the requested and final URL, the status, the content type, the title, the size read, and the page's text — its first 50 000 characters, with `content_complete` saying whether that is all of it. Download it from the run (`files` in the response, or the run's page in the dashboard) to see what the audit was based on. The file is written only when the page was read, under that fixed name in the run's output directory; a second read in the same run replaces it.

## Networking: `allowed_hosts: ["*"]`

The agent audits any site, so it declares `["*"]` — every public address, never a private or reserved one.

- **Cloud runtime (`flyio`)**: the tool runs in the run's sandbox machine, whose firewall enforces the list on every connection — every public address is reachable, private and reserved ones never are, and outbound TCP port 25 is refused.
- **Local runtime**: a tool script runs as a child process of the server, and the list is advisory there. The tool's own refusal of non-public addresses is what keeps it on public pages.

See [`environment.networking`](../../docs/agent-yaml.md) for the full rules.

## How to run

From the repo root, against a local registry (`pnpm dev:registry`), with a Google Gemini key:

```bash
cd agents/seo-audit
skrun build && skrun push
skrun verify dev/seo-audit@1.3.1          # admin step; dev-token = auto-admin

skrun run dev/seo-audit -i '{"website_url": "https://example.com"}' --llm-key-env google=GOOGLE_API_KEY
```

Run it a second time on the same site, with the same credential: `previous_score` and `trend` come from the first audit. The agent keeps one notebook per caller (`scope: per_caller`): a client running it with a key of their own compares with their own audits, never with yours.

## Version history

- **1.3.1** — the retired `filesystem` field and the empty `secrets` list removed from `agent.yaml`.
- **1.3.0** — one notebook per caller: `agent.yaml` declares `scope: per_caller`. Before, every caller of the agent read and wrote the same previous audits. Needs a Skrun server ≥ 2.0.0, where per-caller state is also the default; an earlier server ignores the field and keeps one notebook for every caller.
- **1.2.0** — the model is Gemini 3.8 Flash, with Gemini 3.5 Flash-Lite as fallback: Google opens Gemini 2.5 only to accounts that have used it before. No `temperature` any more: Google recommends keeping Gemini 3 models at their default.
- **1.1.2** — `fetch_page` saves what it read as `fetched-page.json`, one of the run's files.
- **1.1.1** — `fetch_page` connects to the address it checked, instead of resolving the host a second time to connect.
- **1.1.0** — the agent reads the page: the `fetch_page` tool, called first. Before, it had no tool and audited a site it never read.
- **1.0.1** — the retired `sandbox` field removed from `agent.yaml`.
