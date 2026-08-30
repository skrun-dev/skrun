import { describe, expect, it } from "vitest";
import {
  buildMachineConfig,
  buildPoolMachineConfig,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
} from "./machine-config.js";

const baseInput = {
  runId: "run-abc-123",
  image: "ghcr.io/skrun-dev/skrun-runtime:v0.9.0",
  bundleUrl: "https://r2.example.com/bundles/foo.tgz?sig=xyz",
  outputsPutUrl: "https://r2.example.com/outputs/foo.tar?sig=zyx",
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

    it("defaults RUNNER_PORT to 9000 and MAX_RUN_TIMEOUT_MS to 300000", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.RUNNER_PORT).toBe("9000");
      expect(result.config.env?.MAX_RUN_TIMEOUT_MS).toBe("300000");
    });

    it("propagates explicit runnerPort and maxRunTimeoutMs overrides", () => {
      const result = buildMachineConfig({
        ...baseInput,
        runnerPort: 8888,
        maxRunTimeoutMs: 600_000,
      });
      expect(result.config.env?.RUNNER_PORT).toBe("8888");
      expect(result.config.env?.MAX_RUN_TIMEOUT_MS).toBe("600000");
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
  });

  describe("env sanitization (ADR-014)", () => {
    it("env contains EXACTLY the allowlisted keys — no leakage from process.env", () => {
      const result = buildMachineConfig(baseInput);
      const envKeys = Object.keys(result.config.env ?? {}).sort();
      expect(envKeys).toEqual([
        "BUNDLE_URL",
        "MAX_RUN_TIMEOUT_MS",
        "OUTPUTS_PUT_URL",
        "RUNNER_PORT",
        "SKRUN_ALLOWED_HOSTS",
        "SKRUN_CONTAINER_MODE",
      ]);
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

    it("machineNameForRun shares the same prefix that cleanup-machines (task 6.1) filters on", () => {
      // SC-19 / D-7: admin cleanup must be able to find every runner machine
      // by prefix. The naming convention is stable across both code paths.
      expect(machineNameForRun("xyz")).toBe("skrun-run-xyz");
      expect(machineNameForRun("xyz").startsWith("skrun-run-")).toBe(true);
    });
  });

  describe("internal invariant — assertEnvIsSafe", () => {
    // Smoke test that the defense-in-depth assertion would trip if the
    // function were edited to leak a forbidden key. We can't reach
    // assertEnvIsSafe directly without exporting it, so we exercise the
    // contract via the public builder by abusing the bundleUrl input: even
    // if a key is allowlisted, the assert is the second line of defense
    // here. (The first line is the allowlist itself, which already catches
    // unknown keys — see the env-keys test above.)
    it("documents that any future widening of the allowlist must remain credentials-free", () => {
      const result = buildMachineConfig(baseInput);
      // This is intentionally a snapshot test of the env KEY SET only, NOT
      // values — values contain presigned URLs which change every run.
      expect(new Set(Object.keys(result.config.env ?? {}))).toEqual(
        new Set([
          "SKRUN_CONTAINER_MODE",
          "BUNDLE_URL",
          "OUTPUTS_PUT_URL",
          "SKRUN_ALLOWED_HOSTS",
          "RUNNER_PORT",
          "MAX_RUN_TIMEOUT_MS",
        ]),
      );
    });
  });

  describe("RPC token (SEC-2026-002)", () => {
    it("carries RUNNER_RPC_TOKEN in the env when rpcToken is set (exempt from the forbidden-substring guard)", () => {
      const result = buildMachineConfig({ ...baseInput, rpcToken: "deadbeefcafe" });
      expect(result.config.env?.RUNNER_RPC_TOKEN).toBe("deadbeefcafe");
    });

    it("omits RUNNER_RPC_TOKEN and leaves the default 6-key env when no rpcToken is given", () => {
      const result = buildMachineConfig(baseInput);
      expect(result.config.env?.RUNNER_RPC_TOKEN).toBeUndefined();
      expect(Object.keys(result.config.env ?? {})).toHaveLength(6);
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
});

describe("buildPoolMachineConfig — a blank, pre-created machine (#111)", () => {
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
    const env = buildPoolMachineConfig(poolInput).config.env ?? {};
    for (const key of [
      "BUNDLE_URL",
      "OUTPUTS_PUT_URL",
      "SKRUN_ALLOWED_HOSTS",
      "RUNNER_RPC_TOKEN",
    ]) {
      expect(env[key]).toBeUndefined();
    }
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
});
