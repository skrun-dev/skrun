/**
 * The `Content-Disposition` value that makes a response a download named
 * `name` (RFC 6266): `attachment; filename="<fallback>"; filename*=UTF-8''<name>`.
 *
 * - `filename*` (RFC 8187) carries the exact name, percent-encoded as UTF-8
 *   bytes: every byte outside the RFC's `attr-char` set is encoded, so a quote,
 *   a backslash, a CR, a LF or a non-ASCII character can neither end the value
 *   nor split the header.
 * - `filename` is the fallback for clients that ignore `filename*`: printable
 *   ASCII only, with `"`, `\` and `%` — and every control or non-ASCII
 *   character — replaced by `_`. It can never break its quotes.
 *
 * The result is always a single line of printable ASCII, which any HTTP stack
 * accepts as a header value. An empty name gives a bare `attachment`: the
 * client names the download from the URL.
 */
export function attachmentDisposition(name: string): string {
  if (name === "") return "attachment";
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeExtValue(name)}`;
}

/** Printable ASCII, minus the three characters a quoted fallback must not carry. */
function asciiFallback(name: string): string {
  let out = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code <= 0x7e;
    out += printable && char !== '"' && char !== "\\" && char !== "%" ? char : "_";
  }
  return out;
}

/** RFC 8187 `attr-char`: the only bytes an `ext-value` may carry unencoded. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/** The name's UTF-8 bytes, each outside `attr-char` as `%XX`. Never throws. */
function encodeExtValue(name: string): string {
  let out = "";
  for (const byte of Buffer.from(name, "utf8")) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
