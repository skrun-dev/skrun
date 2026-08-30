import { stdin } from "node:process";
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

/** Split `<namespace>/<name>` into its parts. Pure (tested). */
export function splitAgent(agent: string): { ns: string; name: string } {
  const slash = agent.indexOf("/");
  const ns = slash === -1 ? "" : agent.slice(0, slash);
  const name = slash === -1 ? "" : agent.slice(slash + 1);
  if (!ns || !name) throw new Error("--agent must be in the form <namespace>/<name>.");
  return { ns, name };
}

/** Normalise the CLI policy arg (`open` | `creator-only`/`creator_only`). Pure (tested). */
export function parsePolicy(arg: string): "open" | "creator_only" {
  const normalized = arg.toLowerCase().replace("-", "_");
  if (normalized === "open") return "open";
  if (normalized === "creator_only") return "creator_only";
  throw new Error(`Invalid policy '${arg}'. Use 'open' or 'creator-only'.`);
}

/**
 * Resolve the LLM key from `--key-env <VAR>` or stdin — NEVER a positional
 * argument, so the secret doesn't land in the shell history. Pure (tested).
 */
export async function resolveKeyInput(
  opts: { keyEnv?: string },
  env: NodeJS.ProcessEnv,
  readStdin: () => Promise<string>,
): Promise<string> {
  if (opts.keyEnv) {
    const value = env[opts.keyEnv];
    if (!value?.trim()) {
      throw new Error(`Environment variable ${opts.keyEnv} is empty or unset.`);
    }
    return value.trim();
  }
  const piped = (await readStdin()).trim();
  if (!piped) {
    throw new Error("No key provided. Pipe it via stdin, or pass --key-env <VAR>.");
  }
  return piped;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `skrun llm-key` — manage the creator LLM keys attached to your agent. Attaching
 * a key lets your callers run the agent without supplying their own key (you cover
 * the inference). The key is read from stdin or `--key-env`, never an argument, so
 * it never reaches the shell history; the server stores it encrypted and never
 * returns it.
 */
export function registerLlmKeyCommand(program: Command): void {
  const cmd = program.command("llm-key").description("Manage your agent's creator LLM keys");

  cmd
    .command("set <provider>")
    .description("Attach (or replace) your LLM key for a provider (key from stdin or --key-env)")
    .requiredOption("--agent <ns/name>", "The agent you own")
    .option("--key-env <var>", "Read the key from this env var instead of stdin")
    .action(async (provider: string, opts: { agent: string; keyEnv?: string }) => {
      try {
        const { ns, name } = splitAgent(opts.agent);
        const key = await resolveKeyInput(opts, process.env, readStdin);
        await client().setLlmKey(ns, name, provider, key);
        format.success(`Attached ${provider} key to ${opts.agent}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List attached providers + the caller-key policy")
    .requiredOption("--agent <ns/name>", "The agent you own")
    .action(async (opts: { agent: string }) => {
      try {
        const { ns, name } = splitAgent(opts.agent);
        const { policy, keys } = await client().listLlmKeys(ns, name);
        format.info(`policy: ${policy}`);
        if (keys.length === 0) {
          format.info("No LLM key attached.");
          return;
        }
        for (const k of keys) {
          format.info(`${String(k.provider)}  ••••${String(k.last4)}`);
        }
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("rm <provider>")
    .description("Remove your LLM key for a provider")
    .requiredOption("--agent <ns/name>", "The agent you own")
    .action(async (provider: string, opts: { agent: string }) => {
      try {
        const { ns, name } = splitAgent(opts.agent);
        await client().removeLlmKey(ns, name, provider);
        format.success(`Removed ${provider} key from ${opts.agent}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("policy <policy>")
    .description("Set the caller-key policy: open | creator-only")
    .requiredOption("--agent <ns/name>", "The agent you own")
    .action(async (policyArg: string, opts: { agent: string }) => {
      try {
        const { ns, name } = splitAgent(opts.agent);
        const policy = parsePolicy(policyArg);
        await client().setLlmKeyPolicy(ns, name, policy);
        format.success(`Set caller-key policy to ${policy} for ${opts.agent}.`);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
