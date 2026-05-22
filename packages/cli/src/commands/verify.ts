import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

/**
 * Parsed `<namespace>/<name>@<version>` syntax. Versions are semver-shaped
 * strings; the server is the source of truth and rejects malformed values.
 */
interface AgentRef {
  namespace: string;
  name: string;
  version: string;
}

const AGENT_REF_REGEX = /^([a-z0-9-]+)\/([a-z0-9-]+)@(.+)$/;

export function parseAgentRef(arg: string): AgentRef | null {
  const match = arg.match(AGENT_REF_REGEX);
  if (!match) return null;
  const [, namespace, name, version] = match;
  if (!namespace || !name || !version) return null;
  return { namespace, name, version };
}

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify <agent>")
    .description(
      "Mark an agent version as verified (admin only). Usage: skrun verify <namespace>/<name>@<version>",
    )
    .action(async (agentArg: string) => {
      const ref = parseAgentRef(agentArg);
      if (!ref) {
        format.error("Usage: skrun verify <namespace>/<name>@<version>");
        process.exit(1);
      }

      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      const client = new RegistryClient(getRegistryUrl(), token);
      try {
        await client.verifyVersion(ref.namespace, ref.name, ref.version, true);
        format.success(`Version ${ref.version} of ${ref.namespace}/${ref.name} verified.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
