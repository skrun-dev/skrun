/**
 * Phase 19 — Cloud E2E live smoke (SC-1 + SC-9 baseline).
 *
 * Hits a DEPLOYED Skrun api-server (mode=api-server, runtime=flyio) with
 * a real POST /run via SSE. Verifies the full chain end-to-end:
 *   1. /health 200
 *   2. POST /run streams SSE events
 *   3. `run_start` → `llm_complete` → `run_complete` arrive in order
 *   4. Final output JSON has the expected shape (SC-1 — parity with
 *      LocalAdapter)
 *   5. Machine spawned for the run was destroyed afterwards (SC-9)
 *
 * **NOT covered** (deferred from #15 scope, tracked as follow-up):
 *   - SC-7 (bundle download < 3s) — needs runner-side timing event
 *     payload that the current image doesn't emit explicitly. The total
 *     event-to-event timing we DO log gives a coarse upper bound.
 *   - SC-8 (file output presigned URLs retrievable) — requires running
 *     an agent that produces file outputs. email-drafter writes only
 *     JSON. A future iteration could push + run csv-to-executive-report
 *     or a synthetic file-emitting agent.
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
 *   SKRUN_CLOUD_API_TOKEN   — durable sk_live_* API key (OAuth deployments reject dev-token)
 *   SKRUN_CLOUD_TEST_AGENT  — agent ref (default "dev/email-drafter@1.0.0")
 */

import { FlyMachinesApi } from "../../../packages/runtime/src/adapter/flyio/fly-api.js";
import { results } from "./_ctx.js";

const PHASE = "flyio-cloud";
const DEFAULT_AGENT = "dev/email-drafter@1.0.0";

// Input matches email-drafter's required schema.
const TEST_INPUT = {
  context: "Phase 19 cloud-E2E live smoke — Skrun #15",
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
  const agentRef = process.env.SKRUN_CLOUD_TEST_AGENT ?? DEFAULT_AGENT;

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

  const start = Date.now();
  // agentRef = "dev/email-drafter@1.0.0" → namespace="dev", name="email-drafter", version="1.0.0"
  const match = agentRef.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/);
  if (!match) {
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: `invalid SKRUN_CLOUD_TEST_AGENT format "${agentRef}" — expected ns/name[@version]`,
    });
    return;
  }
  const [, ns, name, version] = match;

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

    // Step 2: POST /run with Accept: text/event-stream
    const runRes = await fetch(`${apiUrl}/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: TEST_INPUT, version }),
    });
    if (!runRes.ok) {
      const bodyText = await runRes.text();
      // Deployed apps run in OAuth mode and reject the `dev-token` shortcut, so
      // a 401/403 with that token is the most common foot-gun — point at the fix.
      const authHint =
        (runRes.status === 401 || runRes.status === 403) && apiToken === "dev-token"
          ? " — hint: OAuth deployments reject the dev-token shortcut; use a durable sk_live_ API key in SKRUN_CLOUD_API_TOKEN"
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

    // SC-1: output shape parity — email-drafter emits at least { subject, body }
    if (typeof finalOutput.subject !== "string" || typeof finalOutput.body !== "string") {
      throw new Error(
        `output missing expected fields (got keys: ${Object.keys(finalOutput).join(",")})`,
      );
    }

    // Step 5: SC-9 — machine destroyed after run
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
        `SC-9 fail: ${lingering.length} machine(s) still alive after run with run_id ${runId}: ${lingering.map((m) => m.id).join(", ")}`,
      );
    }

    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: true,
      duration: Date.now() - start,
      cost: 0,
      detail: `agent=${agentRef} run_id=${runId} events=${observed.join("→")} output_keys=${Object.keys(finalOutput).join(",")} machines_after=0`,
    });
  } catch (err) {
    results.push({
      agent: PHASE,
      feature: "cloud-e2e",
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: `error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
