import { createLogger } from "@skrun-dev/runtime";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import { PATH_SEGMENT_REGEX } from "../db/namespace.js";
import { getUser } from "../middleware/auth.js";
import { type QuotaConfig, thresholdsFor } from "../quotas/thresholds.js";
import { assertAgentVisibleOrThrow } from "../services/access.js";
import {
  assertKeyCanPushOrThrow,
  assertKeyCanReadAgentOrThrow,
  assertKeyScopeOrThrow,
  assertMasterReadOrThrow,
  assertNotDelegatedOrThrow,
  isDelegatedKey,
  isInstanceAdmin,
  isMasterCredential,
} from "../services/key-scope.js";
import type { PushLimits, RegistryService } from "../services/registry.js";
import {
  canSetVerified,
  type VerificationPolicy,
  verificationKind,
} from "../services/verification-policy.js";
import type { UserContext } from "../types.js";
import { dispatchPushError, dispatchRegistryError, requireMasterCredential } from "./_helpers.js";

const logger = createLogger("registry");

/**
 * What bounds a push by `user`, read when it arrives — like a run's
 * thresholds: the server's longest timeout, and the bundle storage of the
 * account's plan (a plan no setting names gets `free`'s, with one
 * `quota_plan_unknown` line). Every push entrypoint passes it to the service.
 */
export function pushLimits(quotaConfig: QuotaConfig, user: UserContext): PushLimits {
  const at = thresholdsFor(quotaConfig, user.plan, Date.now(), logger.child({ user_id: user.id }));
  return {
    plan: at.plan,
    maxTimeoutS: at.maxTimeoutS,
    storageBytes: at.storageBytes,
    master: isMasterCredential(user),
  };
}

/** The credential an admin attests with (`isInstanceAdmin`), as the refusal names it. */
const ADMIN_FULL_ACCESS =
  "full access (a session, the dev token, or an account-wide API key that carries every operation)";

/**
 * Agent namespace + name URL path segments (`PATH_SEGMENT_REGEX`, one
 * definition in `db/namespace.ts`). Lowercase-kebab, length ≤64.
 * Applied at the route boundary so a malformed URL never reaches the storage
 * layer where it could decode into a path-traversal sequence.
 *
 * Note: this is intentionally a touch more permissive than
 * @skrun-dev/schema's `AGENT_NAME_REGEX` (which enforces no leading/trailing
 * hyphens and no `--`). The path segment regex covers both the namespace
 * (registry-side identifier, e.g. GitHub username) AND the name (agent slug),
 * and the namespace shape isn't owned by the schema package.
 */
function validateAgentParams(c: Context, namespace: string, name: string): Response | null {
  if (!PATH_SEGMENT_REGEX.test(namespace) || !PATH_SEGMENT_REGEX.test(name)) {
    return c.json(
      {
        error: {
          code: "INVALID_AGENT_NAME",
          message: "namespace and name must be lowercase kebab-case (a-z, 0-9, hyphen, ≤64 chars).",
        },
      },
      400,
    );
  }
  return null;
}

export function createRegistryRoutes(
  service: RegistryService,
  authMiddleware: MiddlewareHandler,
  db: DbAdapter,
  verificationPolicy: VerificationPolicy,
  /** The quota settings, read once by the app: they bound every push. */
  quotaConfig: QuotaConfig,
): Hono {
  const router = new Hono();

  // Push — auth required
  router.post("/agents/:namespace/:name/push", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    const version = c.req.query("version");
    const user = getUser(c);

    if (!version) {
      return c.json(
        { error: { code: "MISSING_VERSION", message: "Query param 'version' is required" } },
        400,
      );
    }

    // Check namespace ownership
    if (namespace !== user.namespace) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to push to namespace '${namespace}'`,
          },
        },
        403,
      );
    }

    // Version notes: validate X-Skrun-Version-Notes header server-side.
    // Client percent-encodes the value so non-ASCII chars transit safely in headers.
    const rawNotes = c.req.header("X-Skrun-Version-Notes");
    let notes: string | null = null;
    if (rawNotes !== undefined && rawNotes !== "") {
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawNotes);
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_NOTES",
              message: "Version notes header is not valid percent-encoded UTF-8",
            },
          },
          400,
        );
      }
      // Length check (≤ 500 chars — checked on the decoded form, per spec)
      if (decoded.length > 500) {
        return c.json(
          {
            error: {
              code: "INVALID_NOTES",
              message: "Version notes must be 500 characters or less",
            },
          },
          400,
        );
      }
      // No null bytes
      if (decoded.includes("\x00")) {
        return c.json(
          {
            error: {
              code: "INVALID_NOTES",
              message: "Version notes must not contain null bytes",
            },
          },
          400,
        );
      }
      notes = decoded;
    }

    // API-key scope: the key must permit push; a resource-scoped key may only
    // push to its granted agents and cannot create a brand-new one. Loaded once
    // here (API keys only — session/dev-token carry no key and skip the read).
    if (user.key) {
      try {
        const existing = await db.getAgent(namespace, name);
        assertKeyCanPushOrThrow(user, existing);
      } catch (err) {
        return dispatchRegistryError(c, err);
      }
    }

    try {
      const body = await c.req.arrayBuffer();
      const buffer = Buffer.from(body);
      const metadata = await service.push(
        namespace,
        name,
        version,
        buffer,
        user.id,
        notes,
        pushLimits(quotaConfig, user),
        // A client that hangs up while its agent.yaml waits to be read leaves
        // its place in the line, never read.
        c.req.raw.signal,
      );
      return c.json(metadata);
    } catch (err) {
      return dispatchPushError(c, err);
    }
  });

  // Pull latest — auth required, 404 opaque for non-owner non-admin.
  // Ownership check fires BEFORE storage fetch: non-owner path throws
  // NOT_FOUND in `assertAgentVisibleOrThrow` and never reaches
  // `service.pull` / `storage.get`. Bundle bytes are never read on
  // ownership-404 (the non-owner pull test spies on `storage.get` to prove it).
  router.get("/agents/:namespace/:name/pull", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    try {
      const agent = await db.getAgent(namespace, name);
      assertAgentVisibleOrThrow(agent, getUser(c), namespace, name);
      // An agent's source is for a full-access credential: a reduced or a
      // delegated key pulls nothing.
      assertMasterReadOrThrow(getUser(c));
      const result = await service.pull(namespace, name, undefined, { preloadedAgent: agent });
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${name}-${result.version}.agent"`);
      c.header("X-Agent-Version", result.version);
      return c.body(new Uint8Array(result.buffer));
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Pull specific version — auth required, 404 opaque for non-owner non-admin.
  router.get("/agents/:namespace/:name/pull/:version", authMiddleware, async (c) => {
    const { namespace, name, version } = c.req.param();
    const _invalidNameV = validateAgentParams(c, namespace, name);
    if (_invalidNameV) return _invalidNameV;
    try {
      const agent = await db.getAgent(namespace, name);
      assertAgentVisibleOrThrow(agent, getUser(c), namespace, name);
      assertMasterReadOrThrow(getUser(c));
      const result = await service.pull(namespace, name, version, { preloadedAgent: agent });
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${name}-${result.version}.agent"`);
      c.header("X-Agent-Version", result.version);
      return c.body(new Uint8Array(result.buffer));
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // List — auth required, filtered by ownership unless the caller is the
  // instance administrator: role='admin' on a master credential (a session,
  // the dev-token, or an account-wide key with every operation) sees all agents
  // instance-wide. Any other caller — an administrator's reduced key included —
  // sees only agents it owns (owner_id === user.id). Anonymous → 401.
  router.get("/agents", authMiddleware, async (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const limit = Number(c.req.query("limit") ?? "20");
    const user = getUser(c);
    // A delegated key cannot enumerate the account's agents (read-confined).
    if (isDelegatedKey(user)) {
      return c.json(
        {
          error: {
            code: "KEY_SCOPE_FORBIDDEN",
            message: "This endpoint is not available to a resource-scoped API key.",
          },
        },
        403,
      );
    }
    const userId = isInstanceAdmin(user) ? undefined : user.id;
    const result = await service.list(page, limit, userId);
    return c.json({ ...result, page, limit });
  });

  // Metadata — auth required, 404 opaque for non-owner non-admin.
  // Non-owner readers get the SAME 404 body as a genuine agent-not-found —
  // existence is hidden from non-privileged callers (read-side opacity).
  router.get("/agents/:namespace/:name", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    try {
      const agent = await db.getAgent(namespace, name);
      assertAgentVisibleOrThrow(agent, getUser(c), namespace, name);
      // A delegated key may read metadata only for its in-scope agents.
      assertKeyCanReadAgentOrThrow(getUser(c), agent);
      const metadata = await service.getMetadata(namespace, name);
      return c.json(metadata);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Versions — auth required, 404 opaque for non-owner non-admin.
  router.get("/agents/:namespace/:name/versions", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    try {
      const agent = await db.getAgent(namespace, name);
      assertAgentVisibleOrThrow(agent, getUser(c), namespace, name);
      const user = getUser(c);
      assertNotDelegatedOrThrow(user);
      const versions = await service.getVersions(namespace, name);
      // The list stays readable by any key that is not delegated; the parsed
      // configuration of each version (model, tools, MCP servers, whose URLs
      // may carry a credential) is for a full-access credential only, like the
      // source `pull` hands out.
      if (isMasterCredential(user)) return c.json({ versions });
      return c.json({ versions: versions.map(({ config_snapshot: _, ...rest }) => rest) });
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Verify a specific version. The attestation authority is governed by the
  // operator verification policy (admin-only by default; the agent owner may
  // self-attest under `owner`/`disabled`). Per-version trust: each version is
  // reviewed independently, push of a new version starts at verified=false, and
  // pinned production callers keep their verified status through author
  // iteration. Promotion to admin is a manual SQL UPDATE — there is
  // intentionally no API for elevation. dev-token in self-host mode auto-grants
  // admin so the local-dev UX still works.
  router.patch("/agents/:namespace/:name/versions/:version/verify", authMiddleware, async (c) => {
    const { namespace, name, version } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    const user = getUser(c);

    // Verification authority is governed by the operator policy. Under `admin`
    // only the instance administrator (role admin on a master credential) may
    // attest — no agent read for a session or the dev-token. Under
    // `owner`/`disabled` the agent owner may attest their own agents, so load
    // the agent for its owner_id (404 if absent); `setVersionVerified` stays the
    // per-version 404 source under `admin`.
    // Load the agent when the policy needs its owner_id (owner/disabled) OR when
    // an API key needs a resource-scope check. Under `admin` policy with a
    // session/dev-token, no agent read.
    const agent =
      verificationPolicy !== "admin" || user.key != null
        ? await db.getAgent(namespace, name)
        : null;
    if (verificationPolicy !== "admin" && !agent) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Agent ${namespace}/${name} not found` } },
        404,
      );
    }
    const agentOwnerId = agent?.owner_id ?? "";

    if (!canSetVerified(verificationPolicy, user, { owner_id: agentOwnerId })) {
      // Both name the credential an admin needs: the role alone is not enough.
      const message =
        verificationPolicy === "admin"
          ? `Only an admin can verify agent versions, with ${ADMIN_FULL_ACCESS}. Promotion to admin requires a manual SQL UPDATE on the users table (see docs/self-hosting.md → Admin role).`
          : `Only the agent owner, or an admin with ${ADMIN_FULL_ACCESS}, can verify this agent's versions.`;
      return c.json({ error: { code: "FORBIDDEN", message } }, 403);
    }

    // API-key scope: verify needs `agent:verify` + (for a resource-scoped key)
    // the agent in its grants. API keys only; a missing agent 404s below.
    if (user.key && agent) {
      try {
        assertKeyScopeOrThrow(user, agent, "agent:verify");
      } catch (err) {
        return dispatchRegistryError(c, err);
      }
    }

    let body: { verified: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    if (typeof body.verified !== "boolean") {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Body must contain { verified: boolean }" } },
        400,
      );
    }

    try {
      const updated = await service.setVersionVerified(namespace, name, version, body.verified);

      // Structured log emission — forensic trail for "who verified what when".
      // The deferred audit-log UI on agent-detail will surface these events;
      // until then, operators grep pino logs for `event:agent_version_verify`.
      logger.info(
        {
          event: "agent_version_verify",
          actor: { user_id: user.id, namespace: user.namespace, role: user.role },
          target: { namespace, name, version },
          action: body.verified ? "verify" : "unverify",
          kind: verificationKind(user),
          timestamp: new Date().toISOString(),
        },
        `${user.namespace} ${body.verified ? "verified" : "unverified"} ${namespace}/${name}@${version}`,
      );

      // The answer carries the version, whose parsed configuration is for a
      // full-access credential only, like the versions list: setting the flag
      // to the value it already has would otherwise be a plain read of it.
      if (isMasterCredential(user)) return c.json(updated);
      const { config_snapshot: _, ...rest } = updated;
      return c.json(rest);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Change agent visibility — auth required, namespace owner OR admin.
  // Write-side convention (like verify/delete): announce permission denial
  // with an explicit 403 (NOT the opaque read-side 404), and return 404 only
  // when the agent genuinely doesn't exist in the caller's own namespace.
  router.patch("/agents/:namespace/:name/visibility", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    const user = getUser(c);

    // Agent-lifecycle administration requires a master credential — a delegated
    // or operation-limited key cannot change visibility / delete.
    const denied = requireMasterCredential(c);
    if (denied) return denied;

    if (namespace !== user.namespace && user.role !== "admin") {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to change visibility in namespace '${namespace}'`,
          },
        },
        403,
      );
    }

    let body: { visibility: "private" | "public" };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    if (body.visibility !== "private" && body.visibility !== "public") {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: 'Body must contain { visibility: "private" | "public" }',
          },
        },
        400,
      );
    }

    // Public visibility is disabled for now: the hosting model is
    // private-only. Reject `public` here — the column and
    // the run-authorization branch are retained for later reactivation, only the
    // set-path affordance is withheld. The ownership check above runs first, so a
    // non-owner gets 403 (no oracle that public is disabled).
    if (body.visibility === "public") {
      return c.json(
        {
          error: {
            code: "PUBLIC_VISIBILITY_DISABLED",
            message: "Public visibility is not available for now; agents are private-only.",
          },
        },
        400,
      );
    }

    try {
      const updated = await db.setVisibility(namespace, name, body.visibility);
      if (!updated) {
        return c.json(
          { error: { code: "NOT_FOUND", message: `Agent ${namespace}/${name} not found` } },
          404,
        );
      }
      logger.info(
        {
          event: "agent_visibility_change",
          actor: { user_id: user.id, namespace: user.namespace, role: user.role },
          target: { namespace, name },
          action: body.visibility,
          timestamp: new Date().toISOString(),
        },
        `${user.namespace} set ${namespace}/${name} visibility=${body.visibility}`,
      );
      return c.json(updated);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Delete a single version — auth required, namespace owner OR admin.
  // MUST be registered BEFORE the whole-agent DELETE below: Hono is first-match-wins
  // and the more-specific path with /versions/:version must be registered first to
  // guarantee future-proofing against shadowing.
  // Admin override mirrors the whole-agent DELETE — same operator scenario
  // (moderation of squatter/abusive versions across namespaces).
  router.delete("/agents/:namespace/:name/versions/:version", authMiddleware, async (c) => {
    const { namespace, name, version } = c.req.param();
    const _invalidNameV = validateAgentParams(c, namespace, name);
    if (_invalidNameV) return _invalidNameV;
    const user = getUser(c);

    const denied = requireMasterCredential(c);
    if (denied) return denied;

    if (namespace !== user.namespace && user.role !== "admin") {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to delete versions in namespace '${namespace}'`,
          },
        },
        403,
      );
    }

    try {
      await service.deleteVersion(namespace, name, version);
      return c.body(null, 204);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  // Delete whole agent — auth required, namespace owner OR admin.
  // Admin override lets operators clean up squatter/abusive agents in any
  // namespace without impersonation. Promotion to admin remains a manual
  // SQL UPDATE — there's no API for elevation.
  router.delete("/agents/:namespace/:name", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const _invalidName = validateAgentParams(c, namespace, name);
    if (_invalidName) return _invalidName;
    const user = getUser(c);

    const denied = requireMasterCredential(c);
    if (denied) return denied;

    if (namespace !== user.namespace && user.role !== "admin") {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to delete agents in namespace '${namespace}'`,
          },
        },
        403,
      );
    }

    try {
      await service.deleteAgent(namespace, name);
      return c.body(null, 204);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  return router;
}
