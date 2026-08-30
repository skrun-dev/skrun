import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { authorizeRunnerRequest, type InitResult } from "@skrun-dev/runtime/runner";
import { Hono } from "hono";
import { z } from "zod";
import {
  collectOutputs,
  dispatchTool,
  initRunner,
  openOutputFile,
  shutdownRunner,
} from "./dispatch.js";
import { applyEgress, isPoolMode } from "./egress-channel.js";

// Time spent loading modules. ES modules hoist every static import, so the whole
// dependency graph above is evaluated BEFORE the first statement of this module
// body runs — which means elapsed time at this point IS the module-load cost
// (plus Node's own bootstrap). Reported to the harness in the /init response so
// start-up time can be attributed without reading logs.
//
// This also corrects an older comment here which claimed the probes below were
// printed "before the heavy imports": because of that hoisting they never were.
// They prove loading finished; they cannot measure it.
const MODULE_LOAD_MS = Math.round(performance.now());

// Boot probes — always to STDERR: stdout is line-buffered and gets dropped when
// the process dies within milliseconds in Fly's log-forwarder context. Same
// pattern as runner-start.sh + entrypoint.sh (surfaced 2026-05-25).
process.stderr.write(`[skrun-runner] boot: node ${process.version} uid=${process.getuid?.()}\n`);
process.stderr.write(`[skrun-runner] boot: modules loaded in ${MODULE_LOAD_MS}ms\n`);

// By design the sandbox has zero LLM/DB/Skrun-API credentials in env. The
// only envs read here are infrastructure (port + graceful shutdown timing).
const PORT = Number.parseInt(process.env.RUNNER_PORT ?? "9000", 10);

/**
 * How long the assignment waits for the privileged helper to confirm the egress
 * rules. Generous relative to the work (resolving a handful of hostnames and
 * writing firewall rules took ~1.6s for the full boot-time set), and still far
 * below any caller timeout — the point is to fail closed rather than hang.
 */
const CLAIM_EGRESS_TIMEOUT_MS = 15_000;

/**
 * Cold-start telemetry captured once at boot and reported in the /init response
 * so the harness can attribute the otherwise-opaque create->healthz interval.
 *  - vm_boot_ms: in-VM kernel-boot -> runner-listening (from /proc/uptime at the
 *    moment the server starts accepting connections). The harness subtracts this
 *    from create->healthz to isolate the host-side schedule + image pull.
 *  - entrypoint_egress_ms: read from the marker the entrypoint wrote before the
 *    capsh handoff (the egress-allowlist setup duration; a sub-part of vm_boot).
 *  - module_load_ms: time spent loading this program's modules, also a sub-part of
 *    vm_boot. Together with entrypoint_egress_ms it splits vm_boot into its parts,
 *    so start-up work can be attributed instead of inferred.
 * All best-effort — a read/parse failure leaves the field undefined and the
 * harness degrades (never throws).
 */
const bootInfo: {
  vm_boot_ms?: number;
  entrypoint_egress_ms?: number;
  module_load_ms?: number;
} = { module_load_ms: MODULE_LOAD_MS };

/** Seconds since this machine booted, in ms; undefined where /proc is unavailable. */
function readUptimeMs(): number | undefined {
  try {
    const seconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function captureBootInfo(): void {
  try {
    const seconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
    if (Number.isFinite(seconds)) {
      bootInfo.vm_boot_ms = Math.round(seconds * 1000);
    }
  } catch {
    // /proc/uptime unavailable (e.g. a non-Linux dev host) — leave undefined.
  }
  try {
    const marker = JSON.parse(readFileSync("/tmp/skrun-boot.json", "utf8")) as {
      egress_ms?: number;
    };
    if (typeof marker.egress_ms === "number") {
      bootInfo.entrypoint_egress_ms = marker.egress_ms;
    }
  } catch {
    // Marker absent (self-host/api-server mode, or write failed) — leave undefined.
  }
}

const ToolConfigSchema = z.looseObject({ name: z.string() });
const McpServerSchema = z.looseObject({ name: z.string() });

const InitBodySchema = z.object({
  bundleUrl: z.string().url(),
  outputsPutUrl: z.string().url().optional(),
  tools: z.array(ToolConfigSchema).default([]),
  mcpServers: z.array(McpServerSchema).default([]),
  allowedHosts: z.array(z.string()).default([]),
});

const ToolBodySchema = z.object({
  kind: z.enum(["script", "mcp"]),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

// Boot interlock: a machine that waits to be assigned must hold the credential
// that gates being assigned. Without it this process would hold NEITHER
// credential, which is the open-when-unset back-compat state — an unauthenticated
// /init, whose body carries an arbitrary bundle URL, on the private network.
// The harness-side config builder already refuses to produce such a machine; this
// is the same refusal at the other end, where it is enforceable rather than
// trusted. Fail loudly at boot, in the style of the api-server's own env gates.
if (isPoolMode() && !process.env.RUNNER_CLAIM_TOKEN) {
  process.stderr.write(
    "[skrun-runner] FATAL: started with an assignment channel but no assignment credential — " +
      "refusing to serve, because this state would leave every route open.\n",
  );
  process.exit(2);
}

const app = new Hono();

/**
 * Assignment latch. Set synchronously at the top of the assignment handler, before
 * anything that can yield, so two concurrent callers cannot both get through — this
 * is what makes the machine single-use without a lock anywhere else in the system.
 *
 * It is deliberately never cleared. A failed assignment leaves the machine latched
 * and without a run credential, i.e. permanently unusable — which is the intended
 * terminal state: the caller destroys it and falls back rather than retrying on a
 * machine whose firewall rules are unconfirmed.
 */
let assigned = false;

// RPC auth across the three lifecycle states — see authorizeRunnerRequest. Both
// credentials are read fresh from the environment on every request, because the
// per-run one is installed at assignment time rather than at boot.
app.use("*", async (c, next) => {
  const decision = authorizeRunnerRequest(c.req.path, c.req.header("Authorization"), {
    claimToken: process.env.RUNNER_CLAIM_TOKEN,
    runToken: process.env.RUNNER_RPC_TOKEN,
  });
  if (!decision.allowed) {
    // A machine that is already assigned answers 409, not 401: the caller has to
    // tell "your credential is wrong" from "someone else got here first", because
    // only the second means discard this machine and take another. The decision is
    // made in the authorisation step because it runs before any handler could.
    if (decision.denial === "already-claimed") {
      return c.json({ error: "already claimed" }, 409);
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

/**
 * Identifies THIS server process, for the whole time it lives.
 *
 * A pre-created machine is paused with its memory snapshotted and later woken.
 * The platform documents that wake as an attempt, not a guarantee: it may cold-
 * boot the machine instead, which costs the full start-up the pre-creation
 * exists to avoid — and looks identical from the outside. Reporting the same
 * value at readiness and at assignment settles which one happened, because a
 * cold boot necessarily runs a new process and mints a new value.
 *
 * Uptime cannot answer this: a paused machine's clock is frozen with the rest of
 * it, so the reading tells you how long the process has RUN, not how long ago it
 * started, and comparing it against elapsed real time misreads every genuine
 * wake as a cold boot.
 *
 * Random rather than the pid — no reason to publish process internals for a
 * value whose only job is to differ across restarts.
 */
const PROCESS_ID = randomBytes(8).toString("hex");

app.get("/healthz", (c) => c.json({ ok: true, process_id: PROCESS_ID }));

const ClaimBodySchema = z.object({
  rpcToken: z.string().min(32),
  allowedHosts: z.array(z.string()).default([]),
});

/**
 * Assign this pre-created machine to a run: install its egress rules, then its
 * per-run credential.
 *
 * The order below is the security property, not a style choice:
 *
 *   1. latch, synchronously — no second caller past this point
 *   2. egress rules, and WAIT for the privileged helper to confirm them
 *   3. only then install the run credential
 *
 * Installing the credential first would let a run begin with its firewall rules
 * unconfirmed, which is the one thing this whole path exists to prevent. It mirrors
 * the boot-time behaviour on an ordinary machine, where a failed firewall setup
 * aborts the boot instead of continuing without it.
 */
app.post("/claim", async (c) => {
  if (assigned) {
    // Reached only when a PREVIOUS assignment failed: the latch is set but no run
    // credential was installed, so the authorisation step still sees an unassigned
    // machine. A successful assignment is refused earlier, by that step.
    return c.json({ error: "already claimed" }, 409);
  }
  assigned = true;

  const raw = await c.req.json().catch(() => null);
  const parsed = ClaimBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid /claim body", details: parsed.error.issues }, 400);
  }

  try {
    await applyEgress(parsed.data.allowedHosts, CLAIM_EGRESS_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[skrun-runner] claim failed — egress not confirmed: ${message}\n`);
    // No run credential is installed. The machine stays latched and unusable.
    return c.json({ error: "egress setup failed", message }, 500);
  }

  // How long this machine has been up, read at assignment rather than at boot.
  //
  // It is the only way the caller can tell a machine that genuinely resumed from
  // its snapshot from one that silently cold-booted instead — the platform treats
  // the resume as an attempt, not a guarantee, and the two are indistinguishable
  // from the outside. A resumed machine has been up since the pool was filled; a
  // cold-booted one has been up for seconds. Reported, never interpreted here:
  // the caller knows when it created the machine, this process does not.
  const uptimeMs = readUptimeMs();

  process.env.RUNNER_RPC_TOKEN = parsed.data.rpcToken;
  // Only now is it safe to drop the assignment credential: with the run credential
  // in place the machine is in the claimed state. Dropping it any earlier — on the
  // failure path, say — would leave this process holding NEITHER credential, which
  // is the open-when-unset state. The latch, not this delete, is what prevents a
  // second assignment (the environment is readable by same-user code anyway).
  delete process.env.RUNNER_CLAIM_TOKEN;

  // `process_id` is what tells a genuine wake from a silent cold boot: unchanged
  // since readiness means this is the same process the machine was paused with.
  // `uptime_ms` stays for the operator record — it is a running time, not an age.
  return c.json({ ok: true, uptime_ms: uptimeMs, process_id: PROCESS_ID });
});

app.post("/init", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = InitBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid /init body", details: parsed.error.issues }, 400);
  }
  try {
    const result = await initRunner({
      bundleUrl: parsed.data.bundleUrl,
      outputsPutUrl: parsed.data.outputsPutUrl,
      // biome-ignore lint/suspicious/noExplicitAny: zod-validated loose objects relayed to runtime providers
      tools: parsed.data.tools as any,
      // biome-ignore lint/suspicious/noExplicitAny: zod-validated loose objects relayed to runtime providers
      mcpServers: parsed.data.mcpServers as any,
      allowedHosts: parsed.data.allowedHosts,
    });
    // Typed against the shared runtime contract so the runner and the harness
    // cannot drift on the /init response shape. `boot` carries the cold-start
    // clock captured at listen-time; `phases` the in-VM /init timings.
    const response: InitResult = {
      ok: true,
      tools: result.tools,
      phases: result.phases,
      boot: bootInfo,
    };
    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "init failed", message }, 500);
  }
});

app.post("/tool", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ToolBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid /tool body", details: parsed.error.issues }, 400);
  }
  try {
    const result = await dispatchTool(parsed.data.kind, parsed.data.name, parsed.data.args);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ content: message, isError: true });
  }
});

app.post("/outputs/collect", async (c) => {
  try {
    const result = await collectOutputs();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "collect failed", message }, 500);
  }
});

// GET /outputs/file?path=<relative-path>
// Streams a single output file back to the harness so it can sync-upload
// to R2. Path is resolved under /mnt/session/outputs and rejected if it
// escapes (defense-in-depth — the manifest path is already filesystem-walked,
// but we re-validate because it round-trips through HTTP).
app.get("/outputs/file", async (c) => {
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "missing required ?path query parameter" }, 400);
  }
  try {
    const opened = await openOutputFile(path);
    // biome-ignore lint/suspicious/noExplicitAny: Hono body() accepts a Node Readable but the TS type is the web ReadableStream
    return c.body(opened.stream as any, 200, {
      "Content-Type": opened.mimeType,
      "Content-Length": String(opened.size),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("escapes") ? 400 : 404;
    return c.json({ error: "file fetch failed", message }, status);
  }
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  captureBootInfo();
  console.log(`[skrun-runner] listening on :${info.port}`);
});

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[skrun-runner] received ${signal} — shutting down`);
  await shutdownRunner().catch((err) => {
    console.error("[skrun-runner] shutdown error:", err);
  });
  server.close(() => process.exit(0));
  // Hard kill after 10s if close() hangs (MCP subprocess didn't exit cleanly).
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
