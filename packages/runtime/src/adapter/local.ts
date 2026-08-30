import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOutputFiles } from "../files/output-collector.js";
import type { LLMRouter } from "../llm/router.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { parseTimeout, withGeneratorTimeout } from "../security/timeout.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunRequest, RunResult } from "../types.js";
import type { RuntimeAdapter } from "./adapter.js";
import { runAgentLoop } from "./agent-loop.js";

export interface StateCallbacks {
  getState: (agentName: string) => Promise<Record<string, unknown> | null>;
  setState: (agentName: string, state: Record<string, unknown>) => Promise<void>;
}

export class LocalAdapter implements RuntimeAdapter {
  private logger: Logger;

  constructor(
    private router: LLMRouter,
    private tools: ToolRegistry,
    private stateCallbacks?: StateCallbacks,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("runtime");
  }

  async execute(request: RunRequest): Promise<RunResult> {
    let lastResult: RunResult | undefined;
    let lastError: RunEvent | undefined;

    for await (const event of this.executeStream(request)) {
      if (event.type === "run_complete") {
        lastResult = {
          runId: request.runId,
          status: "completed",
          output: event.output,
          usage: {
            promptTokens: event.usage.prompt_tokens,
            completionTokens: event.usage.completion_tokens,
            totalTokens: event.usage.total_tokens,
            estimatedCost: event.cost.estimated,
            ...(event.usage.cache_read_tokens !== undefined && {
              cacheReadTokens: event.usage.cache_read_tokens,
            }),
            ...(event.usage.cache_write_tokens !== undefined && {
              cacheWriteTokens: event.usage.cache_write_tokens,
            }),
          },
          durationMs: event.duration_ms,
          files: event.files,
        };
      } else if (event.type === "run_error") {
        lastError = event;
      }
    }

    if (lastResult) return lastResult;

    const errorEvent = lastError as Extract<RunEvent, { type: "run_error" }> | undefined;
    return {
      runId: request.runId,
      status: "failed",
      output: {},
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 0,
      error: errorEvent?.error.message ?? "Unknown error",
    };
  }

  async *executeStream(request: RunRequest): AsyncGenerator<RunEvent> {
    const config = request.agentConfig;
    const timeoutMs = parseTimeout(config.environment.timeout);
    const start = Date.now();

    if (!request.outputDir) {
      const outputDir = join(tmpdir(), `skrun-outputs-${request.runId}`);
      mkdirSync(outputDir, { recursive: true });
      request.outputDir = outputDir;
    }

    yield {
      type: "run_start",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      agent: config.name,
      agent_version: request.agent_version ?? "unknown",
    };

    // LocalAdapter runs the agent in-process with no VM spawn, so it emits NO
    // `runner_spawned` cold-start event and invokes no spawn-telemetry callback
    // — that per-phase breakdown is flyio-only (see FlyioAdapter). The persisted
    // per-run telemetry columns stay null for local runs.
    this.logger.info(
      {
        event: "run_start",
        run_id: request.runId,
        agent: config.name,
        agent_version: request.agent_version,
      },
      "Agent run started",
    );

    try {
      const loop = runAgentLoop({
        request,
        router: this.router,
        tools: this.tools,
        stateCallbacks: this.stateCallbacks,
        logger: this.logger,
        startMs: start,
      });
      // Stream events from the agent loop AS THEY HAPPEN so heartbeats
      // (and tool_call / tool_result) reach SSE consumers in real time.
      // The terminal `run_complete` is intercepted so we can append the
      // file manifest collected from the harness output dir; everything
      // else is forwarded verbatim.
      for await (const event of withGeneratorTimeout(loop, timeoutMs)) {
        if (event.type === "run_complete" && request.outputDir) {
          const files = collectOutputFiles(request.outputDir);
          yield { ...event, files };
        } else {
          yield event;
        }
      }
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      const action = isTimeout ? "timeout" : "run_failed";

      this.logger.error(
        {
          event: action,
          run_id: request.runId,
          agent: config.name,
          error: err instanceof Error ? err.message : String(err),
        },
        `Agent run ${action}`,
      );

      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: {
          code: isTimeout ? "TIMEOUT" : "EXECUTION_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
