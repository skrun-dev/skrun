import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

// Simple tar extractor for POSIX ustar format
function extractTar(tarBuffer: Buffer, outputDir: string): number {
  let offset = 0;
  let fileCount = 0;

  while (offset < tarBuffer.length - 512) {
    // Read header
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    // Check for end-of-archive (all zeros)
    if (header.every((b) => b === 0)) break;

    // Extract filename (first 100 bytes, null-terminated)
    const nameEnd = header.indexOf(0);
    const fileName = header.subarray(0, Math.min(nameEnd, 100)).toString("utf-8");

    // Extract size (octal, bytes 124-135)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Read file content
    const content = tarBuffer.subarray(offset, offset + size);

    // Write file (with path traversal protection)
    const filePath = resolve(outputDir, fileName);
    if (!filePath.startsWith(resolve(outputDir) + sep) && filePath !== resolve(outputDir)) {
      throw new Error(`Path traversal detected in bundle: ${fileName}`);
    }
    const dir = join(filePath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content);
    fileCount++;

    // Skip to next 512-byte boundary
    const padding = (512 - (size % 512)) % 512;
    offset += size + padding;
  }

  return fileCount;
}

async function decompressGzip(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gunzip.on("end", () => resolvePromise(Buffer.concat(chunks)));
    gunzip.on("error", reject);
    Readable.from(buffer).pipe(gunzip);
  });
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
      // Check auth
      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      // Parse agent ref: namespace/name or namespace/name@version
      const [fullName, version] = agentRef.split("@");
      const parts = fullName.split("/");
      if (parts.length !== 2) {
        format.error('Invalid agent name. Use format: namespace/name (e.g., "acme/seo-audit")');
        process.exit(1);
      }
      const [namespace, name] = parts;

      // Pull
      const client = new RegistryClient(getRegistryUrl(), token);
      let bundle: Buffer;
      try {
        bundle = await client.pull(namespace, name, version);
      } catch (err) {
        format.error(formatPullErrorMessage(err, `${namespace}/${name}`));
        process.exit(1);
      }

      // Extract
      const outputDir = join(process.cwd(), name);
      if (existsSync(outputDir)) {
        format.warn(`Directory ${name}/ already exists. Overwriting.`);
      }
      mkdirSync(outputDir, { recursive: true });

      try {
        const tarBuffer = await decompressGzip(bundle);
        const fileCount = extractTar(tarBuffer, outputDir);
        format.success(
          `Pulled ${namespace}/${name}${version ? `@${version}` : ""} → ./${name}/ (${fileCount} files)`,
        );
      } catch (err) {
        format.error(
          `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
