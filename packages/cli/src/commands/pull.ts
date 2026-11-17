import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  BundleDecompressedTooLargeError,
  decompressedCapText,
  isUnsafeName,
  maxDecompressedBytes,
  type UnpackedAgentEntry,
  unpackAgentTar,
} from "@skrun-dev/schema";
import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";

/**
 * The most `skrun pull` unpacks a bundle to (gzip-bomb defense), in bytes:
 * `BUNDLE_MAX_DECOMPRESSED_MB` from the user's environment, read as the server
 * reads its own (`maxDecompressedBytes`, `@skrun-dev/schema`) — unset, the
 * server's default; malformed, it throws, naming the variable.
 */
export function pullMaxDecompressedBytes(): number {
  return maxDecompressedBytes(process.env.BUNDLE_MAX_DECOMPRESSED_MB);
}

/**
 * Read a pulled .agent bundle (tar.gz) and check every entry, writing nothing.
 * Unlike the API reader (which SKIPS bad entries for hot-path resilience), the
 * CLI THROWS on any unsafe entry — a pulled bundle containing path-traversal
 * names or symlinks is a hard error the user should see. A bundle past the
 * decompression cap — `maxBytes`, by default the user's
 * `BUNDLE_MAX_DECOMPRESSED_MB` — is refused, the variable that raises it named;
 * so is one an entry of which cannot be written out — two entries that
 * contradict each other, a name too long —, by the codec, its message naming
 * the entry (`BundleEntryError`), as the push refuses it.
 */
export async function readPulledBundle(
  gzBuffer: Buffer,
  maxBytes: number = pullMaxDecompressedBytes(),
): Promise<UnpackedAgentEntry[]> {
  let entries: UnpackedAgentEntry[];
  try {
    entries = await unpackAgentTar(gzBuffer, { maxBytes });
  } catch (err) {
    if (err instanceof BundleDecompressedTooLargeError) {
      // Rounded down, as the server says it: what is said stays true.
      throw new Error(
        `The bundle decompresses to more than ${decompressedCapText(maxBytes)}, the most skrun pull unpacks. Set BUNDLE_MAX_DECOMPRESSED_MB to a larger number of MB to pull it.`,
      );
    }
    throw err;
  }
  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "link") {
      throw new Error(`Refusing to extract link entry from bundle: ${entry.name}`);
    }
    if (isUnsafeName(entry.name, entry.linkname)) {
      throw new Error(`Path traversal detected in bundle: ${entry.name}`);
    }
  }
  return entries;
}

/**
 * Write a pulled bundle's entries into `outputDir`, raw bytes so binary assets
 * survive: each path is checked to stay inside it before the first write, and
 * the directory is made only then. A directory entry — the standard `tar`
 * writes one for each directory it packs — makes its directory. Returns the
 * number of files written.
 */
export function writePulledBundle(entries: UnpackedAgentEntry[], outputDir: string): number {
  const root = resolve(outputDir);
  const placed = entries.map((entry) => {
    const path = resolve(outputDir, entry.name);
    const inside = path.startsWith(root + sep) || (entry.type === "directory" && path === root);
    if (!inside) throw new Error(`Path traversal detected in bundle: ${entry.name}`);
    return { entry, path };
  });

  mkdirSync(root, { recursive: true });
  let fileCount = 0;
  for (const { entry, path } of placed) {
    if (entry.type === "directory") {
      mkdirSync(path, { recursive: true });
      continue;
    }
    const fileDir = dirname(path);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(path, entry.content);
    fileCount++;
  }
  return fileCount;
}

/**
 * Extract a pulled .agent bundle into `outputDir`: read and checked whole
 * (`readPulledBundle`), then written (`writePulledBundle`) — a refused bundle
 * writes nothing, not even the directory. Returns the number of files written.
 */
export async function extractBundle(
  gzBuffer: Buffer,
  outputDir: string,
  maxBytes: number = pullMaxDecompressedBytes(),
): Promise<number> {
  return writePulledBundle(await readPulledBundle(gzBuffer, maxBytes), outputDir);
}

/**
 * Format the error printed to stderr when `skrun pull` fails. On a 404
 * response, prints a 3-cause hint — intentionally NOT
 * confirming or denying the agent's existence. The server returns 404
 * indistinguishably for both genuine-not-found and ownership-not-allowed
 * cases (multi-tenant filter), so the CLI must respect the same opacity.
 *
 * Exported separately to make the message contract testable without
 * driving the full Commander action.
 */
export function formatPullErrorMessage(err: unknown, agentRef: string): string {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; code?: string };
    if (e.status === 404 || e.code === "NOT_FOUND") {
      return [
        `Agent '${agentRef}' not found. Possible causes:`,
        "  1. Typo in the agent name",
        "  2. You're not logged in with the namespace-owning account — run `skrun whoami` to check",
        "  3. The agent doesn't exist",
      ].join("\n");
    }
    return e.message;
  }
  return String(err);
}

export function registerPullCommand(program: Command): void {
  program
    .command("pull <agent>")
    .description("Pull agent from the Skrun registry")
    .action(async (agentRef: string) => {
      // The server this pull comes from, and its session
      const client = connect();

      // Parse agent ref: namespace/name or namespace/name@version
      const [fullName, version] = agentRef.split("@");
      const parts = fullName.split("/");
      if (parts.length !== 2) {
        format.error('Invalid agent name. Use format: namespace/name (e.g., "acme/seo-audit")');
        exitWith(1);
      }
      const [namespace, name] = parts;

      // The cap this pull unpacks under, read before anything is downloaded:
      // a malformed value stops it, the variable named.
      let maxBytes: number;
      try {
        maxBytes = pullMaxDecompressedBytes();
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }

      // Pull
      let bundle: Buffer;
      try {
        bundle = await client.pull(namespace, name, version);
      } catch (err) {
        format.error(formatPullErrorMessage(err, `${namespace}/${name}`));
        exitWith(1);
      }

      // Read and check the archive before anything is written: a refused pull
      // leaves no directory behind.
      let entries: UnpackedAgentEntry[];
      try {
        entries = await readPulledBundle(bundle, maxBytes);
      } catch (err) {
        format.error(
          `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`,
        );
        exitWith(1);
      }

      // Extract
      const outputDir = join(process.cwd(), name);
      if (existsSync(outputDir)) {
        format.warn(`Directory ${name}/ already exists. Overwriting.`);
      }

      try {
        const fileCount = writePulledBundle(entries, outputDir);
        format.success(
          `Pulled ${namespace}/${name}${version ? `@${version}` : ""} → ./${name}/ (${fileCount} files)`,
        );
      } catch (err) {
        format.error(
          `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`,
        );
        exitWith(1);
      }
    });
}
