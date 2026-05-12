/**
 * Phase 04 — SSE streaming + async webhook callbacks.
 *
 * Validates the streaming endpoint (run_start → llm_complete → run_complete
 * event order), tool-call events on web-scraper, the SSE+webhook conflict
 * (400 SSE_WEBHOOK_CONFLICT), and the async webhook flow with HMAC signature.
 */

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { REGISTRY, results, TOKEN } from "./_ctx.js";

function parseSSEText(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventName = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice(7).trim();
      if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
    }
    if (eventName && dataStr) {
      try {
        events.push({ event: eventName, data: JSON.parse(dataStr) });
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

export async function run(): Promise<void> {
  console.log("Testing SSE streaming (happy path)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { code: "const x = 1;" } }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const events = parseSSEText(text);

    const types = events.map((e) => e.event);
    const hasRunStart = types[0] === "run_start";
    const hasRunComplete = types[types.length - 1] === "run_complete";
    const hasLlmComplete = types.includes("llm_complete");

    results.push({
      agent: "streaming",
      feature: "SSE happy path (run_start → llm_complete → run_complete)",
      passed:
        contentType.includes("text/event-stream") &&
        hasRunStart &&
        hasRunComplete &&
        hasLlmComplete,
      duration: 0,
      cost: 0,
      detail: `content-type=${contentType}, events=[${types.join(",")}]`,
    });
  }

  console.log("Testing SSE streaming (run_complete has output/usage/cost)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { code: "function add(a,b) { return a + b; }" } }),
    });
    const text = await res.text();
    const events = parseSSEText(text);
    const complete = events.find((e) => e.event === "run_complete");

    const hasOutput = complete?.data?.output !== undefined;
    const hasUsage = complete?.data?.usage !== undefined;
    const hasCost = complete?.data?.cost !== undefined;
    const hasDuration = typeof complete?.data?.duration_ms === "number";

    results.push({
      agent: "streaming",
      feature: "run_complete contains output, usage, cost, duration_ms",
      passed: !!complete && hasOutput && hasUsage && hasCost && hasDuration,
      duration: 0,
      cost: 0,
      detail: `output=${hasOutput}, usage=${hasUsage}, cost=${hasCost}, duration_ms=${hasDuration}`,
    });
  }

  console.log("Testing SSE streaming with tool calls (web-scraper)...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/web-scraper/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        input: { url: "https://example.com", question: "What is this page?" },
      }),
    });
    const text = await res.text();
    const events = parseSSEText(text);
    const types = events.map((e) => e.event);

    const hasToolCall = types.includes("tool_call");
    const hasToolResult = types.includes("tool_result");
    const hasRunStart = types[0] === "run_start";
    const hasRunComplete = types[types.length - 1] === "run_complete";

    // tool_call should have tool name and args
    const toolCallEvent = events.find((e) => e.event === "tool_call");
    const toolHasName = typeof toolCallEvent?.data?.tool === "string";

    // tool_result should have result string
    const toolResultEvent = events.find((e) => e.event === "tool_result");
    const resultHasContent = typeof toolResultEvent?.data?.result === "string";

    results.push({
      agent: "streaming",
      feature: "SSE with tool calls (tool_call + tool_result events)",
      passed:
        hasRunStart &&
        hasToolCall &&
        hasToolResult &&
        hasRunComplete &&
        toolHasName &&
        resultHasContent,
      duration: 0,
      cost: 0,
      detail: `events=[${types.join(",")}], tool=${toolCallEvent?.data?.tool}`,
    });
  }

  console.log("Testing SSE + webhook conflict → 400...");
  {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { code: "x" }, webhook_url: "https://example.com/hook" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as Record<string, string> | undefined;
    results.push({
      agent: "streaming",
      feature: "SSE + webhook conflict → 400",
      passed: res.status === 400 && err?.code === "SSE_WEBHOOK_CONFLICT",
      duration: 0,
      cost: 0,
      detail: `status=${res.status}, code=${err?.code}`,
    });
  }

  console.log("Testing webhook (202 + callback with signature)...");
  {
    // Start a mini HTTP server to receive the webhook
    let webhookPayload: string | null = null;
    let webhookSignature: string | null = null;
    let webhookReceived = false;

    const server: Server = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          webhookPayload = body;
          webhookSignature = (req.headers["x-skrun-signature"] as string) ?? null;
          webhookReceived = true;
          res.writeHead(200);
          res.end("OK");
        });
      });
      srv.listen(0, () => resolve(srv));
    });

    const port = (server.address() as { port: number }).port;

    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { code: "const y = 2;" },
        webhook_url: `http://localhost:${port}/callback`,
      }),
    });

    const responseBody = (await res.json()) as Record<string, unknown>;
    const got202 = res.status === 202;
    const hasRunId = typeof responseBody.run_id === "string";

    // Wait for webhook callback (up to 60s for LLM to respond)
    for (let i = 0; i < 120 && !webhookReceived; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    server.close();

    let signatureValid = false;
    if (webhookPayload && webhookSignature) {
      // Verify HMAC (using default dev key)
      const sigMatch = webhookSignature.match(/^sha256=([a-f0-9]+)$/);
      if (sigMatch) {
        const expected = createHmac("sha256", "skrun-dev-webhook-secret")
          .update(webhookPayload)
          .digest("hex");
        signatureValid = sigMatch[1] === expected;
      }
    }

    let payloadValid = false;
    if (webhookPayload) {
      try {
        const parsed = JSON.parse(webhookPayload) as Record<string, unknown>;
        payloadValid = parsed.status !== undefined && parsed.output !== undefined;
      } catch {
        // invalid JSON
      }
    }

    results.push({
      agent: "streaming",
      feature: "Webhook 202 + callback received + signature valid",
      passed: got202 && hasRunId && webhookReceived && signatureValid && payloadValid,
      duration: 0,
      cost: 0,
      detail: `202=${got202}, run_id=${hasRunId}, received=${webhookReceived}, sig=${signatureValid}, payload=${payloadValid}`,
    });
  }
}
