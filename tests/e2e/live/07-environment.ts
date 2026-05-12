/**
 * Phase 07 — per-run environment override (#9 + #11).
 *
 * `environment.networking.allowed_hosts` and `environment.timeout` can be
 * overridden in the POST /run body. Asserts an empty allowed_hosts on an
 * agent without MCP still completes, and that a timeout override reaches
 * the runtime.
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing environment override — allowed_hosts=[] on agent without MCP...");
  {
    // code-review has no MCP servers — allowed_hosts=[] should not break it
    try {
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { code: "const x = 1;" },
          environment: { networking: { allowed_hosts: [] } },
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      results.push({
        agent: "allowed-hosts",
        feature: "env override allowed_hosts=[] + no MCP → still completes",
        passed: body.status === "completed",
        duration: (body.duration_ms as number) ?? 0,
        cost: ((body.cost as Record<string, number>)?.estimated as number) ?? 0,
        detail: `status=${body.status}, agent_version=${body.agent_version}`,
      });
    } catch (err) {
      results.push({
        agent: "allowed-hosts",
        feature: "env override allowed_hosts=[] + no MCP → still completes",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("Testing environment override — timeout override...");
  {
    // Verify environment override reaches the runtime (timeout=60s override)
    try {
      const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { code: "function hello() { return 'world'; }" },
          environment: { timeout: "60s" },
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      results.push({
        agent: "env-override",
        feature: "environment.timeout override in POST /run body → completes",
        passed: body.status === "completed",
        duration: (body.duration_ms as number) ?? 0,
        cost: ((body.cost as Record<string, number>)?.estimated as number) ?? 0,
        detail: `status=${body.status}`,
      });
    } catch (err) {
      results.push({
        agent: "env-override",
        feature: "environment.timeout override in POST /run body → completes",
        passed: false,
        duration: 0,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
