import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { packAgentTar } from "@skrun-dev/schema";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractBundle, formatPullErrorMessage } from "./pull.js";

describe("formatPullErrorMessage", () => {
  // VT-19 (#80): on 404 the CLI prints the 3-cause SC-17 message and
  // intentionally does NOT confirm/deny the agent's existence. The
  // multi-tenant filter returns 404 indistinguishably whether the agent
  // doesn't exist OR the caller is not the owner — the CLI must respect
  // the same opacity.
  it("VT-19 (#80): on 404 prints 3-cause hint without confirming existence", () => {
    const err = Object.assign(new Error("Agent acme/secret not found"), {
      status: 404,
      code: "NOT_FOUND",
    });
    const msg = formatPullErrorMessage(err, "acme/secret");

    // 3-cause structure
    expect(msg).toContain("Agent 'acme/secret' not found");
    expect(msg).toContain("Possible causes");
    expect(msg).toContain("Typo in the agent name");
    expect(msg).toContain("skrun whoami");
    expect(msg).toContain("doesn't exist");

    // Critically — the message must NOT confirm/deny existence or use
    // permission-related language that would leak the multi-tenant rule.
    expect(msg).not.toMatch(/permission/i);
    expect(msg).not.toMatch(/forbidden/i);
    expect(msg).not.toMatch(/access denied/i);
    expect(msg).not.toMatch(/private/i);
    expect(msg).not.toMatch(/unauthorized/i);
  });

  it("VT-19b (#80): on non-404 returns the raw error message verbatim", () => {
    const err = Object.assign(new Error("Pull failed (500): internal error"), {
      status: 500,
      code: "INTERNAL",
    });
    const msg = formatPullErrorMessage(err, "acme/foo");
    expect(msg).toBe("Pull failed (500): internal error");
  });

  it("VT-19c (#80): falls back to code=NOT_FOUND when status missing (defense in depth)", () => {
    // An error without `status` but with `code: NOT_FOUND` should still
    // trigger the 3-cause hint — the helper checks both signals.
    const err = Object.assign(new Error("Agent x/y not found"), { code: "NOT_FOUND" });
    const msg = formatPullErrorMessage(err, "x/y");
    expect(msg).toContain("Possible causes");
  });

  it("handles non-Error values gracefully", () => {
    expect(formatPullErrorMessage("plain string error", "acme/foo")).toBe("plain string error");
    expect(formatPullErrorMessage({ weird: true }, "acme/foo")).toBe("[object Object]");
  });
});

// Build a gzipped tar with arbitrary entries (incl. a symlink) — packAgentTar only
// emits regular files, so we drop to tar-stream for the security cases.
function packRaw(
  entries: Array<{ name: string; type?: Headers["type"]; linkname?: string; content?: Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
    for (const e of entries) {
      const content = e.content ?? Buffer.alloc(0);
      pack.entry(
        {
          name: e.name,
          type: e.type ?? "file",
          linkname: e.linkname,
          size: content.length,
          mtime: new Date(0),
        },
        content,
      );
    }
    pack.finalize();
  });
}

describe("extractBundle (skrun pull)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-pull-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts a normal bundle with POSIX paths + binary fidelity", async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const gz = await packAgentTar([
      { name: "SKILL.md", content: Buffer.from("# hi") },
      { name: "scripts/foo.py", content: Buffer.from("print(1)") },
      { name: "assets/logo.bin", content: bin },
    ]);
    const count = await extractBundle(gz, dir);
    expect(count).toBe(3);
    expect(readFileSync(join(dir, "scripts", "foo.py")).toString()).toBe("print(1)");
    expect(readFileSync(join(dir, "assets", "logo.bin")).equals(bin)).toBe(true);
  });

  it("throws on a path-traversal entry (VT-6)", async () => {
    const gz = await packAgentTar([{ name: "../escape.txt", content: Buffer.from("leak") }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(/traversal/i);
  });

  it("throws on a symlink entry (VT-8)", async () => {
    const gz = await packRaw([{ name: "evil", type: "symlink", linkname: "../../etc/passwd" }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(/link entry/i);
  });

  it("rejects a gzip bomb over the cap (VT-4b / SC-4)", async () => {
    const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024)); // 60 MB > 50 MB cap
    await expect(extractBundle(bomb, dir)).rejects.toThrow(/gzip-bomb/);
  });
});
