import { useState } from "react";
import { getAuthHeaders } from "../../lib/api-client";

export interface RunFile {
  name: string;
  size: number;
  /** Server-built per-run download URL (legacy fallback). */
  url?: string;
  /** Unified-namespace file identifier. Preferred when present. */
  file_id?: string;
}

interface FilesBlockProps {
  files?: RunFile[] | null;
  /**
   * The run that produced the files. Given, every download asks the API for a
   * fresh link first (`GET /api/runs/:id/files/:name/link`): it works from a
   * run's detail, whose stored file list carries no URL, and after the link a
   * run returned has expired.
   */
  runId?: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Where to download `file` from, without asking the API: its id, else the URL it came with. */
function knownEndpoint(file: RunFile): string | null {
  if (file.file_id) return `/api/files/${encodeURIComponent(file.file_id)}/content`;
  if (file.url) return file.url;
  return null;
}

function isSameOrigin(url: string): boolean {
  return new URL(url, window.location.href).origin === window.location.origin;
}

/** The message of a JSON error answer, or a generic one naming the status. */
async function failureMessage(res: Response, what: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `${what} failed: HTTP ${res.status}`;
}

/** A fresh download link for one of a run's files, from this API (same origin). */
async function freshLink(runId: string, name: string): Promise<string> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}/link`,
    { headers: getAuthHeaders(), credentials: "same-origin" },
  );
  if (!res.ok) throw new Error(await failureMessage(res, "Download"));
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string" || body.url === "") {
    throw new Error(`No download URL available for "${name}".`);
  }
  return body.url;
}

/**
 * A same-origin route needs the caller's credentials, which a plain navigation
 * would not send in token mode: fetch it with them, then save the bytes.
 */
async function saveFromThisOrigin(url: string, name: string): Promise<void> {
  const res = await fetch(url, { headers: getAuthHeaders(), credentials: "same-origin" });
  if (!res.ok) throw new Error(await failureMessage(res, "Download"));
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

/**
 * Another origin — a presigned object-storage URL — is never fetched: the
 * dashboard's CSP allows no such connection (`connect-src 'self'`), and a store
 * sends no CORS headers unless its operator configured some. The browser
 * navigates to it instead; its response is signed to be
 * an attachment, so the file is saved and the page stays. No `download`
 * attribute: across origins the browser ignores it.
 */
function navigateTo(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function FilesBlock({ files, runId }: FilesBlockProps) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!files || files.length === 0) return null;

  async function handleDownload(file: RunFile, key: string) {
    setError(null);
    setDownloadingKey(key);
    try {
      const url = runId ? await freshLink(runId, file.name) : knownEndpoint(file);
      if (!url) throw new Error(`No download URL available for "${file.name}".`);
      if (isSameOrigin(url)) {
        await saveFromThisOrigin(url, file.name);
      } else {
        navigateTo(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingKey(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
        Files ({files.length})
      </h3>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {files.map((file, idx) => {
          const key = file.file_id ?? `${file.name}-${idx}`;
          const isDownloading = downloadingKey === key;
          return (
            <li key={key} className="flex items-center justify-between py-2">
              <div className="min-w-0 flex-1 pr-3">
                <p className="text-sm font-mono text-gray-900 dark:text-gray-100 truncate">
                  {file.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatSize(file.size)}
                  {file.file_id && (
                    <>
                      {" · "}
                      <span className="font-mono">{file.file_id.slice(0, 12)}…</span>
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleDownload(file, key)}
                disabled={isDownloading}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDownloading ? "Downloading…" : "Download"}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
