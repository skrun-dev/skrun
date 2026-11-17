// A thread agent.yaml files are read in (agent-yaml-reader.ts) — a push's, a
// run's —, one at a time. Plain JavaScript, not TypeScript: a worker thread
// loads its file as it is, so the same file runs from src under the test runner
// and from dist, where the build copies it (packages/api/package.json), with no
// loader — the server refuses to start without it (assertAgentYamlWorkerPresent).
// For each file it is sent, it says it has started — the reader's clock starts then, never while
// the thread and the schema load — then answers once: the configuration, as
// JSON, and the warnings; or the refusal, its message and its issues. The
// reader stops the thread when a read outlasts its budget.
import { parentPort } from "node:worker_threads";
import { parseAgentYaml, ValidationError } from "@skrun-dev/schema";

parentPort.on("message", (text) => {
  parentPort.postMessage({ type: "started" });
  let answer;
  try {
    const { config, warnings } = parseAgentYaml(text);
    answer = { type: "read", config: JSON.stringify(config), warnings };
  } catch (err) {
    answer =
      err instanceof ValidationError
        ? { type: "refused", message: err.message, issues: err.issues }
        : { type: "refused", message: err instanceof Error ? err.message : String(err) };
  }
  parentPort.postMessage(answer);
});
