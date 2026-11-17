/**
 * What the harness and the runner say to each other to prepare a run and to
 * run its tools — the bodies of `POST /claim`, `POST /init` and `POST /tool`,
 * the answers to the first two and to `GET /healthz`, and the body of a failed
 * `/init` — declared once, here. (A tool's answer is the runtime's
 * `ToolResult`, which both sides already import.)
 *
 * The harness (the cloud adapter) sends the requests and reads the answers; the
 * runner, in the sandbox, reads the requests and writes the answers. Both import
 * these schemas: the runner through `@skrun-dev/runtime/runner`, the adapter from
 * this module. A copy on either side would compile against itself and drift in
 * silence, so a guard reads both sides and fails on any other declaration of
 * these shapes.
 *
 * The runner image and the harness are deployed separately, so each side talks
 * to an older version of the other during a rollout. Two rules follow, and every
 * schema below keeps them:
 *
 * - A field a reader does not know is ignored, never refused. An object here
 *   drops the keys it does not declare instead of failing on them, so a newer
 *   harness can send a field an older runner has never heard of, and a newer
 *   runner can answer with one an older harness does not read.
 * - A field added later is optional. Requiring it would make the older side's
 *   messages fatal to the newer one.
 *
 * A failed `/init` names the step that failed (`INIT_STAGES`), and the harness
 * judges from that step alone whether the failure is the run's own
 * (`classifyInitFailure`): the runner is told the step by its error's class
 * (`initStageOf`), never by its text.
 *
 * A leaf module: it loads zod and the runtime's typed errors — a leaf module
 * too — and nothing else of this package, because the runner's slim entry
 * exports it (see `runner.ts`).
 */
import { z } from "zod";
import { BundleFetchFailedError, McpConnectError } from "./errors.js";
import type { ToolDefinition } from "./tools/types.js";

/**
 * An agent's tool or MCP server, as the harness relays it from the agent's
 * validated configuration: its name is checked, and the rest is kept whole for
 * the provider that runs it.
 */
const RelayedEntrySchema = z.looseObject({ name: z.string() });

/** The body of `POST /init`: what the runner needs to prepare the agent of a run. */
export const InitRequestSchema = z.object({
  /** Presigned URL of the agent's bundle; the runner downloads its own copy. */
  bundleUrl: z.string().url(),
  /** Presigned URL for the run's outputs. Accepted, not used: outputs are read by the harness. */
  outputsPutUrl: z.string().url().optional(),
  tools: z.array(RelayedEntrySchema).default([]),
  mcpServers: z.array(RelayedEntrySchema).default([]),
  allowedHosts: z.array(z.string()).default([]),
  /**
   * Hex sha256 the downloaded bundle must match before anything is extracted.
   * Optional: a bundle published before checksums were recorded has none, and
   * an older harness does not send it.
   */
  bundleSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/** The body of `POST /init` as the runner reads it, the absent lists empty. */
export type InitRequest = z.infer<typeof InitRequestSchema>;

/**
 * What a pre-created machine measured of its infrastructure hosts — the object
 * store, the package registries, opened once when it booted — after its
 * assignment was answered: `changed`, a host now resolves to an address its
 * boot opened no rule for; `unmeasured`, nothing to read — no measurement made,
 * one not written yet, a host that resolved to nothing —; `unchanged`. The
 * machine's privileged loop writes the word, and the runner reports it in its
 * answer to `/init`, failed or not. A measurement only: no egress rule moves
 * for it.
 */
export const INFRA_HOSTS_CHECKS = ["changed", "unmeasured", "unchanged"] as const;

/** What a pre-created machine measured of its infrastructure hosts. */
export type InfraHostsCheck = (typeof INFRA_HOSTS_CHECKS)[number];

/**
 * The measurement in an `/init` answer. Absent from an older runner's answer,
 * and from a machine created for its run, which measures nothing; a word this
 * side does not know is read as absent rather than refusing the answer.
 */
const InfraHostsField = z.enum(INFRA_HOSTS_CHECKS).optional().catch(undefined);

/**
 * The runner's answer to a successful `/init`: the agent's tools, and the
 * timings of its start-up. `phases` and `boot` are optional — an older runner
 * answers `{ ok, tools }` alone — so a harness degrades on their absence rather
 * than failing the run; timings it cannot read — a field missing or of another
 * type, as an image that changed them could send — are read as absent too, the
 * start kept: they are telemetry. `infra_hosts` is read without waiting: a
 * measurement not written yet is `unmeasured`, and never delays the run.
 */
export const InitResultSchema = z.object({
  ok: z.literal(true),
  tools: z.array(z.custom<ToolDefinition>()),
  /** The `/init` phases, timed in the machine, in ms. */
  phases: z
    .object({
      bundle_ms: z.number(),
      extract_ms: z.number(),
      /** Absent from a runner that predates the dependency install. */
      deps_ms: z.number().optional(),
      mcp_ms: z.number(),
    })
    .optional()
    .catch(undefined),
  /** The machine's start-up, measured once when the runner began listening, in ms. */
  boot: z
    .object({
      vm_boot_ms: z.number().optional(),
      entrypoint_egress_ms: z.number().optional(),
      module_load_ms: z.number().optional(),
    })
    .optional()
    .catch(undefined),
  infra_hosts: InfraHostsField,
});

/** The runner's answer to a successful `/init`. */
export type InitResult = z.infer<typeof InitResultSchema>;

/**
 * The steps a failed `/init` is told by: the bundle's download — no answer, an
 * answer that refused it, a body that did not arrive whole —, its checksum, its
 * extraction, a disk found full, the connection to one of the agent's MCP
 * servers, and anything else.
 */
export const INIT_STAGES = [
  "bundle-network",
  "bundle-status",
  "bundle-incomplete",
  "bundle-checksum",
  "bundle-extract",
  "disk-full",
  "mcp-connect",
  "other",
] as const;

/** A step a failed `/init` is told by. */
export type InitStage = (typeof INIT_STAGES)[number];

/**
 * The body of a failed `/init` (status 500): a fixed error, the failure's
 * message, the step that failed, — for a connection to an MCP server — what
 * that server answered, and the measurement of the infrastructure hosts, which
 * a failed `/init` waits for within a bound: a failure can come before the
 * measurement is written.
 * `stage`, `mcp` and `infra_hosts` are absent from an older runner's body; a
 * step or a word this side does not know, or facts it cannot read, are read as
 * absent rather than refusing the body.
 */
export const InitErrorBodySchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  stage: z.enum(INIT_STAGES).optional().catch(undefined),
  /**
   * What a failed connection's MCP server answered: the HTTP status it refused
   * the connection with, or the code of the JSON-RPC error it sent.
   */
  mcp: z
    .object({
      http_status: z.number().int().optional(),
      rpc_code: z.number().int().optional(),
    })
    .optional()
    .catch(undefined),
  infra_hosts: InfraHostsField,
});

/** The body of a failed `/init`. */
export type InitErrorBody = z.infer<typeof InitErrorBodySchema>;

/** What a failed connection's MCP server answered, as the body of a failed `/init` carries it. */
export type InitMcpFacts = NonNullable<InitErrorBody["mcp"]>;

/**
 * The most of a failure's message the body of a failed `/init` carries, in
 * bytes as JSON writes it: far under what the harness reads of an error body
 * (4 KiB), so that a message of any length — an MCP server's address is the
 * agent's own, unbounded — leaves the step, what the server answered and the
 * measurement readable. The harness never shows the message to a run's caller.
 */
export const INIT_ERROR_MESSAGE_MAX_BYTES = 1024;

/** What ends a message that was cut. */
const CUT_MARKER = "…";

/** The bytes a text takes inside a JSON string — escapes included, quotes left out. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * A failure's message as the body of a failed `/init` carries it: whole within
 * {@link INIT_ERROR_MESSAGE_MAX_BYTES}, otherwise cut to fit it with a marker at
 * its end — counted as JSON writes it, an escaped character at its escape's
 * length, and cut between characters, never inside one.
 */
export function initErrorMessage(message: string): string {
  const kept = INIT_ERROR_MESSAGE_MAX_BYTES - jsonStringBytes(CUT_MARKER);
  let bytes = 0;
  let at = 0;
  let cutAt: number | undefined;
  for (const character of message) {
    bytes += jsonStringBytes(character);
    if (cutAt === undefined && bytes > kept) cutAt = at;
    if (bytes > INIT_ERROR_MESSAGE_MAX_BYTES) return `${message.slice(0, cutAt)}${CUT_MARKER}`;
    at += character.length;
  }
  return message;
}

/**
 * The body a runner answers a failed `/init` with: the fixed error, the
 * failure's message within its bound ({@link initErrorMessage}), the step read
 * from the error's class ({@link initStageOf}), what an MCP server answered
 * ({@link mcpFactsOf}), and the measurement of the infrastructure hosts, when
 * there is one.
 */
export function initErrorBody(
  err: unknown,
  infraHosts: InfraHostsCheck | undefined,
): InitErrorBody {
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: "init failed",
    message: initErrorMessage(message),
    stage: initStageOf(err),
    mcp: mcpFactsOf(err),
    infra_hosts: infraHosts,
  };
}

/** The steps the runner names itself: no error class of the runtime's says them. */
export type RunnerNamedStage = "bundle-checksum" | "bundle-extract" | "disk-full";

/**
 * A step of `/init` that failed where no error of the runtime's says which: a
 * bundle that does not match its checksum, one that does not extract, a disk
 * the runner found full. The runner raises it with the step it was running.
 */
export class InitStepError extends Error {
  readonly stage: RunnerNamedStage;

  constructor(stage: RunnerNamedStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InitStepError";
    this.stage = stage;
  }
}

/** How deep a chain of causes is followed: far enough for any wrapping, never round a cycle. */
const MAX_CAUSE_DEPTH = 8;

/** Whether `err`, or one of its causes, is a write the disk refused for want of space. */
function outOfSpace(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof at === "object" && at !== null; depth++) {
    if ((at as { code?: unknown }).code === "ENOSPC") return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The step a failure of `/init` is told by, read from its error's class and
 * never from its text. A full disk is the disk's, whatever step met it; the
 * download's failures say how they failed (an older one without `kind`, by
 * whether an answer came); the runner names its checksum and its extraction;
 * a failed connection to an MCP server is its own step; the rest is `other`.
 */
export function initStageOf(err: unknown): InitStage {
  if (outOfSpace(err)) return "disk-full";
  if (err instanceof InitStepError) return err.stage;
  if (err instanceof BundleFetchFailedError) {
    switch (err.details.kind) {
      case "network":
        return "bundle-network";
      case "status":
        return "bundle-status";
      case "incomplete":
        return "bundle-incomplete";
      default:
        return err.details.httpStatus === null ? "bundle-network" : "bundle-status";
    }
  }
  if (err instanceof McpConnectError) return "mcp-connect";
  return "other";
}

/**
 * What the MCP server of a failed connection answered — the status it refused
 * the connection with, the code of the JSON-RPC error it sent —, for the body
 * of a failed `/init`; nothing when it answered neither, or when `err` is not
 * a failed connection.
 */
export function mcpFactsOf(err: unknown): InitMcpFacts | undefined {
  if (!(err instanceof McpConnectError)) return undefined;
  const { httpStatus, rpcCode } = err.details;
  if (httpStatus === undefined && rpcCode === undefined) return undefined;
  return {
    ...(httpStatus !== undefined && { http_status: httpStatus }),
    ...(rpcCode !== undefined && { rpc_code: rpcCode }),
  };
}

/**
 * The statuses an MCP server refuses a connection with that another machine
 * would meet too: the server asks for a credential the agent does not send
 * (401), has nothing at that address (404), or does not take the method (405).
 * A 403 is left out — a CDN in front of the server can refuse one machine's
 * address and not the next —, and so are 408, 429 and 5xx, which say "later".
 */
const SURE_MCP_STATUSES: ReadonlySet<number> = new Set([401, 404, 405]);

/**
 * Whether a failed `/init` is the run's own fault, which another machine would
 * meet again (`deterministic`), or may not be (`indeterminate`). The run's own:
 * a bundle whose download arrived whole and does not match its checksum, or
 * does not extract; an MCP server that refused the connection with 401, 404 or
 * 405, or answered it with a JSON-RPC error, on any transport. Anything else —
 * another refusal, no answer, a full disk, a body without a step from an older
 * runner — may not be. Where the line runs between the two lives here and
 * nowhere else.
 */
export function classifyInitFailure(
  failure: Pick<InitErrorBody, "stage" | "mcp">,
): "deterministic" | "indeterminate" {
  switch (failure.stage) {
    case "bundle-checksum":
    case "bundle-extract":
      return "deterministic";
    case "mcp-connect": {
      const status = failure.mcp?.http_status;
      if (failure.mcp?.rpc_code !== undefined) return "deterministic";
      return status !== undefined && SURE_MCP_STATUSES.has(status)
        ? "deterministic"
        : "indeterminate";
    }
    default:
      return "indeterminate";
  }
}

/**
 * The longest lifetime, in seconds, a machine's guardian arms: ten digits. Past
 * them, its sum with the machine's uptime could overflow into a deadline already
 * passed.
 */
const MAX_LIFETIME_S = 9_999_999_999;

/**
 * The body of `POST /claim`: what assigns a waiting machine to a run — the run's
 * credential, the hosts its egress rules allow, and how long the machine may
 * live from there, in whole seconds. The lifetime is optional: an older harness
 * does not send it, and the machine then arms none.
 */
export const ClaimRequestSchema = z.object({
  rpcToken: z.string().min(32),
  allowedHosts: z.array(z.string()).default([]),
  lifetimeS: z.number().int().positive().max(MAX_LIFETIME_S).optional(),
});

/** The body of `POST /claim` as the runner reads it. */
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

/**
 * The runner's answer to a successful `/claim`. `process_id` names the process
 * that answered — the same value it gave when the machine was made ready means
 * the machine resumed rather than booted again; `uptime_ms` is how long the
 * machine has run. Both optional: an older runner sends neither or only the
 * second, and a harness reads their absence as "unknown".
 */
export const ClaimResultSchema = z.object({
  ok: z.literal(true),
  uptime_ms: z.number().optional(),
  process_id: z.string().optional(),
});

/** The runner's answer to a successful `/claim`. */
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/**
 * The body of `POST /tool`: a tool of the agent's to run — one of its scripts,
 * or a tool of one of its MCP servers — by its name, and its arguments, none
 * when the body sends none.
 */
export const ToolRequestSchema = z.object({
  kind: z.enum(["script", "mcp"]),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** The body of `POST /tool` as the runner reads it, the absent arguments empty. */
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

/**
 * The runner's answer to `GET /healthz`, which it gives once it serves: `ok`,
 * and `process_id`, the process that answered — the value its answer to
 * `/claim` gives too, which is how a pooled machine that resumed is told from
 * one that booted again. A harness reads the runner ready from the status
 * alone, and the process from this answer: both fields are optional to it — an
 * older runner answers `{ ok }` alone —, and an answer it cannot read leaves the
 * process unknown.
 */
export const HealthzResultSchema = z.object({
  ok: z.literal(true).optional(),
  process_id: z.string().optional(),
});

/** The runner's answer to `GET /healthz`. */
export type HealthzResult = z.infer<typeof HealthzResultSchema>;
