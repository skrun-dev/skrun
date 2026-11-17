import { describe, expect, it } from "vitest";
import { findRetiredFields, RETIRED_FIELDS, type RetiredField } from "./retired-fields.js";

describe("findRetiredFields", () => {
  it("names environment.sandbox, whatever its value", () => {
    for (const value of ["strict", "permissive", null, {}]) {
      expect(findRetiredFields({ environment: { sandbox: value } })).toEqual([
        {
          code: "RETIRED_FIELD",
          field: "environment.sandbox",
          message: "environment.sandbox has no effect and is ignored — remove it.",
        },
      ]);
    }
  });

  it("finds nothing in a document without a retired field", () => {
    expect(findRetiredFields({ environment: { timeout: "300s" } })).toEqual([]);
    expect(findRetiredFields({ name: "a" })).toEqual([]);
    expect(findRetiredFields({ environment: null })).toEqual([]);
    expect(findRetiredFields({ environment: "sandbox" })).toEqual([]);
    expect(findRetiredFields(null)).toEqual([]);
    expect(findRetiredFields("environment")).toEqual([]);
    expect(findRetiredFields(undefined)).toEqual([]);
  });

  it("does not take an inherited key for a present one", () => {
    const environment = Object.create({ sandbox: "strict" }) as Record<string, unknown>;
    expect(findRetiredFields({ environment })).toEqual([]);
  });

  it("works on any list of fields, at any depth — one issue per field present", () => {
    const fields: RetiredField[] = [
      { path: ["environment", "old_setting"], message: "old_setting is gone" },
      { path: ["a", "b", "c"], message: "c is gone" },
      { path: ["top"], message: "top is gone" },
    ];
    const issues = findRetiredFields(
      { environment: { old_setting: "on" }, a: { b: { c: 1 } }, other: true },
      fields,
    );
    expect(issues.map((i) => [i.field, i.message])).toEqual([
      ["environment.old_setting", "old_setting is gone"],
      ["a.b.c", "c is gone"],
    ]);
  });

  it("lists environment.sandbox and environment.filesystem, and every entry has a path and a message", () => {
    expect(RETIRED_FIELDS.map((f) => f.path.join("."))).toContain("environment.sandbox");
    expect(RETIRED_FIELDS.map((f) => f.path.join("."))).toContain("environment.filesystem");
    for (const field of RETIRED_FIELDS) {
      expect(field.path.length).toBeGreaterThan(0);
      expect(field.message).toMatch(new RegExp(field.path.join("\\.")));
    }
  });
});
