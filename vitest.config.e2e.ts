import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    globals: false,
    env: {
      // The dev-token admin shortcut is a fail-secure opt-in (SKRUN_DEV_AUTH).
      // Enable it process-wide for the e2e suite — some files (e.g. sdk.test.ts)
      // import createApp directly and don't load tests/e2e/setup.ts. NODE_ENV=test
      // (vitest default) keeps it inside the createApp interlock's allowlist.
      SKRUN_DEV_AUTH: "1",
    },
  },
});
