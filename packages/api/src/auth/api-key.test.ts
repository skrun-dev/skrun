import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  apiKeyShapes,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  RETIRED_API_KEY_PREFIX,
} from "./api-key.js";

// No fixture in this file is a whole key written as a literal: every key is
// generated or assembled at run time, so no secret scanner reads one here.

const BODY_LENGTH = 30;
const KEY_LENGTH = API_KEY_PREFIX.length + 36;
const SAMPLE = 1000;

/** A key of the current format, with a given body and checksum. */
function assemble(body: string, sum: string): string {
  return `${API_KEY_PREFIX}${body}${sum}`;
}

/** The body of a generated key (the 30 characters between prefix and checksum). */
function bodyOf(key: string): string {
  return key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + BODY_LENGTH);
}

/**
 * The checksum of any body, computed here and not by the module: CRC32 in
 * base62, most significant digit first, six characters. The known vectors below
 * pin the same encoding; this helper builds a token whose checksum is right, so
 * that only its alphabet can make it fail.
 */
function checksumOf(body: string): string {
  const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = BigInt(crc32(body));
  let out = "";
  for (let i = 0; i < 6; i++) {
    out = digits[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
}

describe("API Key", () => {
  describe("the prefix", () => {
    it("is the literal value other tools match on", () => {
      expect(API_KEY_PREFIX).toBe("skrun_sk_");
    });
  });

  describe("generateApiKey", () => {
    it("mints 45-character keys: the prefix, 36 base62 characters, a valid checksum", () => {
      const shape = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{36}$`);
      for (let i = 0; i < SAMPLE; i++) {
        const { key } = generateApiKey();
        expect(key).toHaveLength(45);
        expect(key).toMatch(shape);
        expect(isApiKeyFormat(key)).toBe(true);
      }
    });

    it("returns as keyPrefix the prefix and the first 8 body characters (17 characters)", () => {
      for (let i = 0; i < SAMPLE; i++) {
        const { key, keyPrefix } = generateApiKey();
        expect(keyPrefix).toBe(`${API_KEY_PREFIX}${bodyOf(key).slice(0, 8)}`);
        expect(keyPrefix).toHaveLength(17);
      }
    });

    it("returns a SHA-256 hash of the key", () => {
      const { key, keyHash } = generateApiKey();
      expect(keyHash).toBe(hashApiKey(key));
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates distinct keys", () => {
      const keys = new Set<string>();
      const hashes = new Set<string>();
      for (let i = 0; i < SAMPLE; i++) {
        const { key, keyHash } = generateApiKey();
        keys.add(key);
        hashes.add(keyHash);
      }
      expect(keys.size).toBe(SAMPLE);
      expect(hashes.size).toBe(SAMPLE);
    });

    it("draws every body position from the whole alphabet: digits, upper and lower case", () => {
      // At each of the 30 positions, over 500 keys, each class appears. A fair
      // draw misses a class at a position with probability at most (52/62)^500,
      // about 6e-39, so the 90 checks together fail by chance far less than once
      // in 10^36 runs. A body drawn from one class, or a position that is not
      // drawn at all, fails here.
      const classes: Array<[string, RegExp]> = [
        ["digit", /[0-9]/],
        ["upper case", /[A-Z]/],
        ["lower case", /[a-z]/],
      ];
      const bodies = Array.from({ length: 500 }, () => bodyOf(generateApiKey().key));
      for (let position = 0; position < BODY_LENGTH; position++) {
        const seen = bodies.map((body) => body[position]).join("");
        for (const [name, cls] of classes) {
          expect(cls.test(seen), `position ${position} never draws a ${name}`).toBe(true);
        }
      }
    });
  });

  describe("the checksum encoding (known vectors)", () => {
    // CRC32 of the 30 body characters, in base62 (0-9, A-Z, a-z), most
    // significant digit first, left-padded with 0 to six characters. These
    // vectors were computed independently of this module; a tool that checks a
    // key offline relies on the same encoding.
    it.each([
      ["0123456789ABCDEFGHIJabcdefghij", "4Us3aw"],
      ["0".repeat(30), "2C8GjS"],
      ["z".repeat(30), "4IlJEz"],
    ])("body %s has the checksum %s", (body, sum) => {
      expect(isApiKeyFormat(assemble(body, sum))).toBe(true);
    });
  });

  describe("hashApiKey", () => {
    // hashApiKey is format-agnostic — any string works.
    it("is deterministic", () => {
      const key = "test-input-deterministic-fixture";
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it("returns 64-char hex string (SHA-256)", () => {
      const hash = hashApiKey("test-input-sha256-fixture");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("different keys produce different hashes", () => {
      const a = hashApiKey("test-input-fixture-a");
      const b = hashApiKey("test-input-fixture-b");
      expect(a).not.toBe(b);
    });
  });

  describe("isApiKeyFormat", () => {
    it("accepts a generated key", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(key)).toBe(true);
    });

    it("rejects a key one character too long", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(`${key}0`)).toBe(false);
    });

    it("rejects a key one character too short", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(key.slice(0, -1))).toBe(false);
    });

    it("rejects a key with a character outside the alphabet", () => {
      const { key } = generateApiKey();
      const at = API_KEY_PREFIX.length + 3;
      expect(isApiKeyFormat(`${key.slice(0, at)}-${key.slice(at + 1)}`)).toBe(false);
    });

    it.each([
      "-",
      "_",
      ".",
      "+",
      "/",
    ])("rejects a body holding %s even when its checksum is computed on that body", (outside) => {
      // The checksum is right for this body, so only the alphabet can refuse it.
      // The witness: the same body with a base62 character there is accepted,
      // so the helper's checksum is the module's.
      const head = bodyOf(generateApiKey().key).slice(0, 3);
      const tail = "a".repeat(BODY_LENGTH - 4);
      const valid = `${head}b${tail}`;
      expect(isApiKeyFormat(assemble(valid, checksumOf(valid)))).toBe(true);
      const body = `${head}${outside}${tail}`;
      const token = assemble(body, checksumOf(body));
      expect(token).toHaveLength(KEY_LENGTH);
      expect(isApiKeyFormat(token)).toBe(false);
      expect(apiKeyShapes(`token=${token}`)).toEqual([]);
    });

    it("rejects a key whose checksum is wrong by one character", () => {
      const { key } = generateApiKey();
      const last = key.slice(-1);
      expect(isApiKeyFormat(`${key.slice(0, -1)}${last === "0" ? "1" : "0"}`)).toBe(false);
    });

    it("rejects a checksum above the 32-bit range on a valid body", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(assemble(bodyOf(key), "zzzzzz"))).toBe(false);
    });

    it("rejects a neighbouring prefix", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(`skrun_sx_${key.slice(API_KEY_PREFIX.length)}`)).toBe(false);
    });

    it("rejects another product's prefix on a valid body and checksum", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(`skrun_pk_${key.slice(API_KEY_PREFIX.length)}`)).toBe(false);
    });

    it("rejects a whole key of the retired format", () => {
      expect(isApiKeyFormat(`${RETIRED_API_KEY_PREFIX}${"0".repeat(32)}`)).toBe(false);
    });

    it("rejects a key without prefix", () => {
      const { key } = generateApiKey();
      expect(isApiKeyFormat(key.slice(API_KEY_PREFIX.length))).toBe(false);
    });

    it("rejects a key that is too short", () => {
      expect(isApiKeyFormat(`${API_KEY_PREFIX}abcdef`)).toBe(false);
    });

    it("rejects a key of the right length made of non-alphanumeric characters", () => {
      expect(isApiKeyFormat(`${API_KEY_PREFIX}${"!".repeat(36)}`)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isApiKeyFormat("")).toBe(false);
    });

    it("rejects dev-token", () => {
      expect(isApiKeyFormat("dev-token")).toBe(false);
    });
  });

  describe("third-party secret patterns", () => {
    // Stripe secret-key patterns, copied from the two scanners:
    // - gitleaks, rule `stripe-access-token` (config/gitleaks.toml): the body of
    //   its expression only — the trailing context group that follows it uses
    //   syntax JavaScript does not compile;
    // - trufflehog, detector `stripe` (pkg/detectors/stripe/stripe.go).
    const thirdParty: Array<[string, RegExp]> = [
      ["gitleaks stripe-access-token", /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})/],
      ["trufflehog stripe", /[rs]k_live_[a-zA-Z0-9]{20,247}/],
    ];
    const contexts: Array<[string, (key: string) => string]> = [
      ["bare", (key) => key],
      ["in an Authorization header", (key) => `curl -H "Authorization: Bearer ${key}"`],
      ["in an environment line", (key) => `SKRUN_CLOUD_API_TOKEN=${key}`],
    ];

    it.each(thirdParty)("no generated key matches %s, in any context", (_name, pattern) => {
      for (let i = 0; i < SAMPLE; i++) {
        const { key } = generateApiKey();
        for (const [, wrap] of contexts) {
          expect(pattern.test(wrap(key))).toBe(false);
        }
      }
    });

    it.each(thirdParty)("a whole key of the retired format still matches %s", (_name, pattern) => {
      // The positive witness: the pattern as copied does catch what it caught
      // before, so the test above cannot pass on a pattern that matches nothing.
      const retired = `${RETIRED_API_KEY_PREFIX}${"0123456789abcdef".repeat(2)}`;
      for (const [, wrap] of contexts) {
        expect(pattern.test(wrap(retired))).toBe(true);
      }
    });
  });

  describe("our own names are never shaped like a key", () => {
    // Cookie, table, column and label names of ours that start with the brand.
    // None holds the key prefix, in any letter case: a bearer that starts with
    // it is read as a key whatever its case, and a scanner rule matching on the
    // prefix would flag every line that writes such a name. The name itself is
    // checked — `name=value` is never a whole key shape, whatever the name, so
    // searching that line for one would pass a name that began with the prefix.
    const names = [
      "skrun_session",
      "__Host-skrun_session",
      "skrun_oauth_state",
      "skrun_device_user_code",
      "skrun_device_csrf",
      "_skrun_migrations",
      "__Secure-skrun_session",
      "skrun_run_id",
      "skrun_pool_id",
      "skrun_lifetime_end",
      "skrun_run_admission_account",
      "skrun_run_admission_instance",
      "skrun_smoke_id",
      "skrun_runtime",
    ];
    it.each(names)("%s does not hold the key prefix, in any letter case", (name) => {
      expect(name.toLowerCase()).not.toContain(API_KEY_PREFIX.toLowerCase());
    });

    it("one of these names with a generated key as value is a key shape", () => {
      const { key } = generateApiKey();
      expect(apiKeyShapes(`skrun_session=${key}`)).toEqual([key]);
    });
  });

  describe("apiKeyShapes", () => {
    it("finds a whole key of the current format in surrounding text", () => {
      const { key } = generateApiKey();
      expect(apiKeyShapes(`<p>Your key: ${key}</p>`)).toEqual([key]);
    });

    it("finds a key copied with a wrong checksum: the shape is enough", () => {
      const { key } = generateApiKey();
      const typo = `${key.slice(0, -1)}${key.slice(-1) === "0" ? "1" : "0"}`;
      expect(apiKeyShapes(`token=${typo}`)).toEqual([typo]);
    });

    it("finds a whole key of the retired format", () => {
      const retired = `${RETIRED_API_KEY_PREFIX}${"0a".repeat(16)}`;
      expect(apiKeyShapes(`Bearer ${retired}`)).toEqual([retired]);
    });

    it("finds both formats, in text order", () => {
      const { key } = generateApiKey();
      const retired = `${RETIRED_API_KEY_PREFIX}${"f".repeat(32)}`;
      expect(apiKeyShapes(`${retired} then ${key}`)).toEqual([retired, key]);
    });

    it("returns nothing for a truncated example or a bare prefix", () => {
      expect(apiKeyShapes(`${API_KEY_PREFIX}3f9a… and ${API_KEY_PREFIX}*`)).toEqual([]);
      expect(apiKeyShapes(`${RETIRED_API_KEY_PREFIX}abc…`)).toEqual([]);
      expect(apiKeyShapes("")).toEqual([]);
    });

    it("returns nothing for a key one character short", () => {
      const { key } = generateApiKey();
      expect(apiKeyShapes(key.slice(0, KEY_LENGTH - 1))).toEqual([]);
    });
  });
});
