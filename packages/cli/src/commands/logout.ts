import type { Command } from "commander";
import {
  InvalidRegistryUrl,
  removeOlderConfig,
  removeSession,
  resolveTarget,
} from "../utils/auth.js";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";

/**
 * `skrun logout` — removes the session of the server the CLI targets, by the
 * order it resolves it in, and no other; if it was the current server, none is
 * current afterwards — no other session takes its place. A sign-in file of an
 * older CLI, or one that cannot be read, is removed whole. Nothing is sent.
 */
export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Sign out of the server the CLI is using: remove its saved session, and no other")
    .action(() => {
      if (removeOlderConfig()) {
        format.success("Removed the sign-in saved by an older CLI.");
        return;
      }

      let address: string;
      try {
        address = resolveTarget().address;
      } catch (err) {
        if (!(err instanceof InvalidRegistryUrl)) throw err;
        format.error(err.message);
        exitWith(1);
      }

      if (removeSession(address)) {
        format.success(`Logged out of ${address}.`);
      } else {
        format.info(`No session for ${address} — nothing to remove.`);
      }
    });
}
