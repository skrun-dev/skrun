/**
 * Phase 19 — Cloud E2E live smoke: the output's shape, and the machine's teardown.
 *
 * Hits a DEPLOYED Skrun api-server (mode=api-server, runtime=flyio) with
 * a real POST /run via SSE. Verifies the full chain end-to-end:
 *   1. /health 200
 *   2. POST /run streams SSE events
 *   3. `run_start` → `llm_complete` → `run_complete` arrive in order
 *   4. Final output JSON has the expected shape (the same as the local
 *      runtime's)
 *   5. Machine spawned for the run was destroyed afterwards
 *
 * **NOT covered here**:
 *   - How long the bundle download takes: the `/init` phases of the
 *     `runner_spawned` event carry it (`init_bundle_ms`), but this phase
 *     asserts no bound on it.
 *   - Downloading a run's output files: email-drafter writes only JSON.
 *     Running an agent that produces files (csv-to-executive-report, or a
 *     synthetic file-emitting agent) would cover it.
 *
 * Cloud-only — run on demand via `pnpm cloud:e2e:smoke` (NOT part of
 * `pnpm test:e2e:live`, the local-registry regression). SKIPs cleanly when
 * any of the live-cloud secrets below are missing.
 *
 * Required env:
 *   FLY_API_TOKEN           — used to verify the spawned machine was destroyed
 *   FLY_TEST_APP_NAME       — sandbox runners app (same as production SKRUN_RUNNERS_APP)
 *   SKRUN_CLOUD_API_URL     — base URL of the deployed api-server
 *                             (e.g. https://skrun-cloud-api-test.fly.dev)
 *   SKRUN_CLOUD_API_TOKEN   — an API key (OAuth deployments reject dev-token)
 *   <PROVIDER>_API_KEY      — the caller's model key, sent in X-LLM-API-Key: a cloud
 *                             server carries no model key of its own. Absent, the
 *                             phase is skipped and says so.
 * Optional env:
 *   SKRUN_CLOUD_CALLER_PROVIDER — the provider of that key (default "google", the
 *                             default agent's primary model)
 *   SKRUN_CLOUD_TEST_AGENT  — agent ref ns/name[@version]. Default: email-drafter, in
 *                             the namespace of the token's account (GET /api/me), at
 *                             the version agents/email-drafter/agent.yaml carries —
 *                             derived, so no account name is written here and no
 *                             version goes stale.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FlyMachinesApi } from "../../../packages/runtime/src/adapter/flyio/fly-api.js";
import { ROOT, results } from "./_ctx.js";

const PHASE = "flyio-cloud";

/** The default agent: a demo whose version is read from the repository. */
const DEFAULT_AGENT_NAME = "email-drafter";
const DEFAULT_CALLER_PROVIDER = "google";

/** The top-level `version:` of an agent.yaml. */
function repositoryVersion(agentName: string): string {
  const yaml = readFileSync(join(ROOT, "agents", agentName, "agent.yaml"), "utf-8");
  const match = /^version:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(yaml);
  if (!match) throw new Error(`agents/${agentName}/agent.yaml carries no top-level version`);
  return match[1];
}

/** The namespace of the account the token belongs to. */
async function tokenNamespace(apiUrl: string, apiToken: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/me`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) throw new Error(`GET /api/me returned ${res.status} — is the token valid here?`);
  const me = (await res.json()) as { namespace?: unknown };
  if (typeof me.namespace !== "string" || me.namespace === "") {
    throw new Error("GET /api/me returned no namespace");
  }
  return me.namespace;
}

// Input matches email-drafter's required schema.
const TEST_INPUT = {
  context: "Phase 19 cloud-E2E live smoke — Skrun",
  tone: "friendly",
  recipient: "engineering colleague",
};

interface SseEvent {
  event: string;
  data: unknown;
}

async function* streamSseEvents(res: Response): AsyncIterable<SseEvent> {
  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = block.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      let parsed: unknown = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Keep raw string if not JSON (rare for SSE event payloads).
      }
      yield { event, data: parsed };
    }
  }
}

export async function run(): Promise<void> {
  const flyToken = process.env.FLY_API_TOKEN;
  const runnersApp = process.env.FLY_TEST_APP_NAME;
  const apiUrl = process.env.SKRUN_CLOUD_API_URL;
  const apiToken = process.env.SKRUN_CLOUD_API_TOKEN;

  if (!flyToken || !runnersApp || !apiUrl || !apiToken) {
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: true,
      duration: 0,
      cost: 0,
      detail:
        "skipped — set FLY_API_TOKEN + FLY_TEST_APP_NAME + SKRUN_CLOUD_API_URL + SKRUN_CLOUD_API_TOKEN to run",
    });
    return;
  }

  // The caller's key: the server holds none, as in production. The provider
  // name is checked before use and never echoed — a key pasted there by mistake
  // would otherwise land in the report.
  const provider = (process.env.SKRUN_CLOUD_CALLER_PROVIDER ?? DEFAULT_CALLER_PROVIDER)
    .trim()
    .toLowerCase();
  const start = Date.now();
  if (!/^[a-z][a-z0-9]{1,31}$/.test(provider)) {
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: false,
      duration: 0,
      cost: 0,
      detail: "SKRUN_CLOUD_CALLER_PROVIDER is not a provider name (lowercase letters and digits)",
    });
    return;
  }
  const keyVar = `${provider.toUpperCase()}_API_KEY`;
  const callerKey = process.env[keyVar]?.trim();
  if (!callerKey) {
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: true,
      duration: 0,
      cost: 0,
      detail: `skipped — no caller key: set ${keyVar} (the server carries no model key), or SKRUN_CLOUD_CALLER_PROVIDER and that provider's key`,
    });
    return;
  }

  let agentRef = process.env.SKRUN_CLOUD_TEST_AGENT ?? `<account>/${DEFAULT_AGENT_NAME}`;
  try {
    // Step 1: /health 200 — surface a clear hint when the deployed app is
    // offline (e.g. parked / scaled to 0) instead of a raw fetch error.
    let healthRes: Response;
    try {
      healthRes = await fetch(`${apiUrl}/health`);
    } catch (e) {
      throw new Error(
        `cannot reach ${apiUrl}/health (${e instanceof Error ? e.message : String(e)}) — is the deployed app awake? wake it (or check SKRUN_CLOUD_API_URL)`,
      );
    }
    if (!healthRes.ok) {
      throw new Error(
        `/health returned ${healthRes.status} at ${apiUrl} — app may be unhealthy or parked`,
      );
    }

    // The agent: the one named, or the default derived from the account and
    // the repository — "<ns>/email-drafter@<version of its agent.yaml>".
    agentRef =
      process.env.SKRUN_CLOUD_TEST_AGENT ??
      `${await tokenNamespace(apiUrl, apiToken)}/${DEFAULT_AGENT_NAME}@${repositoryVersion(DEFAULT_AGENT_NAME)}`;
    const match = agentRef.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/);
    if (!match) {
      throw new Error(
        `invalid SKRUN_CLOUD_TEST_AGENT format "${agentRef}" — expected ns/name[@version]`,
      );
    }
    const [, ns, name, version] = match;

    // Step 2: POST /run with Accept: text/event-stream, and the caller's key
    const runRes = await fetch(`${apiUrl}/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        Accept: "text/event-stream",
        "X-LLM-API-Key": JSON.stringify({ [provider]: callerKey }),
      },
      body: JSON.stringify({ input: TEST_INPUT, version }),
    });
    if (!runRes.ok) {
      const bodyText = await runRes.text();
      // Deployed apps run in OAuth mode and reject the `dev-token` shortcut, so
      // a 401/403 with that token is the most common foot-gun — point at the fix.
      const authHint =
        (runRes.status === 401 || runRes.status === 403) && apiToken === "dev-token"
          ? " — hint: OAuth deployments reject the dev-token shortcut; use an API key in SKRUN_CLOUD_API_TOKEN"
          : "";
      throw new Error(`POST /run returned ${runRes.status}${authHint}: ${bodyText}`);
    }

    // Step 3 + 4: stream events, assert sequence + final output shape
    const observed: string[] = [];
    let runId: string | null = null;
    let finalOutput: Record<string, unknown> | null = null;
    let runError: unknown = null;

    for await (const evt of streamSseEvents(runRes)) {
      observed.push(evt.event);
      const dataObj = (typeof evt.data === "object" && evt.data !== null ? evt.data : {}) as Record<
        string,
        unknown
      >;
      if (evt.event === "run_start" && typeof dataObj.run_id === "string") {
        runId = dataObj.run_id;
      }
      if (evt.event === "run_complete" && typeof dataObj.output === "object" && dataObj.output) {
        finalOutput = dataObj.output as Record<string, unknown>;
      }
      if (evt.event === "run_error") {
        runError = dataObj.error;
      }
    }

    if (runError) {
      throw new Error(`run_error event: ${JSON.stringify(runError).slice(0, 200)}`);
    }
    if (!runId) throw new Error("never received a run_start event with a run_id");
    if (!finalOutput) throw new Error("never received run_complete with output");
    if (!observed.includes("run_complete")) {
      throw new Error(`SSE stream ended before run_complete (events: ${observed.join(",")})`);
    }

    // Output shape, the same as the local runtime's — email-drafter emits at least { subject, body }
    if (typeof finalOutput.subject !== "string" || typeof finalOutput.body !== "string") {
      throw new Error(
        `output missing expected fields (got keys: ${Object.keys(finalOutput).join(",")})`,
      );
    }

    // Step 5: the machine is destroyed after the run
    // Best-effort: list machines on the runners app, assert none remain
    // bearing the runId prefix. (Other live phases might have left orphans
    // but they should NOT match `skrun-run-${runId}-*`.)
    const flyApi = new FlyMachinesApi(flyToken, runnersApp);
    const machines = await flyApi.list();
    const lingering = machines.filter(
      (m) => typeof m.name === "string" && m.name.includes(runId as string),
    );
    if (lingering.length > 0) {
      throw new Error(
        `machine teardown failed: ${lingering.length} machine(s) still alive after run with run_id ${runId}: ${lingering.map((m) => m.id).join(", ")}`,
      );
    }

    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: true,
      duration: Date.now() - start,
      cost: 0,
      detail: `agent=${agentRef} caller_key=${provider} run_id=${runId} events=${observed.join("→")} output_keys=${Object.keys(finalOutput).join(",")} machines_after=0`,
    });
  } catch (err) {
    // A server error can quote what it was sent; the key never reaches the report.
    const message = (err instanceof Error ? err.message : String(err)).replaceAll(
      callerKey,
      "[redacted]",
    );
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: `agent=${agentRef} caller_key=${provider} error: ${message}`,
    });
  }
}
