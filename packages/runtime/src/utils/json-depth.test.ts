import { describe, expect, it } from "vitest";
import { exceedsNestingDepth, MAX_JSON_NESTING_DEPTH } from "./json-depth.js";

/** An object `levels` levels deep, the object itself the first: `{ n: { n: … 1 } }`. */
function objectsDeep(levels: number): Record<string, unknown> {
  let value: unknown = 1;
  for (let level = 0; level < levels; level++) value = { n: value };
  return value as Record<string, unknown>;
}

/** An array `levels` levels deep: `[[…[]]]`. */
function arraysDeep(levels: number): unknown[] {
  let value: unknown[] = [];
  for (let level = 1; level < levels; level++) value = [value];
  return value;
}

describe("exceedsNestingDepth — how deeply a JSON value nests", () => {
  it("the bound is 100 levels", () => {
    expect(MAX_JSON_NESTING_DEPTH).toBe(100);
  });

  it("an object or an array is a level, anything else none", () => {
    expect(exceedsNestingDepth({}, 0)).toBe(true);
    expect(exceedsNestingDepth([], 0)).toBe(true);
    expect(exceedsNestingDepth({}, 1)).toBe(false);
    for (const leaf of ["text", 1, true, null, undefined]) {
      expect(exceedsNestingDepth(leaf, 0)).toBe(false);
    }
    expect(exceedsNestingDepth({ a: "x", b: [1, 2], c: { d: null } }, 2)).toBe(false);
    expect(exceedsNestingDepth({ a: "x", b: [1, [2]], c: { d: null } }, 2)).toBe(true);
  });

  it("100 levels pass the bound, 101 exceed it — objects, arrays, and the two mixed", () => {
    expect(exceedsNestingDepth(objectsDeep(100))).toBe(false);
    expect(exceedsNestingDepth(objectsDeep(101))).toBe(true);
    expect(exceedsNestingDepth(arraysDeep(100))).toBe(false);
    expect(exceedsNestingDepth(arraysDeep(101))).toBe(true);
    expect(exceedsNestingDepth({ list: arraysDeep(99) })).toBe(false);
    expect(exceedsNestingDepth({ list: arraysDeep(100) })).toBe(true);
  });

  // The walk holds one frame per level it has open, never one per sibling
  // still to visit: across the call, the heap does not grow with the width.
  // Each value is built just before it is measured, ahead of the cases that
  // leave garbage behind: a collection during the call would hide a growth.
  // Wide margins, for a slow machine: on a developer's machine, under 0.2 MB
  // for the array and about 5 MB for the object (its keys, while it is open);
  // a walk that held each sibling still to visit grew it by 50 to 130 MB for
  // the array.
  it("measures a wide value with a branch past the bound without holding anything per sibling: the heap does not grow with the width", () => {
    const heapGrowth = (wide: unknown) => {
      const heapBefore = process.memoryUsage().heapUsed;
      const exceeds = exceedsNestingDepth(wide);
      return { exceeds, grownBytes: process.memoryUsage().heapUsed - heapBefore };
    };

    const wideArray: unknown[] = Array.from({ length: 1_000_000 }, () => []);
    wideArray.push(arraysDeep(150));
    const array = heapGrowth(wideArray);
    expect(array.exceeds).toBe(true);
    expect(array.grownBytes).toBeLessThan(16 * 1024 * 1024);

    const wideObject: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 300_000 }, (_, i) => [`k${i}`, i]),
    );
    wideObject.last = objectsDeep(150);
    const object = heapGrowth(wideObject);
    expect(object.exceeds).toBe(true);
    expect(object.grownBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("only the deepest branch counts: a wide value of shallow branches passes", () => {
    const wide = { items: Array.from({ length: 10_000 }, (_, i) => ({ i, tags: [String(i)] })) };
    expect(exceedsNestingDepth(wide)).toBe(false);
    wide.items.push({ i: -1, tags: [JSON.stringify(objectsDeep(200))] });
    // A string is a leaf, whatever it spells.
    expect(exceedsNestingDepth(wide)).toBe(false);
    expect(exceedsNestingDepth({ ...wide, last: objectsDeep(98) })).toBe(false);
    expect(exceedsNestingDepth({ ...wide, last: objectsDeep(99) })).toBe(false);
    expect(exceedsNestingDepth({ ...wide, last: objectsDeep(100) })).toBe(true);
  });

  it("a very wide value with one branch past the bound exceeds it, wherever the branch sits; the same value without it does not", () => {
    const wideArray: unknown[] = Array.from({ length: 200_000 }, () => []);
    expect(exceedsNestingDepth(wideArray)).toBe(false);
    expect(exceedsNestingDepth([...wideArray, arraysDeep(100)])).toBe(true);
    expect(exceedsNestingDepth([arraysDeep(100), ...wideArray])).toBe(true);
    expect(exceedsNestingDepth([...wideArray, arraysDeep(99)])).toBe(false);

    const wideObject: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i % 2 === 0 ? {} : i]),
    );
    expect(exceedsNestingDepth(wideObject)).toBe(false);
    expect(exceedsNestingDepth({ ...wideObject, last: objectsDeep(100) })).toBe(true);
    expect(exceedsNestingDepth({ first: objectsDeep(100), ...wideObject })).toBe(true);
    expect(exceedsNestingDepth({ ...wideObject, last: objectsDeep(99) })).toBe(false);
  });

  // Measured with a stack of its own: a value nested past what the call stack
  // holds — past what JSON.stringify writes — is measured, never thrown on.
  it("a value nested a million levels deep is measured without throwing", () => {
    const deep = objectsDeep(1_000_000);
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    expect(exceedsNestingDepth(deep)).toBe(true);
    expect(exceedsNestingDepth(deep, 1_000_000)).toBe(false);
  });

  it("a value that contains itself ends the walk at the first level past the bound", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    loop.again = [loop];
    expect(exceedsNestingDepth(loop)).toBe(true);
  });
});
