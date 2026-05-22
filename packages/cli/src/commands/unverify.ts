import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";
import { parseAgentRef } from "./verify.js";

export function registerUnverifyCommand(program: Command): void {
  program
    .command("unverify <agent>")
    .description(
      "Revoke verification on an agent version (admin only). Usage: skrun unverify <namespace>/<name>@<version>",
    )
    .action(async (agentArg: string) => {
      const ref = parseAgentRef(agentArg);
      if (!ref) {
        format.error("Usage: skrun unverify <namespace>/<name>@<version>");
        process.exit(1);
      }

      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      const client = new RegistryClient(getRegistryUrl(), token);
      try {
        await client.verifyVersion(ref.namespace, ref.name, ref.version, false);
        format.success(`Version ${ref.version} of ${ref.namespace}/${ref.name} unverified.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
