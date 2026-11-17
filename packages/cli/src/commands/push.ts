import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgent, validateAgentCapabilities } from "@skrun-dev/schema";
import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect, type VerificationView } from "../utils/registry-client.js";
import { getValidatedConfig } from "../utils/validated-config.js";
import { printValidationWarnings } from "../utils/validation-output.js";

export function registerPushCommand(program: Command): void {
  program
    .command("push")
    .description("Push agent to the Skrun registry")
    .option("-m, --message <text>", "Attach a note to this version (max 500 chars, plain text)")
    .action(async (opts: { message?: string }) => {
      const dir = process.cwd();

      // Validate --message client-side before doing any work
      const notes = validateNotes(opts.message);

      // The server this push goes to, and its session
      const client = connect();

      // Validate agent
      const result = await validateAgent(dir);
      if (!result.valid) {
        for (const err of result.errors) {
          format.error(`${err.file ?? ""}: ${err.message}`);
        }
        exitWith(1);
      }
      printValidationWarnings(result);

      const config = getValidatedConfig(result);
      const slug = config.name;
      const version = config.version;
      let namespace: string;
      try {
        namespace = await client.currentNamespace();
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }

      // Capability check — refuse before any network call if model can't handle declared media
      const capCheck = validateAgentCapabilities(config);
      if (!capCheck.ok) {
        for (const err of capCheck.errors) format.error(err);
        exitWith(1);
      }

      // Find or build .agent bundle
      const bundlePath = join(dir, `${slug}-${version}.agent`);
      if (!existsSync(bundlePath)) {
        format.error(`Bundle not found: ${slug}-${version}.agent. Run \`skrun build\` first.`);
        exitWith(1);
      }

      const bundle = readFileSync(bundlePath);

      // Push
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

        // Every pushed version lands at verified=false. Whether that stops it
        // from running is the server's verification policy, read after the
        // push (best effort): the note says what is true there.
        const versions = (body.versions as string[] | undefined) ?? [];
        const view = await client.verificationView();
        printAfterPushNote(`${namespace}/${slug}@${version}`, version, versions.length === 1, view);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });
}

/**
 * The note after a successful push. Only the `admin` policy keeps an
 * unverified version from running: under it, the note names the step and who
 * may take it. Under `owner` and `disabled` the version can be called at once.
 * Without the policy, the note says what it always said. `skrun deploy` prints
 * the same note.
 */
export function printAfterPushNote(
  ref: string,
  version: string,
  isFirstVersion: boolean,
  view: VerificationView,
): void {
  if (view.policy === "owner") {
    format.info(
      `${ref} can be called now. Verifying it is optional on this server: \`skrun verify ${ref}\` records that you vouch for this version.`,
    );
    return;
  }
  if (view.policy === "disabled") {
    format.info(`${ref} can be called now. This server does not gate runs on verification.`);
    return;
  }

  const unverified = isFirstVersion
    ? "New agents start unverified."
    : `Version ${version} is not yet verified.`;
  if (view.policy === "admin" && view.role === "admin") {
    format.warn(
      `${unverified} Run \`skrun verify ${ref}\` before it can be called — you are an admin on this server.`,
    );
  } else if (view.policy === "admin") {
    format.warn(
      `${unverified} An admin of this server must run \`skrun verify ${ref}\` before it can be called.`,
    );
  } else {
    format.warn(`${unverified} Run \`skrun verify ${ref}\` (admin only) before it can be called.`);
  }
  if (!isFirstVersion) {
    format.warn(
      "Previously verified versions of this agent remain runnable for callers pinning them.",
    );
  }
}

/** Whether a pushed version can be called at once: only `owner` and `disabled` say so. */
export function callableAtOnce(view: VerificationView): boolean {
  return view.policy === "owner" || view.policy === "disabled";
}

/**
 * Validate --message input client-side. Returns null (empty/missing) or the validated string.
 * Ends the command (`exitWith`) on invalid input.
 */
function validateNotes(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw.length > 500) {
    format.error(`--message too long (${raw.length} chars). Max 500.`);
    exitWith(1);
  }
  if (raw.includes("\x00")) {
    format.error("--message must not contain null bytes.");
    exitWith(1);
  }
  return raw;
}
