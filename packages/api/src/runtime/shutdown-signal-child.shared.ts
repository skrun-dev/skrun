/**
 * A server process for shutdown-signal.test.ts, never shipped: an HTTP server
 * listening on a free local port, one run in flight that ignores the stop,
 * and the stop's handlers installed as the entry points install them. It
 * writes one JSON line on stdout once it listens (`child_ready`); every final
 * write of the run writes the row it left (`child_row_written`). Once its row
 * is written, the run ends its own way — a failure, as a loop that breaks off
 * would — and writes what its caller is told, as the run route tells it
 * (`child_told`); then it settles. The rest of its stdout is the API's log.
 */
import { createServer } from "node:http";
import { createLogger } from "@skrun-dev/runtime";
import type { FinalRunWrite } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { failureToTell, finalizeRun } from "../routes/_helpers.js";
import { installShutdownHandlers, registerInFlightRun } from "./in-flight-runs.js";

const RUN_ID = "run-in-flight";

const db = new MemoryDb();
const log = createLogger("api");
await db.createRun({
  id: RUN_ID,
  agent_id: null,
  agent_version: "dev/agent@1.0.0",
  status: "running",
  input: {},
});
const run = registerInFlightRun({
  runId: RUN_ID,
  db,
  log,
  mode: "sse",
  runtimeMode: "local",
});

/** The run's own end, after the stop's: what its caller is told, then the run settles. */
async function endsItsOwnWay(): Promise<void> {
  const written = await finalizeRun(db, log, RUN_ID, run, {
    status: "failed",
    error: "the run's own failure",
    now: new Date(),
    mode: "sse",
    runtimeMode: "local",
  });
  const told = failureToTell(written);
  process.stdout.write(
    `${JSON.stringify({ event: "child_told", code: told?.code ?? null, message: told?.message ?? null })}\n`,
  );
  run.settle();
}

const finishRun = db.finishRun.bind(db);
db.finishRun = async (
  id: string,
  data: FinalRunWrite,
  options?: { replaceShutdownProvisional?: boolean },
) => {
  const row = await finishRun(id, data, options);
  process.stdout.write(
    `${JSON.stringify({ event: "child_row_written", status: row?.status ?? null, error: row?.error ?? null })}\n`,
  );
  // Once the write is back with the stop: the run's own end comes after it.
  setImmediate(() => void endsItsOwnWay());
  return row;
};

const server = createServer((_request, response) => {
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ event: "child_ready" })}\n`);
});

installShutdownHandlers({ server });
