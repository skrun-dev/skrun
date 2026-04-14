import type { RunEvent, RunRequest, RunResult } from "../types.js";

export interface RuntimeAdapter {
  execute(request: RunRequest): Promise<RunResult>;
  executeStream(request: RunRequest): AsyncGenerator<RunEvent>;
}
