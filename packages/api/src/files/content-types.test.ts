import { describe, expect, it } from "vitest";
import { contentTypeFor } from "./content-types.js";

describe("contentTypeFor", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    ["photo.png", "image/png"],
    ["photo.JPG", "image/jpeg"],
    ["picture.webp", "image/webp"],
    ["diagram.svg", "image/svg+xml"],
    ["data.csv", "text/csv"],
    ["notes.md", "text/markdown"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("types %s as %s", (name, type) => {
    expect(contentTypeFor(name)).toBe(type);
  });

  it.each(["archive.tar.gz", "binary", "noext."])("falls back to octet-stream for %s", (name) => {
    expect(contentTypeFor(name)).toBe("application/octet-stream");
  });
});
