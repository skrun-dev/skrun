import { SkrunApiError } from "./errors.js";
import type { RunEvent, SdkRunResult } from "./types.js";

/**
 * Collect a run's event stream into the result a synchronous `POST /run`
 * returns, with the same shape: `run_start` gives the run id and the resolved
 * version; `run_complete` gives the completed result, its `files` each with
 * their download `url` and its `files_excluded` counts (`{}` from a server that
 * does not send them); `run_error` gives the failed result the synchronous
 * call returns (`status: "failed"`, `error` holding the message, an empty
 * output, zero usage, and nothing left out). A stream that ends before either throws
 * `STREAM_INTERRUPTED`. Every other event is skipped, a type or a stage this
 * SDK does not know included.
 *
 * This is a copy of the synchronous result's shape, kept here so the SDK
 * depends on no other package.
 */
export async function collectRunResult(events: AsyncIterable<RunEvent>): Promise<SdkRunResult> {
  let agentVersion: string | undefined;
  for await (const event of events) {
    if (event.type === "run_start") {
      agentVersion = event.agent_version;
    } else if (event.type === "run_complete") {
      return {
        run_id: event.run_id,
        status: "completed",
        agent_version: agentVersion ?? "unknown",
        output: event.output,
        usage: event.usage,
        cost: event.cost,
        duration_ms: event.duration_ms,
        files: event.files ?? [],
        files_excluded: event.files_excluded ?? {},
      };
    } else if (event.type === "run_error") {
      return {
        run_id: event.run_id,
        status: "failed",
        agent_version: agentVersion ?? "unknown",
        output: {},
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 0,
        files: [],
        files_excluded: {},
        error: event.error.message,
      };
    }
  }
  throw SkrunApiError.streamInterrupted();
}

/**
 * Parse an SSE response body into an async generator of RunEvent objects.
 * Reads the response stream as text, splits on double newlines, and yields
 * parsed events. Stops after run_complete or run_error. `onChunk` is called for
 * every chunk read, a heartbeat's included — what a silence deadline re-arms on.
 */
export async function* parseSSEStream(
  response: Response,
  onChunk?: () => void,
): AsyncGenerator<RunEvent> {
  const body = response.body;
  if (!body) {
    throw SkrunApiError.streamInterrupted();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE blocks (separated by \n\n)
      const blocks = buffer.split("\n\n");
      // Keep the last incomplete block in the buffer
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim()) continue;

        let eventName = "";
        let dataStr = "";

        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
        }

        if (!eventName || !dataStr) continue;

        try {
          const event = JSON.parse(dataStr) as RunEvent;
          yield event;

          // Stop iteration after terminal events
          if (event.type === "run_complete" || event.type === "run_error") {
            return;
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      let eventName = "";
      let dataStr = "";
      for (const line of buffer.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
      }
      if (eventName && dataStr) {
        try {
          const event = JSON.parse(dataStr) as RunEvent;
          yield event;
          if (event.type === "run_complete" || event.type === "run_error") {
            return;
          }
        } catch {
          // Skip malformed
        }
      }
    }

    // If we exit without a terminal event, the stream was interrupted
    throw SkrunApiError.streamInterrupted();
  } finally {
    reader.releaseLock();
  }
}
