import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";
import { getValidatedConfig } from "../utils/validated-config.js";

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy agent to Skrun — validate, build, push, get live URL")
    .option("-m, --message <text>", "Attach a note to this version (max 500 chars, plain text)")
    .action(async (opts: { message?: string }) => {
      const dir = process.cwd();

      // Validate --message client-side
      let notes: string | null = null;
      if (opts.message !== undefined && opts.message !== "") {
        if (opts.message.length > 500) {
          format.error(`--message too long (${opts.message.length} chars). Max 500.`);
          process.exit(1);
        }
        if (opts.message.includes("\x00")) {
          format.error("--message must not contain null bytes.");
          process.exit(1);
        }
        notes = opts.message;
      }

      // 1. Check auth
      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      // 2. Validate
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
      format.success(`Validated ${namespace}/${slug}`);

      // 3. Build
      const bundlePath = join(dir, `${slug}-${version}.agent`);
      if (!existsSync(bundlePath)) {
        // Build inline using the same tar logic from build command
        try {
          const { execFileSync } = await import("node:child_process");
          execFileSync(process.execPath, [join(dir, "../../packages/cli/bin/skrun.js"), "build"], {
            cwd: dir,
            stdio: "pipe",
          });
        } catch {
          format.error("Build failed. Run `skrun build` to see details.");
          process.exit(1);
        }
      }

      if (!existsSync(bundlePath)) {
        format.error(`Bundle not found after build: ${slug}-${version}.agent`);
        process.exit(1);
      }

      const bundle = readFileSync(bundlePath);
      format.success(`Built ${slug}-${version}.agent (${(bundle.length / 1024).toFixed(1)} KB)`);

      // 4. Push
      const registryUrl = getRegistryUrl();
      const client = new RegistryClient(registryUrl, token);

      try {
        const { warning } = await client.push(bundle, namespace, slug, version, {
          notes: notes ?? undefined,
        });
        if (warning === "notes-unsupported" && notes) {
          format.warn(
            "Server doesn't support version notes — your message was not stored. Upgrade the registry to use `-m`.",
          );
        }
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      format.success(`Pushed ${namespace}/${slug}@${version}`);

      // 5. Print live URL
      const runUrl = `${registryUrl}/api/agents/${namespace}/${slug}/run`;
      console.log("");
      console.log("  🚀 Deployed! Your agent is live:");
      console.log("");
      console.log(`  POST ${runUrl}`);
      console.log("  Auth: Bearer <your-token>");
      console.log("");
      console.log("  Test it:");
      console.log(`  curl -X POST ${runUrl} \\`);
      console.log(`    -H "Authorization: Bearer ${token}" \\`);
      console.log(`    -H "Content-Type: application/json" \\`);
      console.log(`    -d '{"input": {"query": "test"}}'`);
      console.log("");
    });
}
