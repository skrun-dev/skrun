import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

function client(): RegistryClient {
  const token = getToken();
  if (!token) {
    format.error("Not logged in. Run `skrun login` first.");
    process.exit(1);
  }
  return new RegistryClient(getRegistryUrl(), token);
}

export interface CreateKeyInput {
  name: string;
  scope_kind: "account" | "agents";
  agents: string[];
  scopes?: string[];
}

/** Map `skrun keys create` flags to the `POST /api/keys` payload. Pure (tested). */
export function buildCreateKeyInput(opts: {
  name: string;
  agent?: string;
  runOnly?: boolean;
}): CreateKeyInput {
  return {
    name: opts.name,
    scope_kind: opts.agent ? "agents" : "account",
    agents: opts.agent ? [opts.agent] : [],
    // Omit `scopes` for a full key; run-only narrows to `agent:run`.
    scopes: opts.runOnly ? ["agent:run"] : undefined,
  };
}

/**
 * `skrun keys` — manage API keys. The headline use case is minting a restricted
 * key for a client: `skrun keys create --name acme --agent dev/my-agent
 * --run-only` produces a key that can only run that one agent, with no account
 * access (the "restricted key" pattern). Key management itself requires an
 * account-wide credential — a scoped or run-only key cannot mint or revoke keys.
 */
export function registerKeysCommand(program: Command): void {
  const keys = program.command("keys").description("Manage API keys");

  keys
    .command("create")
    .description("Create an API key (optionally scoped to a single agent)")
    .requiredOption("--name <name>", "Key name")
    .option("--agent <ns/name>", "Scope the key to a single agent you own")
    .option("--run-only", "Restrict the key to running (no push/verify)")
    .action(async (opts: { name: string; agent?: string; runOnly?: boolean }) => {
      try {
        const result = await client().createKey(buildCreateKeyInput(opts));
        format.success("API key created — save it now, it won't be shown again:");
        format.info(String(result.key));
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  keys
    .command("list")
    .description("List your API keys")
    .action(async () => {
      try {
        const list = await client().listKeys();
        if (list.length === 0) {
          format.info("No API keys.");
          return;
        }
        for (const k of list) {
          const scope = k.scope_kind === "agents" ? "scoped" : "account";
          format.info(`${k.key_prefix}…  ${String(k.name)}  [${scope}]`);
        }
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  keys
    .command("revoke <id>")
    .description("Revoke (delete) an API key by id")
    .action(async (id: string) => {
      try {
        await client().revokeKey(id);
        format.success(`Revoked key ${id}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
