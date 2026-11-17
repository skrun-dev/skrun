import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getOpenAPISchema } from "../openapi.js";
import { API_KEY_PREFIX, generateApiKey } from "./api-key.js";

/**
 * The key format is published in words — the API reference, the OpenAPI
 * description of key authentication, the self-hosting guide — so that a secret
 * scanner can recognise a key and verify its checksum without calling the
 * server. Only the prefix in the OpenAPI text comes from the constant; every
 * number and the checksum's encoding are written by hand. This test reads each
 * number from the published text and checks it against keys the code mints:
 * the lengths, and the checksum recomputed exactly as the text describes it.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SAMPLE = 200;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const WORDS: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** A published page, read from the repository. */
function page(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

/** The one line of `text` that starts with `start`, its inline-code backticks removed. */
function lineStarting(text: string, start: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith(start));
  expect(lines, `one line starting with "${start}"`).toHaveLength(1);
  return lines[0].replaceAll("`", "");
}

/** The checksum as the published text describes it. */
function describedChecksum(body: string, length: number): string {
  // The CRC-32 of the body's ASCII bytes, in base62 (digits, A-Z, a-z), most
  // significant digit first, left-padded with 0.
  let value = BigInt(crc32(Buffer.from(body, "ascii")));
  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out.padStart(length, "0");
}

/** The format sentence the API reference and the OpenAPI description share. */
const FORMAT =
  /(\S+?),? followed by (\d+) characters of 0-9A-Za-z, (\d+) in all: (\d+) random characters, then a (\d+)-character checksum of them\. The checksum is the CRC-32 \(IEEE, as zlib computes it\) of the (\d+) characters taken as ASCII bytes, written in base62 \(digits, then A-Z, then a-z\), most significant digit first, left-padded with 0 to (\d+) characters\./;

/** Checks the numbers of a format sentence against minted keys. */
function expectFormatOfMintedKeys(sentence: string): void {
  const match = FORMAT.exec(sentence);
  expect(match, "the format sentence, as published").not.toBeNull();
  const [, prefix, rest, total, random, sum, randomAgain, sumAgain] = match as RegExpExecArray;
  expect(prefix).toBe(API_KEY_PREFIX);
  expect(Number(randomAgain)).toBe(Number(random));
  expect(Number(sumAgain)).toBe(Number(sum));
  expect(Number(rest)).toBe(Number(random) + Number(sum));
  expect(Number(total)).toBe(prefix.length + Number(rest));
  const shape = new RegExp(`^${prefix}[0-9A-Za-z]{${rest}}$`);
  for (let i = 0; i < SAMPLE; i++) {
    const { key } = generateApiKey();
    expect(key).toHaveLength(Number(total));
    expect(key).toMatch(shape);
    const body = key.slice(prefix.length, prefix.length + Number(random));
    expect(key).toBe(`${prefix}${body}${describedChecksum(body, Number(sum))}`);
  }
}

describe("the key format the docs publish", () => {
  const reference = lineStarting(page("docs/api.md"), "API keys start with `");

  it("the API reference states the lengths and the checksum of the keys the code mints", () => {
    expectFormatOfMintedKeys(reference);
  });

  it("the API reference states the key prefix that key lists show", () => {
    const shown =
      /shows each key by its first (\d+) characters, (\S+) and the first (\d+) random characters\./.exec(
        reference,
      );
    expect(shown, "the sentence on the shown prefix, as published").not.toBeNull();
    const [, length, prefix, visible] = shown as RegExpExecArray;
    expect(prefix).toBe(API_KEY_PREFIX);
    expect(Number(length)).toBe(prefix.length + Number(visible));
    for (let i = 0; i < SAMPLE; i++) {
      const { key, keyPrefix } = generateApiKey();
      expect(keyPrefix).toHaveLength(Number(length));
      expect(keyPrefix).toBe(key.slice(0, Number(length)));
    }
  });

  it("the OpenAPI description of key authentication states the same format", () => {
    const schemes = getOpenAPISchema().components.securitySchemes as Record<
      string,
      { description: string }
    >;
    expectFormatOfMintedKeys(schemes.apiKeyAuth.description);
  });

  it("the self-hosting guide states the same prefix, length and checksum length", () => {
    const line = lineStarting(page("docs/self-hosting.md"), "Keys start with `");
    const match =
      /^Keys start with (\S+?), followed by (\d+) characters of 0-9A-Za-z, the last (\w+) a checksum/.exec(
        line,
      );
    expect(match, "the format sentence, as published").not.toBeNull();
    const [, prefix, rest, last] = match as RegExpExecArray;
    expect(prefix).toBe(API_KEY_PREFIX);
    const sum = WORDS[last] ?? (/^\d+$/.test(last) ? Number(last) : undefined);
    expect(sum, `"${last}" is a number word or a number`).toBeDefined();
    for (let i = 0; i < SAMPLE; i++) {
      const { key } = generateApiKey();
      expect(key).toHaveLength(prefix.length + Number(rest));
      const body = key.slice(prefix.length, key.length - sum);
      expect(key.slice(-sum)).toBe(describedChecksum(body, sum));
    }
  });
});
