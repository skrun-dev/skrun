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

import {
  cleanupDevNamespace,
  ROOT,
  registryLogPath,
  results,
  skrun,
  startRegistry,
  stopRegistry,
  TOKEN,
} from "./e2e/live/_ctx.js";
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
import { run as runOutputValidation } from "./e2e/live/14-output-validation.js";
import { run as runVerifyRequired } from "./e2e/live/15-verify-required.js";
import { run as runSimplifyName } from "./e2e/live/16-simplify-agent-name.js";
import { run as runMultiTenantReads } from "./e2e/live/17-multi-tenant-reads.js";
import { run as runDashboardServed } from "./e2e/live/20-dashboard-served.js";
import { run as runAgentVisibility } from "./e2e/live/21-agent-visibility.js";
import { run as runVerificationPolicy } from "./e2e/live/22-verification-policy.js";
import { run as runApiKeyScopes } from "./e2e/live/23-api-key-scopes.js";
import { run as runCreatorLlmKey } from "./e2e/live/24-creator-llm-key.js";
import { run as runDeviceLogin } from "./e2e/live/25-device-login.js";
import { run as runBaseUrlGuard } from "./e2e/live/26-base-url-guard.js";

// Phases 18 (Fly Machines API smoke) + 19 (deployed-cloud E2E) are NOT run
// here. They exercise live external infra (Fly.io / a DEPLOYED api-server),
// not the local registry this suite spins up, so a stray cloud-creds .env made
// them false-RED whenever the cloud app was offline, rejected the dev-token
// (OAuth deployments do), or pointed at a pruned image tag. They run on demand
// via `pnpm fly:smoke` (phase 18) and `pnpm cloud:e2e:smoke` (phase 19).

// --- Start registry ---
console.log("Starting registry...");
await startRegistry();
console.log("Registry OK\n");

// --- Login ---
skrun(["login", "--token", TOKEN], ROOT);

// --- Pre-flight cleanup: purge dev/* so a persistent cloud DB (DATABASE_URL)
//     doesn't carry stale agent rows whose bundles were lost with the ephemeral
//     MemoryStorage on the previous run (BUNDLE_NOT_FOUND). No-op on a fresh DB.
await cleanupDevNamespace();

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

// --- Phase 14: audit/002 output validation + tool_call_error + run.files ---
await runOutputValidation();

// --- Phase 15: per-version verify-required-before-run (#83) ---
await runVerifyRequired();

// --- Phase 16: simplify-agent-name (#84) ---
await runSimplifyName();

// --- Phase 17: multi-tenant reads — registry GET ownership gate ---
await runMultiTenantReads();

// (Phases 18 + 19 are cloud-only — see the import-block note above. Run them
//  on demand via `pnpm fly:smoke` / `pnpm cloud:e2e:smoke`.)

// --- Phase 20: operator dashboard served by the server (#93) ---
await runDashboardServed();

// --- Phase 21: agent visibility (#81) — field round-trips through registry + DB ---
await runAgentVisibility();

// --- Phase 22: verification policy (#103) — /api/me policy + admin verify round-trip ---
await runVerificationPolicy();

// --- Phase 23: API-key scopes (#65) — scoped key mint + run/pull/key-mgmt 403s ---
await runApiKeyScopes();

// --- Phase 24: creator-attached LLM keys (#102) — attach + keyless run + policy/delegated 403s ---
await runCreatorLlmKey();

// --- Phase 25: CLI device-login flow (#82) — device/code 404 fallback, consent page, poll states ---
await runDeviceLogin();

// --- Phase 26: model.base_url guard (SEC-001, audit/006) — a caller's key is not
//     sent to an endpoint the agent's author chose. Driven with a REAL delegated
//     sk_live key, because a dev-token is a master credential and would be exempt. ---
await runBaseUrlGuard();

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

// On failure, point the human at the registry log file — that's where the
// real server-side error message lives for 0ms / $0 failures.
if (failed > 0 && registryLogPath) {
  console.log(`\nRegistry log (for failure diagnostics):\n  ${registryLogPath}`);
  console.log(`  Grep for the failed agent name or 'event_failed' / 'error' to find the stack.\n`);
}

// --- Cleanup ---
stopRegistry();

process.exit(failed > 0 ? 1 : 0);
