import { describe, expect, it } from "vitest";
import {
  MACHINE_LABEL_KEYS,
  MachineConfigSchema,
  POOL_LABEL_KEY,
  RUN_LABEL_KEY,
} from "./fly-api.js";
import {
  buildMachineConfig,
  buildPoolMachineConfig,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
} from "./machine-config.js";

const baseInput = {
  runId: "run-abc-123",
  image: "ghcr.io/skrun-dev/skrun-runtime:v0.9.0",
  allowedHosts: ["api.openai.com", "api.anthropic.com"],
};

describe("buildMachineConfig", () => {
  describe("happy path", () => {
    it("produces a valid CreateMachineRequest with the canonical machine name", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.name).toBe("skrun-run-run-abc-123");
      expect(result.config.image).toBe(baseInput.image);
    });

    it("sets SKRUN_CONTAINER_MODE=runner so the entrypoint takes the iptables + capsh path", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.SKRUN_CONTAINER_MODE).toBe("runner");
    });

    it("joins allowedHosts with comma (matching dns-reresolve.sh CSV parser)", () => {
      const result = buildMachineConfig({
        ...baseInput,
        allowedHosts: ["a.com", "b.com", "c.com"],
      });
      expect(result.config.env?.SKRUN_ALLOWED_HOSTS).toBe("a.com,b.com,c.com");
    });

    it("defaults RUNNER_PORT to 9000, and carries no lifetime it was not given", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.RUNNER_PORT).toBe("9000");
      expect(result.config.env?.RUNNER_LIFETIME_S).toBeUndefined();
    });

    it("propagates an explicit runnerPort", () => {
      const result = buildMachineConfig({ ...baseInput, runnerPort: 8888 });
      expect(result.config.env?.RUNNER_PORT).toBe("8888");
    });

    // What ends a machine nobody destroyed: the lifetime it is given, in whole
    // seconds — never the run timeout the configuration used to carry and
    // nothing read. The exact key set says the timeout is gone.
    it("carries the lifetime it is given, in seconds, and no run timeout", () => {
      const env = buildMachineConfig({ ...baseInput, lifetimeSeconds: 1250 }).config.env ?? {};
      expect(env.RUNNER_LIFETIME_S).toBe("1250");
      expect(Object.keys(env).sort()).toEqual([
        "RUNNER_LIFETIME_S",
        "RUNNER_PORT",
        "SKRUN_ALLOWED_HOSTS",
        "SKRUN_CONTAINER_MODE",
      ]);
    });

    it("omits SKRUN_DNS_RESOLVE_INTERVAL when not provided (entrypoint default of 30s applies)", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.SKRUN_DNS_RESOLVE_INTERVAL).toBeUndefined();
    });

    it("includes SKRUN_DNS_RESOLVE_INTERVAL when provided", () => {
      const result = buildMachineConfig({ ...baseInput, dnsResolveIntervalSeconds: 60 });
      expect(result.config.env?.SKRUN_DNS_RESOLVE_INTERVAL).toBe("60");
    });

    it("forwards region when set", () => {
      const result = buildMachineConfig({ ...baseInput, region: "cdg" });
      expect(result.region).toBe("cdg");
    });

    it("sets restart policy to 'no' (sandbox machines are one-shot)", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.restart?.policy).toBe("no");
    });

    // Whatever ends its process — the run's end, the machine's own lifetime, a
    // crash — the platform then destroys the machine. Without it, a machine
    // whose process ended would only be stopped (restart: no), billing its disk
    // until something destroys it.
    it("is destroyed by the platform once its process exits (auto_destroy)", () => {
      expect(buildMachineConfig(baseInput).config.auto_destroy).toBe(true);
    });
  });

  describe("env sanitization: no credential reaches the sandbox", () => {
    it("env contains EXACTLY the allowlisted keys — no leakage from process.env", () => {
      const result = buildMachineConfig(baseInput);
      const envKeys = Object.keys(result.config.env ?? {}).sort();
      // No URL of the run: they travel in the body of /init, signed once the
      // machine answers.
      expect(envKeys).toEqual(["RUNNER_PORT", "SKRUN_ALLOWED_HOSTS", "SKRUN_CONTAINER_MODE"]);
    });

    it("env contains no credentials-shaped keys (case-insensitive substring match)", () => {
      const result = buildMachineConfig(baseInput);
      const env = result.config.env ?? {};
      const forbidden = [
        "API_KEY",
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "DATABASE_URL",
        "ANTHROPIC",
        "OPENAI",
        "GOOGLE",
        "WEBHOOK",
        "FLY_API",
      ];
      for (const key of Object.keys(env)) {
        const upperKey = key.toUpperCase();
        for (const f of forbidden) {
          expect(upperKey.includes(f), `key "${key}" contains forbidden "${f}"`).toBe(false);
        }
      }
    });
  });

  describe("machine name uniqueness", () => {
    it("yields distinct machine names for distinct runIds", () => {
      const ids = ["a", "b", "c", "d-1", "d-2", "abc-def-ghi"];
      const names = new Set(ids.map((id) => machineNameForRun(id)));
      expect(names.size).toBe(ids.length);
    });

    it("machineNameForRun shares the same prefix that cleanup-machines filters on", () => {
      // Admin cleanup must be able to find every runner machine by prefix. The
      // naming convention is stable across both code paths.
      expect(machineNameForRun("xyz")).toBe("skrun-run-xyz");
      expect(machineNameForRun("xyz").startsWith("skrun-run-")).toBe(true);
    });
  });

  describe("internal invariant — assertEnvIsSafe", () => {
    // Smoke test that the defense-in-depth assertion would trip if the
    // function were edited to leak a forbidden key. We can't reach
    // assertEnvIsSafe directly without exporting it, so we exercise the
    // contract via the public builder: even if a key is allowlisted, the
    // assert is the second line of defense here. (The first line is the
    // allowlist itself, which already catches unknown keys — see the
    // env-keys test above.)
    it("documents that any future widening of the allowlist must remain credentials-free", () => {
      const result = buildMachineConfig(baseInput);
      // This is intentionally a snapshot test of the env KEY SET only, NOT
      // values — values such as the run token change every run.
      expect(new Set(Object.keys(result.config.env ?? {}))).toEqual(
        new Set(["SKRUN_CONTAINER_MODE", "SKRUN_ALLOWED_HOSTS", "RUNNER_PORT"]),
      );
    });
  });

  describe("RPC token (SEC-2026-002)", () => {
    it("carries RUNNER_RPC_TOKEN in the env when rpcToken is set (exempt from the forbidden-substring guard)", () => {
      const result = buildMachineConfig({ ...baseInput, rpcToken: "deadbeefcafe" });
      expect(result.config.env?.RUNNER_RPC_TOKEN).toBe("deadbeefcafe");
    });

    it("omits RUNNER_RPC_TOKEN and leaves the default 3-key env when no rpcToken is given", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.RUNNER_RPC_TOKEN).toBeUndefined();
      expect(Object.keys(result.config.env ?? {})).toHaveLength(3);
    });
  });

  describe("infra hosts + harness 6PN (SEC-2026-001 egress redesign)", () => {
    it("carries RUNNER_INFRA_HOSTS (CSV) when infraHosts is set", () => {
      const result = buildMachineConfig({
        ...baseInput,
        infraHosts: ["registry.npmjs.org", "pypi.org"],
      });
      expect(result.config.env?.RUNNER_INFRA_HOSTS).toBe("registry.npmjs.org,pypi.org");
    });

    it("omits RUNNER_INFRA_HOSTS when infraHosts is empty or unset", () => {
      expect(
        buildMachineConfig({ ...baseInput, infraHosts: [] }).config.env?.RUNNER_INFRA_HOSTS,
      ).toBeUndefined();
      expect(buildMachineConfig(baseInput).config.env?.RUNNER_INFRA_HOSTS).toBeUndefined();
    });

    it("carries RUNNER_HARNESS_6PN when harness6pn is set (an address, not a credential — no forbidden-substring trip)", () => {
      const result = buildMachineConfig({ ...baseInput, harness6pn: "fdaa:0:1234::2" });
      expect(result.config.env?.RUNNER_HARNESS_6PN).toBe("fdaa:0:1234::2");
    });

    it("omits RUNNER_HARNESS_6PN when harness6pn is unset", () => {
      expect(buildMachineConfig(baseInput).config.env?.RUNNER_HARNESS_6PN).toBeUndefined();
    });
  });

  // The label is how a creation whose outcome is unknown is found again: the
  // platform filters its listing on a metadata pair, never on a name. The key is
  // a wire name — what the listing is filtered on — so it is pinned literally.
  describe("label", () => {
    it("labels the machine with the run it serves, and with nothing else", () => {
      expect(buildMachineConfig(baseInput).config.metadata).toEqual({
        skrun_run_id: "run-abc-123",
      });
    });

    it("keeps the label out of the environment the sandbox reads", () => {
      const env = buildMachineConfig(baseInput).config.env ?? {};
      expect(Object.values(env)).not.toContain("run-abc-123");
    });
  });
});

describe("the label keys", () => {
  it("are one per kind of machine the product creates", () => {
    expect(RUN_LABEL_KEY).toBe("skrun_run_id");
    expect(POOL_LABEL_KEY).toBe("skrun_pool_id");
    expect([...MACHINE_LABEL_KEYS]).toEqual(["skrun_run_id", "skrun_pool_id"]);
  });
});

describe("buildPoolMachineConfig — a blank, pre-created machine", () => {
  const poolInput = {
    poolId: "abc123",
    image: "registry.example/skrun-runtime:runner-1.0.0",
    claimToken: "c".repeat(64),
  };

  it("names the machine under the pool prefix, distinct from per-run machines", () => {
    expect(buildPoolMachineConfig(poolInput).name).toBe("skrun-pool-abc123");
    expect(POOL_MACHINE_NAME_PREFIX).toBe("skrun-pool-");
    // Operator tooling tells them apart by prefix because their safe-to-destroy
    // rules differ: a pooled machine is old by design, so age proves nothing.
    expect(machineNameForRun("abc123").startsWith(POOL_MACHINE_NAME_PREFIX)).toBe(false);
  });

  it("carries the claim credential and the harness-level parameters only", () => {
    const env = buildPoolMachineConfig({
      ...poolInput,
      infraHosts: ["registry.npmjs.org"],
      harness6pn: "fdaa:0:1234::2",
      dnsResolveIntervalSeconds: 30,
    }).config.env;
    expect(env?.RUNNER_CLAIM_TOKEN).toBe("c".repeat(64));
    expect(env?.SKRUN_CONTAINER_MODE).toBe("runner");
    expect(env?.RUNNER_INFRA_HOSTS).toBe("registry.npmjs.org");
    expect(env?.RUNNER_HARNESS_6PN).toBe("fdaa:0:1234::2");
    expect(env?.SKRUN_DNS_RESOLVE_INTERVAL).toBe("30");
  });

  // "Blank" is the security property: these four are the only run-specific
  // values, and a machine that has never been assigned a run must hold none.
  it("carries NONE of the run-specific values", () => {
    const config = buildPoolMachineConfig(poolInput).config;
    const env = config.env ?? {};
    for (const key of [
      "BUNDLE_URL",
      "OUTPUTS_PUT_URL",
      "SKRUN_ALLOWED_HOSTS",
      "RUNNER_RPC_TOKEN",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    // Its label names the pool's machine, never a run.
    expect(config.metadata?.skrun_run_id).toBeUndefined();
  });

  // A pooled machine's lifetime starts at its assignment to a run, never at its
  // boot: one that waits for a run must not end on the way. Nor does it carry
  // the run timeout the configuration used to carry — the exact key set says so.
  it("carries no lifetime and no run timeout", () => {
    const env = buildPoolMachineConfig(poolInput).config.env ?? {};
    expect(env.RUNNER_LIFETIME_S).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual([
      "RUNNER_CLAIM_TOKEN",
      "RUNNER_PORT",
      "SKRUN_CONTAINER_MODE",
    ]);
  });

  it("labels the machine with its pool id, and with nothing else", () => {
    expect(buildPoolMachineConfig(poolInput).config.metadata).toEqual({
      skrun_pool_id: "abc123",
    });
  });

  // The gap the 1.2 security review found: without the credential the runner
  // holds NEITHER token, which is its open-when-unset back-compat state — an
  // unauthenticated /init, whose body carries an arbitrary bundle URL.
  it("refuses to build without a claim credential", () => {
    expect(() => buildPoolMachineConfig({ ...poolInput, claimToken: "" })).toThrow(
      /claimToken is required/,
    );
    expect(() =>
      buildPoolMachineConfig({ ...poolInput, claimToken: undefined as unknown as string }),
    ).toThrow(/open-when-unset/);
  });

  it("keeps the env guard narrow — the exemption is by exact name, not by category", () => {
    // RUNNER_CLAIM_TOKEN contains "TOKEN", which the forbidden-substring guard
    // blocks by default. It passes only because it is named in FORBIDDEN_EXCEPTIONS,
    // the same narrow mechanism RUNNER_RPC_TOKEN uses — so a future secret-shaped
    // key added by mistake still trips the guard.
    expect(() => buildPoolMachineConfig(poolInput)).not.toThrow();
    expect(buildPoolMachineConfig(poolInput).config.env?.RUNNER_CLAIM_TOKEN).toBeDefined();
  });

  it("pins restart:no — the claim latch lives in runner memory, so a restart would reset it", () => {
    expect(buildPoolMachineConfig(poolInput).config.restart).toEqual({ policy: "no" });
  });

  // A pause, its resume, and the cold boot the platform makes of a paused
  // machine it stopped all leave the machine alive — none of them is an exit of
  // its process: the pool's own gestures survive it.
  it("is destroyed by the platform once its process exits (auto_destroy)", () => {
    expect(buildPoolMachineConfig(poolInput).config.auto_destroy).toBe(true);
  });
});

// The client reads `auto_destroy` back from a listing as it reads the rest of a
// machine's configuration — which is how a check against the real platform sees
// that the flag reached it. A listing carries every machine of the app: one whose
// flag is of another type must not fail it.
describe("auto_destroy, read back from a listing", () => {
  const listed = () => buildMachineConfig(baseInput).config;

  it("is kept by the client's schema of a machine's configuration", () => {
    expect(MachineConfigSchema.parse(listed()).auto_destroy).toBe(true);
  });

  it("is read as absent when it is not a boolean, and the configuration still reads", () => {
    for (const value of [null, "yes", 1]) {
      const parsed = MachineConfigSchema.safeParse({ ...listed(), auto_destroy: value });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.auto_destroy).toBeUndefined();
      expect(parsed.data?.image).toBe(baseInput.image);
    }
  });
});
