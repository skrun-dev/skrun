import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgent, validateAgentCapabilities } from "@skrun-dev/schema";
import type { Command } from "commander";
import { getCurrentNamespace, getRegistryUrl, getToken } from "../utils/auth.js";
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
      const slug = config.name;
      const version = config.version;
      let namespace: string;
      try {
        namespace = await getCurrentNamespace();
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Capability check — refuse before any network call if model can't handle declared media
      const capCheck = validateAgentCapabilities(config);
      if (!capCheck.ok) {
        for (const err of capCheck.errors) format.error(err);
        process.exit(1);
      }

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
        const { body, warning } = await client.push(bundle, namespace, slug, version, {
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

        // Surface the per-version verified gate. New agent + just-pushed
        // version always lands at verified=false, so the user knows an admin
        // step is required before this version can run. Differentiated wording
        // for first-version-of-new-agent vs new-version-of-existing-agent —
        // the latter clarifies that pinned callers on prior verified versions
        // are unaffected.
        const versions = (body.versions as string[] | undefined) ?? [];
        const isFirstVersion = versions.length === 1;
        if (isFirstVersion) {
          format.warn(
            `New agents start unverified. Run \`skrun verify ${namespace}/${slug}@${version}\` (admin only) before it can be called.`,
          );
        } else {
          format.warn(
            `Version ${version} is not yet verified. Run \`skrun verify ${namespace}/${slug}@${version}\` (admin only) before it can be called.`,
          );
          format.warn(
            "Previously verified versions of this agent remain runnable for callers pinning them.",
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
