/**
 * creator-llm-key — attach / remove / list a creator's encrypted LLM keys on
 * their agent, and resolve (decrypt) them harness-side at run time.
 *
 * The plaintext is encrypted via the KeyProvider (AES-256-GCM) before it touches
 * the DB; only the harness ever decrypts it (run.ts), and it is never returned by
 * a read endpoint — `listCreatorKeys` exposes provider + last4 only.
 *
 * Takes `db` + `keyProvider` as arguments (no Hono / no module singletons) so
 * every branch is unit-testable in isolation.
 */

import type { DbAdapter } from "../db/adapter.js";
import type { Agent, AgentLlmKeyInfo } from "../db/schema.js";
import { RegistryError } from "./registry.js";
import { buildAad, KEY_ENVELOPE_VERSION, type KeyProvider } from "./secrets/key-provider.js";

/**
 * Providers a creator may attach a key for — exactly those the LLM router can
 * instantiate (`router.ts` createProvider). NB `meta` is a valid agent.yaml model
 * provider but the router has no client for it, so a key for it would be inert;
 * we reject it at attach time rather than fail mysteriously at run.
 */
const ATTACHABLE_PROVIDERS = new Set(["anthropic", "openai", "google", "mistral", "groq", "xai"]);

/**
 * Minimum plaintext length. Every real provider key far exceeds this; it guards
 * against an empty / typo'd value and keeps `last4` from echoing a whole short key.
 */
const MIN_KEY_LENGTH = 16;

function maskLast4(plaintext: string): string {
  return plaintext.slice(-4).padStart(4, "•");
}

/**
 * Attach (or replace) a creator's LLM key for one provider on one agent.
 * Returns the provider + display `last4` (never the key).
 */
export async function attachCreatorKey(
  db: DbAdapter,
  keyProvider: KeyProvider,
  agent: Agent,
  provider: string,
  plaintext: string,
): Promise<{ provider: string; last4: string }> {
  if (!keyProvider.isConfigured()) {
    throw new RegistryError(
      "ENCRYPTION_NOT_CONFIGURED",
      "This server cannot store creator LLM keys: SKRUN_SECRETS_ENCRYPTION_KEY is not set.",
      500,
    );
  }
  const normalized = provider.toLowerCase();
  if (!ATTACHABLE_PROVIDERS.has(normalized)) {
    throw new RegistryError(
      "INVALID_LLM_PROVIDER",
      `Unsupported LLM provider '${provider}'. Supported: ${[...ATTACHABLE_PROVIDERS].sort().join(", ")}.`,
      400,
    );
  }
  if (plaintext.length < MIN_KEY_LENGTH) {
    throw new RegistryError(
      "INVALID_LLM_KEY",
      `LLM key looks too short (minimum ${MIN_KEY_LENGTH} characters).`,
      400,
    );
  }
  const ciphertext = keyProvider.encrypt(
    plaintext,
    buildAad(agent.id, normalized, KEY_ENVELOPE_VERSION),
  );
  const last4 = maskLast4(plaintext);
  await db.setAgentLlmKey(agent.id, normalized, ciphertext, last4, KEY_ENVELOPE_VERSION);
  return { provider: normalized, last4 };
}

/** Remove a creator's LLM key for one provider on one agent. */
export async function removeCreatorKey(
  db: DbAdapter,
  agent: Agent,
  provider: string,
): Promise<void> {
  await db.deleteAgentLlmKey(agent.id, provider.toLowerCase());
}

/** Presence list (provider + last4 + updated_at) — never the plaintext. */
export async function listCreatorKeys(db: DbAdapter, agent: Agent): Promise<AgentLlmKeyInfo[]> {
  return db.listAgentLlmKeys(agent.id);
}

/**
 * Decrypt all of an agent's attached creator keys into a provider→plaintext map
 * for the run-time resolution chain (harness-side only). Returns `{}` when none
 * are attached. A decrypt failure (e.g. the master key was rotated away, or the
 * row was tampered) is a HARD error — never silently skipped, which would fall
 * through to the wrong tier / wrong payer.
 */
export async function resolveCreatorKeys(
  db: DbAdapter,
  keyProvider: KeyProvider,
  agentId: string,
): Promise<Record<string, string>> {
  const records = await db.getAgentLlmKeySecrets(agentId);
  const out: Record<string, string> = {};
  for (const record of records) {
    out[record.provider] = keyProvider.decrypt(
      record.ciphertext,
      buildAad(record.agent_id, record.provider, record.key_version),
    );
  }
  return out;
}
