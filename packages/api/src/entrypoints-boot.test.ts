import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The API server's two entries, started as processes: on Postgres, a
 * malformed bound on the database's statements refuses the start — before any
 * connection, naming the variable —; on SQLite, the variable is ignored. A
 * malformed deletion journal setting refuses the start on either backend.
 *
 * Each case starts its entry from a temporary directory — SQLite creates its
 * database there, nothing lands in the tree —, with an environment that
 * inherits no DATABASE_URL, on a port the system picks. The Postgres URL a
 * case gives names a port nothing listens on: an entry that went as far as
 * connecting would fail there, without the refusal's line. The TypeScript
 * loader is passed by its absolute URL: a bare specifier would be resolved
 * from the working directory, the temporary one. Nothing waits on a tight
 * delay: the child is followed by its output and its end, each bound is wide
 * (the entry compiles its TypeScript as it starts), and a child still running
 * at the end of its case is killed, its end awaited.
 */

const API_ROOT = join(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(createRequire(join(API_ROOT, "package.json")).resolve("tsx")).href;
const SERVER = join(import.meta.dirname, "server.ts");
const DEV = join(import.meta.dirname, "dev.ts");
const READY_WITHIN_MS = 60_000;
const END_WITHIN_MS = 10_000;
/** A Postgres URL whose port nothing listens on. */
const NOWHERE = "postgres://127.0.0.1:1/x";
const REFUSAL =
  "SKRUN_DB_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000";

interface Boot {
  /** Ended on its own, or running — its "running at" line written —, or neither within the bound. */
  outcome: "ended" | "running" | "neither";
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Starts `entry` with `env` over an environment that inherits no database or bucket settings. */
async function boot(entry: string, env: Record<string, string>): Promise<Boot> {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (
      name === "DATABASE_URL" ||
      name === "SKRUN_DB_STATEMENT_TIMEOUT_MS" ||
      name === "SKRUN_DELETION_JOURNAL" ||
      name.startsWith("S3_")
    ) {
      delete inherited[name];
    }
  }
  const cwd = mkdtempSync(join(tmpdir(), "skrun-entry-boot-"));
  const child = spawn(process.execPath, ["--import", TSX_LOADER, entry], {
    cwd,
    env: { ...inherited, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  let onRunning: () => void = () => {};
  const running = new Promise<"running">((resolve) => {
    onRunning = () => resolve("running");
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
    if (stdout.includes("running at")) onRunning();
  });
  // After the process has exited and its output streams have closed: every line is read.
  const ended = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      ended.then(() => "ended" as const),
      running,
      new Promise<"neither">((resolve) => {
        timer = setTimeout(() => resolve("neither"), READY_WITHIN_MS);
      }),
    ]);
    return { outcome, code: child.exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, END_WITHIN_MS))]);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe("the start of the API server, on a malformed statement bound", () => {
  it("server.ts refuses to start, naming the variable, before any connection", async () => {
    const started = await boot(SERVER, {
      DATABASE_URL: NOWHERE,
      S3_BUCKET: "boot-test",
      S3_ACCESS_KEY_ID: "boot-test",
      S3_SECRET_ACCESS_KEY: "boot-test",
      S3_ENDPOINT: "http://127.0.0.1:1",
      SKRUN_DB_STATEMENT_TIMEOUT_MS: "abc",
    });
    expect(started.outcome, started.stderr).toBe("ended");
    expect(started.code).not.toBe(0);
    expect(started.stderr).toContain(`[skrun-api] FATAL: ${REFUSAL} (got "abc")`);
    // Refused before the adapter was built: it never said it connected.
    expect(started.stdout).not.toContain('"event":"db_connected"');
  }, 90_000);

  it("dev.ts on Postgres refuses to start, naming the variable, before any connection", async () => {
    const started = await boot(DEV, {
      DATABASE_URL: NOWHERE,
      SKRUN_DB_STATEMENT_TIMEOUT_MS: "abc",
    });
    expect(started.outcome, started.stderr).toBe("ended");
    expect(started.code).not.toBe(0);
    expect(started.stderr).toContain(`${REFUSAL} (got "abc")`);
    expect(started.stdout).not.toContain('"event":"db_connected"');
  }, 90_000);

  // On SQLite the bound is not read: the variable is ignored, well formed or not.
  it.each(["5000", "abc"])("dev.ts on SQLite starts with the variable at %s", async (value) => {
    const started = await boot(DEV, { SKRUN_DB_STATEMENT_TIMEOUT_MS: value });
    expect(started.outcome, started.stderr).toBe("running");
  }, 90_000);
});

describe("the start of the API server, on a malformed deletion journal setting", () => {
  const JOURNAL_REFUSAL = 'SKRUN_DELETION_JOURNAL must be true or false (got "maybe")';

  it("server.ts refuses to start, naming the variable, before any connection", async () => {
    const started = await boot(SERVER, {
      DATABASE_URL: NOWHERE,
      S3_BUCKET: "boot-test",
      S3_ACCESS_KEY_ID: "boot-test",
      S3_SECRET_ACCESS_KEY: "boot-test",
      S3_ENDPOINT: "http://127.0.0.1:1",
      SKRUN_DELETION_JOURNAL: "maybe",
    });
    expect(started.stderr).toContain(`[skrun-api] FATAL: ${JOURNAL_REFUSAL}`);
    expect(started.outcome, started.stderr).toBe("ended");
    expect(started.code).not.toBe(0);
    expect(started.stdout).not.toContain('"event":"db_connected"');
  }, 90_000);

  // Read before the two backends part ways — on Postgres, before the migrations
  // connect: createApp, which reads it too, comes after them.
  it("dev.ts on Postgres refuses to start, naming the variable, before any connection", async () => {
    const started = await boot(DEV, { DATABASE_URL: NOWHERE, SKRUN_DELETION_JOURNAL: "maybe" });
    expect(started.stderr).toContain(JOURNAL_REFUSAL);
    expect(started.outcome, started.stderr).toBe("ended");
    expect(started.code).not.toBe(0);
    expect(started.stdout).not.toContain('"event":"db_connected"');
  }, 90_000);

  // The journal is kept on either backend: it is read before the two part ways.
  it("dev.ts on SQLite refuses to start, naming the variable", async () => {
    const started = await boot(DEV, { SKRUN_DELETION_JOURNAL: "maybe" });
    expect(started.stderr).toContain(JOURNAL_REFUSAL);
    expect(started.outcome, started.stderr).toBe("ended");
    expect(started.code).not.toBe(0);
  }, 90_000);
});
