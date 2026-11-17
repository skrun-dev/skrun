# web-scraper

> **Artifacts**: the page title, an answer to your question, and structured data extracted from the page
> **Skrun strengths shown**: an MCP server over stdio (`@playwright/mcp`) · egress limited to named hosts
> **Version**: 1.1.1

## Purpose

Give it a URL and a question; it opens the page in a headless browser, reads it, and answers — with the facts it found on the page, as structured data.

## How it works

`mcp_servers` starts `npx -y @playwright/mcp --headless` over stdio for each run, and the model drives the browser through its tools (`browser_navigate`, then `browser_snapshot` to read the page). `allowed_hosts` names the sites the demo targets — `example.com` and `kickstarter.com`; add the ones you scrape.

## It needs a browser

`@playwright/mcp` does not download a browser. By default it drives the Google Chrome (stable channel) installed on the machine, and its browser tools fail with `Browser "chrome" is not installed` when there is none.

- **Local runtime**: install Chrome first with `npx @playwright/mcp install-browser chrome`, the command that error names — see [Headless Chrome / MCP servers](../../docs/self-hosting.md).
- **Cloud runtime**: the runner image ships no browser, and none can be installed during a run — the Chrome channel installs through the system package manager, as root, which a run's sandbox never has, and it is not offered for arm64 Linux. On a cloud runtime built from Skrun's image, this agent needs a browser the operator provides; without one, it fails with the error above.

`npx -y @playwright/mcp` is not pinned: it runs the package's latest release, and the behaviour above is that of its current one.

## How to run

From the repo root, against a local registry (`pnpm dev:registry`), with a Google Gemini key and Chrome installed:

```bash
cd agents/web-scraper
skrun build && skrun push
skrun verify dev/web-scraper@1.1.1         # admin step; dev-token = auto-admin

skrun run dev/web-scraper \
  -i '{"url": "https://example.com", "question": "What is this page about?"}' \
  --llm-key-env google=GOOGLE_API_KEY
```

The first run can take a minute or two: `npx` fetches the MCP server before the browser starts.
