/**
 * Phase 05 — SkrunClient SDK smoke tests.
 *
 * Exercises the publishable SDK end-to-end against the live registry: run(),
 * stream() (async iterator over SSE events), and list().
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

export async function run(): Promise<void> {
  // Dynamic import to avoid workspace resolution issues in the script
  const { SkrunClient } = await import("../../../packages/sdk/src/index.js");
  const sdkClient = new SkrunClient({ baseUrl: REGISTRY, token: TOKEN });

  console.log("Testing SDK run() on real agent...");
  {
    try {
      const result = await sdkClient.run("dev/code-review", { code: "const y = 2;" });
      const hasVersion = !!result.agent_version && /^\d+\.\d+\.\d+$/.test(result.agent_version);
      results.push({
        agent: "sdk",
        feature: "SDK run() → completed with output + agent_version",
        passed:
          result.status === "completed" &&
          result.output !== undefined &&
          result.usage !== undefined &&
          hasVersion,
        duration: result.duration_ms ?? 0,
        cost: result.cost?.estimated ?? 0,
        detail: `status=${result.status}, version=${result.agent_version}, keys=[${Object.keys(result.output).join(",")}]`,
      });
    } catch (err) {
      results.push({
        agent: "sdk",
        feature: "SDK run() → completed with output",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing SDK stream() on real agent...");
  {
    try {
      const events = [];
      for await (const event of sdkClient.stream("dev/code-review", { code: "let a = 1;" })) {
        events.push(event);
      }
      const types = events.map((e: { type: string }) => e.type);
      const hasRunStart = types[0] === "run_start";
      const hasRunComplete = types[types.length - 1] === "run_complete";
      results.push({
        agent: "sdk",
        feature: "SDK stream() → events in order",
        passed: hasRunStart && hasRunComplete && events.length >= 3,
        duration: 0,
        cost: 0,
        detail: `events=[${types.join(",")}]`,
      });
    } catch (err) {
      results.push({
        agent: "sdk",
        feature: "SDK stream() → events in order",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing SDK list() on registry...");
  {
    try {
      const result = await sdkClient.list();
      results.push({
        agent: "sdk",
        feature: "SDK list() → returns agents",
        passed: result.total > 0 && Array.isArray(result.agents),
        duration: 0,
        cost: 0,
        detail: `total=${result.total}, agents=[${result.agents.map((a: { name: string }) => a.name).join(",")}]`,
      });
    } catch (err) {
      results.push({
        agent: "sdk",
        feature: "SDK list() → returns agents",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
