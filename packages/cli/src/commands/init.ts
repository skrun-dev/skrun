import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AgentConfigSchema, serializeAgentYaml } from "@skrun-dev/schema";
import type { Command } from "commander";
import * as format from "../utils/format.js";
import { askModel, askText } from "../utils/prompts.js";
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
    .option("--model <model>", "Model as provider/name (non-interactive)")
    .action(async (dir: string | undefined, opts) => {
      if (opts.fromSkill) {
        await initFromSkill(opts.fromSkill, opts);
        return;
      }
      await runInit(dir, opts);
    });
}

export interface InitOptions {
  force?: boolean;
  name?: string;
  description?: string;
  model?: string;
}

export async function runInit(dir: string | undefined, opts: InitOptions): Promise<void> {
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

  let provider: string;
  let modelName: string;
  if (opts.model) {
    const parts = opts.model.split("/");
    provider = parts[0];
    modelName = parts.slice(1).join("/");
  } else {
    const model = await askModel();
    provider = model.provider;
    modelName = model.name;
  }

  // Create directory if needed
  if (dir && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Generate SKILL.md
  writeFileSync(skillPath, SKILL_MD_TEMPLATE(name, description), "utf-8");

  // Generate agent.yaml — namespace is assigned by the registry at push time
  // (from your auth context), so the yaml only carries the slug.
  const config = AgentConfigSchema.parse({
    name,
    version: "1.0.0",
    model: { provider, name: modelName },
    inputs: [{ name: "query", type: "string", required: true }],
    outputs: [{ name: "result", type: "string" }],
  });

  const agentYamlPath = join(targetDir, "agent.yaml");
  writeFileSync(agentYamlPath, serializeAgentYaml(config), "utf-8");

  format.success(`Agent created in ${dir ?? "."}`);
  format.info("Run `skrun dev` to start developing.");
}
