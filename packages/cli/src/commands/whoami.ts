import type { Command } from "commander";
import {
  InvalidRegistryUrl,
  NotSignedIn,
  resolveTarget,
  sessionState,
  signInCommand,
  type Target,
} from "../utils/auth.js";
import { CliExit, exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";

/**
 * `skrun whoami` — prints the current CLI identity (namespace + registry).
 *
 * The server is the one the next command would talk to, by the order the CLI
 * resolves it in — printed even without a session, so a sign-in to the wrong
 * server shows. Referenced by the `skrun pull` 404 error hint: when a user gets
 * a not-found, they can run `whoami` to verify which account their CLI is
 * authenticated with. Common scenario: pushed an agent under OAuth account
 * Alice but the CLI session is currently logged in as Bob, so `skrun pull
 * alice/foo` returns 404 (Bob doesn't own it).
 */
export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Print the current CLI identity (namespace + registry URL)")
    .action(async () => {
      let target: Target;
      try {
        target = resolveTarget();
      } catch (err) {
        if (!(err instanceof InvalidRegistryUrl)) throw err;
        format.error(err.message);
        exitWith(1);
      }
      const { address, source } = target;

      const state = sessionState(address);
      if (state !== "present") {
        format.info(`Registry:  ${address}`);
        format.error(
          state === "absent"
            ? `Not logged in. Sign in: ${signInCommand(address, source)}`
            : new NotSignedIn(address, state, source).message,
        );
        exitWith(1);
      }

      try {
        const namespace = await connect().currentNamespace();
        format.info(`Namespace: ${namespace}`);
        format.info(`Registry:  ${address}`);
      } catch (err) {
        if (err instanceof CliExit) throw err; // connect() already said why
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });
}
