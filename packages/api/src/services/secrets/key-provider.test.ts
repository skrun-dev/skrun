import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAad,
  EnvKeyProvider,
  getKeyProvider,
  KEY_ENVELOPE_VERSION,
  MASTER_KEY_BYTES,
} from "./key-provider.js";

const KEY = Buffer.alloc(MASTER_KEY_BYTES, 7); // deterministic 32-byte master key
const AAD = buildAad("agent-1", "anthropic", 1);

function provider(): EnvKeyProvider {
  return new EnvKeyProvider(KEY);
}

describe("EnvKeyProvider (AES-256-GCM)", () => {
  it("VT-2: round-trips and uses a fresh random IV per encryption", () => {
    const p = provider();
    const ct1 = p.encrypt("sk-secret-value", AAD);
    const ct2 = p.encrypt("sk-secret-value", AAD);
    // Random 96-bit IV → identical plaintext+AAD encrypts differently each time.
    expect(ct1).not.toBe(ct2);
    expect(p.decrypt(ct1, AAD)).toBe("sk-secret-value");
    expect(p.decrypt(ct2, AAD)).toBe("sk-secret-value");
  });

  it("VT-3: rejects a tampered ciphertext (GCM integrity)", () => {
    const p = provider();
    const buf = Buffer.from(p.encrypt("plaintext", AAD), "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => p.decrypt(buf.toString("base64"), AAD)).toThrow();
  });

  it("VT-3: rejects a tampered auth tag", () => {
    const p = provider();
    const buf = Buffer.from(p.encrypt("plaintext", AAD), "base64");
    buf[14] ^= 0xff; // tag region is bytes 13..28
    expect(() => p.decrypt(buf.toString("base64"), AAD)).toThrow();
  });

  it("VT-4: a ciphertext does not decrypt under a different AAD", () => {
    const p = provider();
    const envelope = p.encrypt("plaintext", buildAad("agent-A", "anthropic", 1));
    expect(() => p.decrypt(envelope, buildAad("agent-B", "anthropic", 1))).toThrow();
    expect(() => p.decrypt(envelope, buildAad("agent-A", "openai", 1))).toThrow();
    expect(() => p.decrypt(envelope, buildAad("agent-A", "anthropic", 2))).toThrow();
  });

  it("VT-5: rejects an unknown envelope version", () => {
    const p = provider();
    const buf = Buffer.from(p.encrypt("x", AAD), "base64");
    buf[0] = 0xff; // unknown version byte
    expect(() => p.decrypt(buf.toString("base64"), AAD)).toThrow(/version/i);
  });

  it("rejects a too-short envelope", () => {
    const p = provider();
    const bogus = Buffer.from([KEY_ENVELOPE_VERSION, 1, 2, 3]).toString("base64");
    expect(() => p.decrypt(bogus, AAD)).toThrow();
  });

  it("unconfigured provider: isConfigured() false and encrypt/decrypt throw", () => {
    const p = new EnvKeyProvider(null);
    expect(p.isConfigured()).toBe(false);
    expect(() => p.encrypt("x", AAD)).toThrow();
    expect(() => p.decrypt("x", AAD)).toThrow();
  });
});

describe("buildAad", () => {
  it("is deterministic and length-prefixed (unambiguous)", () => {
    expect(buildAad("a", "bc", 1).equals(buildAad("a", "bc", 1))).toBe(true);
    // Length-prefixing prevents (a|bc) from colliding with (ab|c).
    expect(buildAad("a", "bc", 1).equals(buildAad("ab", "c", 1))).toBe(false);
    // The version is part of the AAD.
    expect(buildAad("a", "bc", 1).equals(buildAad("a", "bc", 2))).toBe(false);
  });
});

describe("getKeyProvider (factory + boot interlock)", () => {
  const ENV = "SKRUN_SECRETS_ENCRYPTION_KEY";
  function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env[ENV];
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  }

  it("unset → unconfigured (no throw)", () => {
    withEnv(undefined, () => {
      expect(getKeyProvider().isConfigured()).toBe(false);
    });
  });

  it("valid 32-byte base64 → configured and round-trips", () => {
    withEnv(randomBytes(MASTER_KEY_BYTES).toString("base64"), () => {
      const p = getKeyProvider();
      expect(p.isConfigured()).toBe(true);
      expect(p.decrypt(p.encrypt("v", AAD), AAD)).toBe("v");
    });
  });

  it("valid 64-char hex → configured", () => {
    withEnv(randomBytes(MASTER_KEY_BYTES).toString("hex"), () => {
      expect(getKeyProvider().isConfigured()).toBe(true);
    });
  });

  it("malformed (wrong length) → throws (boot interlock)", () => {
    withEnv("too-short", () => {
      expect(() => getKeyProvider()).toThrow(/32 bytes/);
    });
  });
});
