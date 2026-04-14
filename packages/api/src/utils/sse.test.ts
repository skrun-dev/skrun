import type { RunEvent } from "@skrun-dev/runtime";
import { describe, expect, it } from "vitest";
import { formatSSEEvent } from "./sse.js";

describe("formatSSEEvent", () => {
  it("formats run_start event", () => {
    const event: RunEvent = {
      type: "run_start",
      run_id: "abc-123",
      timestamp: "2026-04-14T00:00:00.000Z",
      agent: "dev/test-agent",
    };
    const { event: eventName, data } = formatSSEEvent(event);
    expect(eventName).toBe("run_start");
    const parsed = JSON.parse(data);
    expect(parsed.type).toBe("run_start");
    expect(parsed.run_id).toBe("abc-123");
    expect(parsed.agent).toBe("dev/test-agent");
  });

  it("formats tool_call event", () => {
    const event: RunEvent = {
      type: "tool_call",
      run_id: "abc-123",
      timestamp: "2026-04-14T00:00:00.000Z",
      tool: "search",
      args: { query: "hello" },
    };
    const { event: eventName, data } = formatSSEEvent(event);
    expect(eventName).toBe("tool_call");
    const parsed = JSON.parse(data);
    expect(parsed.tool).toBe("search");
    expect(parsed.args).toEqual({ query: "hello" });
  });

  it("formats run_complete event with all fields", () => {
    const event: RunEvent = {
      type: "run_complete",
      run_id: "abc-123",
      timestamp: "2026-04-14T00:00:00.000Z",
      output: { result: "done" },
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      cost: { estimated: 0.001 },
      duration_ms: 500,
    };
    const { event: eventName, data } = formatSSEEvent(event);
    expect(eventName).toBe("run_complete");
    const parsed = JSON.parse(data);
    expect(parsed.output).toEqual({ result: "done" });
    expect(parsed.usage.total_tokens).toBe(150);
    expect(parsed.cost.estimated).toBe(0.001);
    expect(parsed.duration_ms).toBe(500);
  });

  it("formats run_error event", () => {
    const event: RunEvent = {
      type: "run_error",
      run_id: "abc-123",
      timestamp: "2026-04-14T00:00:00.000Z",
      error: { code: "TIMEOUT", message: "Agent timed out" },
    };
    const { event: eventName, data } = formatSSEEvent(event);
    expect(eventName).toBe("run_error");
    const parsed = JSON.parse(data);
    expect(parsed.error.code).toBe("TIMEOUT");
  });

  it("data is valid JSON for every event type", () => {
    const events: RunEvent[] = [
      { type: "run_start", run_id: "x", timestamp: "t", agent: "a" },
      { type: "tool_call", run_id: "x", timestamp: "t", tool: "t", args: {} },
      { type: "tool_result", run_id: "x", timestamp: "t", tool: "t", result: "r", is_error: false },
      { type: "llm_complete", run_id: "x", timestamp: "t", provider: "p", model: "m", tokens: 1 },
      {
        type: "run_complete",
        run_id: "x",
        timestamp: "t",
        output: {},
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 0,
      },
      { type: "run_error", run_id: "x", timestamp: "t", error: { code: "ERR", message: "msg" } },
    ];

    for (const event of events) {
      const { data } = formatSSEEvent(event);
      expect(() => JSON.parse(data)).not.toThrow();
    }
  });
});
