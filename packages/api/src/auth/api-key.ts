import { createHash, randomInt } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * The start of every API key this server mints: the brand, then the key family
 * (`sk`, a secret API key). Other tools match leaked keys on this exact value,
 * so a test pins the literal — change it only as a breaking change.
 */
export const API_KEY_PREFIX = "skrun_sk_";

/**
 * The start of the keys minted before the current format. Such a key is refused
 * like any invalid key, without a database read, and never becomes a dev token.
 * This constant is the only place the code spells it.
 */
export const RETIRED_API_KEY_PREFIX = "sk_live_";

/** Base62, in this order: digits, upper case, lower case. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Random characters after the prefix (about 178 bits). */
const BODY_LENGTH = 30;
/** Base62 characters of the CRC32 of the body (62^6 > 2^32). */
const CHECKSUM_LENGTH = 6;
/** Body characters shown in `keyPrefix`, after the prefix. */
const VISIBLE_BODY_LENGTH = 8;
/** The retired format: its prefix, then 32 lower-case hex characters. */
const RETIRED_BODY_LENGTH = 32;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CURRENT_SHAPE = `${escapeRegExp(API_KEY_PREFIX)}[0-9A-Za-z]{${BODY_LENGTH + CHECKSUM_LENGTH}}`;
const RETIRED_SHAPE = `${escapeRegExp(RETIRED_API_KEY_PREFIX)}[0-9a-f]{${RETIRED_BODY_LENGTH}}`;
const CURRENT_KEY = new RegExp(`^${CURRENT_SHAPE}$`);

/**
 * The checksum of a body: the CRC32 of its ASCII bytes, written in base62, most
 * significant digit first, left-padded with `0` to a fixed 6 characters.
 */
function checksum(body: string): string {
  let value = crc32(body);
  let out = "";
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    out = ALPHABET[value % ALPHABET.length] + out;
    value = Math.floor(value / ALPHABET.length);
  }
  return out;
}

/**
 * Generate a new API key with its hash and prefix: the prefix, 30 random base62
 * characters, then the 6-character checksum of those 30 — 45 characters.
 * `keyPrefix` is the prefix and the first 8 body characters.
 * The raw key is returned once — only the hash is stored.
 */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  const key = `${API_KEY_PREFIX}${body}${checksum(body)}`;
  const keyHash = hashApiKey(key);
  const keyPrefix = `${API_KEY_PREFIX}${body.slice(0, VISIBLE_BODY_LENGTH)}`;
  return { key, keyHash, keyPrefix };
}

/**
 * Hash an API key using SHA-256 for storage.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Whether a token is an API key of the current format: the prefix, 36 base62
 * characters, and a checksum that matches the body. The checksum is recomputed
 * and compared as a string, so six characters that decode to a value at or
 * above 2^32 are never canonical.
 */
export function isApiKeyFormat(token: string): boolean {
  if (!CURRENT_KEY.test(token)) return false;
  const rest = token.slice(API_KEY_PREFIX.length);
  return rest.slice(BODY_LENGTH) === checksum(rest.slice(0, BODY_LENGTH));
}

/**
 * Every substring of `text` shaped like a whole API key — current (the prefix
 * and 36 base62 characters; the checksum is not verified, so a key copied with
 * a typo is still found) or retired (its prefix and 32 hex characters). For
 * leak guards: a truncated example (`…`) is not a whole key and is not returned.
 */
export function apiKeyShapes(text: string): string[] {
  return text.match(new RegExp(`${CURRENT_SHAPE}|${RETIRED_SHAPE}`, "g")) ?? [];
}
