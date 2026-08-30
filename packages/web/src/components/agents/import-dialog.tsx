import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScannedAgent,
  useImportAgent,
  useMe,
  usePushScannedAgent,
  useScanAgents,
} from "../../lib/api-client";
import { Btn, Pill } from "../shared/ui";

/**
 * Parse a `.agent` bundle filename produced by `skrun build`.
 *
 * Convention: `skrun build` emits `<slug>-<version>.agent` where `<slug>` is
 * the agent.yaml `name` (slug-only) and `<version>` is the semver string. The
 * last `-` splits slug from version; slugs themselves may contain hyphens
 * (`email-drafter`).
 *
 * Returns `null` if the filename doesn't match the expected shape; the caller
 * surfaces an error and prompts the user for the values manually.
 */
function parseBundleFilename(filename: string): { name: string; version: string } | null {
  const base = filename.replace(/\.agent$/, "");
  const lastDash = base.lastIndexOf("-");
  if (lastDash <= 0 || lastDash === base.length - 1) return null;
  const name = base.slice(0, lastDash);
  const version = base.slice(lastDash + 1);
  // Loose semver-ish guard — final shape is validated server-side.
  if (!/^\d/.test(version)) return null;
  return { name, version };
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "upload" | "scan";

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const [tab, setTab] = useState<Tab>("upload");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is mouse-only by design */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-interactive overlay; the close X-button + escape key are the keyboard paths */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-800 w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-gray-100 dark:border-gray-900">
          <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
            Import Agent
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 rounded-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 12 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 dark:border-gray-900">
          {(["upload", "scan"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative flex-1 h-9 text-[12.5px] font-medium transition-colors ${
                tab === t
                  ? "text-gray-900 dark:text-gray-100"
                  : "text-gray-500 dark:text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              }`}
            >
              {t === "upload" ? "Upload" : "Scan Directory"}
              {tab === t && <span className="absolute bottom-0 left-0 right-0 h-px bg-sky-500" />}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 min-h-[200px] overflow-y-auto flex-1">
          {tab === "upload" ? <UploadTab onClose={onClose} /> : <ScanTab />}
        </div>
      </div>
    </div>
  );
}

function UploadTab({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const importAgent = useImportAgent();
  const me = useMe();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Namespace mirrors the caller's auth context — the push endpoint refuses
  // cross-namespace pushes for non-admin callers (403) AND a cross-namespace
  // admin import would create an agent with `owner_id = admin.id` that the
  // supposed target user can't see, read, or pull (filtered out by the
  // multi-tenant gate). The field is therefore display-only.
  useEffect(() => {
    if (me.data?.namespace) {
      setNamespace(me.data.namespace);
    }
  }, [me.data?.namespace]);

  const handleFile = useCallback((picked: File) => {
    setError(null);
    if (!picked.name.endsWith(".agent")) {
      setError("Invalid bundle format. Use `skrun build` to create a valid .agent file.");
      return;
    }
    setFile(picked);
    // Heuristic pre-fill from filename (`<slug>-<version>.agent`). User can
    // edit before submit — authoritative slug comes from the bundle's internal
    // agent.yaml, which the server validates.
    const parsed = parseBundleFilename(picked.name);
    if (parsed) {
      setName(parsed.name);
      setVersion(parsed.version);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const picked = e.dataTransfer.files[0];
      if (picked) handleFile(picked);
    },
    [handleFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files?.[0];
      if (picked) handleFile(picked);
    },
    [handleFile],
  );

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!file) {
      setError("Choose a .agent bundle first.");
      return;
    }
    if (!namespace.trim() || !name.trim() || !version.trim()) {
      setError("Namespace, name, and version are all required.");
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      await importAgent.mutateAsync({
        namespace: namespace.trim(),
        name: name.trim(),
        version: version.trim(),
        bundle: buffer,
      });
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      }
    }
  }, [file, namespace, name, version, importAgent, onClose]);

  const canSubmit = Boolean(file && namespace.trim() && name.trim() && version.trim());

  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop zone — file picker button below is the keyboard path */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
          isDragging
            ? "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20"
            : "border-gray-200 dark:border-gray-800"
        }`}
      >
        {file ? (
          <p className="text-[12.5px] text-gray-700 dark:text-gray-300 mb-3 font-mono truncate">
            {file.name}
          </p>
        ) : (
          <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mb-3">
            Drag & drop a{" "}
            <code className="text-[11px] font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded-sm">
              .agent
            </code>{" "}
            bundle here
          </p>
        )}
        {/* The file input is triggered programmatically via the button's
            onClick rather than wrapped in a <label>: a <button> nested in a
            <label> swallows the click and never opens the native file picker
            (the button is itself the label's interactive control). */}
        <Btn variant="primary" onClick={() => fileInputRef.current?.click()}>
          {file ? "Choose another file" : "Choose file"}
        </Btn>
        <input
          ref={fileInputRef}
          type="file"
          accept=".agent"
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {/* Form fields — pre-filled from filename heuristic + auth context. */}
      <div className="mt-4 space-y-3">
        <div>
          <label
            htmlFor="import-namespace"
            className="block text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Namespace
          </label>
          <input
            id="import-namespace"
            type="text"
            value={namespace}
            readOnly
            placeholder="dev"
            className="w-full px-2.5 h-8 text-[12.5px] rounded-sm border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none cursor-not-allowed"
          />
          <p className="mt-1 text-[10.5px] text-gray-500 dark:text-gray-500">
            Mirrors your account namespace.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="import-name"
              className="block text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Name (slug)
            </label>
            <input
              id="import-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="email-drafter"
              className="w-full px-2.5 h-8 text-[12.5px] rounded-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-sky-400 font-mono"
            />
          </div>
          <div>
            <label
              htmlFor="import-version"
              className="block text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Version
            </label>
            <input
              id="import-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0.0"
              className="w-full px-2.5 h-8 text-[12.5px] rounded-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-sky-400 font-mono"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Btn
          variant="primary"
          disabled={!canSubmit || importAgent.isPending}
          onClick={handleSubmit}
        >
          {importAgent.isPending ? "Uploading..." : "Import"}
        </Btn>
      </div>

      {error && (
        <div className="mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-2.5">
          <p className="text-[12px] text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}
    </div>
  );
}

function ScanTab() {
  const { data, isLoading, error } = useScanAgents();
  const pushScanned = usePushScannedAgent();
  const [pushingName, setPushingName] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={`skel-${i}`}
            className="h-12 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-[12px] text-red-600 dark:text-red-400">Failed to scan directory.</p>;
  }

  if (!data?.configured) {
    return (
      <div className="text-center py-6">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          Set{" "}
          <code className="text-[11px] font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded-sm">
            SKRUN_AGENTS_DIR
          </code>{" "}
          environment variable to enable folder scanning.
        </p>
      </div>
    );
  }

  if (data.agents.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          No agents found in the configured directory.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.agents.map((agent: ScannedAgent) => (
        <div
          key={agent.name}
          className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-900 hover:bg-gray-50/60 dark:hover:bg-gray-900/30"
        >
          <div className="min-w-0">
            <span className="text-[12.5px] font-medium text-gray-900 dark:text-gray-100">
              {agent.name}
            </span>
            <p className="text-[10.5px] font-mono text-gray-400 dark:text-gray-600 truncate max-w-[250px]">
              {agent.path}
            </p>
          </div>
          {agent.registered ? (
            <Pill tone="emerald" dot>
              Registered
            </Pill>
          ) : (
            <Btn
              variant="accent"
              size="sm"
              disabled={pushingName === agent.name}
              onClick={async () => {
                setPushingName(agent.name);
                try {
                  await pushScanned.mutateAsync(agent.name);
                } catch {
                  // Error handled by mutation
                } finally {
                  setPushingName(null);
                }
              }}
            >
              {pushingName === agent.name ? "Pushing..." : "Push"}
            </Btn>
          )}
        </div>
      ))}
    </div>
  );
}
