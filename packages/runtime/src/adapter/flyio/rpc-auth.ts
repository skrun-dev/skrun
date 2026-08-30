import { timingSafeEqual } from "node:crypto";

/**
 * Whether an incoming runner-RPC request is authorized.
 *
 * Back-compat: when no `expectedToken` is configured the RPC is OPEN (returns
 * `true`). The per-run token is injected into the machine env by a patched
 * api-server, so an un-patched (rolling-deploy window) or self-host caller that
 * carries no token is not rejected — and such runners still have the egress
 * DROP, so the sandbox-to-sibling path stays closed regardless.
 *
 * When a token IS configured, the request must carry
 * `Authorization: Bearer <expectedToken>`, compared in **constant time**
 * (length-guarded — `timingSafeEqual` throws on a length mismatch).
 *
 * Pure (no Hono, no env read) so it unit-tests in isolation; the runner's Hono
 * middleware reads `process.env.RUNNER_RPC_TOKEN` and the header, then delegates
 * the decision here.
 */
export function isRpcAuthorized(
  authHeader: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true; // unset = enforcement off (back-compat)
  return bearerMatches(authHeader, expectedToken);
}

/** Shared constant-time `Authorization: Bearer <token>` comparison. */
function bearerMatches(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const presented = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** The route a runner request is addressed to, as the runner's middleware sees it. */
export type RunnerRoutePath = string;

/** Credentials the runner currently holds, read fresh on every request. */
export interface RunnerCredentials {
  /**
   * Per-machine claim credential, present ONLY on a pre-created (pooled) machine
   * and only until it is claimed. Authorises `/claim` and nothing else.
   */
  claimToken?: string;
  /** Per-run RPC bearer, installed by a successful `/claim` (or injected at create on the cold path). */
  runToken?: string;
}

/** Which lifecycle state the runner is in, derived from the credentials it holds. */
export type RunnerAuthState =
  /** Pre-created, not yet assigned to a run: only `/healthz` and an authenticated `/claim`. */
  | "pooled-unclaimed"
  /** Assigned to a run: the historical per-run-token rule. */
  | "claimed"
  /** Neither credential — a cold-path or self-host runner. The historical open-when-unset rule. */
  | "legacy";

export interface RunnerAuthDecision {
  allowed: boolean;
  state: RunnerAuthState;
  /**
   * Why a request was denied, when the distinction is worth telling the caller.
   *
   * `already-claimed` exists because "your credential is wrong" and "this machine
   * is already spoken for" call for different reactions: the first is a
   * configuration problem, the second means discard this machine and use another.
   * Collapsing both into one answer would send an operator hunting a credential
   * bug that is not there.
   */
  denial?: "unauthorized" | "already-claimed";
}

/** Open to everyone in every state — the harness polls it before it can authenticate. */
const PUBLIC_PATH = "/healthz";
/** The only route reachable on an unclaimed pooled machine, and only with the claim credential. */
const CLAIM_PATH = "/claim";

/**
 * Authorize an inbound runner-RPC request across the three lifecycle states.
 *
 * Why this exists rather than a second `isRpcAuthorized` call: a pre-created
 * ("pooled") machine has no per-run token yet, and `isRpcAuthorized` returns
 * `true` when no token is configured. Reusing it for a pooled machine would
 * therefore serve `/init` — which accepts an arbitrary bundle URL — to anything
 * that can open a socket on the private network. The state must be decided
 * explicitly, not inferred from a single token's absence.
 *
 * | state | condition | reachable |
 * |-------|-----------|-----------|
 * | `pooled-unclaimed` | claim set, run unset | `/healthz`; `/claim` with the claim credential. Everything else denied. |
 * | `claimed`          | run set              | unchanged: every route needs the run token, `/healthz` excepted. `/claim` is refused (single-use). |
 * | `legacy`           | neither set          | unchanged: open (self-host / pre-token image). `/claim` is not part of that contract, so it is denied. |
 *
 * Pure — no Hono, no env read — so the whole matrix unit-tests in isolation; the
 * runner's middleware reads `process.env` and the header, then delegates here.
 */
export function authorizeRunnerRequest(
  path: RunnerRoutePath,
  authHeader: string | undefined,
  credentials: RunnerCredentials,
): RunnerAuthDecision {
  const { claimToken, runToken } = credentials;

  // A run token takes precedence: once installed, the machine is claimed for good,
  // even if the claim credential is somehow still readable in the environment.
  if (runToken) {
    if (path === PUBLIC_PATH) return { allowed: true, state: "claimed" };
    // `/claim` is single-use: a claimed machine is never re-claimable. Denied
    // HERE rather than in the handler — the handler's own guard is unreachable
    // once a run credential exists, because this decision runs first. Reported as
    // `already-claimed` so the caller is told why, instead of being pointed at a
    // credential that is perfectly valid.
    if (path === CLAIM_PATH) {
      return { allowed: false, state: "claimed", denial: "already-claimed" };
    }
    return { allowed: bearerMatches(authHeader, runToken), state: "claimed" };
  }

  if (claimToken) {
    if (path === PUBLIC_PATH) return { allowed: true, state: "pooled-unclaimed" };
    if (path === CLAIM_PATH) {
      return { allowed: bearerMatches(authHeader, claimToken), state: "pooled-unclaimed" };
    }
    // The whole point: no other route is served before the machine is claimed.
    return { allowed: false, state: "pooled-unclaimed" };
  }

  // Neither credential — the historical contract, preserved byte for byte for
  // self-host and for any runner image predating the token. `/claim` is not part
  // of it, so it stays closed rather than inheriting the open-when-unset rule.
  if (path === CLAIM_PATH) return { allowed: false, state: "legacy" };
  return { allowed: true, state: "legacy" };
}
