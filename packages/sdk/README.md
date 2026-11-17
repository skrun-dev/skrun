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
    // Under the server's default `admin` verification policy, the resolved
    // version is not verified yet: an admin runs `skrun verify acme/my-agent@<version>`.
    console.error(`Agent not verified: ${err.message}`);
  } else {
    throw err;
  }
}
```

**Every runtime, the `flyio` one included**: `client.run()` reads the run's event stream and returns its result once the run ends — the same result a blocking call returns, save for a run the server's stop ended, or its deadline, which it returns `failed` where the blocking call answers `503 SERVER_STOPPED` or `504 DEADLINE_EXCEEDED`. A run that fails once started comes back with `status: "failed"` and its `error`; a request refused before the run starts throws `SkrunApiError`. Only the raw API's blocking call (a `POST /run` with neither `Accept: text/event-stream` nor a `webhook_url`) is refused on `flyio`, with `400 SYNC_MODE_UNSUPPORTED`, before the run starts — nothing of it is written, and no run appears in the history. See [Runtime selection](https://github.com/skrun-dev/skrun/blob/main/docs/self-hosting.md#runtime-selection-skrun_runtime).

## Timeouts

The `timeout` option — on the client (`new SkrunClient({ ..., timeout })`) or on a call (`{ timeout }`), in milliseconds, default `60000` — does not mean the same thing for every method:

- **`client.run()` and `client.stream()`**: the longest **silence** allowed — the wait for the server's answer, then the gap between two chunks of the event stream. A run can last as long as it needs: while it waits on a model, a tool or a cold start, the server sends a heartbeat about every 30 s, and each one starts the silence over. A silence longer than the timeout throws `SkrunApiError` with `code: "TIMEOUT"`.
- **Every other call** (`runAsync()`, `push()`, `pull()`, `list()`…): the whole request, answer and body included.

## Binary inputs and live uploads

`client.run()`, `client.stream()` and `client.runAsync()` take `Blob`, `File` and `Uint8Array` values for file inputs: each one is uploaded with `POST /api/files` before the run and replaced by its `file_id` reference. **They never delete what they upload.** An upload is kept for the server's retention — 24 hours by default — and, on a server that bounds an account's live uploads, counts against the account until it expires or is deleted, whether the run completed, failed or was refused. With a limit of 50, an account that lets these methods upload one file per run can run about 50 such runs per 24 hours; the next upload is refused with `SkrunInputFilesLimitError` (the `cause` of a `SkrunFileUploadError`) until enough of them expire or are deleted.

To free its place once the run is over, upload the file yourself, run with its reference, then delete it:

```ts
const receipt = await client.uploadFile(blob, { filename: "receipt.jpg" });
try {
  const result = await client.run("acme/receipts", {
    receipt: [{ type: "file", source: "id", file_id: receipt.file_id }],
  });
  console.log(result.output);
} finally {
  await client.deleteFile(receipt.file_id);
}
```

A deleted upload is gone: a later run that names its `file_id` — a re-run of this run from the dashboard included — is refused `404 FILE_NOT_FOUND`. A full-access key deletes any upload of its account; any other key, only the files it uploaded.

## Verification

Verification is **per version**. Each version of an agent has its own
`verified` flag, and the server's verification policy
(`SKRUN_VERIFICATION_POLICY`) decides what it does and who may set it:

- **`admin`** (the default): `POST /run` returns `403 AGENT_NOT_VERIFIED`
  for a version until an admin verifies it — the whole run is refused,
  scripts included; only an admin may verify.
- **`owner`** and **`disabled`**: every version runs, scripts included;
  the agent's owner (or an admin) may set the flag, which records an
  attestation.

```ts
// Verify a specific version (who may: see the policy above)
await client.verifyVersion("acme/my-agent", "1.0.0", true);

// Revoke
await client.verifyVersion("acme/my-agent", "1.0.0", false);
```

By default an agent is **private** — only its owner (or an admin) can call
`POST /run`, and anyone else gets a `404` identical to a missing agent:

```ts
await client.setVisibility("acme/my-agent", "private");
```

Setting an agent `"public"` is **disabled for now** —
the call is rejected with `400 PUBLIC_VISIBILITY_DISABLED`. To let an outside
caller run one of your agents today, mint an **agent-scoped API key**
instead: they run that agent and nothing else, with no Skrun account.

Pushing a new version doesn't touch the verified state of prior versions
— under `admin`, pinned production callers (`client.run(..., { version: "1.0.0" })`)
keep running while admins review the new version separately.

## Typed errors

`SkrunApiError.fromResponse` dispatches on the server's `error.code` to
typed subclasses. Today:

| Code | Class | When |
|------|-------|------|
| `AGENT_NOT_VERIFIED` | `SkrunNotVerifiedError` | `POST /run` against an unverified version |
| `CONCURRENCY_LIMIT_REACHED` | `SkrunConcurrencyLimitError` | `429`: the account already has as many runs in progress as its plan allows |
| `COMPUTE_QUOTA_EXCEEDED` | `SkrunComputeQuotaError` | `429`: the account used its plan's compute time for the current window |
| `CAPACITY_EXHAUSTED` | `SkrunCapacityError` | `503`: the server is at full capacity |
| `TIMEOUT_ABOVE_LIMIT` | `SkrunTimeoutAboveLimitError` | `400`: the agent, or the run's environment override, declares a timeout above the server's maximum — at a run, or at the agent's push |
| `STORAGE_QUOTA_EXCEEDED` | `SkrunStorageQuotaError` | `413`: a push would take the account's bundles past its plan's storage; nothing of it is stored |
| `INPUT_FILES_LIMIT_REACHED` | `SkrunInputFilesLimitError` | `429`: the account already holds as many live uploads as its plan allows |
| `REDIRECT_REFUSED` | `SkrunApiError` | any `3xx` — set by the client, not the server: it never follows a redirect, so the target receives nothing (no token, model key or body); the message names the target's origin, and `status` is the code received (`0` in a browser, which does not reveal the target) |
| any other | `SkrunApiError` | generic — check `err.code` and `err.status` |

The six quota and capacity classes carry `retryAfterSeconds`, read from the
server's `Retry-After` header: how long to wait before trying again
(undefined for `TIMEOUT_ABOVE_LIMIT` and `STORAGE_QUOTA_EXCEEDED`, where
waiting changes nothing — a deleted version, or for an agent's last version
the deleted agent, makes room for a push). An
upload's refusal, from `client.uploadFile()` or from `client.run()`,
`client.stream()` or `client.runAsync()`, which upload their binary inputs,
comes as the `cause` of the `SkrunFileUploadError` they throw:

```ts
try {
  await client.uploadFile(photo);
} catch (err) {
  if (err instanceof SkrunFileUploadError && err.cause instanceof SkrunInputFilesLimitError) {
    // wait err.cause.retryAfterSeconds, or free a place sooner: delete uploads of
    // yours with client.deleteFile(fileId) until the account holds fewer than its
    // limit — one at the limit, more for an account over it, its plan lowered
    // (see Binary inputs and live uploads)
  }
}
```

Which account a run counts against, how its compute time is charged, and the
account's numbers in the `X-Quota-*` response headers: see
[Quotas](https://github.com/skrun-dev/skrun/blob/main/docs/api.md#quotas). The same
numbers, at any time: `client.usage()`.

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
context (by default the GitHub login on cloud, or `dev` in `dev-token`
mode).
So the agent your `agent.yaml` calls `seo-audit` is reachable as
`alice/seo-audit` if pushed by Alice and `bob/seo-audit` if pushed by
Bob — same bundle, two registry entries.

## Methods

| Method | Purpose |
|--------|---------|
| `client.run(agent, input, opts?)` | Invoke and wait for the result; returns `SdkRunResult` (read from the event stream, so it works on every runtime, see above) |
| `client.stream(agent, input, opts?)` | SSE-streaming invoke (async iterable of `RunEvent`); leaving the loop early (`break`) closes the connection — on the cloud runtime that cancels the run, as any disconnection does; on the local runtime the run goes on to its end |
| `client.runAsync(agent, input, webhookUrl, opts?)` | Async invoke with webhook delivery |
| `client.uploadFile(blob, opts?)` | Upload a binary input to `POST /api/files`; returns its `file_id` and `expires_at` (see [Binary inputs and live uploads](#binary-inputs-and-live-uploads)) |
| `client.deleteFile(fileId)` | Delete an upload (`DELETE /api/files/:id`) — its place among the account's live uploads frees at once |
| `client.push(agent, bundle, version, opts?)` | Upload an `.agent` bundle |
| `client.pull(agent, version?)` | Download a bundle — takes a full-access key (all three operations, account-wide): a run-only key, or one restricted to some agents, gets `403 KEY_SCOPE_FORBIDDEN` |
| `client.getAgent(agent)` | Get metadata |
| `client.getVersions(agent)` | List version strings |
| `client.list(opts?)` | List agents (paginated) |
| `client.verifyVersion(agent, version, verified)` | Flip per-version verified flag (admin only) |
| `client.setVisibility(agent, visibility)` | Set agent visibility. Only `"private"` is accepted today — `"public"` returns `400 PUBLIC_VISIBILITY_DISABLED` for now |
| `client.usage()` | What your account consumes now against its quotas (`UsageResponse`): its plan, its runs in progress, its compute in the current window, its fast runs of the hour while the server's pre-warm pool runs; `quotas` is `null` on a server that sets none. Takes a full-access key — any other gets `403 KEY_SCOPE_FORBIDDEN` |

See [docs/api.md](https://github.com/skrun-dev/skrun/blob/main/docs/api.md) for the wire format and [docs/concepts.md](https://github.com/skrun-dev/skrun/blob/main/docs/concepts.md) for the architecture.

## License

MIT
