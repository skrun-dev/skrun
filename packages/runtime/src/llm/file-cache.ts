import { createHash } from "node:crypto";

/**
 * Per-run cache for provider-side file identifiers (Anthropic file_id, OpenAI file_id, Gemini fileUri).
 *
 * Scope: instantiated by `LLMRouter.call()` for a single agent run, threaded into each
 * provider invocation via `LLMCallRequest._fileCache`. Discarded at end of run.
 *
 * Why per-run (not cross-run): Anthropic Files API entries persist for ~60 minutes
 * server-side, mismatched with our 24h input file TTL. A cross-run cache would
 * surface stale provider file_ids on the second run. Per-run is correct and simpler.
 *
 * Why useful: within a single agent run, the tool-calling loop may call `provider.call()`
 * many times with the same userContent (the multimodal parts don't change between
 * iterations). Without the cache, every iteration re-uploads each non-text part.
 */
export interface ProviderFileCache {
  get(provider: string, fingerprint: string): string | undefined;
  set(provider: string, fingerprint: string, providerFileId: string): void;
}

export class InMemoryProviderFileCache implements ProviderFileCache {
  private store = new Map<string, string>();

  private key(provider: string, fingerprint: string): string {
    return `${provider}::${fingerprint}`;
  }

  get(provider: string, fingerprint: string): string | undefined {
    return this.store.get(this.key(provider, fingerprint));
  }

  set(provider: string, fingerprint: string, providerFileId: string): void {
    this.store.set(this.key(provider, fingerprint), providerFileId);
  }
}

/**
 * SHA-256 fingerprint of binary content. Used as the cache key — same bytes
 * produce the same key, regardless of upstream Skrun file_id, URL, or inline data.
 */
export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
