import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";
import { getValidatedConfig } from "../utils/validated-config.js";

export function registerPushCommand(program: Command): void {
  program
    .command("push")
    .description("Push agent to the Skrun registry")
    .option("-m, --message <text>", "Attach a note to this version (max 500 chars, plain text)")
    .action(async (opts: { message?: string }) => {
      const dir = process.cwd();

      // Validate --message client-side before doing any work
      const notes = validateNotes(opts.message);

      // Check auth
      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      // Validate agent
      const result = await validateAgent(dir);
      if (!result.valid) {
        for (const err of result.errors) {
          format.error(`${err.file ?? ""}: ${err.message}`);
        }
        process.exit(1);
      }

      const config = getValidatedConfig(result);
      const [namespace, name] = config.name.split("/");
      const version = config.version;
      const slug = name ?? config.name;

      // Find or build .agent bundle
      const bundlePath = join(dir, `${slug}-${version}.agent`);
      if (!existsSync(bundlePath)) {
        format.error(`Bundle not found: ${slug}-${version}.agent. Run \`skrun build\` first.`);
        process.exit(1);
      }

      const bundle = readFileSync(bundlePath);

      // Push
      const client = new RegistryClient(getRegistryUrl(), token);
      try {
        const { warning } = await client.push(bundle, namespace, slug, version, {
          notes: notes ?? undefined,
        });
        format.success(
          `Pushed ${namespace}/${slug}@${version} (${(bundle.length / 1024).toFixed(1)} KB)`,
        );
        if (warning === "notes-unsupported" && notes) {
          format.warn(
            "Server doesn't support version notes — your message was not stored. Upgrade the registry to use `-m`.",
          );
        }
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

/**
 * Validate --message input client-side. Returns null (empty/missing) or the validated string.
 * Exits the process on invalid input.
 */
function validateNotes(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw.length > 500) {
    format.error(`--message too long (${raw.length} chars). Max 500.`);
    process.exit(1);
  }
  if (raw.includes("\x00")) {
    format.error("--message must not contain null bytes.");
    process.exit(1);
  }
  return raw;
}
