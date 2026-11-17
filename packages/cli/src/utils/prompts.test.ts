import { MODEL_CHOICES } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { select, text, cancel, CANCELLED } = vi.hoisted(() => ({
  select: vi.fn(),
  text: vi.fn(),
  cancel: vi.fn(),
  CANCELLED: Symbol("cancelled"),
}));

vi.mock("@clack/prompts", () => ({
  select,
  isCancel: (value: unknown) => value === CANCELLED,
  cancel,
  text,
  confirm: vi.fn(),
}));

import { askModel, askTextOrCancel, canPrompt } from "./prompts.js";

describe("askModel", () => {
  beforeEach(() => {
    select.mockReset();
  });

  it("keeps every segment after the provider in a multi-segment model name", async () => {
    select.mockResolvedValue("groq/openai/gpt-oss-120b");
    await expect(askModel()).resolves.toEqual({ provider: "groq", name: "openai/gpt-oss-120b" });
  });

  it("offers the shared model choices, in their order", async () => {
    select.mockResolvedValue(`${MODEL_CHOICES[0].provider}/${MODEL_CHOICES[0].name}`);
    await askModel();
    const offered = select.mock.calls[0][0].options;
    expect(offered).toEqual(
      MODEL_CHOICES.map((c) => ({ value: `${c.provider}/${c.name}`, label: c.label })),
    );
  });

  it("returns the provider and name of the choice picked", async () => {
    const last = MODEL_CHOICES[MODEL_CHOICES.length - 1];
    select.mockResolvedValue(`${last.provider}/${last.name}`);
    await expect(askModel()).resolves.toEqual({ provider: last.provider, name: last.name });
  });
});

describe("canPrompt — whether a prompt can be answered", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  afterEach(() => {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])("the standard input's isTTY %s: %s", (isTTY, expected) => {
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    expect(canPrompt()).toBe(expected);
  });
});

describe("askTextOrCancel", () => {
  beforeEach(() => {
    text.mockReset();
    cancel.mockReset();
  });

  it("returns what was typed", async () => {
    text.mockResolvedValue("typed");
    await expect(askTextOrCancel("Token:", "dev-token")).resolves.toBe("typed");
    expect(text).toHaveBeenCalledWith({
      message: "Token:",
      placeholder: "dev-token",
      defaultValue: "dev-token",
    });
  });

  it("returns undefined when the user cancels, and leaves the process to the caller", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit was called");
    });
    try {
      text.mockResolvedValue(CANCELLED);
      await expect(askTextOrCancel("Token:")).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
