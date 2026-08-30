import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFlyioDeps, readPoolSize, selectRuntimeMode } from "./adapter-selection.js";

const fullEnv = {
  FLY_API_TOKEN: "fly-tok",
  SKRUN_RUNNERS_APP: "skrun-runners",
  S3_ACCESS_KEY_ID: "ak",
  S3_SECRET_ACCESS_KEY: "sk",
  S3_BUCKET: "bucket",
  S3_ENDPOINT: "http://localhost:9000",
  RUNTIME_IMAGE_TAG: "ghcr.io/skrun-dev/skrun-runtime:edge",
} as unknown as NodeJS.ProcessEnv;

describe("adapter-selection", () => {
  it("selectRuntimeMode parses local/flyio, defaults to local, throws on garbage", () => {
    expect(selectRuntimeMode({ SKRUN_RUNTIME: "local" } as NodeJS.ProcessEnv)).toBe("local");
    expect(selectRuntimeMode({ SKRUN_RUNTIME: "flyio" } as NodeJS.ProcessEnv)).toBe("flyio");
    expect(selectRuntimeMode({} as NodeJS.ProcessEnv)).toBe("local");
    expect(() => selectRuntimeMode({ SKRUN_RUNTIME: "nope" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("VT-14: buildFlyioDeps fails fast when RUNTIME_IMAGE_TAG is unset (no silent :latest)", () => {
    const { RUNTIME_IMAGE_TAG: _omit, ...noTag } = fullEnv as Record<string, string>;
    expect(() => buildFlyioDeps(noTag as NodeJS.ProcessEnv)).toThrow(/RUNTIME_IMAGE_TAG/);
  });

  it("VT-14: buildFlyioDeps returns the explicit tag when set (no :latest fallback)", () => {
    const deps = buildFlyioDeps(fullEnv);
    expect(deps.runtimeImageTag).toBe("ghcr.io/skrun-dev/skrun-runtime:edge");
  });

  it("buildFlyioDeps reports ALL missing cloud env vars at once", () => {
    expect(() => buildFlyioDeps({} as NodeJS.ProcessEnv)).toThrow(/RUNTIME_IMAGE_TAG/);
    expect(() => buildFlyioDeps({} as NodeJS.ProcessEnv)).toThrow(/FLY_API_TOKEN/);
  });

  it("infra docker-compose carries the documented :latest default (public self-host config)", () => {
    // Public self-host config only. A public test (this file syncs to the OSS mirror)
    // must NOT read non-synced files — they are absent there. The image-tag policy on
    // the PRIVATE artifacts (`.github/workflows/runtime-image.yml` publishes `:edge`,
    // `infra-cloud/fly.toml` pins a tag) is guarded by VT-14 above (the api fails fast
    // if RUNTIME_IMAGE_TAG is unset) + a private `ci-internal` check.
    const root = join(import.meta.dirname, "..", "..", "..", "..");
    const compose = readFileSync(join(root, "infra", "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/RUNTIME_IMAGE_TAG:-latest/);
  });
});

describe("pre-warm pool configuration (optional, default off)", () => {
  const cloudEnv = fullEnv;

  it("defaults to no pool, so every run creates its own machine", () => {
    expect(readPoolSize({} as NodeJS.ProcessEnv)).toBe(0);
    expect(readPoolSize({ SKRUN_RUNNER_POOL_SIZE: "" } as NodeJS.ProcessEnv)).toBe(0);
    expect(buildFlyioDeps(cloudEnv).pool).toBeUndefined();
  });

  // RT-3c: an operator already running in cloud mode must upgrade untouched. A
  // required pool variable would refuse to start every one of them.
  it("does not make the pool variable required for an existing cloud deployment", () => {
    expect(() => buildFlyioDeps(cloudEnv)).not.toThrow();
  });

  it("builds a pool when asked, sized as configured", () => {
    const deps = buildFlyioDeps({ ...cloudEnv, SKRUN_RUNNER_POOL_SIZE: "3" });
    expect(deps.pool?.enabled).toBe(true);
    expect(deps.pool?.size).toBe(3);
  });

  // A typo should not silently disable a pool the operator believes is running.
  it("fails loudly on a value that is not a non-negative integer", () => {
    for (const bad of ["two", "-1", "1.5"]) {
      expect(() => readPoolSize({ SKRUN_RUNNER_POOL_SIZE: bad } as NodeJS.ProcessEnv)).toThrow(
        /non-negative integer/,
      );
    }
  });
});
