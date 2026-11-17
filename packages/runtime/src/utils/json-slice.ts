/**
 * The JSON object a model's answer carries, as the agent loop reads it: the
 * text from the answer's first `{` to its last `}`, when a `}` comes after
 * that `{`; `undefined` when none does — no `{`, or every `}` before it.
 *
 * The same slice a greedy match of a `{`, then anything — line ends
 * included —, then a `}` finds: from the first `{` it takes everything up to
 * the last `}` after it, and when no `}` follows the first `{`, none follows
 * any later one either, so it finds nothing. Found here in linear time — one
 * search from each end — where such a pattern tries every `{` as a start and
 * runs to the end of the text from each: on an answer of many `{` and no `}`,
 * time quadratic in its length, during which the process serves nothing else.
 *
 * Both count UTF-16 code units, as a pattern without the `u` flag does: a
 * character outside the Basic Multilingual Plane is two units, never split by
 * a `{` or a `}`, which are one.
 */
export function jsonObjectSlice(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  const end = text.lastIndexOf("}");
  return end > start ? text.slice(start, end + 1) : undefined;
}
