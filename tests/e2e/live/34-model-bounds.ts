/**
 * Phase 34 — the bounds on what a model returns end a run by name, on the live
 * registry.
 *
 * No model a provider serves can be made to cross them on purpose: the phase
 * declares an endpoint of its own in `model.base_url` — the fake endpoint
 * compatible with OpenAI's chat completions that the Level-2 suite uses
 * (`../fake-model-endpoint.ts`), started in the suite's process on the loopback
 * address — and runs one agent four times through the event stream, each time
 * against replies scripted to cross one bound:
 *
 *   - an answer that asks for one tool call more than a turn may carry:
 *     `TOO_MANY_TOOL_CALLS`;
 *   - a response one byte larger than one may weigh: `MODEL_RESPONSE_TOO_LARGE`;
 *   - a first answer the output schema refuses, then its repair, together
 *     heavier than a run keeps of them: `MODEL_OUTPUT_BUDGET_EXCEEDED`;
 *   - a final answer whose JSON object weighs one byte more than an output may
 *     before it is parsed: `OUTPUT_TOO_LARGE`.
 *
 * Each line prints the code the run ended on, and the number of requests the
 * endpoint received: a green run is a measurement. The bounds are read from the
 * runtime's build, never written here.
 *
 * The registry is started again for this phase with
 * `SKRUN_ALLOW_LOCAL_MODEL_HOSTS=true` — a loopback endpoint is refused without
 * it — and started again as every other phase knows it at the end, whatever
 * happened. The restart lost the bundles pushed before it: the phase pushes its
 * own agent over HTTP with the suite's token, and deletes it first and last. It
 * runs on the local runtime, the suite's: on the other, each run would acquire
 * a machine. No model of a provider is called, no token spent.
 */

import { type ModelReply, startFakeModelEndpoint } from "../fake-model-endpoint.js";
import {
  REGISTRY,
  results,
  startRegistry,
  stopRegistry,
  TOKEN,
  verifyLatestVersion,
} from "./_ctx.js";

const NS = "dev";
const AGENT = "model-bounds";
const VERSION = "1.0.0";
/** The caller's own key for the agent's provider: the endpoint is the phase's, the key is never checked. */
const CALLER_KEY = JSON.stringify({ openai: "sk-fake-caller-key" });

/** The agent: its model the fake endpoint, its output a number — a text answer is refused, and repaired. */
function agentYaml(baseUrl: string): string {
  return [
    `name: ${AGENT}`,
    `version: ${VERSION}`,
    "model:",
    "  provider: openai",
    "  name: fake-model",
    `  base_url: ${baseUrl}`,
    "inputs:",
    "  - name: q",
    "    type: string",
    "outputs:",
    "  - name: result",
    "    type: number",
    "environment:",
    "  timeout: 60s",
  ].join("\n");
}

/** The `event:` / `data:` blocks of an event stream, the data parsed. */
function parseStream(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6).trim();
    }
    if (!event || !data) continue;
    try {
      events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // A block that is not JSON is not an event this phase reads.
    }
  }
  return events;
}

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function record(feature: string, passed: boolean, detail: string, started: number): void {
  results.push({ agent: AGENT, feature, passed, duration: Date.now() - started, cost: 0, detail });
}

export async function run(): Promise<void> {
  console.log(
    "Testing the bounds on what a model returns (a fake endpoint behind model.base_url)...",
  );
  const { MAX_TOOL_CALLS_PER_TURN, MODEL_RESPONSE_MAX_BYTES, RUN_MODEL_OUTPUT_MAX_BYTES } =
    await import("../../../packages/runtime/dist/llm/router.js");
  const { OUTPUT_PARSE_MAX_BYTES } = await import(
    "../../../packages/runtime/dist/adapter/agent-loop.js"
  );
  const { packAgentTar } = await import("../../../packages/schema/dist/index.js");

  // A valid output, padded to one byte past the bound on an output.
  const head = '{"result":1,"pad":"';
  const tail = '"}';
  const tooLarge = `${head}${"a".repeat(OUTPUT_PARSE_MAX_BYTES + 1 - head.length - tail.length)}${tail}`;
  const cases: Array<{ code: string; feature: string; replies: ModelReply[] }> = [
    {
      code: "TOO_MANY_TOOL_CALLS",
      feature: `an answer asking for ${MAX_TOOL_CALLS_PER_TURN + 1} tool calls in one turn ends the run on TOO_MANY_TOOL_CALLS`,
      replies: [{ kind: "toolCalls", count: MAX_TOOL_CALLS_PER_TURN + 1 }],
    },
    {
      code: "MODEL_RESPONSE_TOO_LARGE",
      feature: `a response of the endpoint larger than ${MODEL_RESPONSE_MAX_BYTES} bytes ends the run on MODEL_RESPONSE_TOO_LARGE`,
      replies: [{ kind: "oversized", contentBytes: MODEL_RESPONSE_MAX_BYTES + 1 }],
    },
    {
      code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
      feature: `answers weighing more than ${RUN_MODEL_OUTPUT_MAX_BYTES} bytes in a run — a refused answer, then its repair — end the run on MODEL_OUTPUT_BUDGET_EXCEEDED`,
      replies: [
        { kind: "answer", content: "a".repeat((RUN_MODEL_OUTPUT_MAX_BYTES * 3) / 4) },
        { kind: "answer", content: "b".repeat(RUN_MODEL_OUTPUT_MAX_BYTES / 2) },
      ],
    },
    {
      code: "OUTPUT_TOO_LARGE",
      feature: `a final answer whose JSON object weighs ${OUTPUT_PARSE_MAX_BYTES + 1} bytes ends the run on OUTPUT_TOO_LARGE`,
      replies: [{ kind: "answer", content: tooLarge }],
    },
  ];

  const endpoint = await startFakeModelEndpoint();
  const setupStarted = Date.now();
  try {
    stopRegistry();
    await startRegistry({ extraEnv: { SKRUN_ALLOW_LOCAL_MODEL_HOSTS: "true" } });
    console.log("  registry started again with SKRUN_ALLOW_LOCAL_MODEL_HOSTS");

    await deleteAgent();
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml(endpoint.baseUrl)) },
      { name: "SKILL.md", content: Buffer.from(`# ${AGENT}\n\nAnswer with a JSON object.\n`) },
    ]);
    const pushed = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/push?version=${VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    await pushed.text();
    if (pushed.status !== 200) {
      record(
        "setup: the agent at the fake endpoint is pushed",
        false,
        `push=${pushed.status}`,
        setupStarted,
      );
      return;
    }
    await verifyLatestVersion(NS, AGENT);

    for (const c of cases) {
      const started = Date.now();
      const before = endpoint.requests.length;
      endpoint.script(c.replies);
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-LLM-API-Key": CALLER_KEY,
        },
        body: JSON.stringify({ input: { q: "hello" } }),
      });
      const events = parseStream(await res.text());
      const last = events.at(-1);
      const error = last?.data.error as { code?: unknown } | undefined;
      const code = typeof error?.code === "string" ? error.code : undefined;
      const requests = endpoint.requests.length - before;
      record(
        c.feature,
        res.status === 200 && last?.event === "run_error" && code === c.code,
        `status=${res.status} last_event=${last?.event ?? "absent"} code=${code ?? "absent"} ` +
          `expected=${c.code} endpoint_requests=${requests}`,
        started,
      );
    }
  } finally {
    await deleteAgent().catch(() => {});
    await endpoint.close();
    // The registry again as every other phase knows it.
    const restarted = Date.now();
    stopRegistry();
    try {
      await startRegistry();
      record("the registry runs again as the other phases know it", true, "health=ok", restarted);
    } catch (err) {
      record(
        "the registry runs again as the other phases know it",
        false,
        err instanceof Error ? err.message : String(err),
        restarted,
      );
    }
  }
}
