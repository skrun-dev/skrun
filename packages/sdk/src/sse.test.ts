import { describe, expect, it } from "vitest";
import { collectRunResult, parseSSEStream } from "./sse.js";
import type { RunEvent } from "./types.js";

function createSSEResponse(text: string): Response {
  return new Response(text, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collectEvents(response: Response): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of parseSSEStream(response)) {
    events.push(event);
  }
  return events;
}

describe("parseSSEStream", () => {
  it("parses run_start event", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"abc","timestamp":"t","agent":"dev/test"}',
      'event: run_complete\ndata: {"type":"run_complete","run_id":"abc","timestamp":"t","output":{},"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"cost":{"estimated":0},"duration_ms":0}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    expect(events[0].type).toBe("run_start");
    if (events[0].type === "run_start") {
      expect(events[0].agent).toBe("dev/test");
    }
  });

  it("parses all 6 event types", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      'event: tool_call\ndata: {"type":"tool_call","run_id":"x","timestamp":"t","tool":"search","args":{"q":"hi"}}',
      'event: tool_result\ndata: {"type":"tool_result","run_id":"x","timestamp":"t","tool":"search","result":"found","is_error":false}',
      'event: llm_complete\ndata: {"type":"llm_complete","run_id":"x","timestamp":"t","provider":"google","model":"gemini","tokens":100}',
      'event: run_complete\ndata: {"type":"run_complete","run_id":"x","timestamp":"t","output":{"r":"done"},"usage":{"prompt_tokens":50,"completion_tokens":50,"total_tokens":100},"cost":{"estimated":0.01},"duration_ms":500}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run_start",
      "tool_call",
      "tool_result",
      "llm_complete",
      "run_complete",
    ]);
  });

  it("stops after run_complete", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      'event: run_complete\ndata: {"type":"run_complete","run_id":"x","timestamp":"t","output":{},"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"cost":{"estimated":0},"duration_ms":0}',
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("run_complete");
  });

  it("stops after run_error", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      'event: run_error\ndata: {"type":"run_error","run_id":"x","timestamp":"t","error":{"code":"TIMEOUT","message":"timed out"}}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("run_error");
  });

  it("skips malformed data lines", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      "event: bad\ndata: not-json",
      'event: run_complete\ndata: {"type":"run_complete","run_id":"x","timestamp":"t","output":{},"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"cost":{"estimated":0},"duration_ms":0}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    expect(events).toHaveLength(2);
  });

  // A runner_spawned event (a type older consumers never saw) must flow
  // through and be yielded, with the stream still terminating on run_complete.
  // The parser casts JSON -> RunEvent with no strict/discriminated validation,
  // so a new event type is backward-compatible for SDK consumers. (The
  // dashboard's timeline renders unknown types with a fallback style; that
  // tolerance is asserted by hand, on a cloud run.)
  it("yields runner_spawned and still completes (unknown-event tolerance)", async () => {
    const text = [
      'event: run_start\ndata: {"type":"run_start","run_id":"x","timestamp":"t","agent":"a"}',
      'event: runner_spawned\ndata: {"type":"runner_spawned","run_id":"x","timestamp":"t","phases":{"create_api_ms":12,"host_schedule_pull_ms":4800,"vm_boot_ms":3200,"init_bundle_ms":210,"init_extract_ms":140,"init_mcp_ms":0}}',
      'event: run_complete\ndata: {"type":"run_complete","run_id":"x","timestamp":"t","output":{},"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"cost":{"estimated":0},"duration_ms":0}',
    ].join("\n\n");

    const events = await collectEvents(createSSEResponse(text));
    expect(events.map((e) => e.type)).toEqual(["run_start", "runner_spawned", "run_complete"]);
    const spawned = events[1];
    if (spawned.type === "runner_spawned") {
      expect(spawned.phases.host_schedule_pull_ms).toBe(4800);
      // The phases only — no operator-internal fields on the wire event.
      expect(Object.keys(spawned)).not.toContain("private_ip");
    }
  });
});

describe("collectRunResult", () => {
  async function* events(...list: RunEvent[]): AsyncGenerator<RunEvent> {
    yield* list;
  }

  it("throws STREAM_INTERRUPTED on a stream with no terminal event", async () => {
    await expect(collectRunResult(events())).rejects.toMatchObject({
      code: "STREAM_INTERRUPTED",
    });
  });

  it("stops at the first terminal event", async () => {
    const result = await collectRunResult(
      events(
        { type: "run_start", run_id: "x", timestamp: "t", agent: "a", agent_version: "1.2.3" },
        { type: "run_error", run_id: "x", timestamp: "t", error: { code: "E", message: "boom" } },
        {
          type: "run_complete",
          run_id: "x",
          timestamp: "t",
          output: { never: "read" },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: { estimated: 1 },
          duration_ms: 1,
          files: [],
          files_excluded: {},
        },
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("boom");
    expect(result.agent_version).toBe("1.2.3");
    expect(result.files_excluded).toEqual({});
  });

  const complete: RunEvent = {
    type: "run_complete",
    run_id: "x",
    timestamp: "t",
    output: {},
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cost: { estimated: 0 },
    duration_ms: 1,
    files: [],
    files_excluded: { name_refused: 1, over_count: 4, upload_budget: 2 },
  };

  it("reports how many output files the run left out, by reason, as the synchronous result does", async () => {
    const result = await collectRunResult(events(complete));

    expect(result.files_excluded).toEqual({ name_refused: 1, over_count: 4, upload_budget: 2 });
  });

  it("reports no file left out from a server that does not count them", async () => {
    const { files_excluded: _counts, ...fromAnEarlierServer } = complete as Extract<
      RunEvent,
      { type: "run_complete" }
    >;

    const result = await collectRunResult(events(fromAnEarlierServer as RunEvent));

    expect(result.files_excluded).toEqual({});
  });
});
