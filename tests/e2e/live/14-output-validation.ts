/**
 * Phase 14 — audit/002 live assertions on new SSE surfaces.
 *
 * - `tool_call_error` event: pushes the dedicated `audit-fixture-tool-error`
 *   fixture (a tiny agent whose only tool exits non-zero on purpose) and
 *   asserts the new event fires with the right shape. The 14 demo agents
 *   no longer trip is_error: true after the Bug A + B fixes shipped earlier
 *   in audit/002, so a deliberate fixture is the only way to exercise this
 *   path against a real LLM.
 *
 * - `run_complete.files[]`: re-uses one of the file-producing demos to
 *   assert the persisted file payload (name + size + file_id) is non-empty.
 *   The FilesBlock UI in the dashboard reads exactly this field.
 */

import { join } from "node:path";
import { postRun, REGISTRY, ROOT, results, skrun, TOKEN, verifyLatestVersion } from "./_ctx.js";

function parseSSEText(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    let eventName = "";
    let dataStr = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventName = line.slice(7).trim();
      if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
    }
    if (eventName && dataStr) {
      try {
        out.push({ event: eventName, data: JSON.parse(dataStr) });
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

export async function run(): Promise<void> {
  console.log("Testing tool_call_error (synthetic fixture)...");
  {
    const fixtureDir = join(ROOT, "tests/fixtures/agents/audit-fixture-tool-error");

    // Build + push the fixture. 409 (version already pushed) is fine — the
    // version is pinned at 1.0.0 and reused across runs.
    skrun(["build"], fixtureDir);
    try {
      skrun(["push"], fixtureDir);
    } catch {
      // 409 VERSION_EXISTS — fixture already in registry from a prior run.
    }
    await verifyLatestVersion("dev", "audit-fixture-tool-error");

    // SSE call: the LLM is forced via tool_choice to invoke `always_fails`,
    // which exits 1 with `[FIXTURE_ALWAYS_FAILS] ...` on stderr → runtime
    // wraps it as is_error: true → emits tool_call_error before tool_result.
    const res = await fetch(`${REGISTRY}/api/agents/dev/audit-fixture-tool-error/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { dummy: "" } }),
    });
    const text = await res.text();
    const events = parseSSEText(text);

    const errorEvent = events.find((e) => e.event === "tool_call_error");
    const okShape =
      !!errorEvent &&
      typeof errorEvent.data.tool === "string" &&
      typeof errorEvent.data.message === "string";

    // The event must come BEFORE the matching tool_result (visibility-only
    // contract — the LLM still receives the failure normally).
    const errorIdx = events.findIndex((e) => e.event === "tool_call_error");
    const resultIdx = events.findIndex((e) => e.event === "tool_result");
    const orderedCorrectly = errorIdx >= 0 && resultIdx > errorIdx;

    const tool = (errorEvent?.data?.tool as string) ?? "?";
    const message = (errorEvent?.data?.message as string) ?? "";
    const code = (errorEvent?.data?.code as string | undefined) ?? "—";

    results.push({
      agent: "audit-fixture-tool-error",
      feature: "tool_call_error event visible before tool_result",
      passed: okShape && orderedCorrectly,
      duration: 0,
      cost: 0,
      detail: `tool_call_error tool=${tool} msg='${message.slice(0, 60)}' code=${code}`,
    });
  }

  console.log("Testing run.files[] populated (adr-writer)...");
  {
    // adr-writer is a file-producing demo (write_artifact). After audit/002
    // its tool_choice: write_artifact migration in Task 2.3-bucket of v0.7.0
    // makes the write deterministic. adr-writer is pushed via testAgent in
    // phase 01 which calls verifyLatestVersion — but the SQLite registry
    // persists across `pnpm test:e2e:live` runs, so we verify again
    // defensively in case 01-demos didn't run or the dir state was lost.
    await verifyLatestVersion("dev", "adr-writer");
    // Inputs must match agent.yaml exactly — the agent requires `adrs_dir`,
    // `title`, `context`, `options` (string, markdown bullet list), and
    // `decision`. The pre-existing fixture used `decision_topic` /
    // `decided_option` (wrong field names) + `options` as a JS array, which
    // POST /run now rejects with MISSING_INPUT.
    const res = await postRun("dev", "adr-writer", {
      adrs_dir: "./fixtures/empty-adrs",
      title: "Adopt async background jobs",
      context:
        "Synchronous request handling is becoming a bottleneck for our reporting endpoints; some clients see 30s+ latency.",
      options: "- BullMQ + Redis\n- Celery + Redis\n- SQS + Lambda",
      decision: "BullMQ + Redis",
    });

    const files = (res.files as Array<{ name?: string; size?: number; file_id?: string }>) ?? [];
    const ok =
      Array.isArray(files) &&
      files.length > 0 &&
      typeof files[0].name === "string" &&
      typeof files[0].size === "number" &&
      typeof files[0].file_id === "string" &&
      files[0].file_id.startsWith("fil_");

    results.push({
      agent: "adr-writer",
      feature: "run.files[] populated with {name, size, file_id} entries",
      passed: ok,
      duration: (res.duration_ms as number) ?? 0,
      cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail: ok
        ? `files=[{name='${files[0].name}', size=${files[0].size}}] count=${files.length}`
        : `files=${JSON.stringify(files).slice(0, 140)}${res.error ? ` | run.error=${typeof res.error === "string" ? res.error : JSON.stringify(res.error)}` : ""}`,
    });
  }
}
