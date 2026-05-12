import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_MIME_TYPES,
  FileInputFieldSchema,
  resolveFileInputDefaults,
} from "./file-input.js";
import { InputFieldSchema, PrimitiveInputFieldSchema } from "./inputs-outputs.js";

describe("FileInputFieldSchema", () => {
  it("parses a minimal file input with media: image", () => {
    const result = FileInputFieldSchema.parse({
      name: "photo",
      type: "file",
      media: "image",
    });
    expect(result.name).toBe("photo");
    expect(result.type).toBe("file");
    expect(result.media).toBe("image");
  });

  it("rejects unknown media type with ZodError", () => {
    expect(() => FileInputFieldSchema.parse({ name: "x", type: "file", media: "video" })).toThrow();
  });

  it("applies default max_size per media via resolveFileInputDefaults", () => {
    const imageField = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "image",
    });
    expect(resolveFileInputDefaults(imageField).max_size).toBe(DEFAULT_MAX_SIZE.image);

    const documentField = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "document",
    });
    expect(resolveFileInputDefaults(documentField).max_size).toBe(DEFAULT_MAX_SIZE.document);

    const audioField = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "audio",
    });
    expect(resolveFileInputDefaults(audioField).max_size).toBe(DEFAULT_MAX_SIZE.audio);
  });

  it("applies default mime_types per media via resolveFileInputDefaults", () => {
    const imageField = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "image",
    });
    expect(resolveFileInputDefaults(imageField).mime_types).toEqual([...DEFAULT_MIME_TYPES.image]);

    const documentField = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "document",
    });
    expect(resolveFileInputDefaults(documentField).mime_types).toEqual([
      ...DEFAULT_MIME_TYPES.document,
    ]);
  });

  it("preserves explicit mime_types and max_size when provided", () => {
    const field = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "image",
      mime_types: ["image/jpeg"],
      max_size: 1_000_000,
    });
    const resolved = resolveFileInputDefaults(field);
    expect(resolved.mime_types).toEqual(["image/jpeg"]);
    expect(resolved.max_size).toBe(1_000_000);
  });

  it("defaults required to true and max_count to 1", () => {
    const field = FileInputFieldSchema.parse({
      name: "x",
      type: "file",
      media: "image",
    });
    expect(field.required).toBe(true);
    expect(field.max_count).toBe(1);
  });

  it("rejects max_count <= 0", () => {
    expect(() =>
      FileInputFieldSchema.parse({
        name: "x",
        type: "file",
        media: "image",
        max_count: 0,
      }),
    ).toThrow();
  });

  it("rejects max_size <= 0", () => {
    expect(() =>
      FileInputFieldSchema.parse({
        name: "x",
        type: "file",
        media: "image",
        max_size: -1,
      }),
    ).toThrow();
  });

  it("requires non-empty name", () => {
    expect(() => FileInputFieldSchema.parse({ name: "", type: "file", media: "image" })).toThrow();
  });
});

describe("InputFieldSchema discriminated union", () => {
  it("accepts a file branch", () => {
    const result = InputFieldSchema.parse({
      name: "photo",
      type: "file",
      media: "image",
    });
    expect(result.type).toBe("file");
  });

  it("accepts a primitive branch (string)", () => {
    const result = InputFieldSchema.parse({
      name: "question",
      type: "string",
    });
    expect(result.type).toBe("string");
    expect(result.name).toBe("question");
  });

  it("accepts every primitive type", () => {
    for (const t of ["string", "number", "boolean", "object", "array"] as const) {
      const result = InputFieldSchema.parse({ name: "x", type: t });
      expect(result.type).toBe(t);
    }
  });

  it("rejects an unknown type discriminator", () => {
    expect(() => InputFieldSchema.parse({ name: "x", type: "unknown" })).toThrow();
  });

  it("rejects a file branch missing media", () => {
    expect(() => InputFieldSchema.parse({ name: "x", type: "file" })).toThrow();
  });
});

describe("PrimitiveInputFieldSchema (regression)", () => {
  it("still validates the legacy string input shape", () => {
    const result = PrimitiveInputFieldSchema.parse({
      name: "q",
      type: "string",
      required: false,
      description: "the question",
    });
    expect(result).toEqual({
      name: "q",
      type: "string",
      required: false,
      description: "the question",
    });
  });
});
