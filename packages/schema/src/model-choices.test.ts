import { describe, expect, it } from "vitest";
import * as schema from "./index.js";
import { MODEL_CHOICES } from "./model-choices.js";
import { ModelConfigSchema } from "./schemas/model-config.js";
import { findRetiredModels } from "./schemas/retired-models.js";

describe("MODEL_CHOICES", () => {
  it("is not empty", () => {
    expect(MODEL_CHOICES.length).toBeGreaterThan(0);
  });

  it("holds only choices an agent.yaml model block accepts", () => {
    for (const choice of MODEL_CHOICES) {
      const parsed = ModelConfigSchema.safeParse({ provider: choice.provider, name: choice.name });
      expect(parsed.success, `${choice.provider}/${choice.name}`).toBe(true);
    }
  });

  it("names each model once, and gives each a label", () => {
    const keys = MODEL_CHOICES.map((c) => `${c.provider}/${c.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const choice of MODEL_CHOICES) {
      expect(choice.label.trim(), `${choice.provider}/${choice.name}`).not.toBe("");
    }
  });

  it("offers one model per provider, Google's first and preselected", () => {
    expect(MODEL_CHOICES.map((c) => c.provider)).toEqual([
      "google",
      "anthropic",
      "openai",
      "xai",
      "mistral",
      "groq",
    ]);
    expect(MODEL_CHOICES[0]).toMatchObject({ provider: "google", name: "gemini-3.8-flash" });
  });

  it("names no -latest alias: each choice is a pinned id", () => {
    for (const choice of MODEL_CHOICES) {
      expect(choice.name, `${choice.provider}/${choice.name}`).not.toMatch(/-latest$/);
    }
  });

  it("offers no model of the retired-model list", () => {
    for (const choice of MODEL_CHOICES) {
      expect(
        findRetiredModels({ model: { provider: choice.provider, name: choice.name } }),
        `${choice.provider}/${choice.name}`,
      ).toEqual([]);
    }
  });

  it("is exported by the package entry point", () => {
    expect(schema.MODEL_CHOICES).toBe(MODEL_CHOICES);
  });
});
