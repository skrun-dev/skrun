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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const error = validate(res);

    results.push({
      agent: name,
      feature,
      passed: !error,
      duration: (res.duration_ms as number) ?? 0,
      cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail:
        error ?? `status=${res.status}, output keys=[${Object.keys(output ?? {}).join(", ")}]`,
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
