/**
 * E2E: a model behind `model.base_url`, through the run route, on both runtimes.
 *
 * The agent declares a fake endpoint compatible with OpenAI's chat completions
 * on the loopback address (`fake-model-endpoint.ts`), and runs with a caller's
 * key, in an event stream — the `flyio` runtime runs no other way. What is
 * real: the route, the registry, the in-memory database, the router and its
 * guarded transport to the endpoint, the agent loop — and on the `flyio`
 * runtime the adapter's own run, from its first event to the release of its
 * machine. What is simulated on that runtime: the acquisition of the machine
 * (a spy on the built runtime's adapter, the module the API resolves, hands
 * back a machine ready, with no tool, whose runner is the fake runner of
 * `fake-model-endpoint.ts`), its destruction (a spy that resolves), and the
 * runtime's other dependencies (the in-memory ones of the route's own tests,
 * whose machines API is watched: nothing of it is read).
 *
 * A local endpoint takes `SKRUN_ALLOW_LOCAL_MODEL_HOSTS=true`, set for each
 * case and removed after it.
 *
 * The bounds on what the model returns end a run by name, the same way on both
 * runtimes: an answer that asks for more tool calls than one turn may carry
 * (the agent declares no tool: the bound holds all the same); a run whose
 * answers weigh more than a run keeps of them — a first answer the output
 * schema refuses, then its repair; a final answer whose JSON object weighs more
 * than an output may before it is parsed. Each bound is read from the runtime's
 * build, never written here. A stopped call ends the run before its answer is
 * read: the agent loop finds an answer's JSON object through one function of
 * the built runtime, replaced by a pass-through that notes the length of each
 * text it is handed — a call the router stopped hands it nothing.
 *
 * The endpoint's body is bounded too, by the guarded transport: a response
 * larger than one may weigh ends the run on its own code, asked for once, the
 * endpoint's address never in the message; a body that never ends is read no
 * longer than the run's timeout — the run ends on it, and the endpoint sees its
 * connection closed within a second of the deadline.
 *
 * Last, what the route refuses before any of that: a required file input sent
 * as an empty list counts as missing, on both runtimes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import { fakeFlyioDeps } from "../../packages/api/src/routes/flyio-run-harness.shared.js";
import type { FlyioRuntimeDeps } from "../../packages/api/src/runtime/adapter-selection.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { OUTPUT_PARSE_MAX_BYTES } from "../../packages/runtime/dist/adapter/agent-loop.js";
import { FlyioAdapter } from "../../packages/runtime/dist/index.js";
import {
  MAX_TOOL_CALLS_PER_TURN,
  MODEL_RESPONSE_MAX_BYTES,
  RUN_MODEL_OUTPUT_MAX_BYTES,
} from "../../packages/runtime/dist/llm/router.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import {
  type FakeModelEndpoint,
  type FakeRunner,
  startFakeModelEndpoint,
  startFakeRunner,
} from "./fake-model-endpoint.js";

/** The length of each text the agent loop handed to the extraction of an answer's JSON object, in order. */
const extraction = vi.hoisted(() => ({ lengths: [] as number[] }));

vi.mock("../../packages/runtime/dist/utils/json-slice.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/runtime/dist/utils/json-slice.js")>();
  return {
    ...actual,
    jsonObjectSlice: (text: string) => {
      extraction.lengths.push(text.length);
      return actual.jsonObjectSlice(text);
    },
  };
});

type Runtime = "local" | "flyio";

const NS = "dev";
const TOKEN = "dev-token";
const VERSION = "1.0.0";
/** The caller's own key for the agent's provider: the run needs no key of the server. */
const CALLER_KEY = JSON.stringify({ openai: "sk-fake-caller-key" });
/** How long a case may take: well past the timeout of any agent below, so a case ends on its assertions. */
const CASE_TIMEOUT_MS = 30_000;

/** The adapter's steps a spy replaces: its machine's acquisition and destruction. */
interface MachineSteps {
  acquireRunner(...args: unknown[]): Promise<unknown>;
  destroyMachineSafely(...args: unknown[]): Promise<void>;
}

/** One case's server. */
interface World {
  app: ReturnType<typeof createApp>;
  db: MemoryDb;
  /** Each property of the machines API the run read — none is expected. */
  machinesApiReads: string[];
}

function world(runtime: Runtime): World {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const machinesApiReads: string[] = [];
  if (runtime === "local") {
    return { app: createApp(storage, db, { runtimeMode: "local" }), db, machinesApiReads };
  }
  const flyApi = new Proxy(
    {},
    {
      get(_target, property) {
        machinesApiReads.push(String(property));
        return undefined;
      },
    },
  ) as FlyioRuntimeDeps["flyApi"];
  const app = createApp(storage, db, {
    runtimeMode: "flyio",
    flyioDeps: { ...fakeFlyioDeps(storage), flyApi },
  });
  return { app, db, machinesApiReads };
}

/** The input every agent below declares, unless a case declares its own. */
const TEXT_INPUT = ["  - name: q", "    type: string"];

/** Push an agent whose model is the fake endpoint, then mark its version verified. */
async function pushAgent(
  w: World,
  name: string,
  endpoint: FakeModelEndpoint,
  opts: { timeout?: string; inputs?: string[] } = {},
): Promise<void> {
  const agentYaml = [
    `name: ${name}`,
    `version: ${VERSION}`,
    "model:",
    "  provider: openai",
    "  name: fake-model",
    `  base_url: ${endpoint.baseUrl}`,
    "inputs:",
    ...(opts.inputs ?? TEXT_INPUT),
    "outputs:",
    "  - name: result",
    "    type: number",
    "environment:",
    `  timeout: ${opts.timeout ?? "10s"}`,
  ].join("\n");
  const bundle = await packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`# ${name}\n\nAnswer with a JSON object.\n`) },
  ]);
  const res = await w.app.request(`/api/agents/${NS}/${name}/push?version=${VERSION}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bundle),
  });
  expect(res.status).toBe(200);
  await w.db.setVersionVerified(NS, name, VERSION, true);
}

/** One event of a run's stream, with the instant it was read. */
interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
  at: number;
}

/** `POST /run`, asking for an event stream, with the caller's key. */
function postRun(
  w: World,
  name: string,
  input: Record<string, unknown> = { q: "hello" },
): Promise<Response> {
  return w.app.request(`/api/agents/${NS}/${name}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-LLM-API-Key": CALLER_KEY,
    },
    body: JSON.stringify({ input }),
  });
}

/** `POST /run` in an event stream, each event read as it arrives. */
async function runStreamed(
  w: World,
  name: string,
): Promise<{ status: number; events: StreamEvent[] }> {
  const res = await postRun(w, name);
  const events: StreamEvent[] = [];
  if (!res.body) return { status: res.status, events };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        if (line.startsWith("data: ")) data = line.slice("data: ".length);
      }
      if (data) events.push({ event, data: JSON.parse(data), at: Date.now() });
    }
  }
  return { status: res.status, events };
}

/** The stream's event names, heartbeats left out. */
function names(events: StreamEvent[]): string[] {
  return events.map((e) => e.event).filter((name) => name !== "run_heartbeat");
}

/** The events a run of this runtime starts with, before its model is called. */
function opening(runtime: Runtime): string[] {
  return runtime === "flyio" ? ["run_start", "runner_spawned"] : ["run_start"];
}

let endpoint: FakeModelEndpoint;
let runner: FakeRunner;

beforeEach(async () => {
  extraction.lengths.length = 0;
  vi.stubEnv("SKRUN_ALLOW_LOCAL_MODEL_HOSTS", "true");
  endpoint = await startFakeModelEndpoint();
  runner = await startFakeRunner();
  const steps = FlyioAdapter.prototype as unknown as MachineSteps;
  vi.spyOn(steps, "acquireRunner").mockResolvedValue({
    machineId: "fake-machine",
    privateIp: "fdaa::f",
    runnerBaseUrl: runner.baseUrl,
    tools: [],
    rpcToken: "fake-rpc-token",
    phases: { create_api_ms: 1 },
  });
  vi.spyOn(steps, "destroyMachineSafely").mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await endpoint.close();
  await runner.close();
});

/** Each runtime, named as the titles of the route's own tests name it. */
const RUNTIMES: Array<[title: string, runtime: Runtime]> = [
  ["local", "local"],
  ["cloud", "flyio"],
];

describe.each(
  RUNTIMES,
)("E2E: a model behind model.base_url, through the run route, on the %s runtime", (_title, runtime) => {
  it(
    "a run whose model answers its output completes through the real loop",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `answers-${runtime}`, endpoint);
      endpoint.script([{ kind: "answer", content: '{"result":42}' }]);

      const { status, events } = await runStreamed(w, `answers-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([...opening(runtime), "llm_complete", "run_complete"]);
      expect(events.at(-1)?.data.output).toEqual({ result: 42 });
      // The answer's text went through the extraction the bounds below are read before.
      expect(extraction.lengths).toEqual(['{"result":42}'.length]);
      expect(endpoint.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /v1/chat/completions",
      ]);
      if (runtime === "flyio") {
        // The adapter read its runner's output files, then let its machine go.
        expect(runner.requests).toEqual(["POST /outputs/collect"]);
        const steps = FlyioAdapter.prototype as unknown as MachineSteps;
        expect(steps.destroyMachineSafely).toHaveBeenCalledTimes(1);
      } else {
        expect(runner.requests).toEqual([]);
      }
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "an answer asking for one tool call more than a turn may carry ends the run on TOO_MANY_TOOL_CALLS, before its answer is read",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `too-many-calls-${runtime}`, endpoint);
      endpoint.script([{ kind: "toolCalls", count: MAX_TOOL_CALLS_PER_TURN + 1 }]);

      const { status, events } = await runStreamed(w, `too-many-calls-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([...opening(runtime), "llm_complete", "run_error"]);
      const error = events.at(-1)?.data.error as { code?: string; message?: string };
      expect(error.code).toBe("TOO_MANY_TOOL_CALLS");
      expect(error.message).toContain(`${MAX_TOOL_CALLS_PER_TURN + 1} tool calls in one turn`);
      // One call of the model, and nothing of its answer read.
      expect(endpoint.requests).toHaveLength(1);
      expect(extraction.lengths).toEqual([]);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers weighing more than a run keeps of them — a refused first answer, then its repair — end the run on MODEL_OUTPUT_BUDGET_EXCEEDED, before the repair is read",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `output-budget-${runtime}`, endpoint);
      // Each under the bound on one response; together past the run's. The
      // first is text with no JSON object: its output, { result: <text> }, is
      // not the number the agent declares, so the repair is asked for.
      const first = "a".repeat((RUN_MODEL_OUTPUT_MAX_BYTES * 3) / 4);
      const repair = "b".repeat(RUN_MODEL_OUTPUT_MAX_BYTES / 2);
      endpoint.script([
        { kind: "answer", content: first },
        { kind: "answer", content: repair },
      ]);

      const { status, events } = await runStreamed(w, `output-budget-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([
        ...opening(runtime),
        "llm_complete",
        "output_validation_warning",
        "llm_complete",
        "run_error",
      ]);
      expect((events.at(-1)?.data.error as { code?: string }).code).toBe(
        "MODEL_OUTPUT_BUDGET_EXCEEDED",
      );
      expect(endpoint.requests).toHaveLength(2);
      // The first answer was read; the repair, stopped, never was.
      expect(extraction.lengths).toEqual([first.length]);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a final answer whose JSON object weighs one byte more than an output may ends the run on OUTPUT_TOO_LARGE",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `output-too-large-${runtime}`, endpoint);
      // A valid output, padded to one byte past the bound.
      const head = '{"result":1,"pad":"';
      const tail = '"}';
      const object = `${head}${"a".repeat(OUTPUT_PARSE_MAX_BYTES + 1 - head.length - tail.length)}${tail}`;
      expect(Buffer.byteLength(object)).toBe(OUTPUT_PARSE_MAX_BYTES + 1);
      endpoint.script([{ kind: "answer", content: object }]);

      const { status, events } = await runStreamed(w, `output-too-large-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([...opening(runtime), "llm_complete", "run_error"]);
      expect((events.at(-1)?.data.error as { code?: string }).code).toBe("OUTPUT_TOO_LARGE");
      expect(endpoint.requests).toHaveLength(1);
      expect(extraction.lengths).toEqual([object.length]);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a response of the endpoint one byte larger than one may weigh ends the run on MODEL_RESPONSE_TOO_LARGE, never EXECUTION_FAILED: asked for once, the endpoint's address in no word of it",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `response-too-large-${runtime}`, endpoint);
      endpoint.script([{ kind: "oversized", contentBytes: MODEL_RESPONSE_MAX_BYTES + 1 }]);

      const { status, events } = await runStreamed(w, `response-too-large-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([...opening(runtime), "llm_complete", "run_error"]);
      const error = events.at(-1)?.data.error as { code?: string; message?: string };
      expect(error.code).toBe("MODEL_RESPONSE_TOO_LARGE");
      expect(error.message).not.toContain(new URL(endpoint.baseUrl).host);
      // No retry: the refusal comes from the body, never from the request.
      expect(endpoint.requests).toHaveLength(1);
      expect(extraction.lengths).toEqual([]);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a body the endpoint never ends is read no longer than the run's timeout: the run ends on TIMEOUT, and the endpoint sees its connection closed within a second of the deadline",
    async () => {
      const timeoutS = 2;
      const w = world(runtime);
      await pushAgent(w, `endless-body-${runtime}`, endpoint, { timeout: `${timeoutS}s` });
      endpoint.script([{ kind: "drip" }]);
      const sent = Date.now();

      const { status, events } = await runStreamed(w, `endless-body-${runtime}`);

      expect(status).toBe(200);
      expect(names(events)).toEqual([...opening(runtime), "run_error"]);
      const end = events.at(-1);
      expect((end?.data.error as { code?: string }).code).toBe("TIMEOUT");
      const timedOutAt = end?.at ?? Number.NaN;
      // Waited for one second past the run's end at most: past it, the read outlived its run.
      const closedAt = await endpoint.closedBetween(sent, timedOutAt + 1000);
      expect(closedAt).toBeDefined();
      const at = closedAt ?? Number.NaN;
      // Read until the deadline — not cut before it, give or take a timer's
      // millisecond —, and not past it by a second.
      expect(at).toBeGreaterThanOrEqual(sent + timeoutS * 1000 - 5);
      expect(at - timedOutAt).toBeLessThanOrEqual(1000);
      expect(endpoint.requests).toHaveLength(1);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe.each(
  RUNTIMES,
)("E2E: a required file input sent as an empty list, on the %s runtime", (_title, runtime) => {
  it(
    "is refused 400 MISSING_INPUT by the run route, in the words of a missing input: nothing written, no machine, no model called",
    async () => {
      const w = world(runtime);
      await pushAgent(w, `empty-file-list-${runtime}`, endpoint, {
        inputs: ["  - name: picture", "    type: file", "    media: image"],
      });

      const res = await postRun(w, `empty-file-list-${runtime}`, { picture: [] });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "MISSING_INPUT", message: "Missing required input: picture" },
      });
      expect(await w.db.listRuns()).toEqual([]);
      const steps = FlyioAdapter.prototype as unknown as MachineSteps;
      expect(steps.acquireRunner).not.toHaveBeenCalled();
      expect(endpoint.requests).toEqual([]);
      expect(w.machinesApiReads).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
