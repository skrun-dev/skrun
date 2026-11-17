import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

/**
 * The stop, on a real signal: a server process with one run in flight is sent
 * SIGTERM, ends that run with the stop's failure — the run's own failure that
 * follows is told as the stop's, `SERVER_STOPPED` —, says what it did, and
 * exits 0. Linux and macOS only — under Windows a child sent SIGTERM is ended at
 * once and its handlers are never called, so the case is skipped there, by
 * name. What the handlers do once called is the stop's own tests'.
 *
 * Nothing waits on a tight delay: the child is followed by its own lines and
 * by its `close` event, never by a fixed sleep; each bound is wide (the child
 * compiles its TypeScript as it starts); the only real wait is the stop's
 * drain. And the child never outlives the case: whatever way it ends, a child
 * still running is sent SIGKILL and its end awaited.
 */

const API_ROOT = join(import.meta.dirname, "..", "..");
const CHILD = join(import.meta.dirname, "shutdown-signal-child.shared.ts");
const READY_WITHIN_MS = 60_000;
const END_WITHIN_MS = 60_000;
const SHUTDOWN_RUN_ERROR = "The server stopped while this run was in progress.";

interface End {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** `promise`, or a rejection that names `what` once `ms` have passed; the timer cleared either way. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server process, its stdout read a JSON line at a time, its stderr kept for a failure's message. */
function startChild() {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", CHILD], {
    cwd: API_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOG_LEVEL: "info" },
  });
  const lines: Array<Record<string, unknown>> = [];
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  let isReady = false;
  let onReady: () => void = () => {};
  const readyLine = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push(parsed);
        if (parsed.event === "child_ready") {
          isReady = true;
          onReady();
        }
      } catch {
        // Not a JSON line: not one the case reads.
      }
    });
  }
  // After the process has exited and its output streams have closed: every line is read.
  const ended = new Promise<End>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Ready, or a rejection if the child ends first. An end after readiness rejects nothing.
  const ready = Promise.race([
    readyLine,
    ended.then(() => {
      if (!isReady) throw new Error(`the child ended before it was ready: ${stderr}`);
    }),
  ]);
  return { child, lines, ready, ended, stderr: () => stderr };
}

/** A child still running is sent SIGKILL, and its end awaited. */
async function stopped(child: ChildProcess, ended: Promise<End>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await within(ended, 10_000, "the child's end").catch(() => {});
}

describe("the stop, on a real signal", () => {
  it.skipIf(process.platform === "win32")(
    "on SIGTERM, a server process ends its run in flight with the stop's failure, says what it did, and exits 0",
    async () => {
      const { child, lines, ready, ended, stderr } = startChild();
      try {
        await within(ready, READY_WITHIN_MS, "the child's readiness");

        child.kill("SIGTERM");
        const end = await within(ended, END_WITHIN_MS, "the child's end after SIGTERM");

        expect(end, stderr()).toEqual({ code: 0, signal: null });
        expect(lines.filter((line) => line.event === "child_row_written")).toEqual([
          { event: "child_row_written", status: "failed", error: SHUTDOWN_RUN_ERROR },
        ]);
        // The run's own failure after the stop's is told as the stop's, under its code.
        expect(lines.filter((line) => line.event === "child_told")).toEqual([
          { event: "child_told", code: "SERVER_STOPPED", message: SHUTDOWN_RUN_ERROR },
        ]);
        expect(lines.find((line) => line.event === "server_stopping")).toMatchObject({
          signal: "SIGTERM",
          in_flight: 1,
        });
        expect(lines.find((line) => line.event === "server_shutdown")).toMatchObject({
          signal: "SIGTERM",
          in_flight: 1,
          abandoned: 1,
          finalized: 1,
          unsettled: 0,
          cleanups_pending: 0,
        });
      } finally {
        await stopped(child, ended);
      }
    },
    READY_WITHIN_MS + END_WITHIN_MS + 30_000,
  );
});
