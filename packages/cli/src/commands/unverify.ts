import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";
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
        exitWith(1);
      }

      // The server this goes to, and its session
      const client = connect();
      try {
        await client.verifyVersion(ref.namespace, ref.name, ref.version, false);
        format.success(`Version ${ref.version} of ${ref.namespace}/${ref.name} unverified.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });
}
