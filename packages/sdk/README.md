# @skrun-dev/sdk

Official TypeScript SDK for [Skrun](https://github.com/skrun-dev/skrun) — deploy any Agent Skill as an API via `POST /run`.

## Install

```bash
npm install @skrun-dev/sdk
```

## Quick example

```ts
import { SkrunClient, SkrunNotVerifiedError } from "@skrun-dev/sdk";

const client = new SkrunClient({
  baseUrl: "http://localhost:4000",
  token: "dev-token",
});

// Invoke an agent
try {
  const result = await client.run("acme/my-agent", { query: "hello" });
  console.log(result.output);
} catch (err) {
  if (err instanceof SkrunNotVerifiedError) {
    // The resolved version is not verified by an admin yet.
    // Ask the operator to run `skrun verify acme/my-agent@<version>`.
    console.error(`Agent not verified: ${err.message}`);
  } else {
    throw err;
  }
}
```

## Verification (admin only)

Verification is **per version**. Each version of an agent has its own
`verified` flag; `POST /run` returns `403 AGENT_NOT_VERIFIED` until an
admin verifies the version.

```ts
// Verify a specific version (admin role required server-side)
await client.verifyVersion("acme/my-agent", "1.0.0", true);

// Revoke
await client.verifyVersion("acme/my-agent", "1.0.0", false);
```

Pushing a new version doesn't touch the verified state of prior versions
— pinned production callers (`client.run(..., { version: "1.0.0" })`)
keep running while admins review the new version separately.

## Typed errors

`SkrunApiError.fromResponse` dispatches on the server's `error.code` to
typed subclasses. Today:

| Code | Class | When |
|------|-------|------|
| `AGENT_NOT_VERIFIED` | `SkrunNotVerifiedError` | `POST /run` against an unverified version |
| any other | `SkrunApiError` | generic — check `err.code` and `err.status` |

The dispatch is extensible — future typed codes don't break existing
consumers that catch the base `SkrunApiError`.

## Naming convention

The first argument to most SDK methods is an `AgentIdentifier` — the
**registry-qualified reference** `<namespace>/<name>` (e.g.,
`"acme/seo-audit"`) or the equivalent `{ namespace, name }` object. The
SDK needs the full form because it constructs the registry URL
(`/api/agents/<namespace>/<name>/run`).

This is **distinct from `agent.yaml`'s `name` field**, which is slug-only
(e.g., `"seo-audit"`). The yaml only carries the slug — the namespace
is recorded by the registry at push time from the publisher's auth
context (the GitHub username on cloud, or `dev` in `dev-token` mode).
So the agent your `agent.yaml` calls `seo-audit` is reachable as
`alice/seo-audit` if pushed by Alice and `bob/seo-audit` if pushed by
Bob — same bundle, two registry entries.

## Methods

| Method | Purpose |
|--------|---------|
| `client.run(agent, input, opts?)` | Synchronous invoke; returns `SdkRunResult` |
| `client.stream(agent, input, opts?)` | SSE-streaming invoke (async iterable of `RunEvent`) |
| `client.runAsync(agent, input, webhookUrl, opts?)` | Async invoke with webhook delivery |
| `client.push(agent, bundle, version, opts?)` | Upload an `.agent` bundle |
| `client.pull(agent, version?)` | Download a bundle |
| `client.getAgent(agent)` | Get metadata |
| `client.getVersions(agent)` | List version strings |
| `client.list(opts?)` | List agents (paginated) |
| `client.verifyVersion(agent, version, verified)` | Flip per-version verified flag (admin only) |

See [docs/api.md](https://github.com/skrun-dev/skrun/blob/main/docs/api.md) for the wire format and [docs/concepts.md](https://github.com/skrun-dev/skrun/blob/main/docs/concepts.md) for the architecture.

## License

MIT
