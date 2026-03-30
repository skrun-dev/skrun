import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AgentConfigSchema, serializeAgentYaml } from "@skrun-dev/schema";
import { type Command, Option } from "commander";
import * as format from "../utils/format.js";
import { DEFAULT_MODELS_BY_PROVIDER, askModel, askText } from "../utils/prompts.js";
import { initFromSkill } from "./init-from-skill.js";

const SKILL_MD_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

## Instructions

Describe what this agent should do. The agent will follow these instructions
when processing requests via POST /run.

## Examples

Provide example inputs and expected outputs to guide the agent.
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init [dir]")
    .description("Create a new Skrun agent")
    .option("--from-skill <path>", "Import an existing Agent Skill")
    .option("--force", "Overwrite existing files")
    .option("--name <name>", "Agent name (non-interactive)")
    .option("--description <desc>", "Agent description (non-interactive)")
    .addOption(
      new Option(
        "--provider <provider>",
        "Provider with a default model (non-interactive)",
      ).choices(Object.keys(DEFAULT_MODELS_BY_PROVIDER)),
    )
    .option("--model <model>", "Model as provider/name (non-interactive)")
    .option("--namespace <ns>", "Agent namespace (non-interactive)")
    .action(async (dir: string | undefined, opts) => {
      if (opts.fromSkill) {
        await initFromSkill(opts.fromSkill, opts);
        return;
      }
      await runInit(dir, opts);
    });
}

interface InitOptions {
  force?: boolean;
  name?: string;
  description?: string;
  provider?: keyof typeof DEFAULT_MODELS_BY_PROVIDER;
  model?: string;
  namespace?: string;
}

export async function resolveInitModel(
  opts: Pick<InitOptions, "model" | "provider">,
): Promise<{ provider: string; name: string }> {
  if (opts.model) {
    const parts = opts.model.split("/");
    return {
      provider: parts[0],
      name: parts.slice(1).join("/"),
    };
  }

  if (opts.provider) {
    return {
      provider: opts.provider,
      name: DEFAULT_MODELS_BY_PROVIDER[opts.provider],
    };
  }

  return askModel();
}

async function runInit(dir: string | undefined, opts: InitOptions): Promise<void> {
  const targetDir = dir ? resolve(dir) : process.cwd();
  const dirName = basename(targetDir);

  // Check for existing SKILL.md
  const skillPath = join(targetDir, "SKILL.md");
  if (existsSync(skillPath) && !opts.force) {
    format.error("SKILL.md already exists. Use --force to overwrite.");
    process.exit(1);
  }

  // Gather info — interactive or from flags
  const name = opts.name ?? (await askText("Agent name?", dirName));
  const description =
    opts.description ?? (await askText("Description?", `A Skrun agent for ${name}.`));

  const model = await resolveInitModel(opts);

  const namespace = opts.namespace ?? (await askText("Namespace?", "my"));

  // Create directory if needed
  if (dir && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Generate SKILL.md
  writeFileSync(skillPath, SKILL_MD_TEMPLATE(name, description), "utf-8");

  // Generate agent.yaml
  const config = AgentConfigSchema.parse({
    name: `${namespace}/${name}`,
    version: "1.0.0",
    model,
    inputs: [{ name: "query", type: "string", required: true }],
    outputs: [{ name: "result", type: "string" }],
  });

  const agentYamlPath = join(targetDir, "agent.yaml");
  writeFileSync(agentYamlPath, serializeAgentYaml(config), "utf-8");

  format.success(`Agent created in ${dir ?? "."}`);
  format.info("Run `skrun dev` to start developing.");
}
