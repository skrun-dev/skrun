/**
 * Shared context for live E2E phases — constants, types, and helpers.
 *
 * Module-singleton pattern: `registryProcess` and `results` live at module
 * scope so phase files can `import { results } from "./_ctx.js"` and push
 * test outcomes without an explicit ctx parameter on every helper call.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const CLI = join(ROOT, "packages/cli/bin/skrun.js");
export const REGISTRY = "http://localhost:4000";
export const TOKEN = "dev-token";

export interface TestResult {
  agent: string;
  feature: string;
  passed: boolean;
  duration: number;
  cost: number;
  detail: string;
}

export const results: TestResult[] = [];

let registryProcess: ChildProcess | null = null;

// --- Registry auto-start/stop ---

export function killPort4000(): void {
  if (process.platform === "win32") {
    // Windows: netstat -ano to find PID, taskkill /F /PID to kill.
    // Args use the real Windows syntax (`/F` `/PID`) — NOT the `//PID` MSYS-bash
    // escape that silently failed on real cmd / pwsh and left orphan registries
    // alive when live tests crashed. Bug surfaced during #77 D-1 verify.
    try {
      const output = execFileSync("netstat", ["-ano"], { encoding: "utf-8" });
      for (const line of output.split("\n")) {
        if (line.includes(":4000") && line.includes("LISTENING")) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== "0") {
            try {
              execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "pipe" });
            } catch {}
          }
        }
      }
    } catch {}
  } else {
    // Linux / macOS: pkill the dev.ts entrypoint matches all tsx-spawned
    // registries. Adequate for CI (no other dev.ts processes alongside tests).
    try {
      execFileSync("pkill", ["-f", "dev.ts"], { stdio: "pipe" });
    } catch {}
  }
}

export async function startRegistry(): Promise<void> {
  killPort4000();
  await new Promise((r) => setTimeout(r, 1000)); // Wait for port release

  const devTs = join(ROOT, "packages/api/src/dev.ts");
  registryProcess = spawn(process.execPath, ["--import", "tsx", devTs], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "4000",
      // Force dev-token mode regardless of user's local .env (OAuth must be off
      // for `dev-token` to work — see packages/api/src/auth/github-oauth.ts).
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      // Force agents directory to the renamed dir (some local .env files may
      // still point at the legacy `examples/`).
      SKRUN_AGENTS_DIR: "./agents",
    },
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

export function stopRegistry(): void {
  if (registryProcess) {
    registryProcess.kill("SIGTERM");
    registryProcess = null;
  }
}

// --- CLI invocation ---

export function skrun(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

// --- Agent yaml patching ---

export function patchAgent(
  dir: string,
  namespace: string,
  provider: string,
  model: string,
): string {
  const yamlPath = join(dir, "agent.yaml");
  const original = readFileSync(yamlPath, "utf-8");

  let patched = original;
  // Patch namespace
  patched = patched.replace(/name: dev\//, `name: ${namespace}/`);
  // Patch provider + model (all demo agents default to google/gemini-2.5-flash)
  patched = patched.replace(/provider: \w+/g, `provider: ${provider}`);
  patched = patched.replace(/name: gemini-[\w.-]+/g, `name: ${model}`);

  writeFileSync(yamlPath, patched, "utf-8");
  return original;
}

export function restoreAgent(dir: string, original: string): void {
  writeFileSync(join(dir, "agent.yaml"), original, "utf-8");
  // Clean up bundle
  for (const _file of ["agent"].map(() => "")) {
    const files = execFileSync("ls", { cwd: dir, encoding: "utf-8" }).split("\n");
    for (const f of files) {
      if (f.endsWith(".agent")) rmSync(join(dir, f));
    }
  }
}

// --- HTTP / agent run ---

export async function postRun(
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

export async function testAgent(
  name: string,
  feature: string,
  input: Record<string, unknown>,
  validate: (res: Record<string, unknown>) => string | null,
): Promise<void> {
  const dir = join(ROOT, "agents", name);
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
