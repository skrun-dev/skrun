import { createHash, timingSafeEqual } from "node:crypto";
import { createLogger, parseTimeout } from "@skrun-dev/runtime";
import {
  AGENT_YAML_MAX_BYTES,
  type AgentConfig,
  type AgentYamlWarnings,
  BundleDecompressedTooLargeError,
  BundleEntryError,
  decompressedCapText,
  findRefusedSettings,
  ValidationError,
} from "@skrun-dev/schema";
import type { BundleConfigRead } from "../cache/bundle-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import type { Agent } from "../db/schema.js";
import { timeoutAboveLimit } from "../quotas/admission.js";
import type { AgentMetadata, AgentVersionInfo } from "../types.js";
import { extractFileBytes } from "../utils/bundle.js";
import { errorFields } from "../utils/error-fields.js";
import { SEMVER_STRICT } from "../utils/semver.js";
import { type UnstorableForm, unstorableForm } from "../utils/unstorable-text.js";
import {
  AGENT_YAML_BUSY_RETRY_AFTER_S,
  type AgentYamlRead,
  AgentYamlReadAbandonedError,
  type AgentYamlReader,
  AgentYamlReaderBusyError,
  AgentYamlReaderError,
  AgentYamlTooComplexError,
  sharedAgentYamlReader,
} from "./agent-yaml-reader.js";

const logger = createLogger("registry-service");

/**
 * Status is encoded as the typed union of HTTP codes the service emits.
 * Callers can return `c.json(..., err.status)` without an `as` cast —
 * Hono's StatusCode parameter accepts this union directly.
 */
export type RegistryErrorStatus = 400 | 403 | 404 | 409 | 413 | 500 | 503;

/**
 * What bounds one push, read for the caller's account when the push arrives:
 * the server's longest timeout and the bundle storage of the account's plan,
 * each `null` when nothing sets it — and who asks, which decides what a
 * refusal tells.
 */
export interface PushLimits {
  /** The plan whose thresholds apply, as a refusal's line names it. */
  plan: string;
  /** The longest timeout an agent may declare, in seconds: the server's, for every plan. */
  maxTimeoutS: number | null;
  /** The bundle bytes the account may hold, this push's included. */
  storageBytes: number | null;
  /**
   * The caller holds a master credential: a storage refusal tells it the
   * account's numbers. Any other key is told the bound only — the numbers
   * are the account's, not the key's.
   */
  master: boolean;
}

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * A size rounded to a tenth of its unit — B, KB, MB, multiples of 1024 as the
 * storage setting counts them — and the bytes that rounding reads as. A size
 * that rounds to 1024 KB is told in MB.
 */
function roundedSize(bytes: number): { text: string; reads: number } {
  if (bytes < KIB) return { text: `${bytes} B`, reads: bytes };
  const kb = Number((bytes / KIB).toFixed(1));
  if (kb < 1024) return { text: `${kb} KB`, reads: kb * KIB };
  const mb = Number((bytes / MIB).toFixed(1));
  return { text: `${mb} MB`, reads: mb * MIB };
}

/** A size to the byte, its thousands grouped: `1,048,576 B`. */
function exactSize(bytes: number): string {
  return `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} B`;
}

/**
 * The three sizes a storage refusal tells — what the account holds, its cap,
 * the bundle refused — rounded while rounding keeps them true: the account
 * below, at or over its cap as it is, and the bundle not fitting. Otherwise
 * to the byte, all three.
 */
function storageSizes(held: number, cap: number, bundle: number) {
  const rounded = { held: roundedSize(held), cap: roundedSize(cap), bundle: roundedSize(bundle) };
  const keepsStanding = Math.sign(rounded.held.reads - rounded.cap.reads) === Math.sign(held - cap);
  const keepsNotFitting = rounded.held.reads + rounded.bundle.reads > rounded.cap.reads;
  if (keepsStanding && keepsNotFitting) {
    return { held: rounded.held.text, cap: rounded.cap.text, bundle: rounded.bundle.text };
  }
  return { held: exactSize(held), cap: exactSize(cap), bundle: exactSize(bundle) };
}

/** What deleting an agent takes with it, as a storage refusal tells it. */
const AGENT_DELETION =
  "which deletes its state and its model keys too, and removes it from the keys restricted to it";

/**
 * The refusal of a bundle that decompresses past the server's cap. The decoder
 * stops at the cap, so the bundle's own size is never known: it is told as
 * more than the cap, the cap rounded down — what is said stays true.
 */
function decompressedTooLarge(maxBytes: number): string {
  return `This bundle decompresses to more than ${decompressedCapText(maxBytes)}, the most this server unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Make the agent smaller — leave out the files it does not need when it runs — and push it again; the server's operator can raise BUNDLE_MAX_DECOMPRESSED_MB.`;
}

/**
 * The refusal of an `agent.yaml` past its fixed limit: its size and the limit,
 * each to the byte, and where long content belongs.
 */
function configTooLarge(bytes: number): string {
  return `This bundle's agent.yaml is ${exactSize(bytes)}, more than the ${AGENT_YAML_MAX_BYTES / KIB} KB (${exactSize(AGENT_YAML_MAX_BYTES)}) an agent.yaml may weigh. agent.yaml holds the agent's configuration: put long content — instructions, context, data — in SKILL.md, AGENTS.md or other files of the bundle, and push it again.`;
}

/**
 * The words of a push refused for the reads waiting: nothing of how the server
 * reads, what it holds or anyone else's push — that it is busy, that nothing
 * was stored, and when to send again (`Retry-After`, beside it).
 */
const PUSH_BUSY_MESSAGE =
  "The server is busy with other pushes right now, and stored nothing of this one. Push it again in a few seconds.";

/**
 * The refusal of a push whose `version` is not strict semver: what a version
 * is, never the value given — it can be of any length, and hold what a
 * response or a log should not carry.
 */
const INVALID_PUSH_VERSION =
  'version must be strict semver (e.g. "1.0.0"): three whole numbers separated by dots. Nothing was stored.';

/** The words of a refused `agent.yaml`: each issue validation found, in order. */
function invalidConfig(err: unknown): string {
  const issues =
    err instanceof ValidationError && err.issues.length > 0
      ? err.issues.map((issue) => issue.message)
      : [err instanceof Error ? err.message : String(err)];
  return `agent.yaml is not valid: ${issues.join("; ")}`;
}

/** Where a configuration holds a text it cannot be stored with, and which form. */
interface UnstorableField {
  /** The field's path — `inputs[0].description` —, or the mapping's when the text is one of its keys; `""` is the top level. */
  path: string;
  /** The text is a key of the mapping at `path`, not the value there. */
  inKey: boolean;
  form: UnstorableForm;
}

/** The characters of a key a refusal's path quotes; past them, the key is cut and ends with `…`. */
const PATH_KEY_MAX_CHARS = 64;

/** `key` as a path quotes it: whole up to `PATH_KEY_MAX_CHARS` characters, cut past them, never inside a surrogate pair. */
function pathKey(key: string): string {
  if (key.length <= PATH_KEY_MAX_CHARS) return key;
  const chars = Array.from(key);
  return chars.length <= PATH_KEY_MAX_CHARS
    ? key
    : `${chars.slice(0, PATH_KEY_MAX_CHARS).join("")}…`;
}

/**
 * The first text of `config` that holds U+0000 or a lone surrogate
 * (`unstorableForm`), at any depth, or `null` when none does. "First" in the
 * order of the configuration as read, not of the file: its fields in the
 * schema's order, defaults included, and a free-form mapping's keys in
 * JavaScript's order — integer-like keys first —; a mapping's key before its
 * value. Each key in the path is cut to `PATH_KEY_MAX_CHARS` characters
 * (`pathKey`): a key is the author's, of any length. Walked without
 * recursion: the depth of a test's `input` is the author's.
 */
function findUnstorableField(config: unknown): UnstorableField | null {
  type Step = { value: unknown; path: string } | { key: string; path: string };
  const steps: Step[] = [{ value: config, path: "" }];
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if ("key" in step) {
      const form = unstorableForm(step.key);
      if (form) return { path: step.path, inKey: true, form };
      continue;
    }
    const { value, path } = step;
    if (typeof value === "string") {
      const form = unstorableForm(value);
      if (form) return { path, inKey: false, form };
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const next: Step[] = [];
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        next.push({ value: item, path: `${path}[${i}]` });
      });
    } else {
      for (const [key, item] of Object.entries(value)) {
        next.push({ key, path });
        next.push({ value: item, path: path === "" ? pathKey(key) : `${path}.${pathKey(key)}` });
      }
    }
    // The last pushed is taken first: pushed in reverse, they are taken in order.
    for (let i = next.length - 1; i >= 0; i -= 1) steps.push(next[i] as Step);
  }
  return null;
}

/**
 * The refusal of a configuration that holds U+0000 or a lone surrogate: the
 * field — or the mapping whose key holds it — and what to write instead. The
 * text itself is never quoted.
 */
function unstorableConfig({ path, inKey, form }: UnstorableField): string {
  const where = !inKey ? path : path === "" ? "a top-level key" : `a key of ${path}`;
  const what =
    form === "nul"
      ? "U+0000, the NUL character (an escape such as \\0 or \\u0000 in a double-quoted string, or the character itself)"
      : "a lone surrogate, half of a UTF-16 pair without its other half (an escape such as \\uD800 in a double-quoted string, written without its other half)";
  const fix = form === "nul" ? "Remove it" : "Write the whole character, or remove it";
  return `agent.yaml is not valid: ${where} holds ${what}, which an agent's configuration cannot be stored with. ${fix}, and push it again.`;
}

/**
 * The configuration a bundle's `agent.yaml` declares — or the push's refusal,
 * judged on the bundle alone, in this order: an archive that decompresses past
 * the server's cap (`413 BUNDLE_DECOMPRESSED_TOO_LARGE`); one that is not a
 * readable gzip-compressed tar, or one an entry of which cannot be written out
 * where an agent runs — `BundleEntryError` says which and why, two entries
 * that contradict each other, a name too long — (`400 BUNDLE_CORRUPT`); no
 * `agent.yaml` at its root, or an empty one (`400 MISSING_CONFIG`); an
 * `agent.yaml` past `AGENT_YAML_MAX_BYTES` (`413 CONFIG_TOO_LARGE`), judged on
 * its bytes, never parsed nor read as text; an `agent.yaml` that is not YAML,
 * or not valid for the schema — an alias included — (`400 INVALID_CONFIG`,
 * each issue in the message), or whose read outlasts its budget (`400
 * INVALID_CONFIG`, too complex to read): `AgentYamlReader` reads it, in a
 * thread of its own. A read that finds as many reads waiting as may wait is
 * refused at once (`503 PUSH_BUSY`, with its `Retry-After`) — the server's
 * state, not the bundle's. A reader that fails is no refusal: its
 * `AgentYamlReaderError` is thrown as it is; so is the
 * `AgentYamlReadAbandonedError` of a read dropped before it started, `signal`
 * — the push's request — aborted. A run answers a stored bundle with the same
 * codes, `CONFIG_TOO_LARGE` aside — the first as a `422`, past the cap the
 * server has when it runs, the three others as a `500`. A run never judges the
 * size of `agent.yaml`: a version stored before its limit runs as it did. Only
 * `agent.yaml` is read out of the archive — the cap, and the rule of its
 * entries, judge all of it.
 */
async function readAgentConfig(
  bundle: Buffer,
  reader: AgentYamlReader,
  signal?: AbortSignal,
): Promise<AgentYamlRead> {
  let files: Record<string, Buffer>;
  try {
    files = await extractFileBytes(bundle, ["agent.yaml"]);
  } catch (err) {
    if (err instanceof BundleDecompressedTooLargeError) {
      throw new RegistryError(
        "BUNDLE_DECOMPRESSED_TOO_LARGE",
        decompressedTooLarge(err.maxBytes),
        413,
      );
    }
    if (err instanceof BundleEntryError) {
      throw new RegistryError(
        "BUNDLE_CORRUPT",
        `This bundle cannot be written out where an agent runs: ${err.message}`,
        400,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new RegistryError(
      "BUNDLE_CORRUPT",
      `This bundle is not a readable .agent archive — a gzip-compressed tar, as skrun build makes (${reason}).`,
      400,
    );
  }
  // Empty is missing, as the run reads it.
  const agentYaml = files["agent.yaml"];
  if (!agentYaml || agentYaml.length === 0) {
    throw new RegistryError(
      "MISSING_CONFIG",
      "This bundle has no agent.yaml at its root, or an empty one: an agent's bundle carries its configuration there, as skrun build makes it.",
      400,
    );
  }
  // Judged on its bytes, before it is read as text: a file past the limit is
  // never parsed.
  if (agentYaml.length > AGENT_YAML_MAX_BYTES) {
    throw new RegistryError("CONFIG_TOO_LARGE", configTooLarge(agentYaml.length), 413);
  }
  try {
    return await reader.read(agentYaml.toString("utf-8"), signal);
  } catch (err) {
    if (err instanceof AgentYamlReaderError || err instanceof AgentYamlReadAbandonedError) {
      throw err;
    }
    if (err instanceof AgentYamlReaderBusyError) {
      throw new RegistryError("PUSH_BUSY", PUSH_BUSY_MESSAGE, 503, {
        cause: err,
        retryAfterS: AGENT_YAML_BUSY_RETRY_AFTER_S,
      });
    }
    if (err instanceof AgentYamlTooComplexError) {
      throw new RegistryError("INVALID_CONFIG", err.issues[0]?.message ?? err.message, 400, {
        cause: err,
      });
    }
    throw new RegistryError("INVALID_CONFIG", invalidConfig(err), 400);
  }
}

/**
 * One turn at a time per key, in this process: `run(key, step)` starts `step`
 * once every earlier step of the same key has settled — stored, refused or
 * failed — and the steps of two keys never wait for each other. A key's entry
 * lives while a step of it runs or waits, and leaves with the last one.
 */
export class AccountTurns {
  private readonly queues = new Map<string, { tail: Promise<void>; holders: number }>();

  /** How many keys have a step running or waiting. */
  get size(): number {
    return this.queues.size;
  }

  async run<T>(key: string, step: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { tail: Promise.resolve(), holders: 0 };
      this.queues.set(key, queue);
    }
    queue.holders += 1;
    const previous = queue.tail;
    let release: () => void = () => {};
    queue.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await step();
    } finally {
      release();
      queue.holders -= 1;
      if (queue.holders === 0) this.queues.delete(key);
    }
  }
}

export class RegistryError extends Error {
  /**
   * The seconds the refusal asks the client to wait before sending again — its
   * `Retry-After` header; none when waiting changes nothing.
   */
  readonly retryAfterS?: number;

  constructor(
    public code: string,
    message: string,
    public status: RegistryErrorStatus,
    options?: ErrorOptions & { retryAfterS?: number },
  ) {
    super(message, options);
    this.name = "RegistryError";
    this.retryAfterS = options?.retryAfterS;
  }
}

export class RegistryService {
  /**
   * The turns of each namespace's pushes — each account's —, whatever bounds
   * them: one service per app, so both push entrypoints share them.
   */
  private readonly pushTurns = new AccountTurns();

  /**
   * `agentYamlReader` reads each pushed `agent.yaml`: the process's own by
   * default, whose threads both push entrypoints — and every service of the
   * process — share.
   */
  constructor(
    private storage: import("../storage/adapter.js").StorageAdapter,
    private db: DbAdapter,
    private readonly agentYamlReader: AgentYamlReader = sharedAgentYamlReader,
  ) {}

  /**
   * Store a new version of `namespace/name` for the account `userId`. A
   * `version` that is not strict semver (`SEMVER_STRICT`, the expression a run
   * names a version with) is refused first, nothing written (`400
   * INVALID_VERSION_FORMAT`, the value never quoted): it names the object's
   * key and the version's row. A bundle
   * that does not load is refused before anything is written, whatever bounds
   * the push: one past the server's decompression cap (`413
   * BUNDLE_DECOMPRESSED_TOO_LARGE`), one that is not a readable archive, has
   * no `agent.yaml` or an invalid one (`400`), or an `agent.yaml` past its
   * fixed limit (`413 CONFIG_TOO_LARGE`) — see `readAgentConfig`. So is an
   * `agent.yaml` whose configuration holds U+0000 or a lone surrogate, which
   * its version's row could not record on every backend (`400
   * INVALID_CONFIG`, `refuseUnstorableConfig`), and then one that declares a
   * setting no code honours — what validation refuses by name (`400`, the
   * code of the first such setting). A version whose row is not written
   * leaves no object behind (`removeUnrecordedBundle`). With
   * `limits`, a push over one is refused likewise — no agent created for it,
   * no object stored: an agent that declares more than the server's longest
   * timeout (`400 TIMEOUT_ABOVE_LIMIT`), and a bundle the account's storage
   * has no room for (`413 STORAGE_QUOTA_EXCEEDED`). Without them, nothing
   * else bounds the push — but the process's reads: a push that finds as many
   * `agent.yaml` reads waiting as may wait is refused `503 PUSH_BUSY`, nothing
   * written, with its line.
   *
   * `signal` is the push's request's: aborted while its `agent.yaml` waits to
   * be read — or before —, the read is dropped, and the push ends there with
   * `AgentYamlReadAbandonedError`, nothing written. Once the read has started,
   * the push goes on as if it had not aborted.
   *
   * The account's pushes take turns in this process, bounded or not, from
   * the duplicate check to the version's row — the turn of the namespace
   * pushed into, the account's own. Two pushes of one version
   * write one object: side by side, the last one's bytes would sit under the
   * first one's checksum, the version refused at every pull; in turn, the
   * second reads the first one's version and is answered
   * `409 VERSION_EXISTS`. And what one reads the account holds is never
   * short of a bundle another is storing. Another instance takes its own
   * turns.
   */
  async push(
    namespace: string,
    name: string,
    version: string,
    bundle: Buffer,
    userId: string,
    notes?: string | null,
    limits?: PushLimits,
    signal?: AbortSignal,
  ): Promise<AgentMetadata> {
    // The version names the object's key and the version's row: anything but
    // strict semver is refused first, before the bundle is read — a `..` would
    // move the key out of the namespace, a NUL would fail the row.
    if (!SEMVER_STRICT.test(version)) {
      throw new RegistryError("INVALID_VERSION_FORMAT", INVALID_PUSH_VERSION, 400);
    }
    // agent.yaml is read next: a bundle that does not load is refused, what
    // it declares can refuse the push, and a refused push leaves nothing
    // behind. Each refusal is judged on the bundle alone, before the turn —
    // it waits for no push of the account; its agent.yaml's read may wait for
    // a reading thread of the process (`AgentYamlReader`) — and before the
    // duplicate check: the bundle
    // that does not load, whatever bounds the push; then a text the version's
    // row could not record, whatever bounds the push; then a setting that no
    // code honours, whatever bounds the push, a timeout outside the range a
    // run can hold included; then, when the server sets one, a timeout above
    // its longest.
    let read: AgentYamlRead;
    try {
      read = await readAgentConfig(bundle, this.agentYamlReader, signal);
    } catch (err) {
      if (err instanceof RegistryError && err.cause instanceof AgentYamlTooComplexError) {
        this.logReadStopped(namespace, name, version, err.cause.budgetMs);
      }
      if (err instanceof RegistryError && err.cause instanceof AgentYamlReaderBusyError) {
        this.logPushBusy(namespace, name, version, err.cause.waitingAtMost);
      }
      throw err;
    }
    const { config, warnings } = read;
    if (warnings.count > 0) this.logYamlWarnings(namespace, name, version, warnings);
    this.refuseUnstorableConfig(config);
    this.refuseUnhonouredSettings(config);
    if (limits) this.refuseOverTimeout(limits, config, userId);

    const store = async (): Promise<void> => {
      // A version already pushed is refused before the storage is read: it
      // would add no byte, and making room would change nothing. The agent and
      // its version are only read here, nothing created.
      const existingAgent = await this.db.getAgent(namespace, name);
      if (existingAgent && (await this.db.getVersionByNumber(existingAgent.id, version))) {
        throw new RegistryError(
          "VERSION_EXISTS",
          `Version ${version} already exists for ${namespace}/${name}. Bump version in agent.yaml.`,
          409,
        );
      }

      if (limits) await this.refuseOverStorage(limits, bundle.length, userId);

      // Get or create agent
      const agent =
        existingAgent ??
        (await this.db.createAgent({
          name,
          namespace,
          description: "",
          owner_id: userId,
        }));

      // Store bundle
      const bundleKey = `${namespace}/${name}/${version}.agent`;
      await this.storage.put(bundleKey, bundle);

      // Checksum the bundle at push so pull() can verify integrity.
      // Always set for new pushes (the nullable column is only a backfill valve
      // for legacy rows).
      const bundleSha256 = createHash("sha256").update(bundle).digest("hex");

      // Create version record; the configuration read above is its snapshot.
      // An object no version row names is counted by no storage quota (it sums
      // the rows) and found by no deletion of a version or an agent — only an
      // account's deletion sweeps its namespace's folder: a failed write takes
      // it back.
      try {
        await this.db.createVersion(agent.id, {
          version,
          size: bundle.length,
          bundle_key: bundleKey,
          bundle_sha256: bundleSha256,
          config_snapshot: config as unknown as Record<string, unknown>,
          notes: notes ?? null,
        });
      } catch (err) {
        await this.removeUnrecordedBundle(agent.id, version, bundleKey, err);
        throw err;
      }
    };

    // The turn is the namespace's: the routes take a push into the pusher's own
    // namespace only, and an account has one, so every push of an account
    // takes it, and the holdings it reads are the pusher's. Two accounts given
    // one namespace — a development token's can be — take it in turn too:
    // keyed on the account, their pushes of one version would meet.
    await this.pushTurns.run(namespace, store);

    return this.buildMetadata(namespace, name);
  }

  /**
   * A run's read of its bundle's `agent.yaml` — once per bundle, for the run
   * cache's entry (`routes/run.ts`): through the reader the push reads with,
   * in the same threads and with the same budget, waiting its turn however
   * many reads wait (`readInTurn`) — a run never gets a push's `503
   * PUSH_BUSY`. Its size is not judged: a version stored before the push
   * held it runs as it did.
   *
   * Resolves to what the entry keeps: the configuration as the thread sent it,
   * or the refusal's message — every way the file is refused, a read stopped at
   * its budget included (its `agent_yaml_read_stopped` line written) —, which
   * the run answers `500 INVALID_CONFIG` with, as it answered a file its parse
   * refused. Rejects only when the file was never judged: the reader's
   * failure (`AgentYamlReaderError`), a fault of the server.
   */
  async readRunConfig(
    namespace: string,
    name: string,
    version: string,
    agentYaml: string,
  ): Promise<BundleConfigRead> {
    try {
      return { json: (await this.agentYamlReader.readInTurn(agentYaml)).configJson };
    } catch (err) {
      if (
        err instanceof AgentYamlReaderError ||
        err instanceof AgentYamlReaderBusyError ||
        err instanceof AgentYamlReadAbandonedError
      ) {
        throw err;
      }
      if (err instanceof AgentYamlTooComplexError) {
        this.logReadStopped(namespace, name, version, err.budgetMs, "run");
      }
      return { refused: err instanceof Error ? err.message : "Invalid agent.yaml" };
    }
  }

  /**
   * Throw the refusal of a configuration that holds U+0000 or a lone
   * surrogate, in a value or a key, at any depth (`400 INVALID_CONFIG`, the
   * first one's path in the message); return when it holds neither. The
   * version's row records the configuration in a `jsonb` column, which Postgres
   * refuses with either — SQLite and the memory store accept them: judged here,
   * the push is refused alike on every backend, before anything is written.
   * Only the push judges it: a run reads its stored configuration as it did.
   */
  private refuseUnstorableConfig(config: AgentConfig): void {
    const field = findUnstorableField(config);
    if (field) throw new RegistryError("INVALID_CONFIG", unstorableConfig(field), 400);
  }

  /**
   * Throw the refusal of a configuration that declares a setting no code
   * honours — the settings validation refuses by name, read by the same
   * function: one `400`, of the first one's code, its message every one of
   * theirs, in order, joined by a space. Return when it declares none. The CLI
   * validates before it pushes; the SDK and a plain request do not, so the
   * push judges it all the same.
   */
  private refuseUnhonouredSettings(config: AgentConfig): void {
    const refused = findRefusedSettings(config);
    const [first] = refused;
    if (!first) return;
    throw new RegistryError(first.code, refused.map((issue) => issue.message).join(" "), 400);
  }

  /**
   * After a push's version write failed with `writeError`: delete the object
   * it stored under `bundleKey`, once the store refused the write for certain
   * and the version's row is read absent. Every way of not knowing keeps the
   * object — an orphan costs storage, a version whose object is gone fails
   * every pull and run —, with a `bundle_kept_unverified` line naming its key,
   * the only way to find it then:
   * - a write whose outcome is unknown (`DbAdapter.writeOutcomeUnknown`: on
   *   Postgres, anything but a refusal the server answered that rolls the
   *   statement back — a connection lost, a server shut down, a statement
   *   stopped, a pooler's error for a session lost behind it, an error with no
   *   SQLSTATE) may have been committed — or commit later, after a reset while
   *   it waited —: the row is not even read;
   * - a row that cannot be read.
   * A row found — the write committed before it threw, or another instance
   * wrote this version's row under the same key — keeps the object, silently.
   * A failed delete is a line too. Never throws: the push's own error is what
   * its caller gets.
   *
   * One window stays open between two instances, which take their turns
   * apart: both push the same version, one's write is refused for another
   * reason than the other's row, and it reads the row absent before the
   * other's commits — it then deletes the object that row will name.
   */
  private async removeUnrecordedBundle(
    agentId: string,
    version: string,
    bundleKey: string,
    writeError: unknown,
  ): Promise<void> {
    if (this.db.writeOutcomeUnknown(writeError)) {
      logger.warn(
        {
          event: "bundle_kept_unverified",
          bundle_key: bundleKey,
          cause: "write_outcome_unknown",
          ...errorFields(writeError),
        },
        "A push's version write failed and may have been committed all the same: its bundle is kept, and may be orphaned",
      );
      return;
    }
    let recorded: boolean;
    try {
      recorded = (await this.db.getVersionByNumber(agentId, version)) !== null;
    } catch (err) {
      logger.warn(
        {
          event: "bundle_kept_unverified",
          bundle_key: bundleKey,
          cause: "row_unreadable",
          ...errorFields(err),
        },
        "A push's version write failed and whether its row exists could not be read: its bundle is kept, and may be orphaned",
      );
      return;
    }
    if (recorded) return;
    await this.storage.delete(bundleKey).catch((err) =>
      logger.warn(
        {
          event: "bundle_delete_failed",
          bundle_key: bundleKey,
          ...errorFields(err),
        },
        "Best-effort bundle delete failed after a push's version write failed — orphaned blob may remain",
      ),
    );
  }

  /**
   * The one line of a pushed agent.yaml the `yaml` library gave warnings —
   * whatever becomes of the push —: how many, and the first one's code, line
   * and column (`AgentYamlWarnings.firstAt`) — never its message, which can
   * quote the file.
   */
  private logYamlWarnings(
    namespace: string,
    name: string,
    version: string,
    warnings: AgentYamlWarnings,
  ): void {
    logger.warn(
      {
        event: "agent_yaml_warnings",
        agent: `${namespace}/${name}`,
        agent_version: version,
        count: warnings.count,
        first_code: warnings.firstAt?.code,
        first_line: warnings.firstAt?.line,
        first_column: warnings.firstAt?.column,
      },
      "A pushed agent.yaml reads with YAML warnings",
    );
  }

  /**
   * The one line of a push — or of a run's read — refused because the read of
   * its agent.yaml outlasted its budget: the agent, its version and the
   * budget — nothing of the file. The message says which.
   */
  private logReadStopped(
    namespace: string,
    name: string,
    version: string,
    budgetMs: number,
    reader: "push" | "run" = "push",
  ): void {
    logger.warn(
      {
        event: "agent_yaml_read_stopped",
        agent: `${namespace}/${name}`,
        agent_version: version,
        budget_ms: budgetMs,
      },
      reader === "push"
        ? "A pushed agent.yaml took longer to read than its budget: the read was stopped, the push refused"
        : "A run's agent.yaml took longer to read than its budget: the read was stopped, the runs of its bundle refused while the run cache keeps it",
    );
  }

  /**
   * The one line of a push refused `503 PUSH_BUSY`: the agent, its version and
   * how many reads may wait — all of them waiting —, nothing of the file nor of
   * the pushes ahead of it.
   */
  private logPushBusy(
    namespace: string,
    name: string,
    version: string,
    waitingAtMost: number,
  ): void {
    logger.warn(
      {
        event: "push_busy",
        agent: `${namespace}/${name}`,
        agent_version: version,
        waiting_at_most: waitingAtMost,
      },
      "A push was refused 503: as many agent.yaml reads were waiting as may wait",
    );
  }

  /** The `quota_refused` line of a push refused for `bound`. */
  private logRefusal(userId: string, limits: PushLimits, bound: "max_timeout" | "storage"): void {
    logger.info(
      { event: "quota_refused", user_id: userId, bound, plan: limits.plan },
      "A push was refused: its account or the server reached a limit",
    );
  }

  /**
   * Throw the refusal of an agent that declares more than the server's
   * longest timeout, its line written; return when it does not, or when
   * nothing sets that bound. Reads nothing: the bundle's configuration only.
   */
  private refuseOverTimeout(limits: PushLimits, config: AgentConfig, userId: string): void {
    // The timeout the run would run under: what agent.yaml declares, the
    // schema's default when it declares none.
    if (limits.maxTimeoutS === null) return;
    const declaredS = parseTimeout(config.environment.timeout) / 1000;
    if (declaredS <= limits.maxTimeoutS) return;
    this.logRefusal(userId, limits, "max_timeout");
    const refusal = timeoutAboveLimit({ declaredS, maxS: limits.maxTimeoutS, overridden: false });
    throw new RegistryError(refusal.code, refusal.message, 400);
  }

  /**
   * Throw the refusal of a bundle the account's storage has no room for, its
   * line written; return when it fits. Reads the account's bundles only when
   * its storage is bounded — under the account's turn (`push`), so no other
   * push of it is between this read and its version's row.
   */
  private async refuseOverStorage(
    limits: PushLimits,
    bundleBytes: number,
    userId: string,
  ): Promise<void> {
    if (limits.storageBytes === null) return;
    const heldBytes = await this.db.sumBundleBytesByOwner(userId);
    if (heldBytes + bundleBytes <= limits.storageBytes) return;
    this.logRefusal(userId, limits, "storage");
    const sizes = storageSizes(heldBytes, limits.storageBytes, bundleBytes);
    throw new RegistryError(
      "STORAGE_QUOTA_EXCEEDED",
      limits.master
        ? `This account's agents hold ${sizes.held} of the ${sizes.cap} of bundle storage its plan allows; this bundle (${sizes.bundle}) does not fit. Delete a version no longer needed (DELETE /api/agents/:namespace/:name/versions/:version) to make room — or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name), ${AGENT_DELETION}.`
        : `This push would take this account past the bundle storage its plan allows; a version deleted from the account makes room — or, for an agent's last version, the agent, ${AGENT_DELETION}.`,
      413,
    );
  }

  async pull(
    namespace: string,
    name: string,
    version?: string,
    opts?: { preloadedAgent?: Agent },
  ): Promise<{ buffer: Buffer; version: string; verified: boolean; sha256: string | null }> {
    // Route layer (its multi-tenant ownership gate) may pass `preloadedAgent` to skip
    // the redundant `db.getAgent` call after it has already done one for
    // the ownership check. Keeps `service.pull` testable in isolation while
    // letting the route layer enforce ownership BEFORE any storage fetch
    // (constant-time semantics — genuine-404 and ownership-404 share the
    // same code path on the route side).
    const agent = opts?.preloadedAgent ?? (await this.db.getAgent(namespace, name));
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    let resolvedVersion: string;
    let resolvedVerified: boolean;
    // Keep the resolved version's checksum for the integrity check
    // below (the row objects would otherwise be discarded here).
    let resolvedSha256: string | null;
    if (version) {
      const v = await this.db.getVersionByNumber(agent.id, version);
      if (!v) {
        throw new RegistryError(
          "VERSION_NOT_FOUND",
          `Version ${version} not found for ${namespace}/${name}`,
          404,
        );
      }
      resolvedVersion = v.version;
      resolvedVerified = v.verified;
      resolvedSha256 = v.bundle_sha256;
    } else {
      const latest = await this.db.getLatestVersion(agent.id);
      if (!latest) {
        throw new RegistryError("NO_VERSIONS", `No versions found for ${namespace}/${name}`, 404);
      }
      resolvedVersion = latest.version;
      resolvedVerified = latest.verified;
      resolvedSha256 = latest.bundle_sha256;
    }

    const bundleKey = `${namespace}/${name}/${resolvedVersion}.agent`;
    const buffer = await this.storage.get(bundleKey);
    if (!buffer) {
      throw new RegistryError("BUNDLE_NOT_FOUND", "Bundle file not found in storage", 500);
    }

    // Verify bundle integrity when a checksum is on record. This runs
    // on EVERY pull() call site — run execution AND the GET /pull download — so
    // a tampered storage object can never be served (universal verification).
    // A null checksum = a legacy bundle predating hashing (the boot backfill
    // populates these); log + serve rather than 500 a legitimate bundle.
    // timingSafeEqual is only reached with two equal-length buffers.
    if (resolvedSha256 != null) {
      const actualBuf = createHash("sha256").update(buffer).digest();
      const expectedBuf = Buffer.from(resolvedSha256, "hex");
      if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
        logger.error(
          {
            event: "bundle_integrity_failed",
            agent: `${namespace}/${name}`,
            version: resolvedVersion,
          },
          "Bundle integrity check failed — refusing to serve a tampered bundle",
        );
        throw new RegistryError(
          "BUNDLE_INTEGRITY_FAILED",
          `Bundle integrity check failed for ${namespace}/${name}@${resolvedVersion}`,
          500,
        );
      }
    } else {
      logger.warn(
        {
          event: "bundle_integrity_unknown",
          agent: `${namespace}/${name}`,
          version: resolvedVersion,
        },
        "Bundle has no stored checksum (legacy) — served unverified",
      );
    }

    // The checksum leaves with the bytes. It is the very value compared just
    // above, and a caller that hands the bundle to a sandbox needs it: the
    // sandbox fetches the object again for itself, so the check above covers
    // this process's copy and no other. `null` means nothing is on record for
    // this version (a legacy bundle) — the caller keeps serving it, as the
    // warning branch above already says.
    return { buffer, version: resolvedVersion, verified: resolvedVerified, sha256: resolvedSha256 };
  }

  async list(
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ agents: AgentMetadata[]; total: number }> {
    // `userId` is provided by the route layer when the caller is a
    // non-admin OAuth/API-key user (narrows results to own agents); it's
    // left undefined for admin callers (or dev-token mode → admin auto-
    // grant) so they see all agents instance-wide.
    const result = await this.db.listAgents({ page, limit, userId });
    const agents: AgentMetadata[] = [];
    for (const a of result.agents) {
      const versions = await this.db.getVersions(a.id);
      const latest = await this.db.getLatestVersion(a.id);
      agents.push({
        name: a.name,
        namespace: a.namespace,
        description: a.description,
        visibility: a.visibility,
        latest_version_verified: latest?.verified ?? false,
        latest_version: latest?.version ?? "",
        versions: versions.map((v) => v.version),
        created_at: a.created_at,
        updated_at: a.updated_at,
        run_count: a.run_count,
        token_count: a.token_count,
      });
    }
    return { agents, total: result.total };
  }

  async getMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    return this.buildMetadata(namespace, name);
  }

  async getVersions(namespace: string, name: string): Promise<AgentVersionInfo[]> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = await this.db.getVersions(agent.id);
    return versions.map((v) => ({
      version: v.version,
      size: v.size,
      pushed_at: v.pushed_at,
      config_snapshot: v.config_snapshot,
      notes: v.notes,
      verified: v.verified,
    }));
  }

  async deleteAgent(namespace: string, name: string): Promise<void> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    // Delete all version bundles from storage. Their extractions, if a run
    // left any in this process, leave on the cache's expiry: the cache is keyed
    // by the bundle's bytes, so an extraction is never served for other
    // content, and another agent with the same bytes may be running from it.
    const versions = await this.db.getVersions(agent.id);
    for (const v of versions) {
      // The key stays in the line: the rows that hold it are deleted right after,
      // and this line is then the only way to find the orphaned object.
      await this.storage.delete(v.bundle_key).catch((err) =>
        logger.warn(
          {
            event: "bundle_delete_failed",
            bundle_key: v.bundle_key,
            ...errorFields(err),
          },
          "Best-effort bundle delete failed during agent delete — orphaned blob may remain",
        ),
      );
    }

    // Delete agent from DB (cascades to versions)
    await this.db.deleteAgent(namespace, name);
  }

  async deleteVersion(namespace: string, name: string, version: string): Promise<void> {
    // Step 1: load agent → 404 NOT_FOUND
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    // Step 2: load versions → 409 LAST_VERSION + 404 VERSION_NOT_FOUND
    const versions = await this.db.getVersions(agent.id);
    if (versions.length <= 1) {
      throw new RegistryError(
        "LAST_VERSION",
        `Cannot delete the last version of ${namespace}/${name}. Use DELETE /api/agents/:namespace/:name to remove the agent entirely.`,
        409,
      );
    }
    const target = versions.find((v) => v.version === version);
    if (!target) {
      throw new RegistryError(
        "VERSION_NOT_FOUND",
        `Version ${version} not found for ${namespace}/${name}`,
        404,
      );
    }

    // Step 3: delete bundle from storage (best-effort, mirror deleteAgent pattern).
    // Order is mandatory: storage BEFORE db. Reverse order = a silent storage leak, for as
    // long as the account lives (deleting the account sweeps its namespace's folder, unless
    // that namespace is shared or outside the shape a push accepts). The key stays in the
    // line, which is then the only way to find the orphaned object.
    await this.storage.delete(target.bundle_key).catch((err) =>
      logger.warn(
        {
          event: "bundle_delete_failed",
          bundle_key: target.bundle_key,
          ...errorFields(err),
        },
        "Best-effort bundle delete failed during version delete — orphaned blob may remain",
      ),
    );

    // Step 4: delete DB row (final commit)
    await this.db.deleteVersion(agent.id, version);
  }

  async setVersionVerified(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<AgentVersionInfo> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const updated = await this.db.setVersionVerified(namespace, name, version, verified);
    if (!updated) {
      throw new RegistryError(
        "VERSION_NOT_FOUND",
        `Version ${version} not found for ${namespace}/${name}`,
        404,
      );
    }
    return {
      version: updated.version,
      size: updated.size,
      pushed_at: updated.pushed_at,
      config_snapshot: updated.config_snapshot,
      notes: updated.notes,
      verified: updated.verified,
    };
  }

  private async buildMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = await this.db.getVersions(agent.id);
    const latest = await this.db.getLatestVersion(agent.id);
    // Every run of the agent, whatever its status and caller, counted where the
    // runs are stored: listing them would carry every input and output of the
    // agent's history for two numbers (the dashboard and the CLI show them).
    const totals = await this.db.getAgentRunTotals(agent.id);
    return {
      name: agent.name,
      namespace: agent.namespace,
      description: agent.description,
      visibility: agent.visibility,
      latest_version_verified: latest?.verified ?? false,
      latest_version: latest?.version ?? "",
      versions: versions.map((v) => v.version),
      created_at: agent.created_at,
      updated_at: agent.updated_at,
      run_count: totals.run_count,
      token_count: totals.token_count,
    };
  }
}
