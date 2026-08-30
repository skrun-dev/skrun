/**
 * Compose boot benchmark — SC-3 / VT-3.
 *
 * `docker compose down -v && time docker compose -f infra/docker-compose.yml up -d --wait`
 * should complete in < 60s on a typical developer / CI machine. The
 * --wait flag blocks until every service hits its healthcheck — the
 * full "ready to receive a POST /run" signal.
 *
 * Env-gated on docker CLI availability — skipped locally on Windows
 * dev boxes without Docker Desktop; CI runners have docker preinstalled
 * + this test runs there.
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function hasDocker(): boolean {
  try {
    execSync("docker --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = hasDocker();
const describeCompose = HAS_DOCKER ? describe : describe.skip;

describeCompose("SC-3 / VT-3: docker compose up cold boot < 60s", () => {
  if (!HAS_DOCKER) {
    it("SKIP — install Docker (with the `compose` plugin) to run this benchmark", () => {
      // skip-only placeholder for CI listing visibility.
    });
    return;
  }

  it.skip("WIP — docker compose down -v && docker compose up -d --wait, measure wall-clock", () => {
    // Real implementation:
    //   1. exec `docker compose -f infra/docker-compose.yml down -v` (cold the volumes)
    //   2. mark start
    //   3. exec `docker compose -f infra/docker-compose.yml up -d --wait`
    //      → blocks until every healthcheck passes
    //   4. measure wall-clock elapsed
    //   5. expect(elapsed).toBeLessThan(60_000)
    //   6. exec `docker compose down -v` (cleanup)
    //   7. PASS line: `PASS compose-boot: bootSeconds=X.Y (limit 60s)`
    //
    // Deferred: requires the runtime image to be PULLABLE from GHCR (or
    // built locally) AND the api-server mode bundling (current
    // follow-up — image-as-runner-only ships in 7.3, api-server mode
    // bundling is a Phase 8/9 backfill). Skeleton lets CI add the
    // step once the image supports both modes.
    expect.fail("Not yet wired — see comments above for implementation outline.");
  });
});
