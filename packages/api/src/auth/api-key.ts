import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "sk_live_";
const KEY_BYTES = 16; // 16 bytes = 32 hex chars

/**
 * Generate a new API key with its hash and prefix.
 * The raw key is returned once — only the hash is stored.
 */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const random = randomBytes(KEY_BYTES).toString("hex"); // 32 hex chars
  const key = `${API_KEY_PREFIX}${random}`;
  const keyHash = hashApiKey(key);
  const keyPrefix = `${API_KEY_PREFIX}${random.slice(0, 8)}`;
  return { key, keyHash, keyPrefix };
}

/**
 * Hash an API key using SHA-256 for storage.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Check if a token string matches the API key format: sk_live_ + 32 hex chars.
 */
export function isApiKeyFormat(token: string): boolean {
  if (!token.startsWith(API_KEY_PREFIX)) return false;
  const suffix = token.slice(API_KEY_PREFIX.length);
  return suffix.length === KEY_BYTES * 2 && /^[0-9a-f]+$/.test(suffix);
}
