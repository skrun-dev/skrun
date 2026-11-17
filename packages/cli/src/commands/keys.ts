import type { Command } from "commander";
import { CliExit, exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";

export interface CreateKeyInput {
  name: string;
  scope_kind: "account" | "agents";
  agents: string[];
  scopes?: string[];
  expires_at?: string;
}

/** The longest `--expires-in` accepted, in days: a hundred years. */
export const MAX_EXPIRES_IN_DAYS = 36_500;

const DAY_MS = 86_400_000;

/**
 * Read `--expires-in <days>`: a whole number of days, from 1 to
 * MAX_EXPIRES_IN_DAYS, written in digits only (`1e3` is refused, not read as
 * 1000). Anything else throws a message that names the option and its bound.
 */
function parseExpiresInDays(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_EXPIRES_IN_DAYS) {
    throw new Error(
      `--expires-in takes a whole number of days, from 1 to ${MAX_EXPIRES_IN_DAYS} (got "${raw}").`,
    );
  }
  return Number(raw);
}

/** The flags of `skrun keys create`, as commander hands them over. */
export interface CreateKeyFlags {
  name: string;
  agent?: string;
  runOnly?: boolean;
  expiresIn?: string;
}

/**
 * Map `skrun keys create` flags to the `POST /api/keys` payload. Pure (tested):
 * `now` is injectable. It throws on an invalid `--expires-in`, so nothing is
 * sent. Without `--expires-in` the payload has no `expires_at`, and the server
 * mints a key that never expires; the server stays the judge of the date.
 */
export function buildCreateKeyInput(opts: CreateKeyFlags, now = Date.now()): CreateKeyInput {
  const input: CreateKeyInput = {
    name: opts.name,
    scope_kind: opts.agent ? "agents" : "account",
    agents: opts.agent ? [opts.agent] : [],
    // Omit `scopes` for a full key; run-only narrows to `agent:run`.
    scopes: opts.runOnly ? ["agent:run"] : undefined,
  };
  if (opts.expiresIn !== undefined) {
    const days = parseExpiresInDays(opts.expiresIn);
    input.expires_at = new Date(now + days * DAY_MS).toISOString();
  }
  return input;
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
    .option(
      "--expires-in <days>",
      `Expire the key after this many days (1 to ${MAX_EXPIRES_IN_DAYS}); without it, the key never expires`,
    )
    .action(async (opts: CreateKeyFlags) => {
      try {
        // Built first: an invalid --expires-in throws before any request.
        const input = buildCreateKeyInput(opts);
        const result = await connect().createKey(input);
        format.success("API key created — save it now, it won't be shown again:");
        format.info(String(result.key));
        // The id is what `skrun keys revoke <id>` takes.
        format.info(`id: ${String(result.id)}`);
        if (result.expires_at == null) {
          format.info("This key never expires; pass --expires-in <days> to give a key an expiry.");
        } else {
          format.info(`expires: ${String(result.expires_at)}`);
        }
      } catch (err) {
        if (err instanceof CliExit) throw err; // connect() already said why
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });

  keys
    .command("list")
    .description("List your API keys")
    .action(async () => {
      try {
        const list = await connect().listKeys();
        if (list.length === 0) {
          format.info("No API keys.");
          return;
        }
        for (const k of list) {
          const scope = k.scope_kind === "agents" ? "scoped" : "account";
          const expires = k.expires_at == null ? "never" : String(k.expires_at);
          // The id first: it is what `skrun keys revoke <id>` takes.
          format.info(
            `${String(k.id)}  ${k.key_prefix}…  ${String(k.name)}  [${scope}]  expires: ${expires}`,
          );
        }
      } catch (err) {
        if (err instanceof CliExit) throw err; // connect() already said why
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });

  keys
    .command("revoke <id>")
    .description("Revoke (delete) an API key by id")
    .action(async (id: string) => {
      try {
        await connect().revokeKey(id);
        format.success(`Revoked key ${id}.`);
      } catch (err) {
        if (err instanceof CliExit) throw err; // connect() already said why
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
    });
}
