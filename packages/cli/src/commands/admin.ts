import { FlyMachinesApi } from "@skrun-dev/runtime";
import type { Command } from "commander";

/**
 * `skrun admin cleanup-machines` — leak safety net for Fly.io sandbox
 * machines. The cloud `FlyioAdapter` destroys each run's machine in a
 * `finally` block + on caller-disconnect, but rare crashes (process
 * killed, panics inside the destroy path, network partitions during the
 * destroy RPC) can leave orphan machines burning Fly.io billing minutes.
 * This command reclaims machines under both naming conventions, by two
 * deliberately different rules — see the note on POOL_MACHINE_NAME_PREFIX for why
 * one rule cannot cover both:
 *
 *   `skrun-run-*`  created for a single run  -> judged on AGE
 *   `skrun-pool-*` created ahead of any run  -> judged on PLATFORM STATE
 *
 * Defaults are conservative either way, so an in-flight run is never destroyed by
 * accident.
 */

const DEFAULT_OLDER_THAN_S = 600;
const MACHINE_NAME_PREFIX = "skrun-run-";

/**
 * Pre-created ("pooled") machines live under their own prefix, and this command
 * leaves them alone unless asked in so many words.
 *
 * They belong to the server that created them. It holds the only record of which
 * ones are spoken for, it recycles them on its own schedule, and it disposes of
 * ones it no longer recognises when it restarts. This process has none of that:
 * it can read a name, a state and a timestamp, and nothing else.
 *
 * Age cannot stand in for that missing knowledge. A per-run machine older than
 * the run timeout is an orphan by definition; a pooled machine is old **by
 * design**, because its creation time is when the pool was stocked, long before
 * any run touches it. An earlier version of this command judged pooled machines
 * `suspended`-and-past-the-cutoff, reasoning that a suspended machine certainly
 * has no run on it. That is true, and it is not the question: a suspended pooled
 * machine is precisely the *unused stock* the pool exists to keep. On the
 * five-minute schedule this command's own documentation recommends, it emptied
 * the pool every pass — never breaking a run, and quietly making the feature
 * pointless.
 *
 * A longer threshold would only move the trap: any number here has to stay above
 * the server's own recycling interval, which is configurable and which this
 * process cannot read. So there is no number. Pool machines are skipped, and
 * `--include-pool` is for the one case this command cannot cover — a deployment
 * being taken down for good, where a human is present anyway.
 *
 * Under that flag the state predicate still holds, so even a deliberate sweep
 * cannot kill a live run:
 *
 *   - `suspended` — nothing is running on it. A run wakes a machine before using
 *     it, so a suspended machine has not been assigned.
 *   - `started`   — it may be serving a run this instant. Reclaimed only once it
 *     has been untouched for far longer than a run can last.
 *
 * Anything else is left alone.
 */
const POOL_MACHINE_NAME_PREFIX = "skrun-pool-";
/** Multiple of `--older-than` a started pool machine must be idle before reclaiming. */
const POOL_STARTED_IDLE_FACTOR = 4;

export interface AdminCleanupOptions {
  /** Skip the destroy call — just print what would be removed. */
  dryRun?: boolean;
  /** Minimum machine age (seconds) before it's eligible for cleanup. */
  olderThan?: number;
  /** Fly.io deploy token. Defaults to `process.env.FLY_API_TOKEN`. */
  token?: string;
  /**
   * The app whose sandbox machines are reaped. Defaults to
   * `process.env.SKRUN_RUNNERS_APP` — the same name the api-server reads — and
   * falls back to the legacy `FLY_APP_NAME` for setups configured before the
   * rename.
   */
  appName?: string;
  /**
   * Sweep pre-created (pooled) machines too. Off by default — they belong to the
   * server that created them. Meant for taking a deployment down for good.
   */
  includePool?: boolean;
  /** Injectable for tests — defaults to a real `FlyMachinesApi`. */
  flyApi?: FlyMachinesApi;
  /** Clock injection for tests — defaults to `Date.now`. */
  now?: () => number;
  /** Output sink — defaults to `console.log`. Tests inject a buffer. */
  log?: (line: string) => void;
}

export interface AdminCleanupResult {
  /** Machine ids matched + actually destroyed (or planned for dry-run). */
  cleaned: string[];
  /** Total machines inspected under both naming conventions. */
  scanned: number;
  /** Whether the call was a dry-run (no destroy actually issued). */
  dryRun: boolean;
}

/**
 * Library-style entry point — pure function so the CLI route layer +
 * future programmatic callers (e.g. a cron) can both invoke it. The
 * `commander` wrapper below is the user-facing shell.
 */
export async function cleanupMachines(opts: AdminCleanupOptions = {}): Promise<AdminCleanupResult> {
  const token = opts.token ?? process.env.FLY_API_TOKEN;
  // The runners app, under the name the api-server itself reads. FLY_APP_NAME is
  // still accepted so existing setups keep working, but it carries a trap of its
  // own: Fly injects that variable into every running machine as *that machine's*
  // app name. A reaper scheduled inside one therefore targets the app it runs in,
  // finds no sandbox machines, and reports a perfectly healthy zero. Preferring
  // SKRUN_RUNNERS_APP makes the CLI and the server agree, and `--app` settles it
  // outright.
  const appName = opts.appName ?? process.env.SKRUN_RUNNERS_APP ?? process.env.FLY_APP_NAME;
  const viaLegacyEnvName =
    !opts.appName && !process.env.SKRUN_RUNNERS_APP && Boolean(process.env.FLY_APP_NAME);
  if (!opts.flyApi && (!token || !appName)) {
    throw new Error(
      "cleanup-machines requires FLY_API_TOKEN + SKRUN_RUNNERS_APP (the runners app — the same " +
        "name the api-server uses). Pass --app to override it; FLY_APP_NAME is still accepted.",
    );
  }
  const flyApi = opts.flyApi ?? new FlyMachinesApi(token as string, appName as string);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line) => console.log(line));
  if (viaLegacyEnvName) {
    log(
      `WARNING: app name taken from FLY_APP_NAME ("${appName}"). Fly sets that variable inside ` +
        "its own machines to the app the machine belongs to, so this may not be your runners " +
        "app. Set SKRUN_RUNNERS_APP or pass --app.",
    );
  }
  const dryRun = opts.dryRun ?? false;
  const includePool = opts.includePool ?? false;
  const olderThanS = opts.olderThan ?? DEFAULT_OLDER_THAN_S;
  const cutoffMs = now() - olderThanS * 1000;

  const machines = await flyApi.list();

  // Per-run machines: unchanged. Age is a sound signal here — one of these older
  // than the run timeout cannot still be serving the run it was created for.
  const runnerMachines = machines.filter((m) => m.name.startsWith(MACHINE_NAME_PREFIX));
  const candidates = runnerMachines.filter((m) => {
    if (!m.created_at) return false;
    const created = Date.parse(m.created_at);
    return Number.isFinite(created) && created <= cutoffMs;
  });

  // Pre-created machines: skipped entirely unless asked for. See the note on
  // POOL_MACHINE_NAME_PREFIX for why there is no age rule here at all.
  const poolMachines = machines.filter((m) => m.name.startsWith(POOL_MACHINE_NAME_PREFIX));
  const startedCutoffMs = now() - olderThanS * POOL_STARTED_IDLE_FACTOR * 1000;
  const poolCandidates = includePool
    ? poolMachines.filter((m) => {
        // Suspended: no age condition. Under an explicit sweep the point is to
        // leave nothing behind, and waiting out a cutoff would only delay it.
        if (m.state === "suspended") return true;
        if (m.state === "started") {
          const touched = Date.parse(m.updated_at ?? m.created_at ?? "");
          return Number.isFinite(touched) && touched <= startedCutoffMs;
        }
        return false;
      })
    : [];
  candidates.push(...poolCandidates);

  log(
    `Found ${runnerMachines.length} runner machine(s); ${candidates.length - poolCandidates.length} older than ${olderThanS}s.`,
  );
  if (poolMachines.length > 0) {
    log(
      includePool
        ? `Found ${poolMachines.length} pre-created machine(s); ${poolCandidates.length} reclaimable ` +
            "(suspended, so no run can be on it; started only when long untouched)."
        : `Found ${poolMachines.length} pre-created machine(s); left alone — the server that ` +
            "created them owns them and recycles them itself. Pass --include-pool to sweep them " +
            "too, e.g. when taking a deployment down for good.",
    );
  }

  const cleaned: string[] = [];
  for (const machine of candidates) {
    const stamp = machine.updated_at ?? machine.created_at;
    const ageS = Math.round((now() - Date.parse(stamp as string)) / 1000);
    if (dryRun) {
      log(
        `[dry-run] would destroy ${machine.id} (name=${machine.name}, state=${machine.state}, idle=${ageS}s)`,
      );
      cleaned.push(machine.id);
      continue;
    }
    try {
      await flyApi.destroy(machine.id);
      log(`destroyed ${machine.id} (name=${machine.name}, state=${machine.state}, idle=${ageS}s)`);
      cleaned.push(machine.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`FAILED to destroy ${machine.id} (name=${machine.name}): ${message}`);
    }
  }

  // D-1 PASS line: machine-readable summary for shell scripts wrapping this.
  // `app=` is part of it because the most confusing outcome this command has is a
  // clean `scanned=0 cleaned=0` — which reads as "nothing to do" whether it is the
  // truth or the app name was wrong. Naming the app it just swept tells them apart.
  log(
    `PASS cleanup-machines: scanned=${runnerMachines.length + poolMachines.length} cleaned=${cleaned.length}${appName ? ` app=${appName}` : ""}${dryRun ? " (dry-run)" : ""}`,
  );

  return { cleaned, scanned: runnerMachines.length + poolMachines.length, dryRun };
}

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command("admin")
    .description("Administrative commands for cloud-runtime operators.");

  admin
    .command("cleanup-machines")
    .description(
      "Destroy orphan Fly.io sandbox machines. Per-run machines (skrun-run-*) are judged " +
        "on age. Pre-created ones (skrun-pool-*) are left alone — they are live stock owned " +
        "by the server that made them — unless --include-pool says otherwise. Conservative " +
        "defaults so in-flight runs are never touched.",
    )
    .option("--dry-run", "List what would be destroyed without calling the destroy API.", false)
    .option(
      "--older-than <seconds>",
      "Minimum age (seconds) before a machine is eligible. Default 600 (= 2× MAX_RUN_TIMEOUT_S).",
      (raw) => Number.parseInt(raw, 10),
      DEFAULT_OLDER_THAN_S,
    )
    .option(
      "--app <name>",
      "The runners app to reap. Overrides SKRUN_RUNNERS_APP / FLY_APP_NAME — use it wherever " +
        "the environment sets an app name you do not control (inside a Fly machine, Fly sets " +
        "FLY_APP_NAME to that machine's own app).",
    )
    .option("--token <token>", "Fly.io deploy token. Overrides FLY_API_TOKEN.")
    .option(
      "--include-pool",
      "Also destroy pre-created (pooled) machines. Off by default: the server that created " +
        "them owns them and recycles them itself, so sweeping them on a schedule would empty " +
        "the pool. For taking a deployment down for good.",
      false,
    )
    .action(
      async (options: {
        dryRun?: boolean;
        olderThan?: number;
        app?: string;
        token?: string;
        includePool?: boolean;
      }) => {
        try {
          await cleanupMachines({
            dryRun: options.dryRun,
            olderThan: options.olderThan,
            appName: options.app,
            token: options.token,
            includePool: options.includePool,
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}
