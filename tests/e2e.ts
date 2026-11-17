/**
 * E2E live test script — tests demo agents + Phase 2 features against a real LLM.
 *
 * Prerequisites:
 *   1. Copy .env.example to .env and set at least GOOGLE_API_KEY
 *   2. Run: pnpm test:e2e:live
 *
 * The script will:
 *   - Auto-start the registry (kills existing process on port 4000)
 *   - Sign the CLI in to it from a profile of its own, never the developer's
 *     configuration
 *   - Patch each agent to dev/ namespace + google provider
 *   - Build and push each agent
 *   - POST /run and verify the response
 *   - Test caller-provided LLM keys
 *   - Test agent verification (an unverified version refused under the default policy)
 *   - Test seo-audit stateful behavior (2 runs)
 *   - Restart the registry with quotas set for one phase (an account's seats and
 *     compute window), then restart it without them
 *   - Run a three-step tool chain on every model choice and demo model whose
 *     provider key is set (the others are skipped, and say so)
 *   - Run an agent whose tool returns more than a tool's result may be, and read
 *     the cut in its tool_result event
 *   - Read the instance's links the dashboard shows (GET /api/instance), and
 *     its 401 with no credential
 *   - Restart the registry with local model endpoints allowed for one phase,
 *     whose agent declares a fake endpoint in model.base_url that crosses each
 *     bound on what a model returns - one line per code, the code printed -,
 *     then restart it as the other phases know it
 *   - On Postgres only, restart the registry with a one-second bound on each
 *     statement it sends its database, hold a key's row from a connection of
 *     the phase's own, and read the 503 DATABASE_TIMEOUT the key's revocation
 *     gets - then restart it as the other phases know it
 *   - Restore original agent.yaml files
 *   - Auto-stop the registry
 *   - Print a summary
 */

import {
  cleanupDevNamespace,
  registryLogPath,
  results,
  signInCli,
  startRegistry,
  stopRegistry,
  toolLoopModels,
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
import { run as runRunBoundary } from "./e2e/live/27-run-boundary.js";
import { run as runAuthorPath } from "./e2e/live/28-author-path.js";
import { run as runToolLoop } from "./e2e/live/29-tool-loop.js";
import { run as runAccountDeletion } from "./e2e/live/30-account-deletion.js";
import { run as runQuotas } from "./e2e/live/31-quotas.js";
import { run as runToolResultCut } from "./e2e/live/32-tool-result-cut.js";
import { run as runInstanceLinks } from "./e2e/live/33-instance-links.js";
import { run as runModelBounds } from "./e2e/live/34-model-bounds.js";
import { run as runDatabaseTimeout } from "./e2e/live/35-database-timeout.js";

/**
 * Runs one phase. An error it throws (a push that failed for another reason than
 * "already there" or "rate-limited", for instance) becomes one FAIL line and the
 * suite goes on, so the summary and the registry log path still print.
 */
async function guarded(name: string, phase: () => Promise<void>): Promise<void> {
  try {
    await phase();
  } catch (err) {
    results.push({
      agent: name,
      feature: "the phase threw before its checks finished",
      passed: false,
      duration: 0,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

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

// --- Login: `skrun login --registry REGISTRY --token TOKEN`, in the suite's own
//     profile (never the developer's configuration), checked by `whoami` and
//     the profile's sign-in file - one line. The profile is removed at exit ---
await guarded("signInCli", signInCli);

// --- Pre-flight cleanup: purge dev/* so a persistent cloud DB (DATABASE_URL)
//     doesn't carry stale agent rows whose bundles were lost with the ephemeral
//     MemoryStorage on the previous run (BUNDLE_NOT_FOUND). No-op on a fresh DB.
await cleanupDevNamespace();

// --- Phase 01: demo agents ---
await guarded("runDemos", runDemos);

// --- Phase 02: caller-provided LLM keys ---
await guarded("runCallerKeys", runCallerKeys);

// --- Phase 03: agent verification ---
await guarded("runVerification", runVerification);

// --- Phase 04: streaming (SSE + webhook) ---
await guarded("runStreaming", runStreaming);

// --- Phase 05: SDK ---
await guarded("runSdk", runSdk);

// --- Phase 06: version pinning (#7) ---
await guarded("runVersionPin", runVersionPin);

// --- Phase 07: environment override (#9 + #11) ---
await guarded("runEnvironment", runEnvironment);

// --- Phase 08: Files API (#12) ---
await guarded("runFilesApi", runFilesApi);

// --- Phase 09: auth (GET /api/me + GET /login) ---
await guarded("runAuth", runAuth);

// --- Phase 10: version notes via --message (#14c) ---
await guarded("runVersionNotes", runVersionNotes);

// --- Phase 11: multimodal direct router calls (#56) ---
await guarded("runMultimodal", runMultimodal);

// --- Phase 12: tool-choice directives (#58) ---
await guarded("runToolChoice", runToolChoice);

// --- Phase 13: prompt-caching (#68) ---
await guarded("runPromptCaching", runPromptCaching);

// --- Phase 14: audit/002 output validation + tool_call_error + run.files ---
await guarded("runOutputValidation", runOutputValidation);

// --- Phase 15: per-version verify-required-before-run (#83) ---
await guarded("runVerifyRequired", runVerifyRequired);

// --- Phase 16: simplify-agent-name (#84) ---
await guarded("runSimplifyName", runSimplifyName);

// --- Phase 17: multi-tenant reads — registry GET ownership gate ---
await guarded("runMultiTenantReads", runMultiTenantReads);

// (Phases 18 + 19 are cloud-only — see the import-block note above. Run them
//  on demand via `pnpm fly:smoke` / `pnpm cloud:e2e:smoke`.)

// --- Phase 20: operator dashboard served by the server (#93) ---
await guarded("runDashboardServed", runDashboardServed);

// --- Phase 21: agent visibility (#81) — field round-trips through registry + DB ---
await guarded("runAgentVisibility", runAgentVisibility);

// --- Phase 22: verification policy (#103) — /api/me policy + admin verify round-trip ---
await guarded("runVerificationPolicy", runVerificationPolicy);

// --- Phase 23: API-key scopes (#65) — scoped key mint + run/pull/key-mgmt 403s ---
await guarded("runApiKeyScopes", runApiKeyScopes);

// --- Phase 24: creator-attached LLM keys (#102) — attach + keyless run + policy/delegated 403s ---
await guarded("runCreatorLlmKey", runCreatorLlmKey);

// --- Phase 25: CLI device-login flow (#82) — device/code 404 fallback, consent page, poll states ---
await guarded("runDeviceLogin", runDeviceLogin);

// --- Phase 26: model.base_url guard (SEC-001, audit/006) — a caller's key is not
//     sent to an endpoint the agent's author chose. Driven with a REAL delegated
//     API key, because a dev-token is a master credential and would be exempt. ---
await guarded("runBaseUrlGuard", runBaseUrlGuard);

// --- Phase 27: run boundary - rate-limit headers on the real routes, key expiry ---
await guarded("runRunBoundary", runRunBoundary);

// --- Phase 28: the author's path through the real CLI - a retired field's
//     warning, the post-push note, a run with the author's own key, and a run
//     refused before it starts when no model key exists ---
await guarded("runAuthorPath", runAuthorPath);

// --- Phase 31: an account's seats and compute window, on a registry started
//     again with quotas set - and started again without them, whatever
//     happens - with a dev token of its own. The restart loses the bundles
//     pushed so far: the phases after it push their own. ---
await guarded("runQuotas", runQuotas);

// --- Phase 29: a three-step tool chain only a remembered turn can finish, on
//     every model choice and on the demos' models - one line per model, a
//     skip for each one whose key is not set ---
await guarded("runToolLoop", async () => runToolLoop(await toolLoopModels()));

// --- Phase 30: deleting an account - by itself, then by an administrator - on
//     the registry's own database, with dev tokens of its own (never the
//     suite's): what is gone, and the run that stays cleared and detached ---
await guarded("runAccountDeletion", runAccountDeletion);

// --- Phase 32: a tool result larger than the bound, on the local runtime -
//     the one it requires, since the cut it reads is the agent loop's own (a
//     registry on the cloud runtime fails it): the tool_result event carries
//     the result cut with its marker, and the run completes. Pushes its own
//     fixture ---
await guarded("runToolResultCut", runToolResultCut);

// --- Phase 33: the instance's links the dashboard reads - GET /api/instance
//     with the suite's token, its shape and its three values printed, and 401
//     with no credential. Pushes nothing ---
await guarded("runInstanceLinks", runInstanceLinks);

// --- Phase 34: the bounds on what a model returns, on a registry started again
//     with local model endpoints allowed - and started again as the other
//     phases know it, whatever happens: an agent whose model.base_url is a fake
//     endpoint in this process, run four times, each crossing one bound - one
//     line per code, the code printed. Pushes its own agent, calls no model of
//     a provider ---
await guarded("runModelBounds", runModelBounds);

// --- Phase 35: a request whose database does not answer in time, on a
//     registry started again with a one-second bound on each statement - and
//     started again without it, whatever happens: a key minted with the
//     suite's token, its row held by a connection of the phase's own, and its
//     revocation answered 503 DATABASE_TIMEOUT - status, code, Retry-After and
//     the wait printed -, then revoked for good once the row is released. On
//     Postgres only: on SQLite, one SKIP line. Pushes nothing, calls no model ---
await guarded("runDatabaseTimeout", runDatabaseTimeout);

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
