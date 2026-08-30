import type { CreateMachineRequest, MachineGuest } from "./fly-api.js";

// Default VM resource spec for runner machines. 1024MB is the smallest
// memory tier that boots our multi-runtime image reliably — Fly's
// default 256MB leaves the machine stuck in "created" state (HTTP 408
// deadline_exceeded). Surfaced during the first real-Fly cold-start run
// 2026-05-25. Bump if multi-tenant agent scripts need more RAM at boot.
const DEFAULT_RUNNER_GUEST: MachineGuest = {
  cpu_kind: "shared",
  cpus: 1,
  memory_mb: 1024,
};

// Allowlist of env keys the runner machine is allowed to receive. The
// sandbox MUST have ZERO credentials (no LLM keys, no DB URL, no Skrun API
// token, no webhook secret) — the LLM loop runs in the harness, never in
// the sandbox. Only infrastructure parameters needed by the runner to do
// its job: download bundle, upload outputs, enforce egress, listen on a
// port, and time out.
const RUNNER_ENV_ALLOWLIST = new Set([
  "SKRUN_CONTAINER_MODE",
  "BUNDLE_URL",
  "OUTPUTS_PUT_URL",
  "SKRUN_ALLOWED_HOSTS",
  "SKRUN_DNS_RESOLVE_INTERVAL",
  "RUNNER_PORT",
  "MAX_RUN_TIMEOUT_MS",
  // Per-run RPC bearer token — the ONE credential the sandbox legitimately
  // receives, so it can authenticate the inbound api→runner RPC. Exempt from
  // the forbidden-substring guard below (see FORBIDDEN_EXCEPTIONS).
  "RUNNER_RPC_TOKEN",
  // Per-machine claim credential, carried ONLY by pre-created (pooled) machines.
  // It is not tied to a run — it authorises exactly one thing, the `/claim` call
  // that installs the per-run RUNNER_RPC_TOKEN — which is why it can be injected
  // at machine creation the way the run token is on the cold path. Also exempt
  // from the forbidden-substring guard, by exact name.
  //
  // Its presence is ALSO what tells the entrypoint to boot in the pooled posture
  // (no agent egress rules yet, command channel created). Deriving the posture
  // from the credential rather than from a separate flag makes it structurally
  // impossible to boot a machine that waits to be claimed without the credential
  // that gates claiming — the failure mode a flag would have allowed.
  "RUNNER_CLAIM_TOKEN",
  // CSV of harness-controlled infra hosts the runner's egress allowlist must
  // permit even though they are not in the agent's allowed_hosts: the object
  // store (bundle GET at /init — outputs are harness-pulled, not pushed) and
  // the install-time package registries. Not credentials — just hostnames.
  "RUNNER_INFRA_HOSTS",
  // The harness's own 6PN address — the runner ip6tables allowlist ACCEPTs the
  // RPC return path to it as defense-in-depth: ESTABLISHED,RELATED is the
  // primary carrier once ICMPv6/ND works; this is cheap insurance against a
  // future conntrack regression. Not a credential — just an address.
  "RUNNER_HARNESS_6PN",
]);

// Substrings that are FORBIDDEN anywhere in env keys or values. Defense in
// depth: even if a future change widens the allowlist by mistake, these
// patterns trip the assert. Matched case-insensitively against KEYS only.
const FORBIDDEN_KEY_SUBSTRINGS = [
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "DATABASE_URL",
  "ANTHROPIC",
  "OPENAI",
  "GOOGLE",
  "GROQ",
  "MISTRAL",
  "WEBHOOK",
  "FLY_API",
  "S3_",
  // "SUPABASE" removed — the legacy SUPABASE_KEY env var was dropped
  // when the api-server moved to a direct Postgres driver. DATABASE_URL
  // above already catches the new connection-string secret. The substring
  // would also false-positive on any future user-facing config name
  // starting with SUPABASE_* that isn't a credential.
];

// Allowlisted keys deliberately exempt from FORBIDDEN_KEY_SUBSTRINGS. The
// per-run RPC token is a credential the runner NEEDS (to authenticate the
// api→runner RPC) — distinct from the LLM/server secrets the guard blocks.
// Narrow by exact name (NOT "all allowlisted keys") so the guard still trips
// on a future allowlisted-by-mistake secret-shaped key.
const FORBIDDEN_EXCEPTIONS = new Set(["RUNNER_RPC_TOKEN", "RUNNER_CLAIM_TOKEN"]);

export interface BuildMachineConfigInput {
  runId: string;
  image: string;
  bundleUrl: string;
  outputsPutUrl: string;
  allowedHosts: string[];
  region?: string;
  runnerPort?: number;
  maxRunTimeoutMs?: number;
  dnsResolveIntervalSeconds?: number;
  /**
   * VM resource spec. Defaults to {@link DEFAULT_RUNNER_GUEST} (shared
   * 1 CPU + 1024MB) which is the smallest tier that boots the multi-
   * runtime image reliably. Pass a larger guest for resource-heavy agents.
   */
  guest?: MachineGuest;
  /**
   * Per-run RPC bearer token. When set, it is injected into the machine env as
   * RUNNER_RPC_TOKEN so the runner can authenticate the api→runner RPC.
   * Optional so callers that pre-date the token (or self-host) keep building —
   * the runner enforces only when the token is present in its env.
   */
  rpcToken?: string;
  /**
   * Harness-controlled infrastructure hosts the runner must reach even though
   * they are not in the agent's `allowed_hosts`: the object-storage endpoint
   * (bundle download + outputs upload) and the install-time package registries.
   * The runner entrypoint resolves + ACCEPTs them on both families (no
   * private-IP filter — they are trusted, and a self-host MinIO endpoint may be
   * private). Empty/unset → no infra rules.
   */
  infraHosts?: string[];
  /**
   * The harness (api-server) own 6PN IPv6 address. When set, the runner's
   * ip6tables OUTPUT allowlist ACCEPTs egress to it so the api→runner RPC reply
   * path survives the default-DROP policy — defense-in-depth behind the
   * primary ESTABLISHED,RELATED match. Optional — unset (self-host / non-Fly)
   * just omits the rule.
   */
  harness6pn?: string;
}

/**
 * Build the Fly.io Machines `CreateMachineRequest` for a runner-mode
 * sandbox. Machine name is `skrun-run-${runId}` — unique per run so
 * concurrent runs cannot collide in the Fly.io app namespace.
 *
 * Throws if the assembled env would contain a forbidden key (defense in
 * depth against future regressions widening the allowlist by mistake).
 */
export function buildMachineConfig(input: BuildMachineConfigInput): CreateMachineRequest {
  const env: Record<string, string> = {
    SKRUN_CONTAINER_MODE: "runner",
    BUNDLE_URL: input.bundleUrl,
    OUTPUTS_PUT_URL: input.outputsPutUrl,
    SKRUN_ALLOWED_HOSTS: input.allowedHosts.join(","),
    RUNNER_PORT: String(input.runnerPort ?? 9000),
    MAX_RUN_TIMEOUT_MS: String(input.maxRunTimeoutMs ?? 300_000),
  };
  if (input.dnsResolveIntervalSeconds !== undefined) {
    env.SKRUN_DNS_RESOLVE_INTERVAL = String(input.dnsResolveIntervalSeconds);
  }
  if (input.rpcToken) {
    env.RUNNER_RPC_TOKEN = input.rpcToken;
  }
  if (input.infraHosts && input.infraHosts.length > 0) {
    env.RUNNER_INFRA_HOSTS = input.infraHosts.join(",");
  }
  if (input.harness6pn) {
    env.RUNNER_HARNESS_6PN = input.harness6pn;
  }

  assertEnvIsSafe(env);

  return {
    name: machineNameForRun(input.runId),
    region: input.region,
    config: {
      image: input.image,
      env,
      guest: input.guest ?? DEFAULT_RUNNER_GUEST,
      // NET_ADMIN is required at the cap level for the entrypoint's iptables
      // setup; the capsh handoff drops to zero caps + uid 1000 right after
      // the egress allowlist is installed (see entrypoint.sh / runner-start.sh).
      // Fly.io grants NET_ADMIN by default to root in machines, so no extra
      // config is needed here — but if Fly.io ever tightens defaults, this is
      // where to surface the requirement explicitly.
      restart: { policy: "no" },
    },
  };
}

/**
 * The canonical machine name for a given runId. Exposed so the admin CLI
 * (`skrun admin cleanup-machines`) can filter on the prefix.
 */
export function machineNameForRun(runId: string): string {
  return `skrun-run-${runId}`;
}

/** Name prefix of a pre-created (pooled) machine — the pool's own namespace. */
export const POOL_MACHINE_NAME_PREFIX = "skrun-pool-";

/**
 * The canonical machine name for a pooled machine. Deliberately a DIFFERENT
 * prefix from {@link machineNameForRun}: operator tooling must be able to tell
 * the two apart, because their safe-to-destroy rules differ. A per-run machine
 * older than the run timeout is an orphan; a pooled machine is old **by design**
 * (its `created_at` is fill time), so age says nothing about whether a run is
 * currently using it.
 */
export function machineNameForPool(poolId: string): string {
  return `${POOL_MACHINE_NAME_PREFIX}${poolId}`;
}

export interface BuildPoolMachineConfigInput {
  /** Unique id for this pooled machine — only used to build its name. */
  poolId: string;
  image: string;
  /**
   * Per-machine claim credential. **Required**: it both authorises the `/claim`
   * that assigns this machine to a run, and tells the entrypoint to boot in the
   * pooled posture. See {@link buildPoolMachineConfig} for why its absence throws.
   */
  claimToken: string;
  region?: string;
  runnerPort?: number;
  maxRunTimeoutMs?: number;
  dnsResolveIntervalSeconds?: number;
  guest?: MachineGuest;
  /** Harness-controlled infra hosts — run-independent, so they are resolved at fill. */
  infraHosts?: string[];
  /** The harness's own private address — run-independent, so it is applied at fill. */
  harness6pn?: string;
}

/**
 * Build the `CreateMachineRequest` for a **blank, pre-created** runner machine.
 *
 * "Blank" is the security property, not a description: this machine has never
 * been assigned to a run, so it carries **no bundle URL, no outputs URL, no
 * agent `allowed_hosts` and no per-run RPC token**. Those four are the only
 * run-specific values; everything else is harness-level and can be applied now.
 * That is what keeps the pool compatible with the single-use sandbox rule — a
 * stock of never-used machines is not a stock of recycled ones.
 *
 * Throws when `claimToken` is missing. That is not defensive noise: the runner's
 * authorisation falls back to the historical open-when-unset rule when it holds
 * *neither* credential, so a machine that was meant to wait for a claim but
 * shipped without the credential would serve `/init` — and `/init` takes an
 * arbitrary bundle URL — to anything on the private network. Refusing to build
 * such a config is the cheapest place to stop that.
 */
export function buildPoolMachineConfig(input: BuildPoolMachineConfigInput): CreateMachineRequest {
  if (!input.claimToken) {
    throw new Error(
      "buildPoolMachineConfig: claimToken is required. A pooled machine without it would boot " +
        "holding neither credential, which is the runner's open-when-unset back-compat state — " +
        "i.e. an unauthenticated /init on the private network. Mint one per machine.",
    );
  }

  const env: Record<string, string> = {
    SKRUN_CONTAINER_MODE: "runner",
    RUNNER_PORT: String(input.runnerPort ?? 9000),
    MAX_RUN_TIMEOUT_MS: String(input.maxRunTimeoutMs ?? 300_000),
    RUNNER_CLAIM_TOKEN: input.claimToken,
  };
  if (input.dnsResolveIntervalSeconds !== undefined) {
    env.SKRUN_DNS_RESOLVE_INTERVAL = String(input.dnsResolveIntervalSeconds);
  }
  if (input.infraHosts && input.infraHosts.length > 0) {
    env.RUNNER_INFRA_HOSTS = input.infraHosts.join(",");
  }
  if (input.harness6pn) {
    env.RUNNER_HARNESS_6PN = input.harness6pn;
  }

  assertEnvIsSafe(env);

  return {
    name: machineNameForPool(input.poolId),
    region: input.region,
    config: {
      image: input.image,
      env,
      guest: input.guest ?? DEFAULT_RUNNER_GUEST,
      // Same as a per-run machine: never restarted under us. The claim latch that
      // makes a machine single-use lives in the runner's memory, so a restart
      // would reset it — `restart: no` is what keeps that guarantee durable.
      restart: { policy: "no" },
    },
  };
}

function assertEnvIsSafe(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!RUNNER_ENV_ALLOWLIST.has(key)) {
      throw new Error(
        `buildMachineConfig: env key "${key}" is not in the runner allowlist. ` +
          `The sandbox must receive only infrastructure params (allowlist: ${[...RUNNER_ENV_ALLOWLIST].join(", ")}). ` +
          "If you need to add a new key, update RUNNER_ENV_ALLOWLIST in machine-config.ts and document why it is credentials-free.",
      );
    }
    // A vetted, deliberately-allowed credential (the per-run RPC token) is
    // exempt from the forbidden-substring guard below.
    if (FORBIDDEN_EXCEPTIONS.has(key)) continue;
    const upperKey = key.toUpperCase();
    for (const forbidden of FORBIDDEN_KEY_SUBSTRINGS) {
      if (upperKey.includes(forbidden)) {
        throw new Error(
          `buildMachineConfig: env key "${key}" contains forbidden substring "${forbidden}" ` +
            "— sandbox machines must not receive credentials.",
        );
      }
    }
  }
}
