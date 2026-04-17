import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentConfigSchema,
  generateAgentYaml,
  parseSkillMd,
  serializeAgentYaml,
} from "@skrun-dev/schema";
import * as format from "../utils/format.js";
import { askModel, askText } from "../utils/prompts.js";

interface FromSkillOptions {
  force?: boolean;
  model?: string;
  namespace?: string;
}

export async function initFromSkill(skillPath: string, opts: FromSkillOptions): Promise<void> {
  const dir = resolve(skillPath);
  const skillMdPath = join(dir, "SKILL.md");
  const agentYamlPath = join(dir, "agent.yaml");
  const agentsMdPath = join(dir, "AGENTS.md");

  // Check SKILL.md exists
  if (!existsSync(skillMdPath)) {
    format.error(`No SKILL.md found in ${dir}. Is this an Agent Skills directory?`);
    process.exit(1);
  }

  // Check existing agent.yaml
  if (existsSync(agentYamlPath) && !opts.force) {
    format.error("agent.yaml already exists. Use --force to overwrite.");
    process.exit(1);
  }

  // Parse SKILL.md
  const content = readFileSync(skillMdPath, "utf-8");
  let skill: ReturnType<typeof parseSkillMd>;
  try {
    skill = parseSkillMd(content);
  } catch (err) {
    format.error(`SKILL.md validation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  format.success(`SKILL.md detected: ${skill.frontmatter.name}`);

  // Generate partial config + prompts
  const generated = generateAgentYaml(skill);

  // Detect AGENTS.md
  const hasAgentsMd = existsSync(agentsMdPath);
  if (hasAgentsMd) {
    generated.config.context_mode = "persistent";
    format.info("Detected AGENTS.md — setting context_mode to persistent.");
  }

  // Resolve model
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

  // Resolve namespace
  const namespace = opts.namespace ?? (await askText("Namespace?", "my"));

  // Resolve input
  const inputStr = await askText("Main input name and type? (name:type)", "query:string");
  const [inputName, inputType] = inputStr.split(":");

  // Resolve network permissions
  const networkStr = await askText(
    "Domains this agent needs to access? (comma-separated, empty for none)",
    "",
  );
  const network = networkStr
    ? networkStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Build full config
  const fullConfig = AgentConfigSchema.parse({
    ...generated.config,
    name: `${namespace}/${skill.frontmatter.name}`,
    model: { provider, name: modelName },
    inputs: [{ name: inputName || "query", type: inputType || "string", required: true }],
    outputs: [{ name: "result", type: "string" }],
    environment: {
      ...generated.config.environment,
      networking: { allowed_hosts: network },
    },
  });

  // Write agent.yaml
  writeFileSync(agentYamlPath, serializeAgentYaml(fullConfig), "utf-8");

  format.success("agent.yaml generated.");
  format.info("Run `skrun dev` to test locally.");
}
