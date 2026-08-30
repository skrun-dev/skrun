import { describe, expect, it } from "vitest";
import { parsePolicy, resolveKeyInput, splitAgent } from "./llm-key.js";

describe("llm-key CLI helpers", () => {
  describe("splitAgent", () => {
    it("splits namespace/name", () => {
      expect(splitAgent("alice/bot")).toEqual({ ns: "alice", name: "bot" });
    });
    it("rejects a missing slash or an empty side", () => {
      expect(() => splitAgent("alice")).toThrow(/namespace.*name/);
      expect(() => splitAgent("/bot")).toThrow();
      expect(() => splitAgent("alice/")).toThrow();
    });
  });

  describe("parsePolicy", () => {
    it("accepts open and creator-only / creator_only (case-insensitive)", () => {
      expect(parsePolicy("open")).toBe("open");
      expect(parsePolicy("creator-only")).toBe("creator_only");
      expect(parsePolicy("creator_only")).toBe("creator_only");
      expect(parsePolicy("Creator-Only")).toBe("creator_only");
    });
    it("rejects an invalid policy", () => {
      expect(() => parsePolicy("nope")).toThrow(/Invalid policy/);
    });
  });

  describe("resolveKeyInput — never a positional arg (shell-history safety)", () => {
    it("reads + trims from --key-env", async () => {
      const key = await resolveKeyInput(
        { keyEnv: "MY_KEY" },
        { MY_KEY: "sk-secret  " },
        async () => "",
      );
      expect(key).toBe("sk-secret");
    });
    it("errors when --key-env is unset/empty", async () => {
      await expect(resolveKeyInput({ keyEnv: "MISSING" }, {}, async () => "")).rejects.toThrow(
        /empty or unset/,
      );
    });
    it("falls back to (trimmed) stdin", async () => {
      const key = await resolveKeyInput({}, {}, async () => "sk-from-stdin\n");
      expect(key).toBe("sk-from-stdin");
    });
    it("errors when stdin is empty and no --key-env", async () => {
      await expect(resolveKeyInput({}, {}, async () => "")).rejects.toThrow(/No key provided/);
    });
  });
});
