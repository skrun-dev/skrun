import { useCallback, useState } from "react";
import {
  type ScannedAgent,
  useImportAgent,
  usePushScannedAgent,
  useScanAgents,
} from "../../lib/api-client";
import { Btn, Pill } from "../shared/ui";

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
            className="w-6 h-6 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center"
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
  const importAgent = useImportAgent();

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!file.name.endsWith(".agent")) {
        setError("Invalid bundle format. Use `skrun build` to create a valid .agent file.");
        return;
      }

      const baseName = file.name.replace(".agent", "");
      const parts = baseName.split("-");
      if (parts.length < 3) {
        setError("Filename must follow format: namespace-name-version.agent");
        return;
      }

      const namespace = parts[0]!;
      const version = parts[parts.length - 1]!;
      const name = parts.slice(1, -1).join("-");

      try {
        const buffer = await file.arrayBuffer();
        await importAgent.mutateAsync({ namespace, name, version, bundle: buffer });
        onClose();
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        }
      }
    },
    [importAgent, onClose],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragging
            ? "border-sky-400 bg-sky-50/50 dark:bg-sky-950/20"
            : "border-gray-200 dark:border-gray-800"
        }`}
      >
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mb-3">
          Drag & drop a{" "}
          <code className="text-[11px] font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">
            .agent
          </code>{" "}
          bundle here
        </p>
        <label>
          <Btn variant="primary" className="cursor-pointer">
            Choose file
          </Btn>
          <input type="file" accept=".agent" onChange={handleFileInput} className="hidden" />
        </label>
      </div>

      {importAgent.isPending && (
        <p className="mt-3 text-[12px] text-sky-600 dark:text-sky-400">Uploading...</p>
      )}

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
            className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse"
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
          <code className="text-[11px] font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">
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
