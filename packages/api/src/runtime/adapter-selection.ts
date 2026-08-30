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

import { FlyMachinesApi, INSTALL_REGISTRY_ALLOWLIST, RunnerPool } from "@skrun-dev/runtime";
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
   * Pre-warm pool, present only when the operator asked for one. Absent means every
   * run creates its own machine — the historical behaviour, and the default
   * everywhere except a deployment that opts in.
   */
  pool?: RunnerPool;
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

  // Pre-warm pool — built only when asked for. `size: 0` means the pool object is
  // never constructed at all, so nothing about the create-per-run path changes for
  // a deployment that has not opted in.
  const poolSize = readPoolSize(env);
  const pool =
    poolSize > 0
      ? new RunnerPool(flyApi, {
          size: poolSize,
          imageTag: runtimeImageTag,
          region: env.FLY_REGION,
          // Run-independent, so they can be applied when the machine is built
          // rather than when it is assigned. The object store's hostname is only
          // visible on a presigned URL, hence the resolver.
          infraHosts: async () => {
            const probe = await storage.getPresignedDownloadUrl("pool-host-probe", 60);
            const hosts = new Set<string>(INSTALL_REGISTRY_ALLOWLIST);
            try {
              hosts.add(new URL(probe).hostname);
            } catch {
              // A malformed presigned URL should not stop the pool from filling;
              // the runner would fail at bundle download, loudly, instead.
            }
            return [...hosts];
          },
          harness6pn: env.FLY_PRIVATE_IP,
        })
      : undefined;

  return { flyApi, storage, runtimeImageTag, pool };
}
