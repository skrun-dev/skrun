import type { Command } from "commander";
import { getCurrentNamespace, getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";

/**
 * `skrun whoami` — prints the current CLI identity (namespace + registry).
 *
 * Referenced by the `skrun pull` 404 error hint: when a user gets
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
      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }
      try {
        const namespace = await getCurrentNamespace();
        format.info(`Namespace: ${namespace}`);
        format.info(`Registry:  ${getRegistryUrl()}`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
