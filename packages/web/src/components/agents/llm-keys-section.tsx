import { useState } from "react";
import {
  type AgentLlmKeyPolicy,
  useAgentLlmKeys,
  useRemoveAgentLlmKey,
  useSetAgentLlmKey,
  useSetLlmKeyPolicy,
} from "../../lib/api-client";
import { Btn, Card } from "../shared/ui";

/** Providers the runtime can instantiate (must match the API's attach validation). */
const PROVIDERS = ["anthropic", "openai", "google", "mistral", "groq", "xai"] as const;

/**
 * Creator LLM key management for an agent (owner-only). Write-only: the plaintext
 * key is never displayed — only the provider + last4. Lets the owner attach/replace/
 * remove a per-provider key and toggle the caller-key policy.
 */
export function LlmKeysSection({ namespace, name }: { namespace: string; name: string }) {
  const { data, isLoading } = useAgentLlmKeys(namespace, name);
  const setKey = useSetAgentLlmKey();
  const removeKey = useRemoveAgentLlmKey();
  const setPolicy = useSetLlmKeyPolicy();

  const [provider, setProvider] = useState<string>(PROVIDERS[0]);
  const [keyValue, setKeyValue] = useState("");

  const policy: AgentLlmKeyPolicy = data?.policy ?? "open";

  async function attach() {
    if (!keyValue.trim()) return;
    try {
      await setKey.mutateAsync({ namespace, name, provider, key: keyValue });
      setKeyValue("");
    } catch {
      // Surfaced by setKey.isError below.
    }
  }

  return (
    <Card title="LLM keys" pad={false}>
      <div className="p-4 space-y-4">
        <p className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
          Attach your own LLM key so callers don't need to supply one — you cover the inference.
          Keys are encrypted at rest and never shown again.
        </p>

        <div className="flex items-center gap-3">
          <span className="text-[12px] text-gray-600 dark:text-gray-400">Caller keys</span>
          <div className="flex items-center p-0.5 rounded-md bg-gray-100/70 dark:bg-gray-900 text-[11.5px]">
            {(["open", "creator_only"] as const).map((p) => (
              <button
                key={p}
                type="button"
                disabled={setPolicy.isPending}
                onClick={() => setPolicy.mutate({ namespace, name, policy: p })}
                className={`px-2.5 h-6 rounded-[5px] transition-colors ${
                  policy === p
                    ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm"
                    : "text-gray-500"
                }`}
              >
                {p === "open" ? "Allowed" : "My key only"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-8 px-2 text-[12px] rounded-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            type="password"
            aria-label="LLM key"
            placeholder="sk-…"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            className="flex-1 h-8 px-2 text-[12px] font-mono rounded-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          />
          <Btn
            variant="accent"
            size="sm"
            disabled={setKey.isPending || !keyValue.trim()}
            onClick={attach}
          >
            Attach
          </Btn>
        </div>
        {setKey.isError && (
          <p className="text-[11px] text-red-600 dark:text-red-400">
            {(setKey.error as Error)?.message ?? "Failed to attach key."}
          </p>
        )}

        {isLoading ? (
          <div className="h-10 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
        ) : !data || data.keys.length === 0 ? (
          <p className="text-[12px] text-gray-400">No LLM key attached.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-900 border border-gray-100 dark:border-gray-900 rounded-sm">
            {data.keys.map((k) => (
              <li key={k.provider} className="flex items-center justify-between px-3 py-2">
                <span className="text-[12.5px] font-medium">{k.provider}</span>
                <span className="font-mono text-[11px] text-gray-500">••••{k.last4}</span>
                <button
                  type="button"
                  onClick={() => removeKey.mutate({ namespace, name, provider: k.provider })}
                  className="px-2 py-0.5 text-[11px] rounded-sm bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
