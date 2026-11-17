// Cloud / self-host runtime adapter selection.
//
// At startup the API server reads `SKRUN_RUNTIME` and either keeps the
// default in-process `LocalAdapter` path (single-tenant self-host) or
// switches to `FlyioAdapter` (per-run sandbox machine on Fly.io). Each
// path requires a different shape of dependencies — credentials for the
// cloud Machines API + S3-compatible storage in the Flyio case, nothing
// extra in the Local case.
//
// The selection lives here (not in `index.ts`) so it can be exercised by
// unit tests without booting the whole Hono app.

import {
  FlyMachinesApi,
  type OutputBytesBudget,
  processOutputBytesBudget,
  RunnerPool,
  storageInfraHosts,
} from "@skrun-dev/runtime";
import { R2Storage } from "../storage/r2.js";

export type RuntimeMode = "local" | "flyio";

export interface FlyioRuntimeDeps {
  flyApi: FlyMachinesApi;
  /**
   * Storage backend used by `FlyioAdapter` for bundle presigned-GET
   * delivery + outputs sync upload. Concrete impl is `R2Storage` (R2 or
   * MinIO depending on env), which is a structural superset of the
   * `PresignedStorageAdapter` the adapter consumes.
   */
  storage: R2Storage;
  /** Image tag the spawned runner machines pull. */
  runtimeImageTag: string;
  /**
   * The runner pool. {@link buildFlyioDeps} builds one at any size, 0 included:
   * its size decides whether it keeps a stock of machines (`enabled`) — at 0,
   * the default, it keeps none and every run creates its own machine —, while
   * its maintenance, once the app starts it, looks after the runners' machines
   * at any size. Absent only from dependencies a caller builds without one:
   * then nothing looks after them.
   */
  pool?: RunnerPool;
  /**
   * The budget every run's outputs upload reserves its file buffers on — the
   * process's, built once like the platform client and the pool. An adapter is
   * built for each run: a budget of its own would bound one run, not the process.
   */
  outputsBudget: OutputBytesBudget;
}

/**
 * Parse the pool size from the environment.
 *
 * **Optional, defaulting to off.** It must never join the required-env list below:
 * adding it there would refuse to start every deployment already running in cloud
 * mode, at upgrade time, over a feature they never asked for. An unparseable or
 * negative value still fails loudly, in the house style — a typo should not
 * silently disable a pool an operator believes they configured.
 */
export function readPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SKRUN_RUNNER_POOL_SIZE;
  if (raw === undefined || raw === "") return 0;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(
      `SKRUN_RUNNER_POOL_SIZE="${raw}" is not a non-negative integer. ` +
        "Set it to 0 (or leave it unset) to create a machine per run.",
    );
  }
  return size;
}

/**
 * Parse `SKRUN_RUNTIME` from the given env (defaults to `process.env`).
 * Throws on unrecognised values rather than silently falling back — a
 * typo in the env should fail loud at startup, not run with the wrong
 * adapter.
 */
export function selectRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const raw = (env.SKRUN_RUNTIME ?? "local").toLowerCase();
  if (raw === "local" || raw === "flyio") return raw;
  throw new Error(
    `SKRUN_RUNTIME="${raw}" is not a valid runtime — expected "local" or "flyio". ` +
      "See .env.example for the supported values.",
  );
}

/**
 * Validate the env block needed for `SKRUN_RUNTIME=flyio` and build the
 * `FlyioRuntimeDeps`. Throws a clear, actionable error when any required
 * variable is missing — the server refuses to start so cloud mode never
 * silently misbehaves due to half-configured infra.
 */
export function buildFlyioDeps(env: NodeJS.ProcessEnv = process.env): FlyioRuntimeDeps {
  const missing: string[] = [];
  const token = env.FLY_API_TOKEN;
  // SKRUN_RUNNERS_APP, not FLY_APP_NAME: Fly auto-injects `FLY_APP_NAME`
  // into every running machine's env as the CURRENT app's name, which
  // would collide with our intended use ("the app where per-run runners
  // should be spawned — different from the api-server's own app"). The
  // collision silently overrode user-supplied secrets on Fly. Renamed
  // 2026-05-25.
  const appName = env.SKRUN_RUNNERS_APP;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  const bucket = env.S3_BUCKET;
  // No silent `:latest` default: require an explicit runner
  // image tag. `:latest` is never published for prerelease builds, so a silent
  // fallback produced the recurring Fly `400 manifest unknown` at machine-create.
  // The operator sets a concrete tag (`:edge` dev, `:latest`/`vX.Y.Z` stable).
  const imageTag = env.RUNTIME_IMAGE_TAG;
  if (!token) missing.push("FLY_API_TOKEN");
  if (!appName) missing.push("SKRUN_RUNNERS_APP");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("S3_BUCKET");
  if (!imageTag) missing.push("RUNTIME_IMAGE_TAG");
  if (missing.length > 0) {
    throw new Error(
      `SKRUN_RUNTIME=flyio is missing required env vars: ${missing.join(", ")}. ` +
        "See .env.example for the full cloud-runtime configuration.",
    );
  }

  const flyApi = new FlyMachinesApi(token as string, appName as string);
  const storage = new R2Storage({
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    accountId: env.S3_ACCOUNT_ID,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
  });
  const runtimeImageTag = imageTag as string;

  // The runner pool — built at any size, 0 included. Its size decides only
  // whether it keeps a stock: at 0 it never creates a machine and every run
  // takes the create-per-run path, unchanged. Its maintenance, which the app
  // starts, runs whatever the size: it empties a stock an earlier process left
  // and sweeps the machines of runs — nothing else destroys a machine a process
  // that died left billing.
  const pool = new RunnerPool(flyApi, {
    size: readPoolSize(env),
    imageTag: runtimeImageTag,
    region: env.FLY_REGION,
    // Run-independent, so they can be applied when the machine is built
    // rather than when it is assigned — the same definition a machine
    // created for a run gets. The object store's hostname is only visible
    // on a presigned URL, hence a resolver: no run exists when the pool fills.
    infraHosts: () => storageInfraHosts(storage),
    harness6pn: env.FLY_PRIVATE_IP,
  });

  return { flyApi, storage, runtimeImageTag, pool, outputsBudget: processOutputBytesBudget() };
}

/** The runtime a server runs: its mode and, on the cloud runtime, its dependencies. */
export interface ResolvedRuntime {
  mode: RuntimeMode;
  /** Present exactly when `mode` is `"flyio"`. */
  flyioDeps?: FlyioRuntimeDeps;
}

/**
 * The one decision a server entry point makes about its runtime: `SKRUN_RUNTIME`
 * read once and, when it names the cloud runtime, the dependencies built from
 * the same environment. The entry point hands both to `createApp`, which does
 * not read the mode again, and starts the output purge on the store in those
 * same dependencies — so the runs and the purge are on one bucket by
 * construction. Throws, as its two parts do, on an unknown mode or an
 * incomplete cloud configuration.
 */
export function resolveRuntime(env: NodeJS.ProcessEnv = process.env): ResolvedRuntime {
  const mode = selectRuntimeMode(env);
  return mode === "flyio" ? { mode, flyioDeps: buildFlyioDeps(env) } : { mode };
}
