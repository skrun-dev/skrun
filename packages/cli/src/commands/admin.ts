import {
  declaredLifetimeEndMs,
  declaredLifetimeMs,
  FlyMachinesApi,
  MACHINE_LIFETIME_GRACE_MS,
  type Machine,
  MachineSpawnError,
} from "@skrun-dev/runtime";
import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";

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
 *   `skrun-run-*`  created for a single run  -> judged on the LIFETIME it declares
 *   `skrun-pool-*` created ahead of any run  -> judged on PLATFORM STATE, and,
 *                  once assigned to a run, on the END OF LIFE it declares
 *
 * It reads the platform's listing and nothing else — never the runs: it cannot
 * tell whether a run is on a machine. So, without an age given, it destroys only
 * a machine whose listing shows no run can be on it, and names, without
 * destroying it, one it cannot judge. A run's machine carries the lifetime it was
 * created with (`RUNNER_LIFETIME_S`, the hold of its run's seat plus a grace):
 * past it plus that grace again, no run can still be on it — its server stops a
 * run at its seat's deadline. One that declares none was made by an older
 * server, which may still be serving a run on it: left. `--older-than`, given,
 * judges on that age what the listing alone does not settle: the operator's
 * call. One it would judge on a time its listing does not give is never
 * destroyed, and always named. While a server
 * runs, its machine maintenance takes what this command leaves — the sweep a
 * run's machine and a pooled one assigned to a run, on its run's row; the
 * reconciliation any other pooled one, on the platform's state.
 */

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
 * Age cannot stand in for that missing knowledge. A per-run machine past the
 * lifetime it declares is an orphan by definition; a pooled machine is old **by
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
 * Under that flag the state predicate still holds, and every machine listed
 * ends in one place the output names:
 *
 *   - `suspended`, `stopped`, `failed` — nothing was running on it when it was
 *     listed. A run wakes a machine before using it, so such a machine had not
 *     been assigned. The listing is old by the time its destruction leaves,
 *     though: it goes without force, at any age, which the platform refuses for a
 *     machine woken since (measured against it on 2026-10-23) — that machine is
 *     spared, and the output says so; one whose refusal's reason it cannot read
 *     fails, and its line says to check it before destroying it by hand.
 *   - `created`   — never started: no run is on it, but the platform destroys it
 *     only with force, and the server that made it may be starting it. Without
 *     `--older-than`: named, never destroyed. With it: destroyed, with force,
 *     once created that long ago.
 *   - `started`   — it may be serving a run this instant. Assigned to one, it
 *     declares the end of its life — the lifetime its assignment handed it,
 *     written once its runner answered: past that end plus the grace no run can
 *     still be on it, as for a run's machine past its lifetime, and without
 *     `--older-than` it is destroyed, with force; within it, it is not yet past
 *     its time. One that declares none — still in stock, or its end never
 *     written —, its listing cannot say: without `--older-than`, named, never
 *     destroyed. With it, either: destroyed, with force, once untouched
 *     POOL_STARTED_IDLE_FACTOR times that age, whatever end it declares — a run
 *     on it that lasts longer since its wake is cut, the operator's call.
 *
 * Any other state — between two, a terminal one, one the client does not know —
 * is named and left, at any age, as is a machine whose listing gives no time to
 * judge it on.
 */
const POOL_MACHINE_NAME_PREFIX = "skrun-pool-";
/**
 * Multiple of `--older-than` a started pool machine must be untouched before it
 * is reclaimed under `--include-pool`. Without `--older-than` a started one is
 * reclaimed only past the end of life it declares plus the grace.
 */
const POOL_STARTED_IDLE_FACTOR = 4;

/**
 * The states of a pooled machine no run can be on: paused, stopped, failed. Under
 * `--include-pool` one listed so goes at any age, without force.
 */
const NOT_RUNNING_STATES: ReadonlySet<Machine["state"]> = new Set([
  "suspended",
  "stopped",
  "failed",
]);

/** In whole seconds, for what the command says. */
const seconds = (ms: number): number => Math.round(ms / 1000);

/** A time the platform listed, in ms since the epoch — undefined when absent or unreadable. */
function timeOf(stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined;
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * What a failed destruction says: the platform client's own words — the status
 * the platform answered and its answer, or why none came —, never the message a
 * spawn error carries for a run's caller, which speaks of a machine that could
 * not be started.
 */
function destroyFailure(err: unknown): string {
  const told = err instanceof MachineSpawnError && err.cause instanceof Error ? err.cause : err;
  return told instanceof Error ? told.message : String(told);
}

export interface AdminCleanupOptions {
  /** Skip the destroy call — just print what would be removed. */
  dryRun?: boolean;
  /**
   * An age, in seconds, that what the listing alone does not settle is judged
   * on: a run's machine older than it is eligible, whatever lifetime it
   * declares; under `includePool`, a pre-created one never started once created
   * that long ago, and a started one once untouched four times as long, whatever
   * end of life it declares. Absent, a run's machine is eligible past the
   * lifetime it declares plus the grace, and one that declares none is left —
   * named in the output and in `left` —; under `includePool`, a started
   * pre-created one past the end of life it declares plus the grace, one that
   * declares none left, as is one never started.
   */
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
  /**
   * Machine ids named and left, never destroyed: without `olderThan`, a run's
   * machine that declares no lifetime and, under `includePool`, a pre-created one
   * never started, or started and declaring no end of life; with it or without,
   * a machine whose listing gives
   * no time to judge it on and, under `includePool`, a pre-created one in any
   * other state than those the command acts on.
   */
  left: string[];
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
  // The age every machine is judged on when the operator gives one; none else.
  const givenMs = opts.olderThan === undefined ? undefined : opts.olderThan * 1000;

  const machines = await flyApi.list();

  // A machine named under neither prefix is not looked at, nor counted in
  // `scanned=`. Every other machine listed ends in one place: a candidate (destroyed, spared or
  // failed below), left — named, never destroyed —, not yet past its time,
  // counted in its summary line, or, without includePool, a pre-created one,
  // left alone unjudged — counted in its summary line only.
  const left: Array<{ machine: Machine; line: string }> = [];
  /** Leave a machine whose listing gives no time to read: nothing to judge it on. */
  const leaveUndated = (m: Machine): void => {
    left.push({
      machine: m,
      line:
        `left ${m.id} (name=${m.name}, state=${m.state}): its listing gives no time to judge it ` +
        "on — this command never destroys a machine on a time it cannot read",
    });
  };

  // Per-run machines: past the age given, when one is; else past the lifetime
  // each declares plus the grace. One that declares none may still carry a run
  // of the older server that made it, which this command cannot see: left.
  const runnerMachines = machines.filter((m) => m.name.startsWith(MACHINE_NAME_PREFIX));
  let runnerWithin = 0;
  const candidates = runnerMachines.filter((m) => {
    const created = timeOf(m.created_at);
    if (created === undefined) {
      leaveUndated(m);
      return false;
    }
    let eligible: boolean;
    if (givenMs !== undefined) {
      eligible = created <= now() - givenMs;
    } else {
      const declared = declaredLifetimeMs(m);
      if (declared === undefined) {
        left.push({
          machine: m,
          line:
            `left ${m.id} (name=${m.name}, state=${m.state}, age=${seconds(now() - created)}s): ` +
            "declares no lifetime — this command does not read the runs and cannot tell whether " +
            "one is on it; pass --older-than to judge it on its age",
        });
        return false;
      }
      eligible = created <= now() - (declared + MACHINE_LIFETIME_GRACE_MS);
    }
    if (!eligible) runnerWithin += 1;
    return eligible;
  });
  const runnerCandidates = candidates.length;
  const runnerLeft = left.length;

  // Pre-created machines: skipped entirely unless asked for. See the note on
  // POOL_MACHINE_NAME_PREFIX for the rule of each listed state.
  const poolMachines = machines.filter((m) => m.name.startsWith(POOL_MACHINE_NAME_PREFIX));
  let poolWithin = 0;
  const poolCandidates = includePool
    ? poolMachines.filter((m) => {
        // Not running when listed: no age condition. Under an explicit sweep the
        // point is to leave nothing behind, and waiting out a cutoff would only
        // delay it.
        if (NOT_RUNNING_STATES.has(m.state)) return true;
        if (m.state !== "created" && m.state !== "started") {
          left.push({
            machine: m,
            line:
              `left ${m.id} (name=${m.name}, state=${m.state}): a state this command does not ` +
              "act on — run it again once the machine has left it",
          });
          return false;
        }
        // Started and assigned to a run: the end of life it declares, plus the
        // grace — unless the operator gives an age, which judges it instead.
        const declaredEnd = m.state === "started" ? declaredLifetimeEndMs(m) : undefined;
        if (declaredEnd !== undefined && givenMs === undefined) {
          if (declaredEnd <= now() - MACHINE_LIFETIME_GRACE_MS) return true;
          poolWithin += 1;
          return false;
        }
        // Never started: its creation time. Started: its last time on the platform.
        const since = timeOf(m.state === "created" ? m.created_at : (m.updated_at ?? m.created_at));
        if (since === undefined) {
          leaveUndated(m);
          return false;
        }
        if (givenMs === undefined) {
          left.push({
            machine: m,
            line:
              m.state === "created"
                ? `left ${m.id} (name=${m.name}, state=${m.state}, age=${seconds(now() - since)}s): ` +
                  "never started — the platform destroys it only with force, and the server that " +
                  "made it may be starting it; pass --older-than to judge it on its age"
                : `left ${m.id} (name=${m.name}, state=${m.state}, idle=${seconds(now() - since)}s): ` +
                  "started and declaring no end of life, it may be serving a run — this command " +
                  "does not read the runs; pass --older-than to judge it (destroyed once untouched " +
                  `${POOL_STARTED_IDLE_FACTOR} times that age)`,
          });
          return false;
        }
        const ageMs = m.state === "created" ? givenMs : givenMs * POOL_STARTED_IDLE_FACTOR;
        if (since <= now() - ageMs) return true;
        poolWithin += 1;
        return false;
      })
    : [];
  candidates.push(...poolCandidates);

  const criterion =
    givenMs === undefined
      ? `${runnerCandidates} past the lifetime it declares plus a grace of ` +
        `${seconds(MACHINE_LIFETIME_GRACE_MS)}s, ${runnerWithin} within it, ${runnerLeft} left — ` +
        "without --older-than this command destroys only a machine its listing shows no run can " +
        "be on: it does not read the runs"
      : `${runnerCandidates} older than ${seconds(givenMs)}s (--older-than), ${runnerWithin} ` +
        `younger, ${runnerLeft} left`;
  log(`Found ${runnerMachines.length} runner machine(s); ${criterion}.`);
  if (poolMachines.length > 0) {
    const poolLeft = left.length - runnerLeft;
    log(
      !includePool
        ? `Found ${poolMachines.length} pre-created machine(s); left alone — the server that ` +
            "created them owns them and recycles them itself. Pass --include-pool to sweep them " +
            "too, e.g. when taking a deployment down for good."
        : givenMs === undefined
          ? `Found ${poolMachines.length} pre-created machine(s); ${poolCandidates.length} ` +
            "reclaimable (suspended, stopped or failed when listed — the platform refuses one " +
            "woken since —, or started and past the end of life it declares plus a grace of " +
            `${seconds(MACHINE_LIFETIME_GRACE_MS)}s), ${poolWithin} within it, ${poolLeft} left: ` +
            "pass --older-than to judge one started that declares none, or one never started."
          : `Found ${poolMachines.length} pre-created machine(s); ${poolCandidates.length} ` +
            "reclaimable (suspended, stopped or failed when listed — the platform refuses one " +
            `woken since —, never started and created ${seconds(givenMs)}s ago or more, or ` +
            `started and untouched for ${seconds(givenMs * POOL_STARTED_IDLE_FACTOR)}s or more), ` +
            `${poolWithin} younger, ${poolLeft} left.`,
    );
  }
  for (const { line } of left) log(line);

  const cleaned: string[] = [];
  for (const machine of candidates) {
    const touched = timeOf(machine.updated_at ?? machine.created_at);
    const shown = `name=${machine.name}, state=${machine.state}${touched === undefined ? "" : `, idle=${seconds(now() - touched)}s`}`;
    if (dryRun) {
      log(`[dry-run] would destroy ${machine.id} (${shown})`);
      cleaned.push(machine.id);
      continue;
    }
    // A pooled machine listed not running goes without force: its server may
    // have woken it for a run since the listing, and the platform then refuses it.
    const unforced = poolCandidates.includes(machine) && NOT_RUNNING_STATES.has(machine.state);
    try {
      const outcome = unforced
        ? await flyApi.destroy(machine.id, { force: false })
        : await flyApi.destroy(machine.id);
      if (outcome === "refused-in-state") {
        log(
          `spared ${machine.id} (${shown}): the platform refused to destroy it in its current ` +
            "state — woken since it was listed, it may be serving a run",
        );
        continue;
      }
      log(`destroyed ${machine.id} (${shown})`);
      cleaned.push(machine.id);
    } catch (err) {
      // Refused without force by a 412 the client did not read as a refusal in
      // its state — its body never read, or another text —: a refusal still, of
      // a machine that may have been woken since the listing.
      const refused =
        unforced && err instanceof MachineSpawnError && err.details.httpStatus === 412
          ? " — refused without a reason this command reads: woken since it was listed, it may " +
            "be serving a run; check it before destroying it by hand"
          : "";
      log(
        `FAILED to destroy ${machine.id} (name=${machine.name}): ${destroyFailure(err)}${refused}`,
      );
    }
  }

  // The PASS line: a machine-readable summary line for shell scripts wrapping this.
  // `app=` is part of it because the most confusing outcome this command has is a
  // clean `scanned=0 cleaned=0` — which reads as "nothing to do" whether it is the
  // truth or the app name was wrong. Naming the app it just swept tells them apart.
  // `left=` counts the machines it named and left: they bill until a server's
  // maintenance, a later run of this command — with --older-than, for one it
  // judges only on an age — or the operator by hand takes them, and a script
  // reading only this line must see them.
  log(
    `PASS cleanup-machines: scanned=${runnerMachines.length + poolMachines.length} cleaned=${cleaned.length} left=${left.length}${appName ? ` app=${appName}` : ""}${dryRun ? " (dry-run)" : ""}`,
  );

  return {
    cleaned,
    left: left.map(({ machine }) => machine.id),
    scanned: runnerMachines.length + poolMachines.length,
    dryRun,
  };
}

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command("admin")
    .description("Administrative commands for cloud-runtime operators.");

  admin
    .command("cleanup-machines")
    .description(
      "Destroy orphan Fly.io sandbox machines. It reads the platform's listing, never the " +
        "runs: without --older-than it destroys only a machine its listing shows no run can be " +
        "on, and names, without destroying it, one it cannot judge. A per-run machine " +
        "(skrun-run-*) is destroyed once it is older than the lifetime it declares plus a grace " +
        `of ${seconds(MACHINE_LIFETIME_GRACE_MS)}s; one made by an older server declares none, ` +
        "and is left. Pre-created ones (skrun-pool-*) are left alone — they are live stock " +
        "owned by the server that made them — unless --include-pool says otherwise.",
    )
    .option("--dry-run", "List what would be destroyed without calling the destroy API.", false)
    .option(
      "--older-than <seconds>",
      "Judge on this age what the listing alone does not settle: a per-run machine older than " +
        "it is destroyed, whatever it declares — a run still on it included —; under " +
        "--include-pool, a pre-created one never started once created that long ago, and a " +
        `started one once untouched ${POOL_STARTED_IDLE_FACTOR} times as long, whatever end of ` +
        "life it declares. Unset, no age replaces what the listing shows: one it cannot judge " +
        "is named and left.",
      (raw) => Number.parseInt(raw, 10),
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
        "the pool. For taking a deployment down for good: one suspended, stopped or failed goes " +
        "at any age, unless the platform refuses it — woken since the listing —; a started one " +
        "assigned to a run goes once past the end of life it declares plus a grace of " +
        `${seconds(MACHINE_LIFETIME_GRACE_MS)}s; one never started, which goes only with force, ` +
        "and a started one that declares no end, which may be serving a run, are named and left " +
        "unless --older-than is given — then the first goes once created that long ago, a " +
        `started one once untouched ${POOL_STARTED_IDLE_FACTOR} times that age, whatever end it ` +
        "declares, cutting a run on it that has lasted longer. One in any other state is named " +
        "and left.",
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
          exitWith(1);
        }
      },
    );
}
