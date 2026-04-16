import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () => Buffer.concat(chunks).toString().split("\n").filter(Boolean),
  };
}

describe("createLogger", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLogLevel === undefined) {
      process.env.LOG_LEVEL = undefined as unknown as string;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it("VT-1: outputs valid JSON with level, time, name, msg", () => {
    const cap = captureStream();
    const logger = createLogger("test", cap.stream);

    logger.info({ event: "test" }, "hello");
    logger.flush();

    const lines = cap.lines();
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(30);
    expect(entry.name).toBe("skrun:test");
    expect(entry.msg).toBe("hello");
    expect(entry.event).toBe("test");
    expect(entry.time).toBeDefined();
  });

  it("VT-2: child logger inherits run context bindings", () => {
    const cap = captureStream();
    const logger = createLogger("test", cap.stream);
    const child = logger.child({ run_id: "abc-123", agent: "dev/x", agent_version: "1.0.0" });

    child.info({ event: "tool_call" }, "tool invoked");
    child.flush();

    const entry = JSON.parse(cap.lines()[0]);
    expect(entry.run_id).toBe("abc-123");
    expect(entry.agent).toBe("dev/x");
    expect(entry.agent_version).toBe("1.0.0");
    expect(entry.event).toBe("tool_call");
  });

  it("VT-3: LOG_LEVEL=warn suppresses info, allows warn", () => {
    process.env.LOG_LEVEL = "warn";
    const cap = captureStream();
    const logger = createLogger("test", cap.stream);

    logger.info({ event: "info_event" }, "should be suppressed");
    logger.warn({ event: "warn_event" }, "should appear");
    logger.flush();

    const lines = cap.lines();
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).event).toBe("warn_event");
  });

  it("VT-4: callerKeys are redacted", () => {
    const cap = captureStream();
    const logger = createLogger("test", cap.stream);

    logger.info(
      { event: "run_start", callerKeys: { anthropic: "sk-ant-super-secret" } },
      "started",
    );
    logger.flush();

    const raw = cap.lines()[0];
    expect(raw).not.toContain("sk-ant-super-secret");
    const entry = JSON.parse(raw);
    expect(entry.callerKeys.anthropic).toBe("[REDACTED]");
  });
});
