import { describe, expect, it, vi } from "vitest";
import * as prompts from "../utils/prompts.js";
import { resolveInitModel } from "./init.js";

describe("resolveInitModel", () => {
  it("uses the provider default model without prompting", async () => {
    const askModelSpy = vi.spyOn(prompts, "askModel");

    await expect(resolveInitModel({ provider: "google" })).resolves.toEqual({
      provider: "google",
      name: "gemini-2.5-flash",
    });
    expect(askModelSpy).not.toHaveBeenCalled();
  });

  it("prefers an explicit model over the provider flag", async () => {
    const askModelSpy = vi.spyOn(prompts, "askModel");

    await expect(
      resolveInitModel({ provider: "google", model: "openai/gpt-4o-mini" }),
    ).resolves.toEqual({
      provider: "openai",
      name: "gpt-4o-mini",
    });
    expect(askModelSpy).not.toHaveBeenCalled();
  });

  it("falls back to the interactive model prompt", async () => {
    const askModelSpy = vi
      .spyOn(prompts, "askModel")
      .mockResolvedValue({ provider: "anthropic", name: "claude-sonnet-4-20250514" });

    await expect(resolveInitModel({})).resolves.toEqual({
      provider: "anthropic",
      name: "claude-sonnet-4-20250514",
    });
    expect(askModelSpy).toHaveBeenCalledTimes(1);
  });
});
