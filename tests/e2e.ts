/**
 * E2E live test script — tests demo agents + Phase 2 features against a real LLM.
 *
 * Prerequisites:
 *   1. Copy .env.example to .env and set at least GOOGLE_API_KEY
 *   2. Run: pnpm test:e2e:live
 *
 * The script will:
 *   - Auto-start the registry (kills existing process on port 4000)
 *   - Patch each agent to dev/ namespace + google provider
 *   - Build and push each agent
 *   - POST /run and verify the response
 *   - Test caller-provided LLM keys
 *   - Test agent verification (script blocking, dev-token bypass)
 *   - Test seo-audit stateful behavior (2 runs)
 *   - Restore original agent.yaml files
 *   - Auto-stop the registry
 *   - Print a summary
 */

import { ROOT, results, skrun, startRegistry, stopRegistry, TOKEN } from "./e2e/live/_ctx.js";
import { run as runDemos } from "./e2e/live/01-demos.js";
import { run as runCallerKeys } from "./e2e/live/02-caller-keys.js";
import { run as runVerification } from "./e2e/live/03-verification.js";
import { run as runStreaming } from "./e2e/live/04-streaming.js";
import { run as runSdk } from "./e2e/live/05-sdk.js";
import { run as runVersionPin } from "./e2e/live/06-version-pin.js";
import { run as runEnvironment } from "./e2e/live/07-environment.js";
import { run as runFilesApi } from "./e2e/live/08-files-api.js";
import { run as runAuth } from "./e2e/live/09-auth.js";
import { run as runVersionNotes } from "./e2e/live/10-version-notes.js";
import { run as runMultimodal } from "./e2e/live/11-multimodal.js";
import { run as runToolChoice } from "./e2e/live/12-tool-choice.js";
import { run as runPromptCaching } from "./e2e/live/13-prompt-caching.js";

// --- Start registry ---
console.log("Starting registry...");
await startRegistry();
console.log("Registry OK\n");

// --- Login ---
skrun(["login", "--token", TOKEN], ROOT);

// --- Phase 01: demo agents ---
await runDemos();

// --- Phase 02: caller-provided LLM keys ---
await runCallerKeys();

// --- Phase 03: agent verification ---
await runVerification();

// --- Phase 04: streaming (SSE + webhook) ---
await runStreaming();

// --- Phase 05: SDK ---
await runSdk();

// --- Phase 06: version pinning (#7) ---
await runVersionPin();

// --- Phase 07: environment override (#9 + #11) ---
await runEnvironment();

// --- Phase 08: Files API (#12) ---
await runFilesApi();

// --- Phase 09: auth (GET /api/me + GET /login) ---
await runAuth();

// --- Phase 10: version notes via --message (#14c) ---
await runVersionNotes();

// --- Phase 11: multimodal direct router calls (#56) ---
await runMultimodal();

// --- Phase 12: tool-choice directives (#58) ---
await runToolChoice();

// --- Phase 13: prompt-caching (#68) ---
await runPromptCaching();

// --- Summary ---
console.log(`\n${"=".repeat(70)}`);
console.log("E2E TEST RESULTS");
console.log("=".repeat(70));

let passed = 0;
let failed = 0;

for (const r of results) {
  const icon = r.passed ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
  console.log(`${icon} ${r.agent} — ${r.feature}`);
  console.log(`       ${r.detail} | ${r.duration}ms | $${r.cost.toFixed(4)}`);
  if (r.passed) passed++;
  else failed++;
}

console.log(`\n${"-".repeat(70)}`);
console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
console.log("-".repeat(70));

// --- Cleanup ---
stopRegistry();

process.exit(failed > 0 ? 1 : 0);
