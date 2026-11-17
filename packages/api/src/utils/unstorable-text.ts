/**
 * The two forms of text a Postgres `jsonb` column refuses: U+0000, the NUL
 * character, whose escape `JSON.stringify` writes as `\u0000`, and a lone
 * surrogate, half of a UTF-16 pair without its other half, whose escape
 * (`\ud800`) it refuses too. A `text` column refuses the first only — it
 * holds no NUL byte —: a lone surrogate never reaches it as it is, the driver
 * writing a text parameter as UTF-8, which turns it into U+FFFD (read in the
 * driver's code, `pg-protocol`). SQLite and the memory store accept both: a
 * value that holds one is stored on those backends and refused on Postgres.
 */

/** A high surrogate with no low one after it, or a low one with no high one before it. */
export const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** U+0000, the NUL character. */
export const NUL = String.fromCodePoint(0);

/** Which of the two forms a text holds. */
export type UnstorableForm = "nul" | "lone_surrogate";

/**
 * The form `text` holds — the NUL character when it holds both —, or `null`
 * when it holds neither. A valid surrogate pair (an emoji) is no lone surrogate.
 */
export function unstorableForm(text: string): UnstorableForm | null {
  if (text.includes(NUL)) return "nul";
  // `search` ignores the expression's `lastIndex`: the shared `g` flag keeps no state here.
  return text.search(LONE_SURROGATE) === -1 ? null : "lone_surrogate";
}
