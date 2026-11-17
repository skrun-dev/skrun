import { afterAll } from "vitest";

// Default the operator dashboard OFF for the api test process.
//
// The dashboard is an opt-in surface; most of the suite builds `createApp`
// without caring about it. Leaving it enabled-by-default would resolve the
// fallback root "../web/dist" (often absent under the test cwd) and emit a
// one-line missing-dir warning on every `createApp`. Defaulting to off keeps
// the suite quiet; dashboard tests opt in explicitly per-`describe` by setting
// SKRUN_DASHBOARD="on" + SKRUN_DASHBOARD_DIR=<fixture> (with afterEach restore).
process.env.SKRUN_DASHBOARD ??= "off";

// Enable the dev-token admin shortcut for the api test process — the suite is
// full of `Bearer dev-token` requests that expect admin. Vitest sets
// NODE_ENV=test (allowlisted) so the createApp dev-auth interlock won't trip.
process.env.SKRUN_DEV_AUTH ??= "1";

// The settings of the operator's own site — the path a finished sign-in returns
// to, the sign-in page, the terms, privacy and docs addresses — change what the
// sign-in pages and the callback serve; the bound on each Postgres statement
// changes how long every database call may take; the deletion journal changes
// what a deletion writes to the bundles' store. None of them is inherited from
// the shell that runs the suite: a value left on a workstation would quietly
// change what every app built here answers. A test that wants one sets it, and
// puts the environment back.
for (const name of [
  "SKRUN_LOGIN_RETURN_PATH",
  "SKRUN_LOGIN_PAGE_URL",
  "SKRUN_TERMS_URL",
  "SKRUN_PRIVACY_URL",
  "SKRUN_DOCS_URL",
  "SKRUN_DB_STATEMENT_TIMEOUT_MS",
  "SKRUN_DELETION_JOURNAL",
]) {
  delete process.env[name];
}

// The file caches extract and write under the real temp directory, and they are
// module singletons that no test empties: each test file would leave its bundle
// extractions, run output directories and uploads behind. Emptying them once the
// file's tests are done removes those directories (their eviction deletes them).
// Imported lazily so that a file that mocks one of these modules gets its mock,
// and a file that never loaded them pays nothing more than an empty cache.
afterAll(async () => {
  const { bundleCache } = await import("./src/cache/bundle-cache.js");
  const { inputCache } = await import("./src/cache/input-cache.js");
  const { _clearOutputCacheForTests } = await import("./src/cache/output-cache.js");
  bundleCache?.clear?.();
  inputCache?.clear?.();
  _clearOutputCacheForTests?.();
});
