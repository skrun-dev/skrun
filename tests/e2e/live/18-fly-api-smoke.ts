/**
 * Phase 18 — Fly.io Machines API smoke (#15 task 2.2).
 *
 * Cloud-only — run on demand via `pnpm fly:smoke`. NOT part of
 * `pnpm test:e2e:live` (that suite is the local-registry regression).
 * Gated on `FLY_API_TOKEN` + `FLY_TEST_APP_NAME`; without them the phase
 * emits a single SKIPPED result. `FLY_TEST_IMAGE` defaults to the
 * always-resolvable `:edge` tag (published on every image build, never
 * pruned), so a stale/pruned pin can't false-RED the smoke.
 *
 * When env is present, walks the FlyMachinesApi lifecycle against a real
 * dev Fly.io app:
 *   1. create a tiny machine from the configured image (Fly auto-starts it)
 *   2. list (assert the machine is present), then wait for `started`
 *   3. suspend — pause the machine and snapshot its memory
 *   4. list (assert `suspended`)
 *   5. start — the resume; assert the private address survived it
 *   6. destroy
 *   7. list (assert the machine is absent)
 *
 * Steps 3-5 exist for the pre-warm pool, which holds suspended machines and
 * wakes one per run. Two things about them can only be proven against the real
 * API, never against hand-written fixtures:
 *
 *   - `suspend()` itself, the only net-new call on the client;
 *   - `suspended` as a machine state. `state` is a strict enum inside an
 *     otherwise permissive schema, so a value the schema does not model is a
 *     hard parse failure, not an ignored extra: every `list()` in the process
 *     would throw from the moment one suspended machine existed in the app.
 *     Step 4 is that assertion, and each poll below re-parses the whole list.
 *
 * `start()` is exercised ONLY as the resume of a suspended machine — the shape
 * the pool uses. Calling it right after `create()` returns HTTP 412 (the
 * machine is already started, Machines API default `skip_launch=false`).
 * `stop()` is still not exercised: nothing in the product calls it, and
 * `destroy(force=true)` tears a machine down from any state.
 *
 * Each result is printed in the PASS line per CONSTITUTION D-1 so a human
 * can verify the machine actually existed (e.g., `machine=fdmach_XYZ
 * lifecycle=create→list-present→suspend→list-suspended→resume→destroy→list-absent`).
 */

// Import via source path: `@skrun-dev/runtime` isn't resolvable from `tests/`
// (no workspace symlink at the tests scope), so use the source file directly.
// Same pattern as scripts/validate-fly-creds.ts.
import {
  FlyMachinesApi,
  type Machine,
  type MachineState,
} from "../../../packages/runtime/src/adapter/flyio/fly-api.js";
import { results } from "./_ctx.js";

const PHASE = "fly-api-smoke";
const IMAGE = process.env.FLY_TEST_IMAGE ?? "ghcr.io/skrun-dev/skrun-runtime:edge";

// The client has no "wait for state" call, so transitions are observed by
// polling `list()`. Fly allows 5 GET/s on machines; this stays well under.
const POLL_INTERVAL_MS = 1_000;
// create → `started` includes the host-side image pull on a cold host, which is
// tens of seconds for the runtime image — hence the wide ceiling.
const BOOT_TIMEOUT_MS = 180_000;
const SUSPEND_TIMEOUT_MS = 60_000;
const RESUME_TIMEOUT_MS = 90_000;
const DESTROY_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `list()` until the machine reports `wanted`, or the deadline passes.
 * Returns the machine record as the API last described it.
 */
async function waitForState(
  api: FlyMachinesApi,
  machineId: string,
  wanted: MachineState,
  timeoutMs: number,
): Promise<Machine> {
  const deadline = Date.now() + timeoutMs;
  let observed = "(never listed)";
  for (;;) {
    const machine = (await api.list()).find((m) => m.id === machineId);
    if (machine) {
      observed = machine.state;
      if (machine.state === wanted) return machine;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `machine ${machineId} never reached "${wanted}" within ${timeoutMs}ms ` +
          `(last state: ${observed})`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Poll `list()` until the machine is gone. Absence stays the assertion — the
 * bound only tolerates Fly taking a moment to drop the record. */
async function waitForAbsent(
  api: FlyMachinesApi,
  machineId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const machine = (await api.list()).find((m) => m.id === machineId);
    if (!machine) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `destroyed machine ${machineId} still in list after ${timeoutMs}ms ` +
          `(state: ${machine.state})`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function run(): Promise<void> {
  const token = process.env.FLY_API_TOKEN;
  const appName = process.env.FLY_TEST_APP_NAME;

  // FLY_TEST_IMAGE defaults to the always-resolvable `:edge` tag above, so only
  // the Fly credentials gate the run. Skip cleanly when the token or app name
  // is absent (dev machines / fork PRs without Fly.io access).
  if (!token || !appName) {
    results.push({
      agent: PHASE,
      feature: "fly-api-lifecycle",
      passed: true,
      duration: 0,
      cost: 0,
      detail: "skipped — set FLY_API_TOKEN + FLY_TEST_APP_NAME to run",
    });
    return;
  }

  const api = new FlyMachinesApi(token, appName);
  const machineName = `skrun-smoke-${Date.now()}`;
  const start = Date.now();
  let machineId: string | null = null;
  // Carried into the failure detail: with seven steps against a live API, which
  // one broke is the first thing a human needs, and the API error alone rarely
  // says (three of them are the same `POST … 400`).
  let step = "create";

  try {
    // 1. create
    const created = await api.create({
      name: machineName,
      config: {
        image: IMAGE,
        // Runner mode + a 1024MB guest, matching what the adapter creates for a
        // real runner. Not cosmetic: the default 256MB tier never finishes
        // booting this image (it sits in `created`), and only a machine that
        // reached `started` can be suspended — so the smaller shape would fail
        // step 3 for a reason that has nothing to do with what is under test.
        env: { SKRUN_CONTAINER_MODE: "runner" },
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
        // Never restarted under us — same as every machine the adapter creates.
        restart: { policy: "no" },
      },
    });
    machineId = created.id;

    // 2. list — assert present, then wait until the VM is actually running
    step = "list-present";
    const listed = await api.list();
    const present = listed.find((m) => m.id === machineId);
    if (!present) {
      throw new Error(`Created machine ${machineId} absent from list`);
    }

    step = "wait-started";
    const booted = await waitForState(api, machineId, "started", BOOT_TIMEOUT_MS);
    const addressBefore = booted.private_ip ?? null;

    // 3. suspend — the net-new call
    step = "suspend";
    const suspendStart = Date.now();
    await api.suspend(machineId);

    // 4. list — assert `suspended`. This is where an unmodelled state value
    // would surface, as a schema mismatch thrown out of `list()`.
    step = "list-suspended";
    await waitForState(api, machineId, "suspended", SUSPEND_TIMEOUT_MS);
    const suspendMs = Date.now() - suspendStart;

    // 5. start — the resume path
    step = "resume";
    const resumeStart = Date.now();
    await api.start(machineId);
    const resumed = await waitForState(api, machineId, "started", RESUME_TIMEOUT_MS);
    const resumeMs = Date.now() - resumeStart;

    // The pool records a machine's private address when it creates it and talks
    // to the runner at that address after the wake, so the address surviving a
    // suspend/resume is load-bearing rather than a curiosity.
    step = "address-stable";
    const addressAfter = resumed.private_ip ?? null;
    if (!addressBefore || !addressAfter || addressBefore !== addressAfter) {
      throw new Error(
        `private address changed across suspend/resume: ` +
          `${addressBefore ?? "(none)"} → ${addressAfter ?? "(none)"}`,
      );
    }

    // 6. destroy — Fly's DELETE (force) accepts machines in any non-destroyed
    // state, including the resumed one from step 5. No explicit stop required.
    step = "destroy";
    await api.destroy(machineId);

    // 7. list — assert absent
    step = "list-absent";
    await waitForAbsent(api, machineId, DESTROY_TIMEOUT_MS);

    // The two timings are platform-state transitions observed by polling, not a
    // ready-to-serve measurement: they are reported for context, and nothing
    // about the cold start is claimed from them.
    results.push({
      agent: PHASE,
      feature: "fly-api-lifecycle",
      passed: true,
      duration: Date.now() - start,
      cost: 0,
      detail:
        `machine=${machineId} name=${machineName} address=${addressAfter} ` +
        `lifecycle=create→list-present→suspend→list-suspended→resume→destroy→list-absent ` +
        `suspend_to_suspended_ms=${suspendMs} resume_to_started_ms=${resumeMs}`,
    });
  } catch (err) {
    // Best-effort cleanup if we crashed mid-lifecycle. `force=true` also covers
    // the case where we died with the machine suspended.
    if (machineId) {
      try {
        await api.destroy(machineId);
      } catch {
        // ignore — cleanup best-effort
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Actionable hint when the failure looks like an unresolvable image rather
    // than a Fly API/network error — the `:edge` default should always resolve.
    const hint = /manifest|not found|unknown|unauthorized|404|image/i.test(msg)
      ? ` — hint: is FLY_TEST_IMAGE (${IMAGE}) published + public on GHCR?`
      : "";
    results.push({
      agent: PHASE,
      feature: "fly-api-lifecycle",
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: `machine=${machineId ?? "(not created)"} step=${step} error=${msg}${hint}`,
    });
  }
}
