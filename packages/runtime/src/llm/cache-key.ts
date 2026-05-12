import { createHash } from "node:crypto";

/**
 * Derive a stable, alphanumeric-safe cache key from the agent context for use
 * with provider-side cache routing primitives (#68 prompt-caching).
 *
 * - **OpenAI** (Chat Completions + Responses): passed as the `prompt_cache_key`
 *   body field — influences routing for higher hit rate.
 * - **xAI Grok** (Chat Completions): passed as the `x-grok-conv-id` HTTP header.
 * - **xAI Grok** (Responses): passed as `prompt_cache_key` body field.
 *
 * The raw concatenation `${agent.name}@${agent.version}+${env_id}` can contain
 * slashes (e.g. `dev/my-agent`), dots (e.g. `1.0.0-beta+build.42`), and other
 * characters that some providers may treat specially in a header context. We
 * SHA-256-hash the raw key and use the hex digest (64 alphanumeric chars) so
 * the same input always produces the same key while remaining safe across all
 * 3 transport surfaces (header + 2 body fields).
 *
 * Trade-off: slightly less debuggable (raw agent identifier not visible in
 * provider logs), but safe and deterministic. Hash collisions are not a concern
 * at this scale — cache pools are isolated per-tenant via the LLM API key.
 *
 * Resolution per spec.md Q-2.B + peer-review C1 fix.
 */
export function hashCacheKey(
  agentName: string,
  agentVersion: string,
  environmentId: string,
): string {
  const raw = `${agentName}@${agentVersion}+${environmentId}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
