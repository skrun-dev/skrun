/**
 * How deeply a JSON value may nest, in levels: the value itself, when it is an
 * object or an array, is the first; each object or array inside another is
 * one more. One bound for every value a run is handed: the API refuses a
 * run whose input nests deeper (`400 INVALID_INPUT_TYPE`), the agent loop an
 * output and the state an answer would have the run keep (`OUTPUT_SCHEMA_INVALID`,
 * as any invalid output: no notebook keeps a state nested deeper) and a tool
 * call's arguments (an error result, the tool not called), and a run's row keeps a
 * marker in place of a value nested deeper, should one reach it all the
 * same. Far below what breaks downstream: `JSON.stringify` overflows the
 * call stack past a few thousand levels, and Postgres `jsonb` refuses a value
 * past about sixteen thousand.
 */
export const MAX_JSON_NESTING_DEPTH = 100;

/**
 * Whether `value` nests deeper than `maxDepth` levels, counted as
 * `MAX_JSON_NESTING_DEPTH` counts them: an object or an array is a level, and
 * anything else none. Never by recursion — a value nested too deeply for the
 * call stack is measured all the same, and the walk never throws for it —
 * and stopped at the first level past `maxDepth`, which also ends the walk of
 * a value that contains itself.
 *
 * Walked with a cursor: one frame per level open on the way down, never more
 * than `maxDepth`, each holding that level's object or array and the index of
 * the next child to look at — nothing held per sibling still to visit. An
 * array is read in place. An object, once opened, is read through the list of
 * its keys (`Object.keys`: one reference per member, dropped when the object
 * is closed). An object's members can be resumed from no handle of its own,
 * and its keys cost the least of the lists that would do: about eight bytes a
 * member where its values, for an object of hundreds of thousands of members,
 * cost several times that. So what the walk holds grows with the depth it
 * reaches and the members of the objects open along it, never with the width
 * of the rest.
 */
export function exceedsNestingDepth(
  value: unknown,
  maxDepth: number = MAX_JSON_NESTING_DEPTH,
): boolean {
  if (value === null || typeof value !== "object") return false;
  if (1 > maxDepth) return true;
  const nodes: object[] = [value];
  const keys: Array<string[] | null> = [keysOf(value)];
  const next: number[] = [0];
  while (nodes.length > 0) {
    const level = nodes.length - 1;
    const node = nodes[level];
    const names = keys[level];
    const index = next[level];
    if (index === (names === null ? (node as unknown[]).length : names.length)) {
      nodes.pop();
      keys.pop();
      next.pop();
      continue;
    }
    next[level] = index + 1;
    const child =
      names === null ? (node as unknown[])[index] : (node as Record<string, unknown>)[names[index]];
    if (child !== null && typeof child === "object") {
      // The child is one level below the frames open: its own level.
      if (nodes.length + 1 > maxDepth) return true;
      nodes.push(child);
      keys.push(keysOf(child));
      next.push(0);
    }
  }
  return false;
}

/** An object's keys, or `null` for an array — read in place, by index. */
function keysOf(node: object): string[] | null {
  return Array.isArray(node) ? null : Object.keys(node);
}
