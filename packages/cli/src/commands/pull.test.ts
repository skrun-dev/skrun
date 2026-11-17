import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { packAgentTar } from "@skrun-dev/schema";
import { Command, CommanderError } from "commander";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { extractBundle, formatPullErrorMessage, registerPullCommand } from "./pull.js";

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

  // The codec refuses it, for every reader: the cloud sandbox's tar refuses such an entry.
  it("throws on a path-traversal entry (VT-6)", async () => {
    const gz = await packAgentTar([{ name: "../escape.txt", content: Buffer.from("leak") }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(
      `The entry "../escape.txt" climbs out of the bundle's directory: its path holds "..".`,
    );
  });

  it("throws on an absolute entry", async () => {
    const gz = await packRaw([{ name: "/escape.txt", content: Buffer.from("leak") }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(/traversal/i);
  });

  it("throws on a symlink entry (VT-8)", async () => {
    const gz = await packRaw([{ name: "evil", type: "symlink", linkname: "../../etc/passwd" }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(/link entry/i);
  });

  // Every entry is checked before the first write: an unsafe one after safe
  // ones leaves nothing behind, where the safe ones used to be written.
  it("writes nothing when an unsafe entry follows safe ones", async () => {
    const out = join(dir, "agent");
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# hi") },
      { name: "scripts/run.py", content: Buffer.from("print(1)") },
      { name: "../escape.txt", content: Buffer.from("leak") },
    ]);
    await expect(extractBundle(gz, out)).rejects.toThrow(/climbs out/i);
    expect(readdirSync(dir)).toEqual([]);
  });

  // An entry no tar run without privileges can make, refused by the codec as
  // the push refuses it: nothing written.
  it.each([
    [
      "a block device",
      [{ name: "disk", type: "block-device" as const }],
      `The entry "disk" is a block device: tar cannot make one without privileges, and an agent's bundle is written out without them.`,
    ],
    [
      "a hard link to no entry",
      [{ name: "scripts/run.py", type: "link" as const, linkname: "scripts/gone.py" }],
      `The entry "scripts/run.py" is a hard link to "scripts/gone.py", and no file of that path comes before it in the bundle: tar cannot make the link.`,
    ],
  ])("refuses %s, writing nothing", async (_label, entries, message) => {
    const out = join(dir, "agent");
    const gz = await packRaw([{ name: "SKILL.md", content: Buffer.from("# hi") }, ...entries]);
    await expect(extractBundle(gz, out)).rejects.toThrow(message);
    expect(readdirSync(dir)).toEqual([]);
  });

  // The standard tar writes an entry for each directory it packs; skrun build
  // writes none. Each makes its directory — an empty one too — and only files
  // are counted.
  it("makes the directory of a directory entry, as a bundle the standard tar makes carries", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# hi") },
      { name: "scripts/", type: "directory" },
      { name: "scripts/run.py", content: Buffer.from("print(1)") },
      { name: "assets/", type: "directory" },
    ]);
    expect(await extractBundle(gz, dir)).toBe(2);
    expect(readFileSync(join(dir, "scripts", "run.py"), "utf-8")).toBe("print(1)");
    expect(statSync(join(dir, "assets")).isDirectory()).toBe(true);
  });

  it("rejects a gzip bomb over the cap (VT-4b / SC-4)", async () => {
    const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024)); // 60 MB > 50 MB cap
    await expect(extractBundle(bomb, dir)).rejects.toThrow(
      "The bundle decompresses to more than 50 MB, the most skrun pull unpacks. Set BUNDLE_MAX_DECOMPRESSED_MB to a larger number of MB to pull it.",
    );
  });
});

describe("extractBundle (skrun pull) — the decompression cap is BUNDLE_MAX_DECOMPRESSED_MB, read as the server reads it", () => {
  const MIB = 1024 * 1024;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-pull-cap-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A real bundle that decompresses past the 50 MB default: one 51 MB file, its tar headers on top. */
  const overDefault = () =>
    packAgentTar([{ name: "assets/big.bin", content: Buffer.alloc(51 * MIB) }]);

  it("a bundle past the 50 MB default is refused without the variable, the message naming it, nothing written", async () => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", undefined);
    await expect(extractBundle(await overDefault(), dir)).rejects.toThrow(
      /more than 50 MB, the most skrun pull unpacks\. Set BUNDLE_MAX_DECOMPRESSED_MB/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("the same bundle is pulled with the variable raised", async () => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "60");
    expect(await extractBundle(await overDefault(), dir)).toBe(1);
    expect(statSync(join(dir, "assets", "big.bin")).size).toBe(51 * MIB);
  });

  it("a lowered variable refuses a bundle under the default, and names its own value", async () => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1");
    const gz = await packAgentTar([{ name: "assets/two.bin", content: Buffer.alloc(2 * MIB) }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(
      "The bundle decompresses to more than 1 MB, the most skrun pull unpacks. Set BUNDLE_MAX_DECOMPRESSED_MB to a larger number of MB to pull it.",
    );
  });

  it.each([
    "abc",
    "0",
    "-5",
    "",
    "1e3",
    "12.9MB",
  ])("a malformed value (%j) is refused, as the server refuses to start on it — never the default in its place", async (raw) => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", raw);
    const gz = await packAgentTar([{ name: "assets/two.bin", content: Buffer.alloc(2 * MIB) }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(
      `BUNDLE_MAX_DECOMPRESSED_MB must be a positive decimal number of MB (got "${raw}"). Unset it to use the 50 MB default.`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a fraction of a MB is read, and told rounded down to a tenth", async () => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1.25");
    const gz = await packAgentTar([{ name: "assets/two.bin", content: Buffer.alloc(2 * MIB) }]);
    await expect(extractBundle(gz, dir)).rejects.toThrow(
      "The bundle decompresses to more than 1.2 MB, the most skrun pull unpacks.",
    );
  });
});

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * `skrun pull <ref>` through the real command, from `cwd`: fetch answers
 * every request with `respond`, every output is captured, and neither
 * commander nor the command may end the test process.
 */
async function skrunPull(
  cwd: string,
  ref: string,
  respond: () => Response,
): Promise<{ printed: string; exitCode: number | undefined; requests: string[] }> {
  const lines: string[] = [];
  const requests: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  writeSession(useThrowawayProfile(), {
    address: "http://registry.test",
    token: "test-token",
    username: "dev",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return respond();
    }),
  );
  const spies = [
    vi.spyOn(process, "cwd").mockReturnValue(cwd),
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitCalled(Number(code ?? 0));
    }),
  ];
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerPullCommand(program);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["pull", ref], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit || err instanceof ExitCalled) exitCode = err.code;
    else if (err instanceof CommanderError) exitCode = err.exitCode;
    else throw err;
  } finally {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllGlobals();
  }
  return { printed: lines.join("\n"), exitCode, requests };
}

describe("skrun pull — the command", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "skrun-pull-cmd-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a malformed BUNDLE_MAX_DECOMPRESSED_MB stops it before anything is downloaded, naming the variable, exit 1", async () => {
    const call = await skrunPull(cwd, "dev/agent", () => {
      throw new Error("nothing should be downloaded");
    });
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1e3");
    const refused = await skrunPull(cwd, "dev/agent", () => {
      throw new Error("nothing should be downloaded");
    });
    expect(call.requests).toHaveLength(1); // unset: it downloads, the 50 MB default
    expect(refused.exitCode).toBe(1);
    expect(refused.printed).toContain(
      'BUNDLE_MAX_DECOMPRESSED_MB must be a positive decimal number of MB (got "1e3"). Unset it to use the 50 MB default.',
    );
    expect(refused.requests).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });

  /** The registry's answer to a pull: the bundle's bytes. */
  const bundleOf = (gz: Buffer) => () => new Response(new Uint8Array(gz));

  it("pulls a bundle into ./<name>/", async () => {
    const gz = await packAgentTar([{ name: "SKILL.md", content: Buffer.from("# hi") }]);
    const call = await skrunPull(cwd, "dev/agent", bundleOf(gz));
    expect(call.exitCode).toBeUndefined();
    expect(readFileSync(join(cwd, "agent", "SKILL.md"), "utf-8")).toBe("# hi");
  });

  // The archive is read and checked whole before anything is written: a
  // refused pull leaves no ./<name>/ behind, empty or not.
  it.each([
    [
      "past the cap",
      () => packAgentTar([{ name: "assets/two.bin", content: Buffer.alloc(2 * 1024 * 1024) }]),
      "Failed to extract bundle: The bundle decompresses to more than 1 MB, the most skrun pull unpacks.",
    ],
    [
      "an unsafe entry after safe ones",
      () =>
        packRaw([
          { name: "SKILL.md", content: Buffer.from("# hi") },
          { name: "../escape.txt", content: Buffer.from("leak") },
        ]),
      `Failed to extract bundle: The entry "../escape.txt" climbs out of the bundle's directory: its path holds "..".`,
    ],
    [
      "two entries that contradict each other",
      () =>
        packAgentTar([
          { name: "SKILL.md", content: Buffer.from("# hi") },
          { name: "scripts/run", content: Buffer.from("#!/bin/sh") },
          { name: "scripts/run/helper.py", content: Buffer.from("print(1)") },
        ]),
      'Failed to extract bundle: The entry "scripts/run/helper.py" needs "scripts/run" to be a directory, and the bundle makes it a file.',
    ],
    [
      "a name over 255 bytes",
      () =>
        packAgentTar([
          { name: "SKILL.md", content: Buffer.from("# hi") },
          { name: `assets/${"n".repeat(256)}`, content: Buffer.from("x") },
        ]),
      'a name of 256 bytes between two "/"; a file system takes 255 at most.',
    ],
  ])("a bundle refused — %s — leaves no directory, exit 1", async (_case, bundle, message) => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1");
    const call = await skrunPull(cwd, "dev/agent", bundleOf(await bundle()));
    expect(call.exitCode).toBe(1);
    expect(call.printed).toContain(message);
    expect(readdirSync(cwd)).toEqual([]);
  });
});
