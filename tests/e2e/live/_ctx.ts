/**
 * Shared context for live E2E phases — constants, types, and helpers.
 *
 * Module-singleton pattern: `registryProcess` and `results` live at module
 * scope so phase files can `import { results } from "./_ctx.js"` and push
 * test outcomes without an explicit ctx parameter on every helper call.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ModelSpec } from "./29-tool-loop.js";
import { assertLiveDatabase } from "./database-guard.js";
import { loadLiveEnv } from "./env-file.js";

// Before anything reads process.env: the suite's `.env` may live in the main
// checkout when this runs from a worktree.
loadLiveEnv();
// Its DATABASE_URL is judged where the suite writes, not here: `startRegistry()`
// below, `openRegistryDb()` and phase 35 (database-guard.ts says why). Importing
// this module judges nothing — the cloud smokes import it and open no database.

export const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Registry stderr/stdout log file path. Set by startRegistry(); printed in
 * the final summary when any test fails so a human (or Claude) can grep it
 * for the actual server-side error message of the failure.
 */
export let registryLogPath: string | null = null;
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

/**
 * Start the registry on :4000, killing whatever listens there first. `extraEnv`
 * is laid over the harness's own variables, for a phase that needs a registry
 * configured otherwise (the quota phase starts one with its settings, then the
 * plain one again); a value of `undefined` removes the variable. Bundles live
 * in the registry's memory: a restart loses every bundle pushed before it.
 */
export async function startRegistry(
  opts: { extraEnv?: Record<string, string | undefined> } = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "4000",
    // Force dev-token mode regardless of user's local .env (OAuth must be off
    // for `dev-token` to work — see packages/api/src/auth/github-oauth.ts).
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    // dev-token is now an explicit fail-secure opt-in (SKRUN_DEV_AUTH); the
    // live registry must enable it. NODE_ENV=development keeps it inside the
    // createApp interlock's trusted allowlist.
    SKRUN_DEV_AUTH: "1",
    NODE_ENV: "development",
    // The live suite spins up a localhost callback server to exercise webhook
    // delivery — the exact local-webhook-testing case this opt-in serves. It
    // is off by default (private/reserved webhook targets are blocked), so the
    // harness enables it explicitly, mirroring SKRUN_DEV_AUTH above.
    SKRUN_ALLOW_LOCAL_WEBHOOKS: "true",
    // Force agents directory to the renamed dir (some local .env files may
    // still point at the legacy `examples/`).
    SKRUN_AGENTS_DIR: "./agents",
    // Pin the dashboard root by absolute path. Its default ("../web/dist") is
    // resolved relative to cwd, which assumes cwd = packages/api (as under
    // `pnpm dev:registry`). This harness spawns with cwd = ROOT, so the
    // relative default would miss the built SPA and the dashboard phase would
    // 404 on a built dist. The published image pins an absolute dir the same way.
    SKRUN_DASHBOARD_DIR: join(ROOT, "packages/web/dist"),
    ...opts.extraEnv,
  };
  for (const [name, value] of Object.entries(opts.extraEnv ?? {})) {
    if (value === undefined) delete env[name];
  }
  // The guard, on the very environment the registry is handed (extraEnv included),
  // before any registry is stopped or started: the registry writes to the database
  // it names (database-guard.ts).
  assertLiveDatabase(env);
  killPort4000();
  await new Promise((r) => setTimeout(r, 1000)); // Wait for port release

  const devTs = join(ROOT, "packages/api/src/dev.ts");
  // Capture the registry's stdout+stderr to a temp file. The legacy
  // `stdio: "pipe"` silenced both streams (never read), so a failed run
  // surfaced as "Expected completed, got failed | 0ms | $0" with no
  // server-side context. Now the log lives at registryLogPath, printed
  // in the final summary when any test fails so a human can grep it.
  registryLogPath = join(tmpdir(), `skrun-e2e-registry-${Date.now()}.log`);
  const logFd = openSync(registryLogPath, "w");
  // --use-system-ca: required on Windows when LLM provider certs (or an
  // intermediate) are present in the system CA store but not in Node's
  // compiled CA bundle. Without this flag, `fetch()` to Google/Anthropic/etc.
  // fails with `unable to verify the first certificate`. Surfaced 2026-05-15.
  registryProcess = spawn(process.execPath, ["--use-system-ca", "--import", "tsx", devTs], {
    cwd: ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
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

/**
 * Purge every agent in the `dev` namespace before the suite runs.
 *
 * In cloud mode the live registry uses a persistent backend (DATABASE_URL →
 * Postgres) but ephemeral MemoryStorage for bundles. Agent rows from a prior
 * run therefore survive in the DB while their bundles are gone, so a later
 * pull / run fails with BUNDLE_NOT_FOUND. Deleting up front keeps the DB and
 * the (fresh) storage in sync. Scoped to `dev` so pointing the suite at a
 * shared cloud DB never touches real users' agents. No-op on a fresh DB.
 */
export async function cleanupDevNamespace(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY}/api/agents?limit=200`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  } catch {
    return; // registry unreachable — let the phases surface the real error
  }
  if (!res.ok) return;
  const body = (await res.json()) as { agents?: Array<{ namespace: string; name: string }> };
  const devAgents = (body.agents ?? []).filter((a) => a.namespace === "dev");
  for (const a of devAgents) {
    await fetch(`${REGISTRY}/api/agents/${a.namespace}/${a.name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }
  if (devAgents.length > 0) {
    console.log(`Pre-flight cleanup: purged ${devAgents.length} dev/* agent(s).`);
  }
}

// --- CLI invocation ---

/**
 * Where the dependency cache was before the CLI got a profile of its own: the
 * CLI and the runtime place it under `homedir()` unless SKRUN_DEPS_DIR says
 * otherwise, so the throwaway profile would otherwise hold a fresh, empty one.
 * Read once, from this process, whose own home never changes.
 */
const DEPS_DIR = process.env.SKRUN_DEPS_DIR ?? join(homedir(), ".skrun", "deps");

/**
 * The CLI's profile for the suite: a throwaway home directory, never the
 * developer's. `skrun login` writes its sign-in file there and every CLI call of
 * the suite reads it from there, so the developer's own configuration is never
 * read or rewritten. Created when the suite starts, removed when it exits.
 */
export const CLI_PROFILE = mkdtempSync(join(tmpdir(), "skrun-e2e-profile-"));
process.on("exit", () => rmSync(CLI_PROFILE, { recursive: true, force: true }));

/**
 * The environment of every CLI call of the suite: this process's, with HOME and
 * USERPROFILE (what `homedir()` reads on Windows) at the suite's profile, the
 * dependency cache where it was, and no SKRUN_REGISTRY_URL — the suite's `.env`
 * may set one, and the CLI must talk to the server it signed in to.
 */
export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: CLI_PROFILE,
    USERPROFILE: CLI_PROFILE,
    SKRUN_DEPS_DIR: DEPS_DIR,
  };
  delete env.SKRUN_REGISTRY_URL;
  return env;
}

export function skrun(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: cliEnv(),
  });
}

/** The namespace the suite's token signs in as. */
const TOKEN_NAMESPACE = "dev";

/**
 * Sign the CLI in for the suite, in its own profile: `skrun login --registry
 * REGISTRY --token TOKEN`, then `skrun whoami`, then the profile's sign-in file
 * read back (the token is the local development one, not a secret). PASS when
 * the CLI says it signed in to REGISTRY as the token's namespace, `whoami` names
 * REGISTRY, and the profile's file makes REGISTRY the current server.
 */
export async function signInCli(): Promise<void> {
  const file = join(CLI_PROFILE, ".skrun", "config.json");
  let login = "";
  let whoami = "";
  let current = "";
  let failure = "";
  try {
    const signedIn = skrun(["login", "--registry", REGISTRY, "--token", TOKEN], ROOT);
    login = /Logged in to .*/.exec(stripVTControlCharacters(signedIn))?.[0].trim() ?? "";
    const identity = stripVTControlCharacters(skrun(["whoami"], ROOT));
    const address = /Registry:\s+(\S+)/.exec(identity)?.[1];
    whoami = address === undefined ? "" : `Registry: ${address}`;
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf-8")) as { current?: unknown };
      current = typeof saved.current === "string" ? saved.current : "";
    }
  } catch (err) {
    failure = ` | ${cliOutput(err)}`;
  }
  results.push({
    agent: "cli-profile",
    feature:
      "the CLI signs in from a profile of the suite's own, never the developer's configuration",
    passed:
      login === `Logged in to ${REGISTRY} as ${TOKEN_NAMESPACE}` &&
      whoami === `Registry: ${REGISTRY}` &&
      current === REGISTRY,
    duration: 0,
    cost: 0,
    detail: `profile=${CLI_PROFILE} login="${login}" whoami="${whoami}" current=${current || "(none)"}${failure}`,
  });
}

/** How `skrun push` reports a push the registry refused: `Push failed (<status>): <message>`. */
const PUSH_REFUSED = /Push failed \((\d{3})\)/;
/** The registry's message for a version it already holds (the 409). */
const VERSION_EXISTS = /Version \S+ already exists/;
/** The window a 429 names (`Limit: 10 per 60s.`), in seconds. */
const RATE_LIMIT_WINDOW = /Limit: \d+ per (\d+)s\b/;
/** How many times a rate-limited push waits for the window before it counts as failed. */
const RATE_LIMIT_WAITS = 3;
/** Seconds added to the window, so the next attempt lands after it has ended. */
const RATE_LIMIT_MARGIN_S = 5;

export interface PushFixtureOptions {
  /** Arguments after `push`, e.g. `["-m", note]`. */
  args?: string[];
  /**
   * Whether a version the registry already holds (409) counts as pushed. True by
   * default: a fixture pinned at a version a previous run left behind is the same
   * fixture. A scenario that deletes the version first to push fresh content sets
   * it to false, so a 409 fails it instead of running the old bundle.
   */
  acceptExisting?: boolean;
}

/**
 * `skrun push` a phase's fixture from `dir`. What the CLI printed decides the
 * outcome, never its exit code (on Windows a failing CLI can exit with a crash
 * status instead of 1):
 * - 409, the version already exists: done, unless `acceptExisting` is false;
 * - 429, the push route's rate limit, which the suite outpaces: wait for the
 *   window to end, then push again, at most RATE_LIMIT_WAITS times;
 * - anything else: an Error that carries what the CLI printed.
 *
 * Returns what a successful push printed, without colour codes — or an empty
 * string when the version was already there (409), since nothing was pushed.
 */
export async function pushFixture(dir: string, opts: PushFixtureOptions = {}): Promise<string> {
  const { args = [], acceptExisting = true } = opts;
  for (let waits = 0; ; waits++) {
    let output: string;
    try {
      return stripVTControlCharacters(skrun(["push", ...args], dir));
    } catch (err) {
      output = cliOutput(err);
    }
    const status = PUSH_REFUSED.exec(output)?.[1];
    if (status === "409" && acceptExisting && VERSION_EXISTS.test(output)) return "";
    if (status !== "429" || waits === RATE_LIMIT_WAITS) {
      const after = waits > 0 ? ` after ${waits} wait(s) for the push rate limit` : "";
      throw new Error(`skrun push failed in ${dir}${after}: ${output}`);
    }
    const seconds = Number(RATE_LIMIT_WINDOW.exec(output)?.[1] ?? 60) + RATE_LIMIT_MARGIN_S;
    console.log(
      `  push rate-limited (429) in ${dir}: waiting ${seconds}s for the window to end (${waits + 1}/${RATE_LIMIT_WAITS})`,
    );
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

/** What a failed CLI call printed, stderr then stdout, without colour codes. */
function cliOutput(err: unknown): string {
  const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
  const printed = [stderr, stdout]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => stripVTControlCharacters(s).trim())
    .join("\n");
  if (printed) return printed;
  return err instanceof Error ? err.message : String(err);
}

// --- Agent yaml patching ---

export function patchAgent(
  dir: string,
  _namespace: string,
  provider: string,
  model: string,
): string {
  const yamlPath = join(dir, "agent.yaml");
  const original = readFileSync(yamlPath, "utf-8");

  // The yaml namespace patching is no longer needed post-#84: `agent.yaml.name`
  // is slug-only, and the registry assigns namespace at push from auth context.
  // The `_namespace` parameter is preserved for caller-side signature
  // compatibility (callers may want namespace context for downstream HTTP
  // assertions) but is intentionally unused here.
  let patched = original;
  // Patch provider + model (all demo agents default to google/gemini-3.8-flash). Every
  // `name: gemini-…` line is replaced, the fallback's included: a patched demo runs
  // one model, its fallback too.
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

/**
 * The models the tool-chain phase (29) runs on, once each: every model choice
 * `skrun init` offers, in its order, then each demo agent's model and fallback.
 * Read from the schema package's build and the demos' `agent.yaml` — no model
 * is written here. A model whose provider key is not set is skipped by the
 * phase, which says so.
 */
export async function toolLoopModels(): Promise<ModelSpec[]> {
  const { MODEL_CHOICES, parseAgentYaml } = await import("../../../packages/schema/dist/index.js");
  const models: ModelSpec[] = [];
  const add = (provider: string, name: string) => {
    if (models.some((m) => m.provider === provider && m.name === name)) return;
    models.push({ provider: provider as ModelSpec["provider"], name });
  };
  for (const choice of MODEL_CHOICES) add(choice.provider, choice.name);
  const agents = join(ROOT, "agents");
  for (const dir of readdirSync(agents).sort()) {
    const path = join(agents, dir, "agent.yaml");
    if (!existsSync(path)) continue;
    const { model } = parseAgentYaml(readFileSync(path, "utf-8")).config;
    add(model.provider, model.name);
    if (model.fallback) add(model.fallback.provider, model.fallback.name);
  }
  return models;
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

/**
 * Verify the latest version of an agent so POST /run reaches past the
 * per-version verified gate (#83). dev-token is admin so this call always
 * passes the admin check. Idempotent — safe to call on already-verified
 * versions. Used by `testAgent` after every push.
 */
export async function verifyLatestVersion(namespace: string, name: string): Promise<void> {
  const metaRes = await fetch(`${REGISTRY}/api/agents/${namespace}/${name}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!metaRes.ok) return;
  const meta = (await metaRes.json()) as { latest_version?: string };
  if (!meta.latest_version) return;
  await fetch(
    `${REGISTRY}/api/agents/${namespace}/${name}/versions/${meta.latest_version}/verify`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    },
  );
}

export async function testAgent(
  name: string,
  feature: string,
  input: Record<string, unknown>,
  validate: (res: Record<string, unknown>) => string | null,
): Promise<void> {
  const dir = join(ROOT, "agents", name);
  const original = patchAgent(dir, "dev", "google", "gemini-3.8-flash");

  try {
    // Build + push (a version already in the registry is kept)
    skrun(["build"], dir);
    await pushFixture(dir);

    // Verify the just-pushed (or pre-existing) version so POST /run reaches
    // past the per-version verified gate (#83). dev-token is admin, so this
    // is the live-test analog of an operator approving the version after a
    // push. Without this, all phase-01+ tests would 403 on the run.
    await verifyLatestVersion("dev", name);

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

    // Include the server-side `res.error` when the validator fails — it's the
    // most useful diagnostic for 0ms / $0 failures (run failed before the LLM
    // call). Otherwise the detail stays the same happy-path string.
    const errorDetail = error
      ? `${error}${res.error ? ` | run.error=${typeof res.error === "string" ? res.error : JSON.stringify(res.error)}` : ""}`
      : `status=${res.status}, version=${res.agent_version as string}, output keys=[${Object.keys(output ?? {}).join(", ")}]`;
    results.push({
      agent: name,
      feature,
      passed: !error,
      duration: (res.duration_ms as number) ?? 0,
      cost: ((res.cost as Record<string, number>)?.estimated as number) ?? 0,
      detail: errorDetail,
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
