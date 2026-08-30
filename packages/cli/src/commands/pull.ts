import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isUnsafeName, unpackAgentTar } from "@skrun-dev/schema";
import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

// Cap decompressed bundle size (gzip-bomb defense), matching the server default.
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * Extract a .agent bundle (tar.gz) into `outputDir`, writing raw bytes so binary
 * assets survive. Unlike the API reader (which SKIPS bad entries for hot-path
 * resilience), the CLI THROWS on any unsafe entry — a pulled bundle containing
 * path-traversal names or symlinks is a hard error the user should see. Returns
 * the number of files written.
 */
export async function extractBundle(gzBuffer: Buffer, outputDir: string): Promise<number> {
  const entries = await unpackAgentTar(gzBuffer, { maxBytes: MAX_DECOMPRESSED_BYTES });
  const root = resolve(outputDir);
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "link") {
      throw new Error(`Refusing to extract link entry from bundle: ${entry.name}`);
    }
    if (isUnsafeName(entry.name, entry.linkname)) {
      throw new Error(`Path traversal detected in bundle: ${entry.name}`);
    }
    const filePath = resolve(outputDir, entry.name);
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      throw new Error(`Path traversal detected in bundle: ${entry.name}`);
    }
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(filePath, entry.content);
    fileCount++;
  }

  return fileCount;
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
        const fileCount = await extractBundle(bundle, outputDir);
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
