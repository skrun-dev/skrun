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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function downloadEndpoint(file: RunFile): string | null {
  if (file.file_id) return `/api/files/${encodeURIComponent(file.file_id)}/content`;
  if (file.url) return file.url;
  return null;
}

export function FilesBlock({ files }: FilesBlockProps) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!files || files.length === 0) return null;

  async function handleDownload(file: RunFile, key: string) {
    const endpoint = downloadEndpoint(file);
    if (!endpoint) {
      setError(`No download URL available for "${file.name}".`);
      return;
    }
    setError(null);
    setDownloadingKey(key);
    try {
      const res = await fetch(endpoint, {
        headers: getAuthHeaders(),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? `Download failed: HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
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
