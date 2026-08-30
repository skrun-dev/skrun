import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

/** `<namespace>/<name>` — visibility is per-agent, so there's no `@version`. */
const AGENT_NAME_REGEX = /^([a-z0-9-]+)\/([a-z0-9-]+)$/;

export function registerVisibilityCommand(program: Command): void {
  program
    .command("visibility <agent> <visibility>")
    .description(
      "Set agent visibility. Usage: skrun visibility <namespace>/<name> private (public ships with the marketplace)",
    )
    .action(async (agentArg: string, visibilityArg: string) => {
      const match = agentArg.match(AGENT_NAME_REGEX);
      if (!match) {
        format.error("Usage: skrun visibility <namespace>/<name> private");
        process.exit(1);
      }
      // Public visibility is a marketplace primitive; the hosting model is
      // private-only for now, so reject it before calling the API (the server
      // enforces the same rule with a 400).
      if (visibilityArg === "public") {
        format.error(
          "Public visibility ships with the marketplace; agents are private-only for now.",
        );
        process.exit(1);
      }
      if (visibilityArg !== "private") {
        format.error("Visibility must be 'private'.");
        process.exit(1);
      }
      const [, namespace, name] = match;

      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      const client = new RegistryClient(getRegistryUrl(), token);
      try {
        await client.setVisibility(namespace, name, visibilityArg);
        format.success(`${namespace}/${name} is now ${visibilityArg}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
