import { useState } from "react";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { EmptyState } from "../components/shared/empty-state";
import { IconPlus } from "../components/shared/icons";
import { Btn, Card, KV, PageHeader } from "../components/shared/ui";
import { type ApiKey, useApiKeys, useCreateApiKey, useRevokeApiKey } from "../lib/api-client";
import { useAuth } from "../lib/auth";

export function SettingsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Profile, API keys, and workspace preferences."
      />
      <div className="space-y-6">
        <ProfileSection />
        <ApiKeysSection />
      </div>
    </div>
  );
}

function ProfileSection() {
  const { user, logout } = useAuth();

  return (
    <Card title="Profile" pad={false}>
      <div className="p-4">
        <div className="flex items-start gap-4">
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="w-14 h-14 rounded-full" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center">
              <span className="text-xl font-semibold text-white">
                {(user?.username ?? "D")[0]?.toUpperCase()}
              </span>
            </div>
          )}
          <dl className="flex-1 space-y-0">
            <KV
              label="Username"
              value={<span className="font-medium">{user?.username ?? "Local Dev"}</span>}
            />
            <KV label="Namespace" value={user?.namespace ?? "dev"} mono />
            <KV label="Email" value={user?.email || "—"} />
            <KV
              label="Plan"
              value={
                <span className="px-2 py-0.5 text-[10.5px] font-medium rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {user?.plan ?? "free"}
                </span>
              }
            />
          </dl>
        </div>
        {user && (
          <div className="px-4 pb-4 pt-2 border-t border-gray-100 dark:border-gray-900 mt-4">
            <Btn variant="danger" size="sm" onClick={logout}>
              Sign out
            </Btn>
          </div>
        )}
      </div>
    </Card>
  );
}

function ApiKeysSection() {
  const { data: keys, isLoading } = useApiKeys();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const revokeKey = useRevokeApiKey();

  return (
    <Card
      title="API Keys"
      action={
        <Btn variant="accent" size="sm" icon={<IconPlus />} onClick={() => setCreateOpen(true)}>
          Create Key
        </Btn>
      }
      pad={false}
    >
      {isLoading ? (
        <div className="p-4 space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={`skel-${i}`}
              className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse"
            />
          ))}
        </div>
      ) : !keys || keys.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="No API keys"
            description="Create one to access the API programmatically."
            action={
              <Btn variant="primary" icon={<IconPlus />} onClick={() => setCreateOpen(true)}>
                Create Key
              </Btn>
            }
          />
        </div>
      ) : (
        <div>
          {/* Header row */}
          <div className="grid grid-cols-[1fr_120px_120px_80px] gap-3 px-4 h-9 bg-gray-50/60 dark:bg-gray-900/40 border-b border-gray-100 dark:border-gray-900 text-[10.5px] font-medium uppercase tracking-[0.06em] text-gray-500 items-center">
            <span>Key</span>
            <span>Created</span>
            <span>Last used</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-900">
            {keys.map((key) => (
              <div
                key={key.id}
                className="grid grid-cols-[1fr_120px_120px_80px] gap-3 items-center px-4 py-3"
              >
                <div>
                  <div className="text-[12.5px] font-medium text-gray-900 dark:text-gray-100">
                    {key.name}
                  </div>
                  <div className="font-mono text-[11px] text-gray-500 dark:text-gray-500">
                    {key.key_prefix}...
                  </div>
                </div>
                <span className="text-[11px] text-gray-500 dark:text-gray-500">
                  {formatDate(key.created_at)}
                </span>
                <span
                  className={`text-[11px] tabular-nums ${key.last_used_at ? "text-gray-700 dark:text-gray-300" : "text-gray-400"}`}
                >
                  {key.last_used_at ? formatDate(key.last_used_at) : "Never"}
                </span>
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => setRevokeTarget(key)}
                    className="px-2.5 py-1 text-[11px] rounded bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <CreateKeyDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke API key"
        message={`Revoke key ${revokeTarget?.key_prefix}...? This cannot be undone.`}
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={async () => {
          if (revokeTarget) {
            try {
              await revokeKey.mutateAsync(revokeTarget.id);
            } catch {
              // handled by mutation
            }
            setRevokeTarget(null);
          }
        }}
        onCancel={() => setRevokeTarget(null)}
      />
    </Card>
  );
}

function CreateKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createKey = useCreateApiKey();

  if (!open) return null;

  const handleCreate = async () => {
    try {
      const result = await createKey.mutateAsync(name);
      setCreatedKey(result.key);
    } catch {
      // handled by mutation
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.querySelector("[data-key-display]") as HTMLElement | null;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  };

  const handleClose = () => {
    setCreatedKey(null);
    setName("");
    setCopied(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is mouse-only by design */}
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md w-full mx-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {createdKey ? "Key Created" : "Create API Key"}
        </h3>

        {createdKey ? (
          <div>
            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3 mb-3">
              <p
                data-key-display
                className="font-mono text-sm text-emerald-800 dark:text-emerald-300 break-all select-all"
              >
                {createdKey}
              </p>
            </div>
            <div className="flex items-center gap-2 mb-4">
              <Btn variant="primary" size="sm" onClick={handleCopy}>
                {copied ? "Copied!" : "Copy"}
              </Btn>
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Save this key — it won't be shown again
              </span>
            </div>
            <Btn variant="secondary" className="w-full justify-center" onClick={handleClose}>
              Done
            </Btn>
          </div>
        ) : (
          <div>
            <label
              htmlFor="key-name-input"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Key name
            </label>
            <input
              id="key-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CI pipeline, local dev..."
              className="w-full px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-sky-500 mb-4"
            />
            <div className="flex gap-3 justify-end">
              <Btn variant="secondary" onClick={handleClose}>
                Cancel
              </Btn>
              <Btn variant="primary" onClick={handleCreate} disabled={createKey.isPending}>
                {createKey.isPending ? "Creating..." : "Create"}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
