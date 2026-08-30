import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_BUNDLE_EXCLUDES,
  type AgentTarEntry,
  isExcludedEntry,
  isUnsafeName,
  packAgentTar,
  type UnpackedAgentEntry,
  unpackAgentTar,
} from "./bundle-tar.js";

const MAX = 50 * 1024 * 1024;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures");

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function contentOf(entries: UnpackedAgentEntry[], name: string): Buffer {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry not found: ${name}`);
  return entry.content;
}

describe("packAgentTar / unpackAgentTar", () => {
  it("normalises Windows backslash names to POSIX (VT-1)", async () => {
    const gz = await packAgentTar([{ name: "scripts\\foo.py", content: Buffer.from("x") }]);
    const entries = await unpackAgentTar(gz, { maxBytes: MAX });
    expect(entries.map((e) => e.name)).toEqual(["scripts/foo.py"]);
  });

  it("round-trips text and binary content byte-identically (VT-2)", async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entries: AgentTarEntry[] = [
      { name: "SKILL.md", content: Buffer.from("# hi\n") },
      { name: "scripts/probe.py", content: Buffer.from("print(1)\n") },
      { name: "assets/logo.bin", content: bin },
    ];
    const out = await unpackAgentTar(await packAgentTar(entries), { maxBytes: MAX });
    expect(out.map((e) => e.name).sort()).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "scripts/probe.py",
    ]);
    expect(contentOf(out, "SKILL.md").toString()).toBe("# hi\n");
    expect(contentOf(out, "assets/logo.bin").equals(bin)).toBe(true);
  });

  it("is byte-deterministic, incl. a >100-byte name that triggers PAX (VT-10)", async () => {
    const entries: AgentTarEntry[] = [
      { name: "SKILL.md", content: Buffer.from("hi") },
      { name: `scripts/${"b".repeat(120)}.py`, content: Buffer.from("x") },
    ];
    const a = await packAgentTar(entries);
    const b = await packAgentTar(entries);
    expect(sha(a)).toBe(sha(b));
  });

  it("preserves a 100-byte name (VT-11)", async () => {
    const name = `d/${"a".repeat(98)}`; // 2 + 98 = 100 bytes
    const out = await unpackAgentTar(await packAgentTar([{ name, content: Buffer.from("x") }]), {
      maxBytes: MAX,
    });
    expect(out[0]?.name).toBe(name);
  });

  it("enforces the gzip-bomb decompression cap (VT-4)", async () => {
    const gz = await packAgentTar([{ name: "big.bin", content: Buffer.alloc(2 * 1024 * 1024, 1) }]);
    await expect(unpackAgentTar(gz, { maxBytes: 1024 })).rejects.toThrow(/gzip-bomb/);
  });

  it("reads a legacy hand-rolled ustar bundle from the registry (RT-1 / SC-8)", async () => {
    const gz = readFileSync(join(FIXTURES, "legacy-handrolled.agent"));
    const out = await unpackAgentTar(gz, { maxBytes: MAX });
    expect(out.map((e) => e.name).sort()).toEqual([
      "SKILL.md",
      "agent.yaml",
      "assets/logo.bin",
      "scripts/probe.py",
    ]);
    expect(contentOf(out, "scripts/probe.py").toString()).toBe("print('hello from scripts/')\n");
    // Binary asset survives a hand-rolled→tar-stream read byte-identically.
    const expectedBin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(contentOf(out, "assets/logo.bin").equals(expectedBin)).toBe(true);
  });
});

describe("isExcludedEntry", () => {
  it("excludes explicit dirs, dotfiles, *.secret, and *.agent", () => {
    expect(AGENT_BUNDLE_EXCLUDES.has("node_modules")).toBe(true);
    for (const name of [
      "node_modules",
      "venv",
      ".venv",
      "__pycache__",
      ".env",
      ".hidden",
      "k.secret",
      "my-bundle-1.0.0.agent",
    ]) {
      expect(isExcludedEntry(name)).toBe(true);
    }
    for (const name of ["scripts", "SKILL.md", "main.py", "agent.yaml"]) {
      expect(isExcludedEntry(name)).toBe(false);
    }
  });
});

describe("isUnsafeName", () => {
  it("flags parent-traversal, absolute names, and escaping symlink targets", () => {
    expect(isUnsafeName("../evil")).toBe(true);
    expect(isUnsafeName("a/../../b")).toBe(true);
    expect(isUnsafeName("/etc/passwd")).toBe(true);
    expect(isUnsafeName("link", "../../etc/passwd")).toBe(true);
    expect(isUnsafeName("scripts/foo.py")).toBe(false);
    expect(isUnsafeName("link", "sibling.txt")).toBe(false);
  });
});
