import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Device-code helpers for the CLI device-login flow (OAuth 2.0 Device
 * Authorization Grant, RFC 8628) + its PKCE (RFC 7636) and CSRF protections.
 *
 * Pure functions only — no DB, no I/O — so they unit-test in isolation. The route
 * layer composes these with the `DbAdapter.device_codes` store. The raw codes are
 * generated here and hashed before storage; the plaintext never touches the DB.
 */

/** Default device-code TTL (seconds) — RFC 8628 codes are short-lived. */
const DEFAULT_DEVICE_CODE_TTL_S = 600;

/**
 * Device-code TTL in seconds, from `SKRUN_DEVICE_CODE_TTL_S` (default 600). A
 * non-numeric / non-positive value falls back to the default. A short TTL shrinks
 * the device-code-phishing window.
 */
export function ttlSeconds(): number {
  const raw = process.env.SKRUN_DEVICE_CODE_TTL_S;
  if (!raw) return DEFAULT_DEVICE_CODE_TTL_S;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n <= 0 ? DEFAULT_DEVICE_CODE_TTL_S : n;
}

/** A high-entropy `device_code` (the CLI's secret; only ever sent by the CLI). */
export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Unambiguous `user_code` charset — excludes 0/O, 1/I/L to avoid human
 * transcription errors. 8 chars grouped `XXXX-XXXX` (31^8 ≈ 8.5e11 combinations;
 * brute force is bounded by the per-IP rate-limit + single-use + the short TTL).
 */
const USER_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A short, human-enterable `user_code`: 8 unambiguous chars, grouped `XXXX-XXXX`. */
export function generateUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_CHARS[bytes[i] % USER_CODE_CHARS.length];
    if (i === 3) out += "-";
  }
  return out;
}

/** SHA-256 hex of a raw code — what we store (the raw code lives only in transit). */
export function hashCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A CSRF double-submit token (random; set in both a cookie and a hidden field). */
export function issueCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time compare of the CSRF cookie value vs the submitted form field
 * (double-submit). A cross-origin attacker can read neither the cookie nor the
 * field, so it cannot forge a matching pair. Needs no server secret.
 */
export function verifyCsrfToken(cookie: string | undefined, field: string | undefined): boolean {
  if (!cookie || !field) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(field);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whole seconds until `expiresAt` (ISO), floored at 0 — the RFC 8628 `expires_in`. */
export function computeExpiresIn(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}
