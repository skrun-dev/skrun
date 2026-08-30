/**
 * KeyProvider — the encryption-at-rest primitive for secrets stored by the API
 * (today: creator-attached LLM keys; later: MCP/OAuth vaults). A pluggable
 * interface so the cloud can swap to a KMS-backed provider later with zero
 * call-site change, while self-host keeps a simple env-supplied master key.
 *
 * `EnvKeyProvider` uses Node's native AES-256-GCM (no third-party crypto lib).
 * Ciphertext is an opaque, self-describing **envelope** (base64):
 *
 *   version(1B) ‖ iv(12B, random per encryption) ‖ authTag(16B) ‖ ciphertext
 *
 * - The **version** byte lets us rotate the master key later (decrypt routes by
 *   version; an unknown version is a loud error).
 * - A fresh random **96-bit IV** per call means identical plaintexts encrypt to
 *   different ciphertexts (no nonce reuse).
 * - The **GCM auth tag** detects tampering — `decrypt` throws on any mismatch.
 * - The caller passes an **AAD** (additional authenticated data) bound into the
 *   tag; `buildAad` produces an unambiguous, length-prefixed AAD so a ciphertext
 *   cannot be replayed under a different (agent, provider, version).
 *
 * The plaintext key is never logged, cached, or written to disk — it lives only
 * transiently in the harness process during encrypt/decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Current envelope version. Bump when the scheme changes (rotation support). */
export const KEY_ENVELOPE_VERSION = 1;

const IV_BYTES = 12; // 96-bit GCM nonce (the recommended size)
const TAG_BYTES = 16; // 128-bit GCM auth tag
export const MASTER_KEY_BYTES = 32; // AES-256

export interface KeyProvider {
  /** Encrypt `plaintext` under the master key, binding `aad` into the tag. */
  encrypt(plaintext: string, aad: Buffer): string;
  /** Decrypt an envelope; throws on tamper, wrong AAD, or unknown version. */
  decrypt(envelope: string, aad: Buffer): string;
  /** True when a master key is configured (else attach is refused, fail-closed). */
  isConfigured(): boolean;
}

/**
 * AES-256-GCM provider keyed by a single 32-byte master key (or `null` when no
 * key is configured — every encrypt/decrypt then throws, and `isConfigured()`
 * is false so the caller refuses the operation).
 */
export class EnvKeyProvider implements KeyProvider {
  constructor(private readonly key: Buffer | null) {}

  isConfigured(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string, aad: Buffer): string {
    if (!this.key) {
      throw new Error("KeyProvider is not configured (SKRUN_SECRETS_ENCRYPTION_KEY unset)");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([KEY_ENVELOPE_VERSION]), iv, tag, ciphertext]).toString(
      "base64",
    );
  }

  decrypt(envelope: string, aad: Buffer): string {
    if (!this.key) {
      throw new Error("KeyProvider is not configured (SKRUN_SECRETS_ENCRYPTION_KEY unset)");
    }
    const buf = Buffer.from(envelope, "base64");
    if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new Error("Malformed key envelope (too short)");
    }
    const version = buf[0];
    if (version !== KEY_ENVELOPE_VERSION) {
      throw new Error(`Unsupported key envelope version: ${version}`);
    }
    const iv = buf.subarray(1, 1 + IV_BYTES);
    const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

/**
 * Build the AAD for a creator LLM key as a deterministic, **length-prefixed**
 * byte string over (agentId, provider, keyVersion) — so the AAD is unambiguous
 * (a field value can never bleed into the next, unlike a raw `a|b` join) and a
 * ciphertext is bound to exactly one (agent, provider, version). Strings are
 * `u32 LE length ‖ utf-8 bytes`; the version is a fixed `u32 LE`.
 */
export function buildAad(agentId: string, provider: string, keyVersion: number): Buffer {
  const parts: Buffer[] = [];
  for (const field of [agentId, provider]) {
    const bytes = Buffer.from(field, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    parts.push(len, bytes);
  }
  const version = Buffer.alloc(4);
  version.writeUInt32LE(keyVersion, 0);
  parts.push(version);
  return Buffer.concat(parts);
}

/**
 * Build the process-wide KeyProvider from `SKRUN_SECRETS_ENCRYPTION_KEY`.
 *
 * - **Unset** → an unconfigured provider (`isConfigured()` false). Attaching a
 *   creator key is then refused (fail-closed); a self-host that never attaches a
 *   key needs no master key and boots normally.
 * - **Set** → decoded as base64 or hex and asserted to be exactly 32 bytes
 *   (AES-256). A malformed value **throws** — and because this is called once at
 *   app startup, that is a loud fail-fast boot interlock, not a deferred surprise.
 */
export function getKeyProvider(): KeyProvider {
  const raw = process.env.SKRUN_SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) return new EnvKeyProvider(null);
  return new EnvKeyProvider(decodeMasterKey(raw));
}

/** Decode a base64-or-hex master key, asserting it is exactly 32 bytes. */
function decodeMasterKey(raw: string): Buffer {
  // A 64-char hex string is also valid base64 — disambiguate hex first.
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === MASTER_KEY_BYTES) key = decoded;
  }
  if (!key || key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `SKRUN_SECRETS_ENCRYPTION_KEY must decode to ${MASTER_KEY_BYTES} bytes (base64 or hex). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}
