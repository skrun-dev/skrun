// Fly.io Machines REST API typed client.
//
// Hand-rolled by design: no widely-adopted official Node
// SDK for the Machines API as of 2026-05-23, so a small typed wrapper around
// native `fetch` + `zod` is cheaper than fighting an unmaintained dep. Surface
// is intentionally narrow — only the eight calls the adapter, the pool and the
// operator's cleanup send: create, start, suspend, stop, destroy, list, list by
// label, and the write of one key of a machine's metadata.
//
// Rate limits per https://fly.io/docs/machines/api/working-with-machines-api/
// (read 2026-10-12): 1 request per second per action, bursts of 3 (GET machine:
// 5/s, bursts of 10), scoped per identifier — the app for an action that names no
// machine, a creation among them; the machine for the others. One client serves
// every caller of a process — the pool and every run — so it keeps the app-wide
// rate itself, for the two actions it sends under the app: each attempt of a
// creation, and of a listing, takes a send slot from a token bucket of its
// action, 3 at once then 1 per second. Two listings at once still share one
// request, and so one slot.
//
// A 429 on a creation or a listing is the platform telling the whole app to slow
// down: it is waited out patiently — the `Retry-After` it sends, capped at 10 s,
// or 1, 2, 4 then 8 s — four times for the whole operation, each retry taking a
// slot again, and each refusal logged without a word of the answer. A 429 on a
// call that targets one machine keeps the short backoff of the per-machine limit
// (0.25, 0.5 then 1 s). A start refused because the machine is still being
// suspended (412) is waited out too, with a margin of its own — see `start()`.
//
// Coalescing — and why a creation never is. The API has no Idempotency-Key
// header. Two concurrent calls that ask for the same thing — the same listing,
// the same order on the same machine — share one request, so concurrent retry
// loops cannot double a mutation (a second DELETE of a machine would answer 404,
// an order sent for nothing). A creation is never shared: two creations are two
// intents, each with its own body, and the path says nothing of the body —
// sharing one request handed the second caller the machine, and the credential,
// of the first. Nor is the write of a metadata key, whose path does not carry
// the value written. Each call says whether it may share (`CallPolicy.coalesce`);
// the choice is never deduced from the path.
//
// A creation that fails — and why it is not simply sent again. With no
// idempotency key, sending a creation again after the first request reached the
// platform makes a second machine, and the first bills unseen. So a creation has
// a loop of its own, and each failure is classified (`classifyCreateFailure`):
// a request that provably never left — connection refused, host not resolved,
// connection timed out — is sent again directly, three times at most; a refusal
// is final; anything else may have made a machine, and that outcome is unknown.
// An unknown outcome is not sent again blindly: the machine is looked for by the
// label every creation of the product carries (`RUN_LABEL_KEY`, `POOL_LABEL_KEY`)
// and adopted when found; only when none appears is the creation sent once more
// — never twice, and never after the platform refused the name as taken. A
// creation without a label has nothing to be found by, and fails.
//
// A caller's signal — and what it never cancels. `create`, `start`, `suspend`,
// `destroy`, `list`, `listByLabel` and `setMetadata` take the signal of their
// caller. Once it
// aborts, nothing more is sent for that caller: a creation's request in flight is
// cut, its waits end, and neither a label search nor a destruction follows — the
// call rejects with the signal's reason, and a machine it may have made is left
// to its caller, who finds it by its label. A shared request is another matter:
// the signal of one caller races it and never aborts it — another caller may be
// waiting for the same answer. Only once every caller waiting for it has
// abandoned does the request stop; a call that comes after sends its own.
//
// A bound on every attempt — and how it differs from a caller's signal. A
// request the platform never answers would wait as long as its caller does:
// forever, for a caller with no signal to give. So each attempt — the request
// and the reading of its whole answer — has a bound of its own, per kind of call
// (`FLY_ATTEMPT_TIMEOUT_MS`), under a signal made afresh for that attempt: a
// bound that elapsed never cuts the next one. An attempt its bound cut has
// failed on the network: a call retries it on the budget it has today, and a
// creation's outcome turns unknown — it is looked for by its label. Unless a
// status that is no success came before the bound cut its body: that status
// decides, on an empty body — a 404 of a destruction is done, a refusal of a
// creation fails it, never sent again —, save a 412 whose body the call reads
// to know which refusal it is (`readsBodyOf`): that body cut — by the bound,
// or by the network —, it has not been read, and its attempt has failed on the
// network. A caller's
// signal ends the call instead. The two are told apart by which of them
// aborted, never by the reason it carries: a caller may abort with a timeout of
// its own. The bounds are per attempt, never per call: a creation's worst case
// (`createWorstCaseMs`) does not count them.

import { z } from "zod";
import { MachineSpawnError } from "../../errors.js";
import { createLogger, type Logger } from "../../logger.js";
import { errorFields } from "../../utils/error-fields.js";

const FLY_API_BASE_URL = "https://api.machines.dev/v1";

// ---------- Zod schemas (response shapes) ----------

/**
 * The machine states the platform documents
 * (https://fly.io/docs/machines/machine-states/, read 2026-10-12): five
 * persistent, nine transient, three terminal.
 */
export const KNOWN_MACHINE_STATES = [
  // persistent
  "created",
  "started",
  "stopped",
  "suspended",
  "failed",
  // transient
  "creating",
  "starting",
  "stopping",
  "restarting",
  "suspending",
  "destroying",
  "launch_failed",
  "updating",
  "replacing",
  // terminal
  "destroyed",
  "replaced",
  "migrated",
] as const;

// A state this client does not know is read as "unknown", never as a parse
// failure. A listing carries every machine of the app: when this field was a
// strict enum, one machine in an unlisted state failed the whole `list()` —
// the pool's reconciliation skipped every pass while it existed, and a machine
// found in `creating` could not be read at all. It happened once already, with
// `suspended`, absent until 2026-08-19 although the pool suspends every machine
// it holds. Callers compare a state to the values they act on; "unknown" is
// none of them.
const MachineStateSchema = z.enum([...KNOWN_MACHINE_STATES, "unknown"]).catch("unknown");

const MachineConfigEnvSchema = z.record(z.string(), z.string()).optional();

const MachineServicePortSchema = z.object({
  port: z.number().int(),
  handlers: z.array(z.string()).optional(),
});

const MachineServiceSchema = z.object({
  protocol: z.string(),
  internal_port: z.number().int(),
  ports: z.array(MachineServicePortSchema).optional(),
});

const MachineMountSchema = z.object({
  volume: z.string(),
  path: z.string(),
});

const MachineRestartPolicySchema = z.object({
  policy: z.enum(["no", "always", "on-failure"]).optional(),
  max_retries: z.number().int().optional(),
});

// Machine "guest" config — VM resource specification. Required for our
// runtime image: the multi-runtime base + iptables setup + Node Hono
// server doesn't fit in Fly's default 256MB, and a 256MB machine stays
// in "created" state on boot (HTTP 408 deadline_exceeded). Surfaced
// during the first real-Fly cold-start run 2026-05-25.
export const MachineGuestSchema = z.object({
  cpu_kind: z.enum(["shared", "performance"]),
  cpus: z.number().int().positive(),
  memory_mb: z.number().int().positive(),
});

// The labels of a machine: the key-value pairs the platform keeps with it and
// filters its listing on. Read tolerantly — any value, and anything that is not
// a set of pairs read as none: a listing carries every machine of the app, and
// one machine labelled by someone else must not fail it (the lesson of the
// states above). Callers compare a value to the text they look for.
const MachineMetadataSchema = z.record(z.string(), z.unknown()).optional().catch(undefined);

// Whether the platform destroys the machine once its main process exits. Read
// tolerantly, for the same reason as the labels: anything but a boolean is read
// as absent rather than failing the listing.
const MachineAutoDestroySchema = z.boolean().optional().catch(undefined);

export const MachineConfigSchema = z.object({
  image: z.string(),
  env: MachineConfigEnvSchema,
  services: z.array(MachineServiceSchema).optional(),
  mounts: z.array(MachineMountSchema).optional(),
  restart: MachineRestartPolicySchema.optional(),
  auto_destroy: MachineAutoDestroySchema,
  guest: MachineGuestSchema.optional(),
  metadata: MachineMetadataSchema,
  // Many additional fields exist on the Fly.io side (size, schedule, dns, ...)
  // — declared open via `.passthrough()` on the outer schema so we don't reject
  // legitimate responses we don't model yet.
});

/**
 * The label of a machine this product creates for a run: `config.metadata` holds
 * `skrun_run_id=<run id>`. A label, not a name, because the platform filters its
 * listing on a metadata pair and never on a name — it is how a creation whose
 * outcome is unknown is found again.
 */
export const RUN_LABEL_KEY = "skrun_run_id";
/** The label of a pre-created (pooled) machine: `skrun_pool_id=<pool id>` — never a run's. */
export const POOL_LABEL_KEY = "skrun_pool_id";
/** Every label key this product puts on the machines it creates. */
export const MACHINE_LABEL_KEYS: readonly string[] = Object.freeze([RUN_LABEL_KEY, POOL_LABEL_KEY]);

export const MachineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    state: MachineStateSchema,
    region: z.string().optional(),
    instance_id: z.string().optional(),
    private_ip: z.string().optional(),
    image_ref: z
      .object({
        registry: z.string().optional(),
        repository: z.string().optional(),
        tag: z.string().optional(),
        digest: z.string().optional(),
      })
      .partial()
      .optional(),
    config: MachineConfigSchema.optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export const ListMachinesResponseSchema = z.array(MachineSchema);

// Start / Stop / Delete responses are typically empty or `{ok: true}`.
// We declare them open so we accept either shape without breakage.
const SimpleAckSchema = z.object({}).passthrough();

// ---------- Inferred types (public) ----------

export type MachineState = z.infer<typeof MachineStateSchema>;
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type MachineGuest = z.infer<typeof MachineGuestSchema>;
export type Machine = z.infer<typeof MachineSchema>;

export interface CreateMachineRequest {
  name?: string;
  region?: string;
  config: MachineConfig;
}

/** How a creation went, filled in by {@link FlyMachinesApi.create} for its caller. */
export interface CreateProgress {
  /**
   * The creation was sent a second time, after a label search found nothing: a
   * second machine of its label may exist — even when the creation failed — and
   * only a search by the label finds it.
   */
  resent: boolean;
  /** The machine returned was found by its label, not answered by the platform. */
  adopted: boolean;
  /**
   * When the creation's first request left, on the client's clock (`nowImpl`) —
   * kept through every retry and the resend. Absent while nothing has left: a
   * creation abandoned while it waits for its slot made no machine.
   */
  firstSentAt?: number;
  /**
   * When the creation's last request left, on the same clock — set again by each
   * request it sends, a retry and the resend included. Absent while nothing has
   * left. A machine is listed only some seconds after the request that made it:
   * a caller that abandons a creation looks for what it may have made until a
   * read leaves well after this instant, not after the first.
   */
  lastSentAt?: number;
}

/** The kinds of call the client sends — each with a bound of its own on every attempt. */
export type FlyEndpoint =
  | "create"
  | "start"
  | "suspend"
  | "stop"
  | "destroy"
  | "list"
  | "listByLabel"
  | "metadata";

/** What a caller may pass a call of the client. */
export interface FlyCallOptions {
  /**
   * The caller's signal. Once it aborts, nothing more is sent for this caller and
   * the call rejects with its reason — see the header for what a shared request
   * does with it.
   */
  signal?: AbortSignal;
}

/** What a caller may pass a destruction. */
export interface FlyDestroyOptions extends FlyCallOptions {
  /**
   * Whether the platform is to destroy the machine whatever its state, a started
   * one included. True by default. False asks it to destroy the machine only if
   * it is not running: measured against the platform on 2026-10-23, a DELETE
   * without force destroys a stopped or a suspended machine, and refuses — 412,
   * `failed_precondition: unable to destroy machine, not currently stopped,
   * suspended, failed, pending, or archived` — a started one, one created and
   * never started, and a suspended one woken just before. That refusal is an
   * answer, never a failure: see {@link MachineDestroyOutcome}.
   */
  force?: boolean;
}

/**
 * What a destruction that did not fail comes to:
 *  - `destroyed` — done, or the machine was already gone (404);
 *  - `refused-in-state` — the platform refuses to destroy this machine in its
 *    current state. Only a destruction without force comes to it: the answer
 *    that destruction is sent for — whether the machine was still idle —, and
 *    so a value rather than a rejection: a rejection stays a machine the call
 *    could not destroy.
 */
export type MachineDestroyOutcome = "destroyed" | "refused-in-state";

// ---------- Retry/backoff config ----------

export interface FlyMachinesApiOptions {
  /** Base URL override (for tests / staging). Defaults to https://api.machines.dev/v1 */
  baseUrl?: string;
  /**
   * Max retries of a network error, on every call but a creation, of a 429 on a
   * call that targets one machine (start, suspend, stop, destroy), and of a 5xx
   * or a 408 on a read by label — one budget per call. Default 3.
   * The 429s of a creation or a listing have a budget of their own, for the whole
   * operation; a creation's network errors have their own rule — see
   * {@link CREATE_DIRECT_RETRY_WAITS_MS}.
   */
  maxRetries?: number;
  /** First wait before such a retry, in ms; doubles each retry. Default 250. */
  backoffBaseMs?: number;
  /** Injectable fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Retries of a `start()` refused because the machine is still being suspended
   * (412, see {@link FlyMachinesApi.start}). Counted apart from the 429 retries.
   * Default 4.
   */
  stillActiveRetries?: number;
  /** First wait before such a retry, in ms; doubles each retry. Default 500. */
  stillActiveBackoffBaseMs?: number;
  /**
   * The one function every wait of the client goes through: the send slot of a
   * creation or a listing, the waits after a 429, the waits of a `start()`
   * refused while the machine suspends — and the spacing of a label search's
   * reads. A wait of 0 ms does not call it. Rejecting abandons the call where it
   * waits, wherever that is — a label search, or the destruction of what it
   * found, included: nothing more is sent, nothing is destroyed, a slot given up
   * is not handed to anyone, and the call rejects with what this function
   * rejected with. A machine a creation may have made is left to the caller, who
   * finds it by the creation's label. Defaults to a timer.
   *
   * `signal`, when the wait belongs to a call that carries one: a wait whose
   * signal aborts is abandoned whether or not this function listens to it — the
   * default timer is cleared then.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Injectable clock, in ms (for tests). Defaults to `Date.now`. The rate buckets
   * read it to place each send.
   */
  nowImpl?: () => number;
  /**
   * Where the client logs each 429 refusal of a creation or a listing
   * (`fly_api_rate_limited`: action, attempt, wait — never the platform's answer).
   * Defaults to a logger of its own.
   */
  logger?: Logger;
  /**
   * The bound of one attempt, in ms, per kind of call — {@link FLY_ATTEMPT_TIMEOUT_MS}
   * for any kind not given. A real timer, never the clock of `nowImpl` nor a wait
   * of `sleepImpl`: a test gives it a few milliseconds.
   */
  attemptTimeoutsMs?: Partial<Record<FlyEndpoint, number>>;
}

interface ResolvedOptions {
  baseUrl: string;
  maxRetries: number;
  backoffBaseMs: number;
  fetchImpl: typeof fetch;
  stillActiveRetries: number;
  stillActiveBackoffBaseMs: number;
  sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowImpl: () => number;
  logger: Logger;
  attemptTimeoutsMs: Readonly<Record<FlyEndpoint, number>>;
}

// ---------- Bounds (exported: what a caller budgets for a creation derives from them) ----------

/**
 * Requests the platform lets an app send at once, per app-wide action — the
 * burst of the creations' bucket and of the listings' one. The platform's
 * documented limit, which the client keeps rather than discovers.
 */
export const FLY_APP_ACTION_BURST = 3;
/** Requests per second the platform lets an app send, per app-wide action, past the burst. */
export const FLY_APP_ACTION_RATE_PER_S = 1;
/** Retries of a creation or a listing the platform refuses with 429, for the whole operation. */
export const FLY_429_MAX_RETRIES = 4;
/** Waits before those retries when the platform names none, in ms. */
export const FLY_429_BACKOFF_MS: readonly number[] = Object.freeze([1000, 2000, 4000, 8000]);
/** The longest `Retry-After` the client honours, in ms; a longer one is cut to it. */
export const FLY_RETRY_AFTER_CAP_MS = 10_000;
/**
 * Waits before the direct retries of a creation whose request provably never
 * reached the platform — connection refused, host not resolved, connection timed
 * out — in ms: three retries at most.
 */
export const CREATE_DIRECT_RETRY_WAITS_MS: readonly number[] = Object.freeze([250, 500, 1000]);
/**
 * Reads of one label search — how a creation whose outcome is unknown is found
 * again — before it concludes the machine is absent. More than the platform's
 * listing needs to show a fresh machine: a creation still in flight when the
 * outcome turned unknown is not listed yet, and a resend crossing it would make
 * a second machine.
 */
export const SEARCH_READS = 5;
/**
 * The wait before each of those reads, in ms — the first included: the platform
 * may still be finishing a creation whose outcome just turned unknown.
 */
export const SEARCH_SPACING_MS = 1000;
/**
 * The bound of one attempt of each kind of call, in ms: the request sent and its
 * whole answer read. Past it, the attempt has failed on the network — see the
 * header. Provisional: each is to be at least twice the slowest answer measured
 * against the platform for its kind. A creation and a suspend — which writes a
 * snapshot of the machine's memory — get the longest; a read by label, which a
 * label search repeats, and the write of one metadata key, the shortest.
 */
export const FLY_ATTEMPT_TIMEOUT_MS: Readonly<Record<FlyEndpoint, number>> = Object.freeze({
  create: 60_000,
  start: 30_000,
  suspend: 60_000,
  stop: 30_000,
  destroy: 30_000,
  list: 30_000,
  listByLabel: 15_000,
  metadata: 15_000,
});

/** Retries of a network error, on every call but a creation, unless the client is told otherwise. */
const DEFAULT_MAX_RETRIES = 3;
/** The first wait before such a retry, in ms; each one doubles. */
const DEFAULT_BACKOFF_BASE_MS = 250;

/**
 * The longest one creation can wait in this client, from the call to its last
 * attempt, when `concurrentCreates` creations are asked of one process at once
 * (the pool's refill counted) and a label search reads `searchReads` times
 * (default {@link SEARCH_READS}), on the client's default `maxRetries` and
 * `backoffBaseMs`:
 *
 *  - its send slot: (N − burst) / rate seconds — none while N ≤ burst;
 *  - the patience for its own 429s: {@link FLY_429_MAX_RETRIES} × {@link FLY_RETRY_AFTER_CAP_MS};
 *  - the patience for the 429s of its search reads, a budget of their own: as much again;
 *  - two label searches — before the one resend, and after a resend whose outcome is
 *    unknown again —, each of k reads: the read's spacing ({@link SEARCH_SPACING_MS}),
 *    and the retries of a read cut by a network error, or answered a 5xx or a 408 —
 *    three, after 0.25, 0.5 then 1 s;
 *  - the direct retries of a request that never left: {@link CREATE_DIRECT_RETRY_WAITS_MS}.
 *
 * Each wait is counted at its length or at one send interval of its bucket
 * (1 / rate), whichever is longer: a retry takes a slot again, and a creation
 * alone never waits more than one interval for it — its bucket never holds more
 * than a burst of sends ahead, and the wait before the retry has spent part of
 * that already. A read cut three times in 1.75 s sends four requests, so it can
 * wait 1.25 s more for its slots: the term counts 3 s.
 *
 * 141 s for 21 creations at once and 5 reads per search: 18 s for a slot, 40 s
 * of patience for the requests and 40 s for the reads, 2 × 5 × (1 + 3) s of
 * search, 3 s of direct retries. What it does not bound: contention between
 * creations at once past the first slot — a retry or a search read that queues
 * again behind other creations doing the same, or behind another listing of the
 * process —, the time each request takes on the platform's side (about 2 s for a
 * creation; a refusal for a duplicate name was measured at 14 s), and the
 * destruction of a machine a search found and did not adopt. Each attempt has a
 * bound of its own ({@link FLY_ATTEMPT_TIMEOUT_MS}), never counted here: what
 * waits on a creation as a whole bounds it with its signal.
 */
export function createWorstCaseMs(input: {
  concurrentCreates: number;
  searchReads?: number;
}): number {
  const reads = input.searchReads ?? SEARCH_READS;
  const intervalMs = 1000 / FLY_APP_ACTION_RATE_PER_S;
  const atLeastASlot = (ms: number) => Math.max(ms, intervalMs);
  const slotWaitMs = Math.max(0, input.concurrentCreates - FLY_APP_ACTION_BURST) * intervalMs;
  const patienceMs = FLY_429_MAX_RETRIES * atLeastASlot(FLY_RETRY_AFTER_CAP_MS);
  let readRetriesMs = 0;
  for (let retry = 0; retry < DEFAULT_MAX_RETRIES; retry++) {
    readRetriesMs += atLeastASlot(DEFAULT_BACKOFF_BASE_MS * 2 ** retry);
  }
  const searchesMs = 2 * reads * (atLeastASlot(SEARCH_SPACING_MS) + readRetriesMs);
  const directRetriesMs = CREATE_DIRECT_RETRY_WAITS_MS.reduce(
    (sum, ms) => sum + atLeastASlot(ms),
    0,
  );
  return slotWaitMs + patienceMs + patienceMs + searchesMs + directRetriesMs;
}

// ---------- A failed creation, classified ----------

/**
 * The status the platform answers a creation whose machine name is already
 * taken with (measured 2026-10-13: 409, `already_exists: unique machine name
 * violation`). Read on the status alone: one sample does not prove the body
 * stable, and a 409 that is not about the name only costs a search that finds
 * nothing.
 */
export const DUPLICATE_NAME_STATUS = 409;

/**
 * Network failures that prove the request never reached the platform: the
 * connection was refused, the host's name did not resolve, the connection was
 * never established in time (Node's fetch reports that as
 * `UND_ERR_CONNECT_TIMEOUT`, measured 2026-10-13).
 */
const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** A failed attempt at a creation, as the client saw it. */
export type CreateFailure =
  /** The request failed without an answer: what `fetch` threw. */
  | { kind: "network"; error: unknown }
  /** The platform answered with a status that is not a success. */
  | { kind: "status"; status: number }
  /** The platform answered a success whose body could not be read as a machine. */
  | { kind: "unreadable"; status: number };

/** What a failed attempt says about the machine it asked for. */
export type CreateFailureClass =
  /** The request provably never reached the platform: sent again directly. */
  | "never-sent"
  /** It may have reached it: a machine may exist, so it is looked for before anything else. */
  | "unknown"
  /** The platform refused the name as taken: the machine is looked for, never sent again. */
  | "duplicate-name"
  /** The platform asked the whole app to slow down: waited out, on a budget of its own. */
  | "rate-limited"
  /** The platform refused the request: the creation fails. */
  | "refused";

/**
 * Classify a failed attempt at a creation. Only a network error that proves the
 * request never left is `never-sent`: every code of the error `fetch` threw — its
 * cause, or each error of an `AggregateError` when every address of the host was
 * tried — must be one that does. Any other network failure, a connection reset
 * once the request left, a response that never came, a 408, a 5xx — neither a
 * gateway nor a timeout says whether the API behind it acted — and a success
 * whose body cannot be read (the machine then exists for sure) are `unknown`.
 */
export function classifyCreateFailure(failure: CreateFailure): CreateFailureClass {
  if (failure.kind === "network") return provesNeverSent(failure.error) ? "never-sent" : "unknown";
  if (failure.kind === "unreadable") return "unknown";
  const { status } = failure;
  if (status === 429) return "rate-limited";
  if (status === DUPLICATE_NAME_STATUS) return "duplicate-name";
  if (status === 408 || status >= 500) return "unknown";
  return "refused";
}

function provesNeverSent(error: unknown): boolean {
  // Node's fetch throws a TypeError whose cause carries the code; an error that
  // carries one itself is read as it is.
  const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (reason instanceof AggregateError) {
    return (
      reason.errors.length > 0 && reason.errors.every((e) => NEVER_SENT_CODES.has(codeOf(e) ?? ""))
    );
  }
  return NEVER_SENT_CODES.has(codeOf(reason) ?? "");
}

function codeOf(error: unknown): string | undefined {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * A creation whose outcome is unknown: what the attempt got, for the error that
 * says so, and whether the platform refused the name as taken.
 */
interface UnknownCreation {
  failureClass: "unknown" | "duplicate-name";
  /** The status the platform answered, when it answered one. */
  status: number | null;
  /** What happened, in a few words: a status, a network code. */
  what: string;
  /** What `fetch` threw, when it threw. */
  error?: unknown;
}

/** What one creation may still spend, for the whole operation. */
interface CreateBudget {
  /** 429 refusals of its requests so far. */
  rateLimited: number;
  /** Direct retries of a request that never left, so far. */
  directRetries: number;
}

/**
 * The error of a creation whose outcome stayed unknown: what the attempt got, and
 * why it ends there. Its cause is `cause` when given — what ended the search —,
 * else what `fetch` threw, if anything. No machine id: whatever the search found
 * and did not adopt, it destroyed itself.
 */
function unknownCreationError(
  name: string,
  path: string,
  outcome: UnknownCreation,
  reason: string,
  cause?: unknown,
): MachineSpawnError {
  const underlying = cause ?? outcome.error;
  return new MachineSpawnError(
    { machineName: name, machineId: null, phase: "create", httpStatus: outcome.status },
    new Error(
      `Fly.io API POST ${path}: the outcome of the creation is unknown (${outcome.what}), and ${reason}`,
      underlying === undefined ? undefined : { cause: underlying },
    ),
  );
}

/** Why a label search failed, in the client's words and the platform's status — never a search error's own wrapper. */
function describeSearchFailure(error: unknown): string {
  if (error instanceof MachineSpawnError && error.cause instanceof Error)
    return error.cause.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A wait of the client its caller abandoned: `sleepImpl` rejected, with `reason`.
 * The client wraps the rejection the moment it happens, so that a step which
 * catches failures — a label search, the destruction of what it found — knows an
 * abandon from a failure for sure, whatever the caller rejected with, and stops
 * instead of acting on it. Never seen outside the client: each public method
 * hands its caller `reason` itself.
 */
class WaitAbandoned {
  constructor(readonly reason: unknown) {}
}

/**
 * A destruction without force the platform refused in the machine's current
 * state (see {@link CallPolicy.refusedInStateIsAnswer}). Thrown inside the
 * client so that a shared request hands it to every caller waiting for it, and
 * read by `destroy()` as the outcome `refused-in-state`. Never seen outside.
 */
class RefusedInState {}

/**
 * An attempt that failed once a status had come whose meaning the call reads in
 * its body (see {@link readsBodyOf}), that body never read — cut by the
 * attempt's bound, the network or the caller. It carries that `status`, so
 * that a call whose retries are spent fails on the last status whose body,
 * read for its meaning, never came — an answer read later does not replace
 * it —, and `cause`, what cut the body. Thrown by `send()`, read by
 * `runWithRetry()` as the attempt's network failure. Never seen outside.
 */
class BodyUnread {
  constructor(
    readonly status: number,
    readonly cause: unknown,
  ) {}
}

/** A call of the client as its caller sees it: an abandoned wait rejects with what the caller abandoned it with. */
async function asCallerSees<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw err instanceof WaitAbandoned ? err.reason : err;
  }
}

/**
 * What an attempt its bound cut fails with: no answer — the request sent and its
 * whole body read — within `ms`. Named as the platform's own timeouts are, a
 * `TimeoutError`; told apart from a caller's abort by the signal that aborted,
 * never by this name.
 */
class AttemptTimedOut extends Error {
  constructor(readonly ms: number) {
    super(`The machines API did not answer within ${ms} ms.`);
    this.name = "TimeoutError";
  }
}

/**
 * The bound of one attempt. Its signal aborts once `ms` have passed — with an
 * {@link AttemptTimedOut} — or once `outer` aborts, with its reason, whichever
 * comes first. One per attempt, made as the attempt starts: a bound already
 * spent would cut the next attempt at once. `end()` clears its timer once the
 * attempt is over, however it ended — none outlives its attempt, and none keeps
 * the process alive meanwhile.
 */
class AttemptBound {
  readonly signal: AbortSignal;
  private readonly own = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(ms: number, outer: AbortSignal | undefined) {
    this.timer = setTimeout(() => this.own.abort(new AttemptTimedOut(ms)), ms);
    this.timer.unref?.();
    this.signal = outer ? AbortSignal.any([outer, this.own.signal]) : this.own.signal;
  }

  /** The error the bound cut the attempt with, once it elapsed; undefined before. */
  get elapsed(): AttemptTimedOut | undefined {
    return this.own.signal.aborted ? (this.own.signal.reason as AttemptTimedOut) : undefined;
  }

  end(): void {
    clearTimeout(this.timer);
  }
}

/** What one attempt got: the platform's status, its headers, and its whole body. */
interface Answer {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

/** States of a machine found by its label that are on their way to running: adopted. */
const ADOPTABLE_STATES: ReadonlySet<MachineState> = new Set([
  "creating",
  "created",
  "starting",
  "started",
]);
/** States of a machine found by its label that are going away: read as absent. */
const GONE_STATES: ReadonlySet<MachineState> = new Set(["destroying", "destroyed"]);

/** The oldest machine by `created_at` — or, when one has none to read, the first listed. */
function oldest(machines: Machine[]): Machine {
  const times = machines.map((m) =>
    m.created_at === undefined ? Number.NaN : Date.parse(m.created_at),
  );
  if (times.some(Number.isNaN)) return machines[0];
  let at = 0;
  for (let i = 1; i < machines.length; i++) if (times[i] < times[at]) at = i;
  return machines[at];
}

/** A network failure in a few words: its codes, never its message. */
function describeNetworkError(error: unknown): string {
  const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const codes = (reason instanceof AggregateError ? reason.errors : [reason])
    .map(codeOf)
    .filter((code): code is string => code !== undefined);
  return codes.length > 0
    ? `a network error, ${[...new Set(codes)].join(", ")}`
    : "a network error";
}

/** The machine a creation's success answered, or why there is none to read. */
function readMachine(text: string): { machine: Machine } | { unreadable: string } {
  if (text === "") return { unreadable: "an empty body" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { unreadable: "a body that is not JSON" };
  }
  const parsed = MachineSchema.safeParse(json);
  if (parsed.success) return { machine: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    unreadable: `a body that is not a machine (${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch"})`,
  };
}

/** The label a creation can be found again by: exactly one of the product's keys, with a value. */
interface CreationLabel {
  key: string;
  value: string;
}

/**
 * The label a creation carries, when it can be found again by it: its
 * configuration holds exactly one of {@link MACHINE_LABEL_KEYS} with a non-empty
 * text value, and the request names the machine — the search keeps only a
 * machine of that label and that name. Otherwise, why it cannot be: what it
 * lacks, the name, the label, or both.
 */
function recoverableLabel(request: CreateMachineRequest): CreationLabel | { lacks: string } {
  const metadata = request.config.metadata ?? {};
  const present = MACHINE_LABEL_KEYS.filter((key) => {
    const value = metadata[key];
    return typeof value === "string" && value !== "";
  });
  const named = Boolean(request.name);
  const labelled = present.length === 1;
  if (named && labelled) return { key: present[0], value: metadata[present[0]] as string };
  const missing = [
    ...(named ? [] : ["no name"]),
    ...(labelled ? [] : ["no single label with a value"]),
  ].join(" and ");
  const keys = labelled ? "" : ` — exactly one of ${MACHINE_LABEL_KEYS.join(", ")}`;
  return { lacks: `it carries ${missing} to be found again by${keys}` };
}

/**
 * A token bucket that hands out send times rather than tokens.
 *
 * `reserve()` books the next free slot and returns how long to wait for it — 0
 * when there is a token now. It is synchronous: the caller books its slot the
 * moment it calls, so the calls are served in the order they were made, and no
 * queue exists to clean up. A slot booked is never given back: a caller that
 * gives up while waiting for it loses it, and no later caller moves.
 *
 * Kept as the theoretical time the next request would be due at one per
 * interval; the burst is how far ahead of that a request may still leave.
 */
class TokenBucket {
  private readonly intervalMs: number;
  private readonly aheadMs: number;
  private dueAt = Number.NEGATIVE_INFINITY;

  constructor(
    burst: number,
    ratePerSecond: number,
    private readonly now: () => number,
  ) {
    this.intervalMs = 1000 / ratePerSecond;
    this.aheadMs = (burst - 1) * this.intervalMs;
  }

  reserve(): number {
    const now = this.now();
    const due = Math.max(this.dueAt, now);
    const sendAt = Math.max(now, due - this.aheadMs);
    this.dueAt = due + this.intervalMs;
    return sendAt - now;
  }
}

/** The actions sent under the app rather than under one machine. */
type AppAction = "create" | "list";

/** What a single call may share, and wait out beyond the 429 policy every call shares. */
interface CallPolicy {
  /** The kind of call: what bounds each of its attempts ({@link FLY_ATTEMPT_TIMEOUT_MS}). */
  endpoint: FlyEndpoint;
  /**
   * Whether a concurrent call of the same method and path — query included —
   * awaits this one's request instead of sending its own. True only for calls
   * that ask for the same thing whoever makes them: a listing, an order on one
   * machine. Never for a creation, which has a loop of its own and never comes
   * here, nor for the write of a metadata key, whose path does not carry its
   * value (see the header).
   *
   * The signal of a caller races the shared promise and never aborts the shared
   * request: one caller giving up must not cancel the call of another. The
   * request stops only once every caller waiting for it has abandoned.
   */
  coalesce: boolean;
  /**
   * The app-wide action this call is, when it is one: each of its attempts takes a
   * send slot from that action's bucket. Calls that target one machine leave it
   * unset — their limit is per machine.
   */
  appAction?: AppAction;
  /**
   * The 429 budget of an app-wide action, when the call shares one with others of
   * its operation — the reads of a creation's label search. A fresh one per call
   * otherwise.
   */
  rateBudget?: { rateLimited: number };
  /**
   * Retry a 412 whose body says the machine is still active. `start()` only. A
   * 412 whose body is cut — by the attempt's bound or by the network — is that
   * attempt failing on the network ({@link readsBodyOf}).
   */
  retryStillActive?: boolean;
  /**
   * Take a 404 as the order done: the machine is not there. A destruction only —
   * what it asks for is a machine gone, and one can be gone before it is asked:
   * destroyed by an earlier request, or by the platform itself.
   */
  absentIsDone?: boolean;
  /**
   * Take a 412 whose body says `failed_precondition` as the platform's answer
   * that it will not destroy the machine in its current state: the call rejects
   * with {@link RefusedInState}, never retried, which `destroy()` reads as an
   * outcome. A destruction without force only — with force, the same answer
   * stays a failure. Read in the body only: a 412 whose body is cut — by the
   * attempt's bound or by the network — is that attempt failing on the network
   * ({@link readsBodyOf}).
   */
  refusedInStateIsAnswer?: boolean;
  /**
   * Retry a 5xx or a 408 — the platform, or a gateway before it, failing this
   * once — on the budget of the network errors. Set by the label reads only: a
   * read changes nothing, and one 500 must not end the search that a 5xx on a
   * creation starts. Never a creation, whose outcome such an answer leaves
   * unknown; never the listing of the whole app nor an order on one machine,
   * which keep failing at once.
   */
  retryServerFailure?: boolean;
}

/** A request concurrent callers share: its promise, and what stops it once none of them waits. */
interface SharedCall {
  promise: Promise<unknown>;
  /** Aborted once every caller waiting for it has abandoned: its request and its waits end. */
  controller: AbortController;
  /** The callers waiting for it. */
  waiting: number;
}

// ---------- Client ----------

export class FlyMachinesApi {
  private readonly opts: ResolvedOptions;
  // The in-flight requests of the calls that coalesce, by method and path (query
  // included). Each entry is the request a concurrent identical call awaits
  // instead of sending a request of its own. A creation is never entered here.
  private readonly inflight = new Map<string, SharedCall>();
  // The send slots of the app-wide actions, one bucket per action, per client —
  // and so per process, which builds one client.
  private readonly buckets: Record<AppAction, TokenBucket>;

  constructor(
    private readonly token: string,
    private readonly appName: string,
    options: FlyMachinesApiOptions = {},
  ) {
    this.opts = {
      baseUrl: options.baseUrl ?? FLY_API_BASE_URL,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      stillActiveRetries: options.stillActiveRetries ?? 4,
      stillActiveBackoffBaseMs: options.stillActiveBackoffBaseMs ?? 500,
      sleepImpl: options.sleepImpl ?? sleep,
      nowImpl: options.nowImpl ?? Date.now,
      logger: options.logger ?? createLogger("fly-api"),
      attemptTimeoutsMs: { ...FLY_ATTEMPT_TIMEOUT_MS, ...options.attemptTimeoutsMs },
    };
    this.buckets = {
      create: new TokenBucket(FLY_APP_ACTION_BURST, FLY_APP_ACTION_RATE_PER_S, this.opts.nowImpl),
      list: new TokenBucket(FLY_APP_ACTION_BURST, FLY_APP_ACTION_RATE_PER_S, this.opts.nowImpl),
    };
  }

  /**
   * Create a machine. Never shared with another caller, never sent again blindly
   * once it may have reached the platform — see the header: a request that
   * provably never left is sent again directly, three times at most; a refusal
   * fails; an outcome that is unknown is looked for by the creation's label —
   * and fails a creation that carries none. When the search finds nothing, the
   * creation is sent once more, never twice: a name refused as taken is looked
   * for, never sent again, and so is a second outcome unknown.
   *
   * `progress`, when given, says how it went: `resent` once the creation is sent
   * a second time — from then on, a second machine of its label may exist, even
   * when this call fails, and the caller is the one to clean it up; `adopted`
   * when the machine returned was found by its label rather than answered.
   *
   * A wait its caller abandons (see `sleepImpl`) ends the creation where it
   * waits, its label search included: nothing more is sent, nothing is
   * destroyed, and the call rejects with what `sleepImpl` rejected with. Once the
   * creation was sent, a machine may exist: the caller finds it by its label.
   *
   * `options.signal` does the same wherever the creation stands: its request in
   * flight is cut, its wait ends, and the call rejects with the signal's reason.
   * `progress.firstSentAt` and `progress.lastSentAt` say whether — and when — a
   * request left.
   */
  async create(
    request: CreateMachineRequest,
    progress: CreateProgress = { resent: false, adopted: false },
    options: FlyCallOptions = {},
  ): Promise<Machine> {
    return asCallerSees(this.createMachine(request, progress, options.signal));
  }

  private async createMachine(
    request: CreateMachineRequest,
    progress: CreateProgress,
    signal: AbortSignal | undefined,
  ): Promise<Machine> {
    const name = request.name ?? "(unnamed)";
    const path = `/apps/${encodeURIComponent(this.appName)}/machines`;
    // Built once: every attempt sends the same body, so a machine found again by
    // its label carries exactly the configuration sent, credential included.
    const body = JSON.stringify(request);
    // One budget for the whole operation, the resend included: its 429s and its
    // direct retries are not counted afresh.
    const budget: CreateBudget = { rateLimited: 0, directRetries: 0 };
    // The reads of the label searches spend a 429 budget of their own, for the
    // whole operation too.
    const searchBudget = { rateLimited: 0 };

    const sent = await this.sendCreation(path, body, name, budget, progress, signal);
    if ("machine" in sent) return sent.machine;
    const label = recoverableLabel(request);
    if ("lacks" in label) throw unknownCreationError(name, path, sent, label.lacks);
    const found = await this.findCreation(path, name, label, sent, searchBudget, signal);
    if (found) {
      progress.adopted = true;
      return found;
    }
    if (sent.failureClass === "duplicate-name") {
      throw unknownCreationError(name, path, sent, "no machine with its label appeared");
    }

    // Absent: sent once more. Set before the request leaves — a resend that
    // crosses a first creation still in flight makes two machines of one label,
    // whatever this call returns.
    progress.resent = true;
    const resent = await this.sendCreation(path, body, name, budget, progress, signal);
    if ("machine" in resent) return resent.machine;
    const foundAfter = await this.findCreation(path, name, label, resent, searchBudget, signal);
    if (foundAfter) {
      progress.adopted = true;
      return foundAfter;
    }
    throw unknownCreationError(
      name,
      path,
      resent,
      "no machine with its label appeared after it was sent again",
    );
  }

  /**
   * Look for the machine a creation whose outcome is unknown may have made, by
   * its label: {@link SEARCH_READS} reads of the listing filtered on it, each
   * after {@link SEARCH_SPACING_MS} — the first included, as the platform may
   * still be finishing the creation. Each read takes a slot of the listings'
   * bucket; their 429s spend `searchBudget`; a read cut by the network, or
   * answered a 5xx or a 408, is read again, three times at most.
   *
   * Only a machine of the label and of the name sent is the creation's — the
   * platform's filter is checked again. What the state of what is found decides:
   *  - on its way to running (`creating`, `created`, `starting`, `started`):
   *    adopted, the oldest when there are several, the others destroyed;
   *  - going away (`destroying`, `destroyed`): as if absent;
   *  - any other state, one unknown included: destroyed, and the creation fails.
   * A machine adopted needs its private address: without one it is read again,
   * and destroyed if the last read still shows none.
   *
   * Returns the machine adopted, or undefined when none appeared. A search that
   * fails fails the creation: an outcome it could not learn is never sent again.
   * Whatever ends it — a read that fails, a machine not to adopt, an address that
   * never shows —, it first destroys every machine of the label and name it saw
   * on the way and did not see going away, at whichever read: never a labelled
   * orphan. All but an abandoned wait, or the creation's signal: that ends the
   * search where it waits — a read, the spacing before one, a destruction —,
   * and nothing more is sent; what the search saw is left to the caller who
   * abandoned it.
   */
  private async findCreation(
    path: string,
    name: string,
    label: CreationLabel,
    outcome: UnknownCreation,
    searchBudget: { rateLimited: number },
    signal: AbortSignal | undefined,
  ): Promise<Machine | undefined> {
    // The machines of the label and name seen so far, by id, as last read.
    const seen = new Map<string, Machine>();
    const fail = async (reason: string, cause?: unknown) => {
      await this.destroyFound([...seen.values()], "unadoptable_create", signal);
      return unknownCreationError(name, path, outcome, reason, cause);
    };
    for (let read = 1; read <= SEARCH_READS; read++) {
      await this.wait(SEARCH_SPACING_MS, signal);
      let listed: Machine[];
      try {
        listed = await this.listLabelled(label, searchBudget, signal);
      } catch (err) {
        if (err instanceof WaitAbandoned) throw err;
        throw await fail(`the search by its label failed: ${describeSearchFailure(err)}`, err);
      }
      const named = listed.filter((m) => m.name === name);
      for (const m of named) {
        if (GONE_STATES.has(m.state)) seen.delete(m.id);
        else seen.set(m.id, m);
      }
      const found = named.filter((m) => !GONE_STATES.has(m.state));
      if (found.length === 0) continue;

      const adoptable = found.filter((m) => ADOPTABLE_STATES.has(m.state));
      if (adoptable.length === 0) {
        const states = [...new Set(found.map((m) => m.state))].join(", ");
        throw await fail(`the machine found by its label is ${states}, not one to adopt`);
      }
      const chosen = oldest(adoptable);
      if (!chosen.private_ip) {
        if (read < SEARCH_READS) continue;
        throw await fail("the machine found by its label never showed a private address");
      }
      await this.destroyFound(
        found.filter((m) => m.id !== chosen.id),
        "duplicate_create",
        signal,
      );
      return chosen;
    }
    return undefined;
  }

  /**
   * Destroy machines a creation found but will not adopt, best effort: a failure
   * is logged. An abandoned wait — or the creation's signal — is no failure: it
   * ends the loop, the machines not destroyed yet left to the caller.
   */
  private async destroyFound(
    machines: Machine[],
    reason: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const machine of machines) {
      try {
        await this.destroyMachine(machine.id, signal);
        this.opts.logger.info(
          { event: "machine_destroy", machine_id: machine.id, reason },
          "a machine found by its label and not adopted was destroyed",
        );
      } catch (err) {
        if (err instanceof WaitAbandoned) throw err;
        this.opts.logger.warn(
          { event: "machine_destroy_failed", machine_id: machine.id, reason, ...errorFields(err) },
          "a machine found by its label could not be destroyed — manual cleanup may be required",
        );
      }
    }
  }

  /**
   * Send one creation until it succeeds, fails for good, or its outcome turns
   * unknown. Each attempt takes a slot of the creations' bucket. A request that
   * never left is sent again directly, after {@link CREATE_DIRECT_RETRY_WAITS_MS};
   * a 429 is waited out on the operation's budget. Each attempt is bounded on
   * its own ({@link FLY_ATTEMPT_TIMEOUT_MS}): one its bound cut may have reached
   * the platform, so its outcome is unknown. Every wait sits outside the attempt:
   * a wait that is abandoned ends the call, it is no network error to classify.
   * Nor is a request its caller's signal cut: the call ends there, its outcome
   * never classified, nothing looked for.
   */
  private async sendCreation(
    path: string,
    body: string,
    name: string,
    budget: CreateBudget,
    progress: CreateProgress,
    signal: AbortSignal | undefined,
  ): Promise<{ machine: Machine } | UnknownCreation> {
    const fail = (httpStatus: number | null, cause: unknown) =>
      new MachineSpawnError(
        { machineName: name, machineId: null, phase: "create", httpStatus },
        cause,
      );
    for (;;) {
      await this.wait(this.buckets.create.reserve(), signal);
      if (signal?.aborted) throw new WaitAbandoned(signal.reason);
      // The instant the first request leaves, kept through every retry and the
      // resend; and the instant this one leaves.
      const sentAt = this.opts.nowImpl();
      progress.firstSentAt ??= sentAt;
      progress.lastSentAt = sentAt;
      // A bound of its own for this attempt, ended before anything waits.
      const bound = new AttemptBound(this.opts.attemptTimeoutsMs.create, signal);
      const sent = await this.send("POST", path, body, bound, signal).then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error }),
      );
      bound.end();
      if ("error" in sent) {
        const err = sent.error;
        if (signal?.aborted) throw new WaitAbandoned(signal.reason);
        if (classifyCreateFailure({ kind: "network", error: err }) === "unknown") {
          return {
            failureClass: "unknown",
            status: null,
            what:
              err instanceof AttemptTimedOut
                ? `no answer within ${err.ms} ms`
                : describeNetworkError(err),
            error: err,
          };
        }
        if (budget.directRetries >= CREATE_DIRECT_RETRY_WAITS_MS.length) throw fail(null, err);
        await this.wait(CREATE_DIRECT_RETRY_WAITS_MS[budget.directRetries++], signal);
        continue;
      }

      const { answer } = sent;
      if (answer.ok) {
        // A success the client cannot read: the machine exists for sure, but
        // which one is unknown — sending again would make a second.
        const read = readMachine(answer.text);
        if ("machine" in read) return read;
        return {
          failureClass: "unknown",
          status: answer.status,
          what: `HTTP ${answer.status} with ${read.unreadable}`,
        };
      }

      const failureClass = classifyCreateFailure({ kind: "status", status: answer.status });
      if (failureClass === "rate-limited") {
        const waitMs = this.rateLimitedWait("create", budget, answer.headers);
        if (waitMs === null) {
          throw fail(429, new Error(`Fly.io API POST ${path}: 429 ${answer.text}`));
        }
        await this.wait(waitMs, signal);
        continue;
      }
      if (failureClass === "refused") {
        throw fail(
          answer.status,
          new Error(`Fly.io API POST ${path}: ${answer.status} ${answer.text}`),
        );
      }
      return {
        failureClass: failureClass === "duplicate-name" ? "duplicate-name" : "unknown",
        status: answer.status,
        what: `HTTP ${answer.status} ${answer.text}`.trim(),
      };
    }
  }

  /**
   * One attempt of a request: sent, and its whole answer read, within `bound` —
   * the attempt's own bound, joined to `signal`, the caller's or the shared
   * request's. Throws what `fetch` threw, or what cut the body while it was read;
   * an attempt the bound cut — and not `signal` — throws the bound's
   * {@link AttemptTimedOut}, whatever `fetch` made of it. Once a status that is
   * no success has come, though, it decides: a body the bound cuts reads as
   * empty — a 404 of a destruction is done, a 422 of a creation refused. A
   * success needs its body: cut, the attempt has failed — a creation's success
   * whose body is cut has an unknown outcome. So does a status whose meaning the
   * call reads in its body (`readsBody`, {@link readsBodyOf}), whatever cut it —
   * the bound, the network or `signal` —: it has not been read, and the attempt
   * has failed, with a {@link BodyUnread} that keeps the status. Any other body that fails to read, the bound not elapsed, reads
   * as empty, as it always has.
   */
  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: string | undefined,
    bound: AttemptBound,
    signal: AbortSignal | undefined,
    readsBody: (status: number) => boolean = () => false,
  ): Promise<Answer> {
    try {
      const response = await this.opts.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: bound.signal,
      });
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        // A status the call reads in its body fails the attempt whatever cut
        // that body — the bound, the network or the caller —, and says which
        // status came. Otherwise, cut by the caller: the call ends; cut by the
        // bound: a success fails the attempt; any other status decides on an
        // empty body.
        if (readsBody(response.status)) throw new BodyUnread(response.status, err);
        if (bound.signal.aborted && (response.ok || signal?.aborted)) throw err;
        text = "";
      }
      return { status: response.status, ok: response.ok, headers: response.headers, text };
    } catch (err) {
      const elapsed = bound.elapsed;
      if (elapsed && !signal?.aborted) {
        throw err instanceof BodyUnread ? new BodyUnread(err.status, elapsed) : elapsed;
      }
      throw err;
    }
  }

  /**
   * Start a machine — and resume one that is suspended.
   *
   * Fly can list a machine as `suspended` while it is still writing its
   * snapshot, and refuses a start sent in that interval: 412, with a body that
   * says the machine is still active (`failed_precondition`). The pool marks a
   * machine ready once its suspend is acknowledged, so a run that claims it in
   * the next seconds lands there. That refusal, and no other, is retried, with
   * waits of its own: 0.5, 1, 2 then 4 s by default — 7.5 s in all, beyond the
   * ~2 s a suspend was measured to take before it shows, and still far less
   * than the cold path (a machine created for the run, tens of seconds) that a
   * refusal would cost. Five starts in 7.5 s stay within the per-action rate
   * limit. Past that margin, the refusal fails as any other answer does.
   *
   * Not measured: whether Fly gives the same answer for a machine that is
   * already started (a pool out of step with the platform). If it does, a start
   * there waits the whole 7.5 s before failing as it does today — a bounded
   * cost.
   *
   * Shared with a concurrent start of the same machine: `options.signal` ends
   * this caller's wait, never the other's — see the header.
   */
  async start(machineId: string, options: FlyCallOptions = {}): Promise<void> {
    await asCallerSees(
      this.request(
        "POST",
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/start`,
        SimpleAckSchema,
        machineId,
        "boot-probe",
        null,
        { endpoint: "start", coalesce: true, retryStillActive: true },
        options.signal,
      ),
    );
  }

  /**
   * Suspend a machine: pause it and snapshot its state, memory included, so the
   * next {@link start} resumes it instead of cold-booting.
   *
   * This is the only net-new call the pre-warm pool needs — {@link start} already
   * targets the endpoint Fly documents as the resume path, so waking a suspended
   * machine reuses it unchanged.
   *
   * Two caveats the caller must handle, both from Fly's own documentation:
   *  - the resume is attempted, **not guaranteed**; a start may silently cold-boot
   *    instead, which is indistinguishable from the API's point of view;
   *  - suspending many machines at once is discouraged, so a pool top-up must
   *    serialise these calls rather than fan them out.
   *
   * Shared with a concurrent suspend of the same machine: `options.signal` ends
   * this caller's wait, never the other's — see the header.
   */
  async suspend(machineId: string, options: FlyCallOptions = {}): Promise<void> {
    await asCallerSees(
      this.request(
        "POST",
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/suspend`,
        SimpleAckSchema,
        machineId,
        "boot-probe",
        null,
        { endpoint: "suspend", coalesce: true },
        options.signal,
      ),
    );
  }

  async stop(machineId: string): Promise<void> {
    await asCallerSees(
      this.request(
        "POST",
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/stop`,
        SimpleAckSchema,
        machineId,
        "boot-probe",
        null,
        { endpoint: "stop", coalesce: true },
      ),
    );
  }

  /**
   * Destroy a machine. A machine already gone — the platform answers 404 — is a
   * destruction done: one `machine_already_gone` line, never a failure.
   *
   * With force by default: the platform destroys the machine whatever its
   * state. `options.force: false` asks it to destroy the machine only if it is
   * not running, and its refusal — 412 `failed_precondition` — resolves
   * `refused-in-state` (see {@link FlyDestroyOptions.force}); any other refusal
   * still rejects.
   *
   * Shared with a concurrent destroy of the same machine sent with the same
   * force — the query is part of what is shared, so a destruction with force
   * never answers one without: `options.signal` ends this caller's wait, never
   * the other's — see the header.
   */
  async destroy(
    machineId: string,
    options: FlyDestroyOptions = {},
  ): Promise<MachineDestroyOutcome> {
    return asCallerSees(this.destroyMachine(machineId, options.signal, options.force ?? true));
  }

  private async destroyMachine(
    machineId: string,
    signal: AbortSignal | undefined,
    force = true,
  ): Promise<MachineDestroyOutcome> {
    // `force=true` — Fly's default DELETE refuses to delete a machine that
    // isn't already stopped (HTTP 412). At end-of-run the FlyioAdapter always
    // calls destroy() on a still-started machine (the auto-started state from
    // create()), so the test smoke (phase 18) AND production both need force.
    // Mocked tests don't catch this; surfaced during the first real-Fly smoke
    // run on 2026-05-25. Without it, that refusal is what the caller asks for.
    try {
      await this.request(
        "DELETE",
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}${force ? "?force=true" : ""}`,
        SimpleAckSchema,
        machineId,
        "boot-probe",
        null,
        { endpoint: "destroy", coalesce: true, absentIsDone: true, refusedInStateIsAnswer: !force },
        signal,
      );
    } catch (err) {
      if (err instanceof RefusedInState) return "refused-in-state";
      throw err;
    }
    return "destroyed";
  }

  /**
   * Write one key of a machine's metadata — `key=value` in the metadata of its
   * configuration, which the platform filters its listing on. Measured against
   * the platform on 2026-10-21: the write answers 204, and a started machine is
   * not restarted by it; the key is found by a listing filtered on it.
   *
   * Never shared, even with a write of the same key on the same machine: the
   * path does not carry the value, and a second caller handed the first one's
   * answer would believe its own value written. A refusal fails at once, on its
   * status — a 429 aside, waited out as on every call on one machine; a network
   * error, or an attempt its bound cut, is sent again on the network budget:
   * the same write twice writes the same value. `options.signal` ends the call
   * where it stands, and nothing more is sent.
   */
  async setMetadata(
    machineId: string,
    key: string,
    value: string,
    options: FlyCallOptions = {},
  ): Promise<void> {
    await asCallerSees(
      this.request(
        "POST",
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/metadata/${encodeURIComponent(key)}`,
        SimpleAckSchema,
        machineId,
        "boot-probe",
        { value },
        { endpoint: "metadata", coalesce: false },
        options.signal,
      ),
    );
  }

  /**
   * Every machine of the app. Shared with a concurrent listing: `options.signal`
   * ends this caller's wait, never another's — see the header.
   */
  async list(options: FlyCallOptions = {}): Promise<Machine[]> {
    return asCallerSees(
      this.request(
        "GET",
        `/apps/${encodeURIComponent(this.appName)}/machines`,
        ListMachinesResponseSchema,
        "(list)",
        "boot-probe",
        null,
        { endpoint: "list", coalesce: true, appAction: "list" },
        options.signal,
      ),
    );
  }

  /**
   * The machines of the app that carry a label: `key=value` in the metadata of
   * their configuration. The platform filters (`?metadata.<key>=<value>`), and the
   * result is checked again here: a platform that ignored the filter would return
   * every machine of the app. A listing — it takes a slot of the listings'
   * bucket, waits out a 429 patiently, and two calls for one label share one
   * request. A read that only reads: a 5xx or a 408 is read again, as a network
   * error is, three times at most — the listing of the whole app fails on one.
   * `options.signal` ends this caller's wait, never another's — see the header.
   */
  async listByLabel(key: string, value: string, options: FlyCallOptions = {}): Promise<Machine[]> {
    return asCallerSees(this.listLabelled({ key, value }, { rateLimited: 0 }, options.signal));
  }

  private async listLabelled(
    label: CreationLabel,
    rateBudget: { rateLimited: number },
    signal: AbortSignal | undefined,
  ): Promise<Machine[]> {
    const query = `metadata.${encodeURIComponent(label.key)}=${encodeURIComponent(label.value)}`;
    const machines = await this.request(
      "GET",
      `/apps/${encodeURIComponent(this.appName)}/machines?${query}`,
      ListMachinesResponseSchema,
      `(list ${label.key}=${label.value})`,
      "boot-probe",
      null,
      {
        endpoint: "listByLabel",
        coalesce: true,
        appAction: "list",
        rateBudget,
        retryServerFailure: true,
      },
      signal,
    );
    return machines.filter((m) => m.config?.metadata?.[label.key] === label.value);
  }

  /**
   * Single private request method that handles auth, retry on 429, response
   * shape validation via zod, and typed error mapping. Centralises the policy.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    contextName: string,
    failurePhase: "create" | "boot-probe" | "init-rpc",
    body: unknown,
    policy: CallPolicy,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!policy.coalesce) {
      return this.runWithRetry<T>(
        method,
        path,
        schema,
        contextName,
        failurePhase,
        body,
        policy,
        signal,
      );
    }
    // Abandoned before it began: nothing is sent, nor shared.
    if (signal?.aborted) throw new WaitAbandoned(signal.reason);
    const inflightKey = `${method} ${path}`;
    let shared = this.inflight.get(inflightKey);
    if (!shared) {
      // The shared request carries no caller's signal: only its own controller,
      // aborted once no caller waits for it any more.
      const controller = new AbortController();
      const promise = this.runWithRetry<T>(
        method,
        path,
        schema,
        contextName,
        failurePhase,
        body,
        policy,
        controller.signal,
      );
      const entry: SharedCall = { promise, controller, waiting: 0 };
      const forget = () => {
        if (this.inflight.get(inflightKey) === entry) this.inflight.delete(inflightKey);
      };
      // Also what keeps a request every caller abandoned from rejecting unseen.
      promise.then(forget, forget);
      this.inflight.set(inflightKey, entry);
      shared = entry;
    }
    return (await this.awaitShared(shared, inflightKey, signal)) as T;
  }

  /**
   * Wait for a shared request, or for this caller's signal, whichever comes
   * first. A caller who abandons leaves the request to the others; the last one
   * to leave stops it, and takes it out of the map — a later call sends its own.
   */
  private async awaitShared(
    shared: SharedCall,
    inflightKey: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    shared.waiting++;
    // A caller without a signal never leaves before the answer: it keeps the request going.
    if (!signal) return shared.promise;
    let onAbort: (() => void) | undefined;
    const abandoned = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        shared.waiting--;
        if (shared.waiting === 0) {
          if (this.inflight.get(inflightKey) === shared) this.inflight.delete(inflightKey);
          shared.controller.abort(signal.reason);
        }
        reject(new WaitAbandoned(signal.reason));
      };
      // Aborted already — even while the shared request was being sent: the
      // listener would never fire.
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([shared.promise, abandoned]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * A wait of this client, through `sleepImpl`. A wait of 0 ms does not call it.
   * A rejection is the caller abandoning the call: it leaves as a
   * {@link WaitAbandoned}, which every public method unwraps. So does `signal`,
   * when it aborts — before the wait, or during it, whether `sleepImpl` listens
   * or not.
   */
  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new WaitAbandoned(signal.reason);
    if (ms <= 0) return;
    const slept = this.opts.sleepImpl(ms, signal).catch((reason: unknown) => {
      throw new WaitAbandoned(reason);
    });
    if (!signal) {
      await slept;
      return;
    }
    let onAbort: (() => void) | undefined;
    const abandoned = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new WaitAbandoned(signal.reason));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([slept, abandoned]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async runWithRetry<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    contextName: string,
    failurePhase: "create" | "boot-probe" | "init-rpc",
    body: unknown,
    policy: CallPolicy,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const spawnError = (httpStatus: number | null, cause: unknown) =>
      new MachineSpawnError(
        {
          machineName: contextName,
          machineId: failurePhase === "create" ? null : contextName,
          phase: failurePhase,
          httpStatus,
        },
        cause,
      );
    const action = policy.appAction;
    const bucket = action === undefined ? undefined : this.buckets[action];
    // Three budgets, counted apart: `attempt` for the network errors of every call,
    // the 429s of a call on one machine and the 5xx and 408 of a read by label
    // (`retryServerFailure`); `rateLimited` for the 429s of an
    // app-wide action, for the whole operation; `stillActiveWaits` for the one
    // refusal `start()` waits out.
    let attempt = 0;
    const rateLimited = policy.rateBudget ?? { rateLimited: 0 };
    let stillActiveWaits = 0;
    // The last status whose body, read for its meaning, never came — what a
    // call whose retries are spent fails on. An answer read later does not
    // replace it: a call that once had an answer it could not read ends on it.
    let unreadStatus: number | null = null;
    const encoded = body !== null ? JSON.stringify(body) : undefined;
    for (;;) {
      // Every attempt of an app-wide action — the first and each retry — takes a
      // send slot.
      if (bucket) await this.wait(bucket.reserve(), signal);
      if (signal?.aborted) throw new WaitAbandoned(signal.reason);
      // A bound of its own for this attempt, ended before anything waits.
      const bound = new AttemptBound(this.opts.attemptTimeoutsMs[policy.endpoint], signal);
      const sent = await this.send(method, path, encoded, bound, signal, (status) =>
        readsBodyOf(policy, status),
      ).then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error }),
      );
      bound.end();
      // What to wait before the next attempt. Every wait happens outside the try
      // below: a wait that is abandoned ends the call, it is not a network error
      // to retry — nor is a request the signal cut.
      let waitMs: number;
      try {
        if ("error" in sent) throw sent.error;
        const { answer } = sent;

        if (answer.status === 429 && action !== undefined) {
          const rateLimitedWaitMs = this.rateLimitedWait(action, rateLimited, answer.headers);
          if (rateLimitedWaitMs === null) {
            throw spawnError(429, new Error(`Fly.io API ${method} ${path}: 429 ${answer.text}`));
          }
          waitMs = rateLimitedWaitMs;
        } else if (answer.status === 429 && attempt < this.opts.maxRetries) {
          waitMs = this.opts.backoffBaseMs * 2 ** attempt;
          attempt++;
        } else if (policy.absentIsDone === true && answer.status === 404) {
          this.opts.logger.info(
            { event: "machine_already_gone", machine_id: contextName },
            "the machine was already gone; its destruction counts as done",
          );
          return schema.parse({});
        } else if (!answer.ok) {
          const bodyText = answer.text;
          if (policy.refusedInStateIsAnswer === true && isRefusedInState(answer.status, bodyText)) {
            throw new RefusedInState();
          }
          if (
            policy.retryStillActive === true &&
            isStillActiveRefusal(answer.status, bodyText) &&
            stillActiveWaits < this.opts.stillActiveRetries
          ) {
            waitMs = this.opts.stillActiveBackoffBaseMs * 2 ** stillActiveWaits;
            stillActiveWaits++;
          } else if (
            policy.retryServerFailure === true &&
            (answer.status === 408 || answer.status >= 500) &&
            attempt < this.opts.maxRetries
          ) {
            waitMs = this.opts.backoffBaseMs * 2 ** attempt;
            attempt++;
          } else {
            throw spawnError(
              answer.status,
              new Error(`Fly.io API ${method} ${path}: ${answer.status} ${bodyText}`),
            );
          }
        } else {
          // 204 No Content (DELETE) or empty body responses are common — guard
          // before parsing JSON to keep zod from choking on "".
          if (answer.text === "") {
            return schema.parse({});
          }
          const parsed = schema.safeParse(JSON.parse(answer.text));
          if (!parsed.success) {
            throw spawnError(
              answer.status,
              new Error(
                `Fly.io API ${method} ${path} response schema mismatch: ${parsed.error.message}`,
              ),
            );
          }
          return parsed.data;
        }
      } catch (err) {
        // A network error — an attempt its bound cut among them, and one whose
        // body read for its meaning never came — takes the retry path of a call
        // on one machine. MachineSpawnError already wraps and re-throws so we
        // don't need to wrap again here; a refusal in the machine's state is an
        // answer, never sent again.
        if (err instanceof MachineSpawnError || err instanceof RefusedInState) throw err;
        if (signal?.aborted) throw new WaitAbandoned(signal.reason);
        if (err instanceof BodyUnread) unreadStatus = err.status;
        const failure = err instanceof BodyUnread ? err.cause : err;
        if (attempt >= this.opts.maxRetries) {
          // Spent, it fails on the last status whose body was never read, when
          // there was one — even if an answer read later came after it: a call
          // that had an answer it could not read is no call that had none.
          throw unreadStatus === null
            ? spawnError(null, failure)
            : spawnError(
                unreadStatus,
                new Error(`Fly.io API ${method} ${path}: ${unreadStatus}, its body unread`, {
                  cause: failure,
                }),
              );
        }
        waitMs = this.opts.backoffBaseMs * 2 ** attempt;
        attempt++;
      }
      await this.wait(waitMs, signal);
    }
  }

  /**
   * The wait before retrying an app-wide action the platform refused with 429 —
   * as long as it says, within a cap, or a growing backoff — counted on the
   * operation's `budget`; null once its four retries are spent. Logs the refusal
   * either way.
   */
  private rateLimitedWait(
    action: AppAction,
    budget: { rateLimited: number },
    headers: Headers,
  ): number | null {
    const refusal = budget.rateLimited + 1;
    if (budget.rateLimited >= FLY_429_MAX_RETRIES) {
      this.logRateLimited(action, refusal, null);
      return null;
    }
    const waitMs = rateLimitWaitMs(
      headers.get("retry-after"),
      this.opts.nowImpl(),
      FLY_429_BACKOFF_MS[budget.rateLimited],
    );
    this.logRateLimited(action, refusal, waitMs);
    budget.rateLimited++;
    return waitMs;
  }

  /** One line per 429 refusal of an app-wide action; never a word of the platform's answer. */
  private logRateLimited(action: AppAction, attempt: number, waitMs: number | null): void {
    this.opts.logger.warn(
      { event: "fly_api_rate_limited", action, attempt, wait_ms: waitMs },
      waitMs === null
        ? "the machines API refused this request for its rate, and the retries are spent"
        : "the machines API refused this request for its rate; waiting before the retry",
    );
  }
}

/** A timer, cleared — and the wait rejected with its reason — once `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How long to wait after a 429: the platform's `Retry-After` — seconds, or an
 * HTTP date read against the client's clock — capped at
 * {@link FLY_RETRY_AFTER_CAP_MS}; `fallbackMs` when it sends none, or one that
 * cannot be read. A date already past means now.
 */
function rateLimitWaitMs(header: string | null, now: number, fallbackMs: number): number {
  const value = header?.trim();
  if (!value) return fallbackMs;
  let waitMs: number;
  if (/^\d+$/.test(value)) {
    waitMs = Number(value) * 1000;
  } else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return fallbackMs;
    waitMs = Math.max(0, at - now);
  }
  return Math.min(waitMs, FLY_RETRY_AFTER_CAP_MS);
}

/**
 * Whether a call under `policy` reads the meaning of `status` in its body: a
 * 412, whose body says which refusal it is, for a destruction without force
 * ({@link isRefusedInState}) and for a start ({@link isStillActiveRefusal}).
 * Any other status a call meets means the same whatever its body. A status read
 * so, its body cut — by the attempt's bound or by the network —, has not been
 * read: the attempt has failed, as on the network, and is sent again.
 */
function readsBodyOf(policy: CallPolicy, status: number): boolean {
  return (
    status === 412 && (policy.refusedInStateIsAnswer === true || policy.retryStillActive === true)
  );
}

/**
 * Fly's refusal to start a machine that is still being suspended. Read on two
 * markers of the body — the status name and the reason — rather than on the
 * whole sentence, which the platform may reword.
 */
function isStillActiveRefusal(status: number, bodyText: string): boolean {
  return status === 412 && /failed_precondition/i.test(bodyText) && /still active/i.test(bodyText);
}

/**
 * Fly's refusal to destroy, without force, a machine in its current state —
 * measured against the platform on 2026-10-23: `412`, `failed_precondition:
 * unable to destroy machine, not currently stopped, suspended, failed, pending,
 * or archived`. Read on the status name rather than the sentence, which the
 * platform may reword; a 412 that does not carry it stays a failure.
 */
function isRefusedInState(status: number, bodyText: string): boolean {
  return status === 412 && /failed_precondition/i.test(bodyText);
}
