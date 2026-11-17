import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./content-disposition.js";

/** The two parameters of a disposition this module produced. */
function parse(value: string): { fallback: string; exact: string } {
  const match =
    /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/.exec(value);
  if (!match) throw new Error(`Not an attachment disposition: ${JSON.stringify(value)}`);
  return { fallback: match[1] ?? "", exact: decodeURIComponent(match[2] ?? "") };
}

/** A header value any HTTP stack sends: one line, printable ASCII only. */
function expectOneSafeLine(value: string): void {
  expect(value).toMatch(/^[\x20-\x7e]+$/);
  expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
}

describe("attachmentDisposition", () => {
  it("names a plain file the same way in both parameters", () => {
    expect(attachmentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it.each([
    ["a quote", 'the "final" report.txt', "the _final_ report.txt"],
    ["a backslash", "a\\b.txt", "a_b.txt"],
    ["a CR and a LF (an injected header)", "a.txt\r\nSet-Cookie: x=1", "a.txt__Set-Cookie: x=1"],
    ["characters beyond ASCII", "résumé 报告.txt", "r_sum_ __.txt"],
    ["a percent sign", "100%.txt", "100_.txt"],
    ["characters encodeURIComponent keeps", "it's (a*b).txt", "it's (a*b).txt"],
  ])("keeps a name with %s on one line: a safe fallback, the exact name in filename*", (_, name, fallback) => {
    const value = attachmentDisposition(name);

    expectOneSafeLine(value);
    expect(parse(value)).toEqual({ fallback, exact: name });
  });

  it("encodes every byte outside the RFC's attr-char set in filename*", () => {
    const value = attachmentDisposition("it's (a*b) é.txt");

    expect(value).toContain("filename*=UTF-8''it%27s%20%28a%2Ab%29%20%C3%A9.txt");
  });

  it("gives a bare attachment for an empty name", () => {
    expect(attachmentDisposition("")).toBe("attachment");
  });

  it("never throws, a lone surrogate included", () => {
    const value = attachmentDisposition("bad\ud800.txt");

    expectOneSafeLine(value);
    expect(parse(value).fallback).toBe("bad_.txt");
  });
});
