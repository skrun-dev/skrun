import { afterAll } from "vitest";

// The suite drives the real app in process: its file caches extract and write
// under the real temp directory, and they are module singletons nothing empties.
// Emptying them once a file's tests are done removes those directories (their
// eviction deletes them), so the suite leaves nothing behind.
afterAll(async () => {
  const { bundleCache } = await import("../../packages/api/src/cache/bundle-cache.js");
  const { inputCache } = await import("../../packages/api/src/cache/input-cache.js");
  const { _clearOutputCacheForTests } = await import(
    "../../packages/api/src/cache/output-cache.js"
  );
  bundleCache?.clear?.();
  inputCache?.clear?.();
  _clearOutputCacheForTests?.();
});
