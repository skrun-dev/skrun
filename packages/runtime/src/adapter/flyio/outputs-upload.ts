// Outputs-upload helper — pulls the file manifest from a runner via
// `POST /outputs/collect`, fetches each file's bytes via
// `GET /outputs/file?path=X`, sync-uploads them to R2 / MinIO via the
// storage adapter, then returns `FileInfo[]` with presigned GET URLs for
// the `run_complete` event.
//
// Lives on the HARNESS side per the cloud-runtime spec: the sandbox runner
// holds no R2 credentials. The harness pulls bytes, uploads to its own
// storage, and presigns. Outputs upload is synchronous — `run_complete`
// is not emitted until every file is in R2 and reachable.

import type { FileInfo } from "../../types.js";
import type { PresignedStorageAdapter } from "./adapter.js";

/** TTL (seconds) for the presigned GET URLs embedded in `run_complete` events. */
const OUTPUTS_PRESIGNED_TTL_S = 15 * 60;

/** Per-file fetch timeout when pulling bytes from the runner. */
const PULL_FILE_TIMEOUT_MS = 60_000;

export interface OutputManifestEntry {
  /** Path relative to `/mnt/session/outputs` inside the runner. */
  path: string;
  size: number;
  mimeType: string;
}

export interface OutputsUploadOptions {
  /** Stable run identifier — used in the R2 key namespace. */
  runId: string;
  /** Runner HTTP base URL (`http://[fdaa:...]:9000`). */
  runnerBaseUrl: string;
  /** Storage adapter that does the actual PUT to R2/MinIO. */
  storage: PresignedStorageAdapter;
  /** Injectable fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Per-run RPC bearer token (SEC-2026-002). When set, sent as
   * `Authorization: Bearer <token>` on `/outputs/collect` + `/outputs/file` so
   * the runner's RPC middleware accepts the harness's outputs pull. Unset →
   * no header (back-compat with a runner that does not enforce the token).
   */
  token?: string;
  /** Override the presigned-URL TTL for the returned FileInfo entries. */
  presignedTtlSeconds?: number;
  /** Override the per-file pull timeout. */
  pullTimeoutMs?: number;
}

/**
 * Pull the manifest from the runner, then sync-upload each file to R2.
 *
 * Returns `FileInfo[]` ready to embed in the `run_complete` event. Each
 * entry carries `name`, `size`, and a presigned `url` for direct GET by
 * the caller. The full set of paths is uploaded under
 * `runs/{runId}/outputs/{relative-path}` in R2.
 *
 * Failure modes:
 * - Manifest fetch fails → throw (the run cannot complete cleanly).
 * - Single file fetch / upload fails → throw with the offending path in the
 *   message (partial uploads are NOT rolled back; the harness destroys
 *   the machine anyway, so re-upload requires a fresh run).
 */
export async function uploadOutputs(opts: OutputsUploadOptions): Promise<FileInfo[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const ttl = opts.presignedTtlSeconds ?? OUTPUTS_PRESIGNED_TTL_S;
  const pullTimeoutMs = opts.pullTimeoutMs ?? PULL_FILE_TIMEOUT_MS;

  const manifest = await fetchManifest(opts.runnerBaseUrl, fetchImpl, opts.token);
  if (manifest.length === 0) return [];

  const results: FileInfo[] = [];
  for (const entry of manifest) {
    const bytes = await pullFile(
      opts.runnerBaseUrl,
      entry.path,
      fetchImpl,
      pullTimeoutMs,
      opts.token,
    );
    const key = `runs/${opts.runId}/outputs/${entry.path}`;
    await opts.storage.put(key, bytes);
    const url = await opts.storage.getPresignedDownloadUrl(key, ttl);
    results.push({ name: entry.path, size: entry.size, url });
  }
  return results;
}

async function fetchManifest(
  baseUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<OutputManifestEntry[]> {
  const response = await fetchImpl(`${baseUrl}/outputs/collect`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`/outputs/collect returned HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    files?: OutputManifestEntry[];
  } | null;
  if (!body || !Array.isArray(body.files)) {
    throw new Error("/outputs/collect returned a malformed body");
  }
  return body.files;
}

async function pullFile(
  baseUrl: string,
  path: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  token?: string,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl}/outputs/file?path=${encodeURIComponent(path)}`;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) {
      throw new Error(`pull "${path}" failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}
