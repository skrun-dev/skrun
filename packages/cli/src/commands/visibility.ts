import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";

/** `<namespace>/<name>` — visibility is per-agent, so there's no `@version`. */
const AGENT_NAME_REGEX = /^([a-z0-9-]+)\/([a-z0-9-]+)$/;

export function registerVisibilityCommand(program: Command): void {
  program
    .command("visibility <agent> <visibility>")
    .description(
      "Set agent visibility. Usage: skrun visibility <namespace>/<name> private (public is not available for now)",
    )
    .action(async (agentArg: string, visibilityArg: string) => {
      const match = agentArg.match(AGENT_NAME_REGEX);
      if (!match) {
        format.error("Usage: skrun visibility <namespace>/<name> private");
        exitWith(1);
      }
      // Public visibility is disabled for now: the hosting model is
      // private-only, so reject it before calling the API (the server
      // enforces the same rule with a 400).
      if (visibilityArg === "public") {
        format.error("Public visibility is not available for now; agents are private-only.");
        exitWith(1);
      }
      if (visibilityArg !== "private") {
        format.error("Visibility must be 'private'.");
        exitWith(1);
      }
      const [, namespace, name] = match;

      // The server this goes to, and its session
      const client = connect();
      try {
        await client.setVisibility(namespace, name, visibilityArg);
        format.success(`${namespace}/${name} is now ${visibilityArg}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });
}
