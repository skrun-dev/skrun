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
    .option("--force", "Overwrite an existing version in the local registry")
    .action(async (opts: { force?: boolean }) => {
      const dir = process.cwd();

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
        await client.push(bundle, namespace, slug, version, opts.force ?? false);
        format.success(
          `Pushed ${namespace}/${slug}@${version} (${(bundle.length / 1024).toFixed(1)} KB)`,
        );
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
