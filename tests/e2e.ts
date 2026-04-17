/**
 * E2E live test script — tests demo agents + Phase 2 features against a real LLM.
 *
 * Prerequisites:
 *   1. Copy .env.example to .env and set at least GOOGLE_API_KEY
 *   2. Run: pnpm test:e2e:live
 *
 * The script will:
 *   - Auto-start the registry (kills existing process on port 4000)
 *   - Patch each agent to dev/ namespace + google provider
 *   - Build and push each agent
 *   - POST /run and verify the response
 *   - Test caller-provided LLM keys
 *   - Test agent verification (script blocking, dev-token bypass)
 *   - Test seo-audit stateful behavior (2 runs)
 *   - Restore original agent.yaml files
 *   - Auto-stop the registry
 *   - Print a summary
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages/cli/bin/skrun.js");
const REGISTRY = "http://localhost:4000";
const TOKEN = "dev-token";
let registryProcess: ChildProcess | null = null;

// --- Registry auto-start/stop ---

function killPort4000(): void {
  try {
    const output = execFileSync("netstat", ["-ano"], { encoding: "utf-8" });
    for (const line of output.split("\n")) {
      if (line.includes(":4000") && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== "0") {
          try {
            execFileSync("taskkill", ["//PID", pid, "//F"], { stdio: "pipe" });
          } catch {}
        }
      }
    }
  } catch {
    try {
      execFileSync("pkill", ["-f", "dev.ts"], { stdio: "pipe" });
    } catch {}
  }
}

async function startRegistry(): Promise<void> {
  killPort4000();
  await new Promise((r) => setTimeout(r, 1000)); // Wait for port release

  const devTs = join(ROOT, "packages/api/src/dev.ts");
  registryProcess = spawn(process.execPath, ["--import", "tsx", devTs], {
    cwd: ROOT,
    env: { ...process.env, PORT: "4000" },
    stdio: "pipe",
  });

  // Poll health endpoint
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${REGISTRY}/health`);
      const body = (await res.json()) as Record<string, string>;
      if (body.status === "ok") return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Registry failed to start");
}

function stopRegistry(): void {
  if (registryProcess) {
    registryProcess.kill("SIGTERM");
    registryProcess = null;
  }
}

interface TestResult {
  agent: string;
  feature: string;
  passed: boolean;
  duration: number;
  cost: number;
  detail: string;
}

const results: TestResult[] = [];

function skrun(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function patchAgent(dir: string, namespace: string, provider: string, model: string): string {
  const yamlPath = join(dir, "agent.yaml");
  const original = readFileSync(yamlPath, "utf-8");

  let patched = original;
  // Patch namespace
  patched = patched.replace(/name: dev\//, `name: ${namespace}/`);
  // Patch provider + model (all examples default to google/gemini-2.5-flash)
  patched = patched.replace(/provider: \w+/g, `provider: ${provider}`);
  patched = patched.replace(/name: gemini-[\w.-]+/g, `name: ${model}`);

  writeFileSync(yamlPath, patched, "utf-8");
  return original;
}

function restoreAgent(dir: string, original: string): void {
  writeFileSync(join(dir, "agent.yaml"), original, "utf-8");
  // Clean up bundle
  for (const _file of ["agent"].map(() => "")) {
    const files = execFileSync("ls", { cwd: dir, encoding: "utf-8" }).split("\n");
    for (const f of files) {
      if (f.endsWith(".agent")) rmSync(join(dir, f));
    }
  }
}

async function postRun(
  namespace: string,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${REGISTRY}/api/agents/${namespace}/${name}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function testAgent(
  name: string,
  feature: string,
  input: Record<string, unknown>,
  validate: (res: Record<string, unknown>) => string | null,
): Promise<void> {
  const dir = join(ROOT, "examples", name);
  const original = patchAgent(dir, "dev", "google", "gemini-2.5-flash");

  try {
    // Build + push (ignore 409 if already pushed)
    skrun(["build"], dir);
    try {
      skrun(["push"], dir);
    } catch {
      // 409 Version already exists — agent already in registry, continue
    }

    // Run
    const res = await postRun("dev", name, input);
    const output = res.output as Record<string, unknown>;
    let error = validate(res);

    // #7 assertion — agent_version must always be echoed in sync responses
    if (!error) {
      const agentVersion = res.agent_version as string | undefined;
      if (!agentVersion) {
        error = "Missing agent_version in response (feature #7 regression)";
      } else if (!/^\d+\.\d+\.\d+$/.test(agentVersion)) {
        error = `agent_version "${agentVersion}" is not strict semver`;
      }
    }

    results.push({
      agent: name,
      feature,
      passed: !error,
      duration: (res.duration_ms as number) ?? 0,
      cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail:
        error ??
        `status=${res.status}, version=${res.agent_version as string}, output keys=[${Object.keys(output ?? {}).join(", ")}]`,
    });
  } catch (err) {
    results.push({
      agent: name,
      feature,
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    restoreAgent(dir, original);
  }
}

// --- Start registry ---
console.log("Starting registry...");
await startRegistry();
console.log("Registry OK\n");

// --- Login ---
skrun(["login", "--token", TOKEN], ROOT);

// --- Test each agent ---

console.log("Testing code-review...");
await testAgent(
  "code-review",
  "Real file review",
  { code: readFileSync(join(ROOT, "packages/runtime/src/llm/router.ts"), "utf-8").slice(0, 2000) },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    const output = res.output as Record<string, unknown>;
    if (typeof output?.score !== "number") return "Missing score in output";
    return null;
  },
);

console.log("Testing pdf-processing...");
await testAgent(
  "pdf-processing",
  "Document extraction",
  { task: "extract text", content: "Annual Report 2025. Revenue grew 45% to $12M. Headcount: 85." },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    return null;
  },
);

console.log("Testing data-analyst...");
await testAgent(
  "data-analyst",
  "Typed I/O (CSV)",
  {
    data: "month,revenue\nJan,10000\nFeb,12000\nMar,15000",
    format: "csv",
    question: "Revenue trend?",
  },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    const output = res.output as Record<string, unknown>;
    if (!output?.analysis) return "Missing analysis in output";
    return null;
  },
);

console.log("Testing seo-audit (run 1 — first audit)...");
await testAgent(
  "seo-audit",
  "State — first audit",
  { website_url: "https://example.com" },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    const output = res.output as Record<string, unknown>;
    if (typeof output?.score !== "number") return "Missing score";
    return null;
  },
);

// seo-audit run 2 — must remember!
// Need to push again (same version conflict — use a trick: different version)
console.log("Testing seo-audit (run 2 — should remember)...");
const seoDir = join(ROOT, "examples/seo-audit");
const _seoOriginal = readFileSync(join(seoDir, "agent.yaml"), "utf-8");
// Already pushed from run 1, just call /run again
const seoRes2 = await postRun("dev", "seo-audit", { website_url: "https://example.com" });
const seoOutput2 = seoRes2.output as Record<string, unknown>;
results.push({
  agent: "seo-audit",
  feature: "State — remembers previous",
  passed:
    seoRes2.status === "completed" &&
    typeof seoOutput2?.previous_score === "number" &&
    (seoOutput2?.previous_score as number) > 0,
  duration: (seoRes2.duration_ms as number) ?? 0,
  cost: ((seoRes2.cost as Record<string, number>)?.estimated as number) ?? 0,
  detail: `score=${seoOutput2?.score}, previous=${seoOutput2?.previous_score}, trend=${seoOutput2?.trend}`,
});

console.log("Testing email-drafter...");
await testAgent(
  "email-drafter",
  "Business email",
  { context: "Follow up on proposal", tone: "formal", recipient: "VP Engineering" },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    const output = res.output as Record<string, unknown>;
    if (!output?.subject) return "Missing subject";
    if (!output?.body) return "Missing body";
    return null;
  },
);

console.log("Testing web-scraper (Playwright MCP)...");
await testAgent(
  "web-scraper",
  "MCP — headless browser",
  { url: "https://example.com", question: "What is this page about?" },
  (res) => {
    if (res.status !== "completed") return `Expected completed, got ${res.status}`;
    return null;
  },
);

// --- Phase 2: Caller-provided LLM keys ---

console.log("Testing caller-provided keys (valid key)...");
{
  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: googleKey }),
      },
      body: JSON.stringify({ input: { code: "const x = 1;" } }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    results.push({
      agent: "caller-keys",
      feature: "Valid caller key → completed",
      passed: body.status === "completed",
      duration: (body.duration_ms as number) ?? 0,
      cost: ((body.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail: `status=${body.status}`,
    });
  }
}

console.log("Testing caller-provided keys (invalid key → no fallback)...");
{
  const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ google: "fake-invalid-key" }),
    },
    body: JSON.stringify({ input: { code: "const x = 1;" } }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  results.push({
    agent: "caller-keys",
    feature: "Invalid caller key → failed (no fallback)",
    passed: body.status === "failed",
    duration: (body.duration_ms as number) ?? 0,
    cost: 0,
    detail: `status=${body.status}`,
  });
}

console.log("Testing caller-provided keys (malformed header → 400)...");
{
  const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "X-LLM-API-Key": "not-json",
    },
    body: JSON.stringify({ input: { code: "x" } }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  const err = body.error as Record<string, string> | undefined;
  results.push({
    agent: "caller-keys",
    feature: "Malformed header → 400",
    passed: res.status === 400 && err?.code === "INVALID_LLM_KEY_HEADER",
    duration: 0,
    cost: 0,
    detail: `status=${res.status}, code=${err?.code}`,
  });
}

// --- Phase 2: Agent verification ---

console.log("Testing verification (default verified=false)...");
{
  const res = await fetch(`${REGISTRY}/api/agents/dev/pdf-processing`);
  const body = (await res.json()) as Record<string, unknown>;
  results.push({
    agent: "verification",
    feature: "Default verified=false",
    passed: body.verified === false,
    duration: 0,
    cost: 0,
    detail: `verified=${body.verified}`,
  });
}

console.log("Testing verification (PATCH /verify → true)...");
{
  const res = await fetch(`${REGISTRY}/api/agents/dev/pdf-processing/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified: true }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  results.push({
    agent: "verification",
    feature: "PATCH /verify → true",
    passed: body.verified === true,
    duration: 0,
    cost: 0,
    detail: `verified=${body.verified}`,
  });
}

console.log("Testing verification (non-dev token + non-verified → warning)...");
{
  // Revoke first
  await fetch(`${REGISTRY}/api/agents/dev/pdf-processing/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified: false }),
  });
  const res = await fetch(`${REGISTRY}/api/agents/dev/pdf-processing/run`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-user-token",
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ google: "fake" }),
    },
    body: JSON.stringify({ input: { content: "test", task: "summarize" } }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  const warnings = body.warnings as string[] | undefined;
  results.push({
    agent: "verification",
    feature: "Non-dev + non-verified → warning",
    passed: Array.isArray(warnings) && warnings.includes("agent_not_verified_scripts_disabled"),
    duration: 0,
    cost: 0,
    detail: `warnings=${JSON.stringify(warnings)}`,
  });
}

console.log("Testing verification (dev-token bypass → no warning)...");
{
  const res = await postRun("dev", "pdf-processing", { content: "test", task: "summarize" });
  const warnings = res.warnings as string[] | undefined;
  results.push({
    agent: "verification",
    feature: "Dev-token bypass → no warning",
    passed: warnings === undefined,
    duration: 0,
    cost: 0,
    detail: `warnings=${JSON.stringify(warnings)}`,
  });
}

// --- Phase 2: Streaming (SSE + webhook) ---

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
      contentType.includes("text/event-stream") && hasRunStart && hasRunComplete && hasLlmComplete,
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
    body: JSON.stringify({ input: { url: "https://example.com", question: "What is this page?" } }),
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

// --- Phase 2: SDK ---

// Dynamic import to avoid workspace resolution issues in the script
const { SkrunClient } = await import("../packages/sdk/src/index.js");
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

// --- Phase 3: Version pinning (#7) ---

console.log("Testing version pinning (SDK run({version}) against latest)...");
{
  try {
    // Discover the current latest version of dev/code-review
    const versions = await sdkClient.getVersions("dev/code-review");
    const pinnedVersion = versions[versions.length - 1]; // latest pushed

    const result = await sdkClient.run(
      "dev/code-review",
      { code: "const z = 3;" },
      { version: pinnedVersion },
    );

    const pinMatch = result.agent_version === pinnedVersion;
    results.push({
      agent: "version-pinning",
      feature: "SDK run({version}) → agent_version echoes pinned version",
      passed: result.status === "completed" && pinMatch,
      duration: result.duration_ms ?? 0,
      cost: result.cost?.estimated ?? 0,
      detail: `pinned=${pinnedVersion}, echoed=${result.agent_version}, match=${pinMatch}`,
    });
  } catch (err) {
    results.push({
      agent: "version-pinning",
      feature: "SDK run({version}) → agent_version echoes pinned version",
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log("Testing version pinning — 404 VERSION_NOT_FOUND with `available`...");
{
  try {
    // Direct fetch to inspect the 404 body
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: { code: "x" }, version: "99.99.99" }),
    });
    const body = (await res.json()) as {
      error?: { code?: string; available?: string[] };
    };
    const passed =
      res.status === 404 &&
      body.error?.code === "VERSION_NOT_FOUND" &&
      Array.isArray(body.error?.available) &&
      body.error.available.length > 0;
    results.push({
      agent: "version-pinning",
      feature: "POST /run with unknown version → 404 VERSION_NOT_FOUND + available[]",
      passed,
      duration: 0,
      cost: 0,
      detail: `status=${res.status}, code=${body.error?.code}, available=[${body.error?.available?.join(",")}]`,
    });
  } catch (err) {
    results.push({
      agent: "version-pinning",
      feature: "POST /run with unknown version → 404 VERSION_NOT_FOUND + available[]",
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log("Testing version pinning — 400 INVALID_VERSION_FORMAT on semver range...");
{
  try {
    const res = await fetch(`${REGISTRY}/api/agents/dev/code-review/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: { code: "x" }, version: "^1.0.0" }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    const passed = res.status === 400 && body.error?.code === "INVALID_VERSION_FORMAT";
    results.push({
      agent: "version-pinning",
      feature: 'POST /run with "^1.0.0" → 400 INVALID_VERSION_FORMAT',
      passed,
      duration: 0,
      cost: 0,
      detail: `status=${res.status}, code=${body.error?.code}`,
    });
  } catch (err) {
    results.push({
      agent: "version-pinning",
      feature: 'POST /run with "^1.0.0" → 400 INVALID_VERSION_FORMAT',
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Phase 2b: Environment override + allowed_hosts (#9 + #11) ---

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

// --- Phase 2b: Files API (#12) ---

console.log("Testing files API — response includes files array...");
{
  // Any agent run should have a `files` field in the response (backward compat)
  try {
    const res = await postRun("dev", "code-review", { code: "const x = 1;" });
    const files = res.files as Array<Record<string, unknown>> | undefined;
    results.push({
      agent: "files-api",
      feature: "POST /run response includes files array (backward compat)",
      passed: Array.isArray(files),
      duration: (res.duration_ms as number) ?? 0,
      cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail: `files=${JSON.stringify(files)}`,
    });
  } catch (err) {
    results.push({
      agent: "files-api",
      feature: "POST /run response includes files array (backward compat)",
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Summary ---
console.log(`\n${"=".repeat(70)}`);
console.log("E2E TEST RESULTS");
console.log("=".repeat(70));

let passed = 0;
let failed = 0;

for (const r of results) {
  const icon = r.passed ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
  console.log(`${icon} ${r.agent} — ${r.feature}`);
  console.log(`       ${r.detail} | ${r.duration}ms | $${r.cost.toFixed(4)}`);
  if (r.passed) passed++;
  else failed++;
}

console.log(`\n${"-".repeat(70)}`);
console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
console.log("-".repeat(70));

// --- Cleanup ---
stopRegistry();

process.exit(failed > 0 ? 1 : 0);
