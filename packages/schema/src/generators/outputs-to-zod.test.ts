import { describe, expect, it } from "vitest";
import type { OutputField } from "../schemas/index.js";
import { outputsToZod } from "./outputs-to-zod.js";

describe("outputsToZod", () => {
  describe("type mapping", () => {
    it("maps string field", () => {
      const schema = outputsToZod([{ name: "title", type: "string" }]);
      expect(schema.safeParse({ title: "hello" }).success).toBe(true);
      expect(schema.safeParse({ title: 42 }).success).toBe(false);
    });

    it("maps number field", () => {
      const schema = outputsToZod([{ name: "count", type: "number" }]);
      expect(schema.safeParse({ count: 42 }).success).toBe(true);
      expect(schema.safeParse({ count: "42" }).success).toBe(false);
    });

    it("maps boolean field", () => {
      const schema = outputsToZod([{ name: "ok", type: "boolean" }]);
      expect(schema.safeParse({ ok: true }).success).toBe(true);
      expect(schema.safeParse({ ok: "true" }).success).toBe(false);
    });

    it("maps array field (any element shape)", () => {
      const schema = outputsToZod([{ name: "items", type: "array" }]);
      expect(schema.safeParse({ items: [] }).success).toBe(true);
      expect(schema.safeParse({ items: [1, "two", { three: 3 }] }).success).toBe(true);
      expect(schema.safeParse({ items: "not-array" }).success).toBe(false);
    });

    it("maps object field (any internal shape, passthrough)", () => {
      const schema = outputsToZod([{ name: "meta", type: "object" }]);
      expect(schema.safeParse({ meta: {} }).success).toBe(true);
      expect(schema.safeParse({ meta: { a: 1, b: "two", c: { nested: true } } }).success).toBe(
        true,
      );
      expect(schema.safeParse({ meta: [1, 2] }).success).toBe(false);
    });
  });

  describe("validation semantics", () => {
    const outputs: OutputField[] = [
      { name: "title", type: "string" },
      { name: "count", type: "number" },
    ];

    it("fails when a declared key is missing", () => {
      const schema = outputsToZod(outputs);
      const result = schema.safeParse({ title: "hello" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const missing = result.error.issues.map((i) => i.path.join("."));
        expect(missing).toContain("count");
      }
    });

    it("accepts extra top-level keys", () => {
      const schema = outputsToZod(outputs);
      const result = schema.safeParse({
        title: "hello",
        count: 1,
        extra: "ignored",
        another: 42,
      });
      expect(result.success).toBe(true);
    });

    it("passes regardless of internal nested-object shape", () => {
      const schema = outputsToZod([{ name: "meta", type: "object" }]);
      const result = schema.safeParse({
        meta: {
          deeply: { nested: { value: [1, 2, 3] } },
          mixedTypes: { s: "x", n: 0, b: false, a: [], o: {} },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns an empty object schema when outputs is empty", () => {
      const schema = outputsToZod([]);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ extra: "ignored" }).success).toBe(true);
    });

    it("supports multiple fields of mixed types", () => {
      const outputs: OutputField[] = [
        { name: "title", type: "string" },
        { name: "count", type: "number" },
        { name: "ok", type: "boolean" },
        { name: "items", type: "array" },
        { name: "meta", type: "object" },
      ];
      const schema = outputsToZod(outputs);
      expect(
        schema.safeParse({
          title: "hello",
          count: 1,
          ok: true,
          items: [1, 2, 3],
          meta: { a: 1 },
        }).success,
      ).toBe(true);
    });
  });
});
