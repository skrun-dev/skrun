import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { attachmentDisposition, createLogger, runOutputKey } from "@skrun-dev/runtime";
import { SkrunError } from "@skrun-dev/schema";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  deleteInputFile,
  getInputFile,
  getInputRetentionSeconds,
  liveInputFilesOf,
  registerInputFile,
} from "../cache/input-cache.js";
import { getOutputDir, getOutputRunId } from "../cache/output-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import { contentTypeFor } from "../files/content-types.js";
import { resolveFileId } from "../files/file-id-resolver.js";
import { writeInputFile } from "../files/input-store.js";
import { isSafeOutputName } from "../files/output-purge.js";
import { getUser } from "../middleware/auth.js";
import { ACCOUNT_LIMIT_MESSAGE } from "../quotas/admission.js";
import { type QuotaConfig, thresholdsFor } from "../quotas/thresholds.js";
import type { RuntimeMode } from "../runtime/adapter-selection.js";
import {
  isDelegatedKey,
  isMasterCredential,
  mayReadRunFiles,
  mayUseUpload,
} from "../services/key-scope.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { UserContext } from "../types.js";

const logger = createLogger("files");

/**
 * The longest a fresh link to a cloud run's output lives, in seconds — the
 * lifetime of the links a completed run carries. A link never outlives the
 * run's deadline: past it, the object is due for deletion.
 */
export const RUN_FILE_LINK_MAX_TTL_S = 15 * 60;

export interface FilesRoutesOptions {
  /**
   * Where runs execute, and so where their output files are: in object
   * storage for a cloud run (`flyio`), in this process's temp directory for a
   * local one.
   */
  runtimeMode: RuntimeMode;
  /** The store a cloud run's outputs were uploaded to. Required on `flyio`. */
  storage?: Pick<StorageAdapter, "getPresignedDownloadUrl">;
  /** The quota settings, read once by the app: they bound an account's live uploads. */
  quotaConfig: QuotaConfig;
}

function isAllowedUploadMime(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("audio/");
}

/** What bounds the uploads of one caller, read when its upload arrives. */
interface UploadBound {
  /** The plan whose number applies, as a refusal's line names it. */
  plan: string;
  /** The live uploads the account may hold, this one's included. */
  limit: number;
  /** The caller holds a master credential: a refusal tells it the account's numbers. */
  master: boolean;
}

/**
 * The live uploads `user`'s account may hold, read for its plan — a plan no
 * setting names gets `free`'s, with one `quota_plan_unknown` line. `null`
 * when no setting bounds uploads: nothing is read then, not even the plan.
 */
function uploadBound(quotaConfig: QuotaConfig, user: UserContext): UploadBound | null {
  if (quotaConfig.perPlan.inputFiles === null) return null;
  const log = logger.child({ user_id: user.id });
  const at = thresholdsFor(quotaConfig, user.plan, Date.now(), log);
  if (at.inputFiles === null) return null;
  return { plan: at.plan, limit: at.inputFiles, master: isMasterCredential(user) };
}

/**
 * The refusal of an upload whose account already holds `bound.limit` live
 * uploads or more in this process — `429 INPUT_FILES_LIMIT_REACHED`, told to
 * wait until it holds fewer: when its oldest upload expires, or, for an account
 * holding more than its limit (its plan lowered), when enough of them have —
 * its `quota_refused` line written; or null when the account has room. The
 * account's numbers go to a master credential only; any other key is told
 * that a limit is reached, with the same wait.
 */
function refuseOverLiveUploads(c: Context, bound: UploadBound, user: UserContext): Response | null {
  const nowMs = Date.now();
  const live = liveInputFilesOf(user.id, bound.limit, nowMs);
  if (live.belowLimitAtMs === null) return null;
  logger.info(
    { event: "quota_refused", user_id: user.id, bound: "input_files", plan: bound.plan },
    "An upload was refused: its account holds as many live uploads as its plan allows",
  );
  c.header("Retry-After", String(Math.max(1, Math.ceil((live.belowLimitAtMs - nowMs) / 1000))));
  const held = `${live.count} live upload${live.count === 1 ? "" : "s"} on this account`;
  const freesAt = new Date(live.belowLimitAtMs).toISOString();
  // How many must expire, or be deleted, before a place frees: one, unless the
  // account holds more than its limit.
  const toGo = live.count - bound.limit + 1;
  const told =
    toGo === 1
      ? `${held}; your plan's limit is ${bound.limit}. The oldest expires at ${freesAt}; an upload deleted (DELETE /api/files/:id) frees its place sooner.`
      : `${held}; your plan's limit is ${bound.limit}. A place frees at ${freesAt}, once the oldest ${toGo} have expired; ${toGo} uploads deleted (DELETE /api/files/:id) free one sooner.`;
  return c.json(
    {
      error: {
        code: "INPUT_FILES_LIMIT_REACHED",
        message: bound.master ? told : ACCOUNT_LIMIT_MESSAGE,
      },
    },
    429,
  );
}

/**
 * Assert the caller may use the file behind a `file_id`. Returns null when it
 * may, or a Hono Response (403) to short-circuit.
 *
 * A full-access credential uses every file of its account; any other key —
 * delegated or reduced — only its own: every key of an account carries the
 * account's id, so the account alone cannot tell two clients of one agent apart.
 *
 * - Input files: `mayUseUpload` — the account (`owner_id`) and the key that made
 *   the upload (`uploaded_by_key_id`), both stored at upload time.
 * - Output files: `mayReadRunFiles` on the producing run — its account and the
 *   key that launched it. Output file_ids without a backing run row (legacy /
 *   expired cache) are denied.
 *
 * No refusal of the delegated key here: a client reads the outputs of its own
 * run by this route.
 */
async function assertFileOwnership(
  c: Context,
  db: DbAdapter,
  fileId: string,
): Promise<Response | null> {
  const user = getUser(c);

  const input = getInputFile(fileId);
  if (input) {
    if (!mayUseUpload(user, input)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this file",
          },
        },
        403,
      );
    }
    return null;
  }

  // Output side — look up the producing run: its account, and its key.
  const runId = getOutputRunId(fileId);
  if (runId) {
    const run = await db.getRun(runId);
    // run.user_id is nullable (SET NULL after parent delete). Treat null as
    // "no longer owned" → refuse rather than expose orphans across tenants.
    if (!run || !mayReadRunFiles(user, run)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this file",
          },
        },
        403,
      );
    }
    return null;
  }

  // file_id is unknown to both indexes — let the downstream handler return its
  // own 404. Returning null here means "no ownership conflict; continue".
  return null;
}

export function createFilesRoutes(
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  opts: FilesRoutesOptions,
): Hono {
  const router = new Hono();
  const linkStorage = opts.storage;
  if (opts.runtimeMode === "flyio" && !linkStorage) {
    throw new Error(
      'createFilesRoutes: the runtime mode "flyio" needs the store its runs upload outputs to.',
    );
  }

  router.post("/files", authMiddleware, async (c) => {
    const user = getUser(c);
    // An account at its plan's live uploads is refused before its body is read.
    const bound = uploadBound(opts.quotaConfig, user);
    if (bound) {
      const refused = refuseOverLiveUploads(c, bound, user);
      if (refused) return refused;
    }

    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_MULTIPART",
            message: "Could not parse multipart/form-data body",
          },
        },
        400,
      );
    }

    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json(
        {
          error: {
            code: "MISSING_FILE",
            message: "Multipart field 'file' is required and must be a binary upload",
          },
        },
        400,
      );
    }

    const mediaType = file.type || "application/octet-stream";
    if (!isAllowedUploadMime(mediaType)) {
      return c.json(
        {
          error: {
            code: "MIME_NOT_ALLOWED",
            message: `Media type '${mediaType}' is not in the allowed upload classes (image/*, application/pdf, audio/*). Strict per-agent mime validation happens at /run.`,
          },
        },
        415,
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    // Again, now that the body is read: another upload of the account may have
    // taken the last place meanwhile. Nothing is awaited from here to the
    // registration, so two uploads in flight at once cannot both take it.
    if (bound) {
      const refused = refuseOverLiveUploads(c, bound, user);
      if (refused) return refused;
    }

    let writeResult: ReturnType<typeof writeInputFile>;
    try {
      writeResult = writeInputFile(bytes);
    } catch (err) {
      if (err instanceof SkrunError && err.code === "FILE_TOO_LARGE") {
        return c.json({ error: { code: "FILE_TOO_LARGE", message: err.message } }, 413);
      }
      throw err;
    }

    const expiresAt = new Date(Date.now() + getInputRetentionSeconds() * 1000);
    registerInputFile(writeResult.file_id, {
      path: writeResult.path,
      size: writeResult.size,
      media_type: mediaType,
      purpose: "input",
      expires_at: expiresAt,
      owner_id: user.id,
      uploaded_by_key_id: user.key?.id ?? null,
    });

    return c.json(
      {
        file_id: writeResult.file_id,
        size: writeResult.size,
        media_type: mediaType,
        purpose: "input" as const,
        expires_at: expiresAt.toISOString(),
      },
      201,
    );
  });

  router.get("/files/:id", authMiddleware, async (c) => {
    const { id } = c.req.param();
    const ownership = await assertFileOwnership(c, db, id);
    if (ownership) return ownership;
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }
    return c.json({
      file_id: id,
      size: resolved.metadata.size,
      media_type: resolved.metadata.media_type,
      purpose: resolved.metadata.purpose,
      expires_at: resolved.metadata.expires_at?.toISOString(),
    });
  });

  router.get("/files/:id/content", authMiddleware, async (c) => {
    const { id } = c.req.param();
    const ownership = await assertFileOwnership(c, db, id);
    if (ownership) return ownership;
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }

    if (!existsSync(resolved.path)) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File data missing on disk for '${id}'`,
          },
        },
        404,
      );
    }

    // A download, never a page: served inline on the API's origin, an output
    // typed text/html or image/svg+xml would run as that origin.
    const content = readFileSync(resolved.path);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": resolved.metadata.media_type,
        "Content-Disposition": attachmentDisposition(resolved.name),
        "Content-Length": String(content.length),
      },
    });
  });

  router.delete("/files/:id", authMiddleware, async (c) => {
    const { id } = c.req.param();
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }
    if (resolved.metadata.purpose === "output") {
      return c.json(
        {
          error: {
            code: "DELETE_OUTPUT_FORBIDDEN",
            message: "Output files are produced by agents and cannot be deleted by callers",
          },
        },
        403,
      );
    }
    // Enforce ownership before deleting a caller-uploaded input file — mirrors
    // the GET handlers. Without this, any authenticated caller could delete
    // another tenant's input file by id (cross-user deletion / IDOR).
    const ownership = await assertFileOwnership(c, db, id);
    if (ownership) return ownership;
    deleteInputFile(id);
    return c.body(null, 204);
  });

  router.get("/runs/:run_id/files/:filename", authMiddleware, async (c) => {
    const { run_id, filename } = c.req.param();

    // A resource-scoped (delegated) key cannot read a run's output files.
    if (isDelegatedKey(getUser(c))) {
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

    // Verify the caller may read the run's files before serving any byte: a
    // full-access credential, any run of its account; any other key, only the
    // runs it launched itself.
    const run = await db.getRun(run_id);
    // Opaque 404: a non-owner gets the same "not found" as a non-existent run,
    // so they cannot tell "exists but not yours" from "does not exist" (aligns
    // run-file reads with the registry's 404-opaque reads).
    if (!run || !mayReadRunFiles(getUser(c), run)) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `Run ${run_id} not found or expired` } },
        404,
      );
    }

    const dir = getOutputDir(run_id);
    if (!dir) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `Run ${run_id} not found or expired` } },
        404,
      );
    }

    const filePath = join(dir, filename);

    // Path traversal protection
    if (!resolve(filePath).startsWith(resolve(dir) + sep)) {
      return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found" } }, 404);
    }

    if (!existsSync(filePath)) {
      return c.json(
        { error: { code: "FILE_NOT_FOUND", message: `File "${filename}" not found` } },
        404,
      );
    }

    const content = readFileSync(filePath);

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(filename),
        "Content-Disposition": attachmentDisposition(filename),
        "Content-Length": String(content.length),
      },
    });
  });

  /**
   * A fresh download link for one of a run's output files: `{ url, expires_at }`.
   *
   * The checks are the run-scoped route's: a delegated key is refused (403), and
   * a run the caller may not read — another account's, or, for a key without
   * full access, one it did not launch — answers the same opaque 404 as a
   * missing one.
   *
   * The name is the router's decoding of the path segment — once, nothing more —
   * and must be, exactly, one of the names the run's row lists: no normalising,
   * no second decoding, no case folding. It must also be a name the output purge
   * would act on (`isSafeOutputName`, the one definition). Only then is a key
   * built, `runOutputKey(run, name)`: the very key the upload wrote. A name is
   * never normalised: `a/../b` and `b` are two names, and comparing a normalised
   * one would presign a key no upload wrote. (A key with a `..` segment reaches
   * the store as it is, and R2 and MinIO refuse it rather than resolve it — not
   * a property to build on: the name rule turns such a name away first, here
   * and at the upload.) Anything else is `404 FILE_NOT_FOUND`, and nothing is
   * presigned.
   *
   * Cloud (`flyio`): a URL presigned with an attachment disposition, valid for
   * at most `RUN_FILE_LINK_MAX_TTL_S` and never past the run's deadline; once
   * the deadline has passed, or the purge has marked the run, `410 FILE_EXPIRED`.
   * Local: the run-scoped route of this API — same origin, it needs the caller's
   * credentials, and it has no expiry of its own (`expires_at: null`) — while
   * the run's outputs are kept; once they are gone, `410 FILE_EXPIRED`.
   *
   * A link is a bearer credential on the cloud runtime: never cached.
   */
  router.get("/runs/:run_id/files/:filename/link", authMiddleware, async (c) => {
    const { run_id, filename } = c.req.param();
    c.header("Cache-Control", "no-store");

    if (isDelegatedKey(getUser(c))) {
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

    const run = await db.getRun(run_id);
    if (!run || !mayReadRunFiles(getUser(c), run)) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `Run ${run_id} not found or expired` } },
        404,
      );
    }

    const listed = (run.files ?? []).some((file) => file.name === filename);
    if (!listed || !isSafeOutputName(filename)) {
      return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found" } }, 404);
    }

    const expired = () =>
      c.json(
        {
          error: {
            code: "FILE_EXPIRED",
            message: `The output files of run ${run_id} are no longer kept`,
          },
        },
        410,
      );

    if (opts.runtimeMode === "flyio" && linkStorage) {
      const now = Date.now();
      const deadline = run.purge_after === null ? Number.NaN : Date.parse(run.purge_after);
      const remainingS = Math.floor((deadline - now) / 1000);
      if (run.outputs_purged_at !== null || !(remainingS >= 1)) return expired();
      const expiresIn = Math.min(RUN_FILE_LINK_MAX_TTL_S, remainingS);
      const url = await linkStorage.getPresignedDownloadUrl(
        runOutputKey(run_id, filename),
        expiresIn,
        { contentDisposition: attachmentDisposition(filename) },
      );
      return c.json({ url, expires_at: new Date(now + expiresIn * 1000).toISOString() }, 200);
    }

    if (!getOutputDir(run_id)) return expired();
    return c.json(
      {
        url: `/api/runs/${encodeURIComponent(run_id)}/files/${encodeURIComponent(filename)}`,
        expires_at: null,
      },
      200,
    );
  });

  return router;
}
