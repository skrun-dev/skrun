import { defineConfig } from "vitest/config";

// The tests are the sources under src/. dist/ is build output, and a watch
// build there may carry compiled copies of them: a run must never pick those
// up, or every test would run twice.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
