import { createLogger } from "@skrun-dev/runtime";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { sessionCookieErasures } from "../auth/session.js";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import { DEFAULT_PLAN } from "../quotas/thresholds.js";
import {
  type AccountDeletionOutcome,
  type AccountDeletionRoute,
  deleteAccount,
} from "../services/account-deletion.js";
import type { DeletionJournal } from "../services/deletion-journal.js";
import { isDelegatedKey } from "../services/key-scope.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { requireMasterCredential } from "./_helpers.js";

/**
 * Deleting an account, over HTTP.
 *
 * `DELETE /api/account` deletes the caller's own account. It takes a master
 * credential — a session, a dev-token, or an account-wide key with every
 * operation — and a JSON body `{"confirm": "<username>"}`. The body is not a
 * formality for a browser: a mutation carried by the session cookie alone
 * needs a JSON `Content-Type` to pass the CSRF guard, and the confirmation
 * gives it one. A dev-token whose account could not be recorded has no row to
 * delete: `404`.
 *
 * `DELETE /api/admin/accounts/:id` deletes another account, by its internal
 * id, for an instance administrator. The checks run in an order chosen so that
 * a caller learns only what it is entitled to:
 *   1. not an administrator, or a delegated key → `404`, the body every admin
 *      route answers such a caller with: nothing says the route exists;
 *   2. an id that is not a UUID → the same `404`, before anything is read
 *      (every backend mints ids with randomUUID(); Postgres would refuse to
 *      compare anything else with an id and turn the read into a `500`);
 *   3. an administrator without a master credential → `403`;
 *   4. no confirmation → `400`;
 *   5. no such account → `404`;
 *   6. a confirmation that is not that account's username → `400`: the id
 *      and the name must designate the same account.
 * The session cookie is left alone when the caller is someone else. An
 * administrator may delete their own account this way — the last one
 * included — and then loses it, as on the self route.
 *
 * The deletion itself — what goes, in which order, what a failure leaves — is
 * the service's (`services/account-deletion.ts`); this module maps its outcome
 * to a status. `503 STORAGE_UNAVAILABLE` means an object could not be deleted
 * — or, when the operator keeps a deletion journal, the deletion could not be
 * recorded there —: the account still exists and the same request, made again,
 * resumes.
 *
 * `PUT /api/admin/accounts/:id/plan` assigns another account's plan — the
 * name its quota thresholds are read under — for an instance administrator,
 * with a JSON body `{"plan": "<name>"}`. The deletion's first three checks, in
 * its order; then a plan the quota settings name, compared trimmed and in lower
 * case — anything else, an absent plan included, is `400 UNKNOWN_PLAN`, which
 * names the known plans (a typo never creates a plan); then the account's
 * existence (`404`). The plan is written in lower case, one
 * `account_plan_changed` line names the administrator's and the account's
 * internal ids and the two plans, and the account's next run reads it.
 */

export interface AccountRoutesStorage {
  /** The store bundles are pushed to — the one the app was built with. */
  bundleStorage: StorageAdapter;
  /** The store a cloud run's outputs are uploaded to; absent on other runtimes. */
  outputStorage?: StorageAdapter;
  /** The deletion journal, when the operator keeps one; absent, nothing is recorded. */
  deletionJournal?: DeletionJournal;
}

/** What the plan route needs of the quota settings: the plans they name — the default plan always among them. */
export interface AccountRoutesPlans {
  knownPlans: ReadonlySet<string>;
}

const log = createLogger("account");

const notFound = { error: { code: "NOT_FOUND", message: "Not found" } } as const;

/** The shape of every id a backend mints (randomUUID()). */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `confirm` field of a JSON body, or `null` when there is none: no body,
 * a body that is not JSON, not an object, or a `confirm` that is not a string.
 */
async function readConfirmation(c: Context): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const confirm = (body as { confirm?: unknown }).confirm;
  return typeof confirm === "string" ? confirm : null;
}

/**
 * Every name the session cookie can carry, as the sign-out erases them: the
 * session rows are gone with the account, the browser's copy goes too.
 */
function eraseSessionCookie(c: Context): void {
  for (const { name, options } of sessionCookieErasures()) {
    setCookie(c, name, "", options);
  }
}

function confirmationMismatch(c: Context, message: string): Response {
  return c.json({ error: { code: "CONFIRMATION_MISMATCH", message } }, 400);
}

/**
 * The `plan` field of a JSON body, trimmed and in lower case, or `null` when
 * there is none: no body, a body that is not JSON, not an object, or a `plan`
 * that is not a string.
 */
async function readPlan(c: Context): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const field = (body as { plan?: unknown }).plan;
  return typeof field === "string" ? field.trim().toLowerCase() : null;
}

/** The plans the settings name, the default first, the others in alphabetical order. */
function plansNamed(knownPlans: ReadonlySet<string>): string {
  const others = [...knownPlans].filter((name) => name !== DEFAULT_PLAN).sort();
  return [DEFAULT_PLAN, ...others].join(", ");
}

export function createAccountRoutes(
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  storage: AccountRoutesStorage,
  plans: AccountRoutesPlans,
): Hono {
  const router = new Hono();

  const run = (userId: string, confirm: string, route: AccountDeletionRoute) =>
    deleteAccount(
      {
        db,
        bundleStorage: storage.bundleStorage,
        outputStorage: storage.outputStorage,
        journal: storage.deletionJournal,
      },
      { userId, confirm, route },
    );

  /** The answers both routes share: a mismatch, a store that failed. */
  const sharedRefusal = (
    c: Context,
    outcome: AccountDeletionOutcome,
    mismatchMessage: string,
  ): Response | null => {
    if (outcome.status === "confirmation_mismatch") return confirmationMismatch(c, mismatchMessage);
    if (outcome.status === "storage_unavailable") {
      return c.json(
        {
          error: {
            code: "STORAGE_UNAVAILABLE",
            message:
              "Object storage could not be reached. The account still exists, and some of its " +
              "stored objects may already be deleted; send the same request again to finish.",
          },
        },
        503,
      );
    }
    return null;
  };

  const SELF_CONFIRM =
    'Send {"confirm": "<your username>"} as the JSON body to delete your account.';

  router.delete("/account", authMiddleware, async (c) => {
    const forbidden = requireMasterCredential(c);
    if (forbidden) return forbidden;
    const user = getUser(c);
    // A dev-token whose account could not be recorded: no row behind the id.
    if (user.syntheticAccount) {
      return c.json({ error: { code: "NOT_FOUND", message: "This account has no record." } }, 404);
    }
    const confirm = await readConfirmation(c);
    if (confirm === null) return confirmationMismatch(c, SELF_CONFIRM);

    const outcome = await run(user.id, confirm, "self");
    const refusal = sharedRefusal(c, outcome, SELF_CONFIRM);
    if (refusal) return refusal;
    // Gone meanwhile: another deletion of the same account committed first.
    if (outcome.status === "not_found") return c.json(notFound, 404);

    eraseSessionCookie(c);
    return c.json({ deleted: true });
  });

  const ADMIN_CONFIRM =
    'Send {"confirm": "<username of that account>"} as the JSON body to delete this account.';

  router.delete("/admin/accounts/:id", authMiddleware, async (c) => {
    const user = getUser(c);
    // The same opaque answer as every admin route gives a caller who is not one.
    if (isDelegatedKey(user) || user.role !== "admin") return c.json(notFound, 404);
    const id = c.req.param("id");
    if (!ACCOUNT_ID.test(id)) return c.json(notFound, 404);
    const forbidden = requireMasterCredential(c);
    if (forbidden) return forbidden;
    const confirm = await readConfirmation(c);
    if (confirm === null) return confirmationMismatch(c, ADMIN_CONFIRM);

    const outcome = await run(id, confirm, "admin");
    const refusal = sharedRefusal(c, outcome, ADMIN_CONFIRM);
    if (refusal) return refusal;
    if (outcome.status === "not_found") return c.json(notFound, 404);
    // Their own account: the id is a UUID, compared as the database compares it.
    if (id.toLowerCase() === user.id.toLowerCase()) eraseSessionCookie(c);
    return c.json({ deleted: true });
  });

  router.put("/admin/accounts/:id/plan", authMiddleware, async (c) => {
    const user = getUser(c);
    // The deletion's order: nothing tells a caller who is not an administrator that the route exists.
    if (isDelegatedKey(user) || user.role !== "admin") return c.json(notFound, 404);
    const id = c.req.param("id");
    if (!ACCOUNT_ID.test(id)) return c.json(notFound, 404);
    const forbidden = requireMasterCredential(c);
    if (forbidden) return forbidden;
    const asked = await readPlan(c);
    if (asked === null || !plans.knownPlans.has(asked)) {
      const known = plansNamed(plans.knownPlans);
      return c.json(
        {
          error: {
            code: "UNKNOWN_PLAN",
            message:
              asked === null
                ? `Send {"plan": "<name>"} as the JSON body. Known plans: ${known}.`
                : `Unknown plan "${asked}". Known plans: ${known}.`,
          },
        },
        400,
      );
    }

    const target = await db.getUserById(id);
    if (!target) return c.json(notFound, 404);
    // Taken before the write: a store may hand back the very row it updates.
    const from = target.plan ?? null;
    // Read again by every run that follows: no cache holds the plan.
    const after = await db.updateUser(id, { plan: asked });
    // Gone meanwhile: a deletion of the account committed first.
    if (!after) return c.json(notFound, 404);
    log.info(
      { event: "account_plan_changed", actor_id: user.id, user_id: id, from, to: asked },
      "An administrator assigned an account's plan",
    );
    return c.json({ id, plan: asked });
  });

  return router;
}
