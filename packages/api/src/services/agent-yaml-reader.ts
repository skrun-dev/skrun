import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  type AgentConfig,
  type AgentYamlWarnings,
  ValidationError,
  type ValidationIssue,
} from "@skrun-dev/schema";

/**
 * How long the read of an `agent.yaml` may run, in milliseconds, before it is
 * stopped and refused (`AgentYamlTooComplexError`): the push `400
 * INVALID_CONFIG`, a run of a version stored before the push held it `500
 * INVALID_CONFIG`. The `yaml`
 * library has shapes whose read grows faster than the file: within the 128 KB
 * an `agent.yaml` may weigh, deep compact sequences (`- - - … 1`) took 2.5 to 4
 * seconds (measured on Windows, 2026-11-16), and others may exist. Every
 * `agent.yaml` of this repository reads in under 13 ms in a thread that has
 * read nothing before, 4 ms after: the budget is 150 times the slowest.
 */
export const AGENT_YAML_READ_BUDGET_MS = 2_000;

/**
 * How many threads read `agent.yaml` files in this process — a push's, and a
 * run's once per bundle — at most as many reads at once; a read past them
 * waits its turn, in the order they came, and its budget starts when it does.
 * A thread holds about 30 MB once started, up to about 200 MB more while it
 * reads the slowest shape accepted, and a processor core for as long as a
 * read lasts: the count bounds what reads can take from the runs this process
 * serves.
 */
export const AGENT_YAML_READS_AT_ONCE = 2;

/**
 * How many reads may wait for a thread in this process when a push's read
 * joins them; past them, the push's read is refused at once
 * (`AgentYamlReaderBusyError` — the push's `503 PUSH_BUSY`). Only slow files
 * fill it: an ordinary `agent.yaml` reads in a few milliseconds, and sixteen
 * of them waiting clear in well under a second. A push let in has at most
 * fifteen reads ahead of it, read `AGENT_YAML_READS_AT_ONCE` at a time, each
 * ending within its budget — and a stopped thread's replacement starting in
 * about 100 ms: what it waits is bounded by those, whatever comes after it. A
 * run's read (`readInTurn`) counts among the reads waiting but is never
 * refused, so runs never let more than that wait ahead of a push. A waiting
 * push holds its body meanwhile, up to the push's cap: the bound bounds that
 * too.
 */
export const AGENT_YAML_READS_WAITING = 16;

/**
 * The `Retry-After` of a push refused for the reads waiting, in seconds: one
 * budget — within it, every read running when the push was refused has ended
 * and handed its thread to a waiting read, at least `AGENT_YAML_READS_AT_ONCE`
 * places freed —, and one second more, for a stopped thread's replacement to
 * start (~100 ms measured) and the rounding.
 */
export const AGENT_YAML_BUSY_RETRY_AFTER_S = Math.ceil(AGENT_YAML_READ_BUDGET_MS / 1000) + 1;

/**
 * The stack of a reading thread, in MB: the one a Node main thread reads with
 * — V8's default of 984 KB — plus the 192 KB Node keeps out of a worker's
 * stack. An `agent.yaml` nested deeper than its stack holds is refused, a YAML
 * parse error: with this stack, at the depth the main thread refused it at
 * (measured on three shapes of nesting, 2026-11-16, a thread that had read
 * nothing before against a freshly started process: the same depth to within
 * two levels). Node's default of 4 MB accepted configurations nested twice
 * deeper than the server ever had.
 */
const READER_STACK_MB = (984 + 192) / 1024;

/**
 * The reading thread: a plain module next to this one, in src as in dist —
 * where the API's build copies it (`packages/api/package.json`, its `build`
 * script), tsc writing only what it compiles.
 */
const WORKER_URL = new URL("./agent-yaml-worker.mjs", import.meta.url);

/**
 * Throw, naming the file, when the reading thread's module is not next to
 * this one: every push and every run's first read of a bundle would fail on
 * it, a `500`. `createApp` calls it, so a server built without the file —
 * the build's copy dropped — refuses to start rather than serve. `url`, for a
 * test, defaults to the module's.
 */
export function assertAgentYamlWorkerPresent(url: URL = WORKER_URL): void {
  const path = fileURLToPath(url);
  if (!existsSync(path)) {
    throw new Error(
      `The agent.yaml reading thread's module is missing: ${path}. The API reads every agent.yaml in it; the build copies it next to agent-yaml-reader.js (packages/api, its build script).`,
    );
  }
}

/** What a read gives: the configuration `agent.yaml` declares, and its warnings. */
export interface AgentYamlRead {
  config: AgentConfig;
  /**
   * The same configuration as the thread sent it: JSON, `JSON.stringify` of
   * what `parseAgentYaml` returned there — its keys in their order.
   */
  configJson: string;
  warnings: AgentYamlWarnings;
}

/**
 * The refusal of an `agent.yaml` whose read outlasted its budget: the read is
 * stopped, the push refused (`400 INVALID_CONFIG`, its issue's message) — or
 * the run (`500 INVALID_CONFIG`, its message, as a run answers any refusal of
 * the file). Its one issue, `YAML_TOO_COMPLEX`, and its message say so without
 * anything of the file.
 */
export class AgentYamlTooComplexError extends ValidationError {
  readonly budgetMs: number;

  constructor(budgetMs: number) {
    const message = `This bundle's agent.yaml is too complex to read: reading it took longer than ${budgetMs / 1000} s, and the read was stopped. Simplify it and push it again.`;
    super("agent.yaml is too complex to read", [{ code: "YAML_TOO_COMPLEX", message }]);
    this.name = "AgentYamlTooComplexError";
    this.budgetMs = budgetMs;
  }
}

/**
 * A reading thread failed, the file never judged: it could not start, it threw
 * outside a read, or it ended without answering. A fault of the server, not of
 * the push or the run that asked.
 */
export class AgentYamlReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentYamlReaderError";
  }
}

/**
 * The refusal of a push's read that finds as many reads waiting for a thread
 * as the reader lets wait: refused at once, never queued, the file never read.
 * The state of the server, not a fault of the file: the push is answered `503
 * PUSH_BUSY`, to be sent again. A run's read is never refused so.
 */
export class AgentYamlReaderBusyError extends Error {
  /** How many reads the reader lets wait — all of them waiting. */
  readonly waitingAtMost: number;

  constructor(waitingAtMost: number) {
    super(`${waitingAtMost} agent.yaml reads are waiting for a thread, as many as may wait`);
    this.name = "AgentYamlReaderBusyError";
    this.waitingAtMost = waitingAtMost;
  }
}

/**
 * A read dropped before it started: the signal it was given — its push's
 * request, whose client hung up — had aborted when it asked for a thread, or
 * aborted while it waited for one. It never reaches a thread, and leaves its
 * place in the line at once.
 */
export class AgentYamlReadAbandonedError extends Error {
  constructor() {
    super("The agent.yaml read was dropped before it started: its request was aborted");
    this.name = "AgentYamlReadAbandonedError";
  }
}

/** What a reading thread posts for each file: its start, then one answer. */
type WorkerMessage =
  | { type: "started" }
  | { type: "read"; config: string; warnings: AgentYamlWarnings }
  | { type: "refused"; message: string; issues?: ValidationIssue[] };

/** The read a thread is doing, and the clock of its budget once it has started. */
interface Read {
  resolve: (read: AgentYamlRead) => void;
  reject: (err: Error) => void;
  budget?: NodeJS.Timeout;
}

/** A reading thread: free, reading, or on its way out — stopped or failed. */
interface Thread {
  worker: Worker;
  state: "free" | "reading" | "leaving";
  read?: Read;
}

/** A read waiting for a thread: given one, or the failure to start one. */
interface Waiter {
  resolve: (thread: Thread) => void;
  reject: (err: Error) => void;
}

/**
 * Reads `agent.yaml` files off the event loop: each in a thread of its own,
 * with `parseAgentYaml`, unchanged, so that no file, whatever its read costs,
 * holds the requests this process serves. A read past `budgetMs` is stopped —
 * its thread terminated — and refused.
 *
 * At most `readsAtOnce` threads, started when a read finds none free and kept
 * for the next reads: a read pays a thread's start, about 100 ms, only when
 * none is free. A thread stopped or failed leaves, and the next read that
 * finds none free starts another. A free thread does not keep the process
 * alive. Reads wait for one in the order they came. A push's read (`read`)
 * finding `waitingAtMost` reads waiting is refused at once, and leaves the
 * line without being read when its signal aborts. A run's read
 * (`readInTurn`) waits its turn whatever the line holds.
 *
 * The configuration comes back as JSON — what Postgres and SQLite record of
 * it, the parse's own values left in the thread.
 *
 * The push reads each bundle's `agent.yaml` with it, and a run each bundle's
 * once, for as long as the run cache keeps it (`routes/run.ts`). The CLI
 * parses on the creator's machine.
 */
export class AgentYamlReader {
  private readonly budgetMs: number;
  private readonly readsAtOnce: number;
  private readonly waitingAtMost: number;
  private readonly threads = new Set<Thread>();
  private readonly waiting: Waiter[] = [];

  constructor(options: { budgetMs?: number; readsAtOnce?: number; waitingAtMost?: number } = {}) {
    this.budgetMs = options.budgetMs ?? AGENT_YAML_READ_BUDGET_MS;
    this.readsAtOnce = options.readsAtOnce ?? AGENT_YAML_READS_AT_ONCE;
    this.waitingAtMost = options.waitingAtMost ?? AGENT_YAML_READS_WAITING;
  }

  /**
   * The configuration `text` declares and its warnings. Rejects with the
   * read's refusal — a `ValidationError`, or the `Error` the parse threw —,
   * with `AgentYamlTooComplexError` past the budget, and with
   * `AgentYamlReaderError` when its thread fails. Before the read starts: with
   * `AgentYamlReaderBusyError`, at once, when as many reads wait for a thread
   * as may wait; with `AgentYamlReadAbandonedError` when `signal` has aborted,
   * or aborts while the read waits — it leaves its place, never read. Once
   * started, a read is not stopped by `signal`: it ends, answered or at its
   * budget. Stopping it would end its thread, and the next read would pay a
   * new one's start, for at most a budget of reading saved.
   */
  async read(text: string, signal?: AbortSignal): Promise<AgentYamlRead> {
    return this.readIn(await this.take({ signal, bounded: true }), text);
  }

  /**
   * A run's read: as `read`, but it waits for a thread however many reads
   * wait — never refused busy — and nothing drops it while it waits. Its
   * arrival is bounded elsewhere: a run reads a bundle's `agent.yaml` once
   * for as long as the run cache keeps the bundle, and runs are rate-limited.
   * Rejects with the read's refusal, with `AgentYamlTooComplexError` past the
   * budget, and with `AgentYamlReaderError` when its thread fails.
   */
  async readInTurn(text: string): Promise<AgentYamlRead> {
    return this.readIn(await this.take({ bounded: false }), text);
  }

  /** `text` read in `thread`, taken for it. */
  private readIn(thread: Thread, text: string): Promise<AgentYamlRead> {
    return new Promise<AgentYamlRead>((resolve, reject) => {
      thread.read = { resolve, reject };
      thread.worker.ref();
      thread.worker.postMessage(text);
    });
  }

  /** How many threads there are, how many read, and how many reads wait for one. */
  get load(): { threads: number; reading: number; waiting: number } {
    let reading = 0;
    for (const thread of this.threads) if (thread.state === "reading") reading += 1;
    return { threads: this.threads.size, reading, waiting: this.waiting.length };
  }

  /**
   * A free thread, a new one while there is room, or the next to come free —
   * `bounded`, while fewer reads wait than may. Nothing for a read whose
   * signal has aborted, nor for one whose signal aborts while it waits: it
   * leaves the line, and the thread goes to the next.
   */
  private take({ signal, bounded }: { signal?: AbortSignal; bounded: boolean }): Promise<Thread> {
    if (signal?.aborted) return Promise.reject(new AgentYamlReadAbandonedError());
    for (const thread of this.threads) {
      if (thread.state === "free") {
        thread.state = "reading";
        return Promise.resolve(thread);
      }
    }
    if (this.threads.size < this.readsAtOnce) {
      try {
        return Promise.resolve(this.start());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (bounded && this.waiting.length >= this.waitingAtMost) {
      return Promise.reject(new AgentYamlReaderBusyError(this.waitingAtMost));
    }
    return new Promise<Thread>((resolve, reject) => {
      // A waiter leaves the line once: given a thread, failed, or dropped. Its
      // listener goes with it, so a signal that outlives the read keeps none.
      const dropped = (): void => {
        const at = this.waiting.indexOf(waiter);
        // Out of the line already. Unreachable while every way out takes this
        // listener with it; were one to leave it behind, a waiter out of the
        // line would still remove no other.
        if (at === -1) return;
        this.waiting.splice(at, 1);
        reject(new AgentYamlReadAbandonedError());
      };
      const waiter: Waiter = {
        resolve: (thread) => {
          signal?.removeEventListener("abort", dropped);
          resolve(thread);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", dropped);
          reject(err);
        },
      };
      signal?.addEventListener("abort", dropped, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** A thread whose read has ended: to the next waiting read, or free. */
  private give(thread: Thread): void {
    const next = this.waiting.shift();
    if (next) {
      next.resolve(thread);
      return;
    }
    thread.state = "free";
    thread.worker.unref();
  }

  /**
   * A thread has ended: its place goes to the next waiting read, in a new
   * thread. A thread that cannot start fails that read, and the place goes to
   * the next one — no read is left waiting for a thread that will not come.
   */
  private gone(thread: Thread): void {
    this.threads.delete(thread);
    while (this.threads.size < this.readsAtOnce) {
      const next = this.waiting.shift();
      if (!next) return;
      try {
        next.resolve(this.start());
      } catch (err) {
        next.reject(err as Error);
      }
    }
  }

  /** A new thread, reading from the start. Throws `AgentYamlReaderError` when it cannot start. */
  private start(): Thread {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, {
        // The thread loads one plain module: nothing of how this process was
        // started — a loader under `pnpm dev`, say — is of use to it.
        execArgv: [],
        resourceLimits: { stackSizeMb: READER_STACK_MB },
      });
    } catch (err) {
      throw new AgentYamlReaderError("The agent.yaml reader could not start", { cause: err });
    }
    const thread: Thread = { worker, state: "reading" };
    this.threads.add(thread);
    worker.on("message", (message: WorkerMessage) => this.heard(thread, message));
    worker.on("messageerror", (err) => {
      this.fail(
        thread,
        new AgentYamlReaderError("The agent.yaml reader's answer could not be read", {
          cause: err,
        }),
      );
      void worker.terminate();
    });
    worker.on("error", (err) =>
      this.fail(thread, new AgentYamlReaderError("The agent.yaml reader failed", { cause: err })),
    );
    worker.on("exit", (code) => {
      this.fail(
        thread,
        new AgentYamlReaderError(
          `The agent.yaml reader ended (exit code ${code}) without answering`,
        ),
      );
      this.gone(thread);
    });
    return thread;
  }

  /** What a thread says of its read: started — the budget's clock starts —, or its answer. */
  private heard(thread: Thread, message: WorkerMessage): void {
    const read = thread.read;
    if (!read || thread.state !== "reading") return;
    if (message.type === "started") {
      read.budget = setTimeout(() => this.stop(thread), this.budgetMs);
      return;
    }
    clearTimeout(read.budget);
    thread.read = undefined;
    if (message.type === "read") {
      let config: AgentConfig;
      try {
        config = JSON.parse(message.config) as AgentConfig;
      } catch (err) {
        read.reject(
          new AgentYamlReaderError("The agent.yaml reader's answer could not be read", {
            cause: err,
          }),
        );
        this.give(thread);
        return;
      }
      read.resolve({ config, configJson: message.config, warnings: message.warnings });
    } else {
      read.reject(
        message.issues
          ? new ValidationError(message.message, message.issues)
          : new Error(message.message),
      );
    }
    this.give(thread);
  }

  /** The budget is out: the read is refused, its thread stopped — its place freed once it has ended. */
  private stop(thread: Thread): void {
    const read = thread.read;
    thread.read = undefined;
    thread.state = "leaving";
    read?.reject(new AgentYamlTooComplexError(this.budgetMs));
    void thread.worker.terminate();
  }

  /** A thread failed: its read, if any, is rejected, and it reads nothing more. */
  private fail(thread: Thread, err: AgentYamlReaderError): void {
    thread.state = "leaving";
    const read = thread.read;
    if (!read) return;
    thread.read = undefined;
    clearTimeout(read.budget);
    read.reject(err);
  }
}

/**
 * The reader of this process: one, so the threads that read `agent.yaml` files
 * are bounded for the process, whatever reads with it — both push entrypoints
 * and the runs.
 */
export const sharedAgentYamlReader = new AgentYamlReader();
