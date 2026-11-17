/**
 * Phase 32 — a tool result larger than the bound reaches the model cut, on the
 * local runtime: the phase requires it (a registry on the cloud runtime fails
 * it), since the cut it reads is the agent loop's own.
 *
 * Pushes the `tool-result-cut` fixture: one script tool, forced on the first
 * turn, that writes about 1.5 MiB of plain text. Runs it once through the event
 * stream, then reads the run's record. The proof is what the server produced,
 * never what the model wrote:
 *
 *   - the `tool_result` event: its result starts with what the tool wrote and
 *     ends with the cut's marker, and its answer — `{ content, isError }` as
 *     JSON, in bytes of UTF-8 — fits the bound, cut as close to it as it goes;
 *   - the stream ends on `run_complete`, and the run's record says `completed`;
 *   - no `runner_spawned` event: the run did not go to a sandbox, so the cut is
 *     the agent loop's own.
 *
 * The bound and the marker are read from the runtime's build, never written
 * here. The run's bound on the sum of its tool results is not reached: past it,
 * every turn would send the model more than its window holds. The unit tests
 * hold it, on both runtimes.
 *
 * Two model calls, the second with about a quarter of a million tokens of input.
 * Self-bootstrapping: pushes its own fixture, and DELETEs it before and after.
 */

import { join } from "node:path";
import { pushFixture, REGISTRY, ROOT, results, skrun, TOKEN, verifyLatestVersion } from "./_ctx.js";

const NS = "dev";
const AGENT = "tool-result-cut";
/** What the fixture's tool writes, over and over. */
const SENTENCE = "The quick brown fox jumps over the lazy dog. ";
/** How far under the bound a cut may end: the longest beginning that fits, give or take a character. */
const CUT_SLACK_BYTES = 8;

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

/**
 * The run's record, once its final status is written. A streamed run's
 * `run_complete` waits for that write, but for 10 s at most: past that it goes
 * first, so the record is read again for a while rather than trusting the order.
 */
async function finishedRunRecord(runId: string): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${REGISTRY}/api/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    record = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (record.status === "completed" || record.status === "failed") return record;
    await new Promise((r) => setTimeout(r, 250));
  }
  return record;
}

async function deleteAgent(): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

export async function run(): Promise<void> {
  console.log("Testing a tool result larger than the bound (cut before the model reads it)...");
  const { TOOL_RESPONSE_MAX_BYTES, TOOL_RESULT_TRUNCATION_MARKER } = await import(
    "../../../packages/runtime/dist/index.js"
  );
  const feature = "a tool result larger than the bound reaches the model cut, with the marker";
  const started = Date.now();
  await deleteAgent();
  try {
    const dir = join(ROOT, "tests/fixtures/agents/tool-result-cut");
    skrun(["build"], dir);
    await pushFixture(dir, { acceptExisting: false });
    await verifyLatestVersion(NS, AGENT);

    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { dummy: "" } }),
    });
    const events = parseStream(await res.text());

    const runId = events.find((e) => e.event === "run_start")?.data.run_id;
    const toolResult = events.find((e) => e.event === "tool_result")?.data;
    const result = typeof toolResult?.result === "string" ? toolResult.result : "";
    const isError = toolResult?.is_error === true;
    const answerBytes = Buffer.byteLength(JSON.stringify({ content: result, isError }), "utf8");
    const last = events.at(-1);
    const record = typeof runId === "string" ? await finishedRunRecord(runId) : {};
    const cost = (last?.data.cost as { estimated?: number } | undefined)?.estimated ?? 0;

    const checks = {
      tool: toolResult?.tool === "big_result" && !isError,
      starts: result.startsWith(SENTENCE.repeat(4)),
      marker: result.endsWith(TOOL_RESULT_TRUNCATION_MARKER),
      fits: answerBytes <= TOOL_RESPONSE_MAX_BYTES,
      close: answerBytes > TOOL_RESPONSE_MAX_BYTES - CUT_SLACK_BYTES,
      completed: last?.event === "run_complete",
      record: record.status === "completed",
      local: !events.some((e) => e.event === "runner_spawned"),
    };
    const failing = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    results.push({
      agent: AGENT,
      feature,
      passed: failing.length === 0,
      duration: Date.now() - started,
      cost,
      detail:
        `tool_result tool=${String(toolResult?.tool ?? "absent")} is_error=${isError} ` +
        `answer_bytes=${answerBytes} bound=${TOOL_RESPONSE_MAX_BYTES} ` +
        `marker=${checks.marker ? "yes" : "no"} starts=${checks.starts ? "yes" : "no"} ` +
        `last_event=${last?.event ?? "absent"} record=${String(record.status ?? "absent")} ` +
        `runner_spawned=${checks.local ? "no" : "yes"}` +
        (failing.length > 0 ? ` failing=[${failing.join(", ")}]` : ""),
    });
  } finally {
    await deleteAgent();
  }
}
