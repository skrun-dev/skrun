import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationIssue } from "../errors.js";
import type { ParsedAgentYaml } from "../parsers/agent-yaml.js";
import { parseAgentYaml } from "../parsers/agent-yaml.js";
import type { ParsedAgentsMd } from "../parsers/agents-md.js";
import { parseAgentsMd } from "../parsers/agents-md.js";
import type { ParsedSkill } from "../parsers/skill-md.js";
import { parseSkillMd } from "../parsers/skill-md.js";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  parsed: {
    skill: ParsedSkill;
    agentConfig: ParsedAgentYaml;
    agentsMd?: ParsedAgentsMd;
  } | null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateAgent(dir: string): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const skillPath = join(dir, "SKILL.md");
  const agentYamlPath = join(dir, "agent.yaml");
  const agentsMdPath = join(dir, "AGENTS.md");

  // Check SKILL.md exists
  if (!(await fileExists(skillPath))) {
    errors.push({
      code: "MISSING_SKILL_MD",
      message: "SKILL.md is required but not found in the agent directory",
      file: "SKILL.md",
    });
  }

  // Check agent.yaml exists
  if (!(await fileExists(agentYamlPath))) {
    errors.push({
      code: "MISSING_AGENT_YAML",
      message: "agent.yaml is required but not found in the agent directory",
      file: "agent.yaml",
    });
  }

  // If either required file is missing, return early
  if (errors.length > 0) {
    return { valid: false, errors, warnings, parsed: null };
  }

  // Parse SKILL.md
  let skill: ParsedSkill;
  try {
    const content = await readFile(skillPath, "utf-8");
    skill = parseSkillMd(content);
    skill.filePath = skillPath;
  } catch (cause) {
    errors.push({
      code: "INVALID_SKILL_MD",
      message: `Failed to parse SKILL.md: ${cause instanceof Error ? cause.message : String(cause)}`,
      file: "SKILL.md",
    });
    return { valid: false, errors, warnings, parsed: null };
  }

  // Parse agent.yaml
  let agentConfig: ParsedAgentYaml;
  try {
    const content = await readFile(agentYamlPath, "utf-8");
    agentConfig = parseAgentYaml(content);
    agentConfig.filePath = agentYamlPath;
  } catch (cause) {
    errors.push({
      code: "INVALID_AGENT_YAML",
      message: `Failed to parse agent.yaml: ${cause instanceof Error ? cause.message : String(cause)}`,
      file: "agent.yaml",
    });
    return { valid: false, errors, warnings, parsed: null };
  }

  // Check AGENTS.md if context_mode is persistent
  let agentsMd: ParsedAgentsMd | undefined;
  if (agentConfig.config.context_mode === "persistent") {
    if (!(await fileExists(agentsMdPath))) {
      errors.push({
        code: "CONTEXT_MODE_NO_AGENTS_MD",
        message:
          'context_mode is "persistent" but AGENTS.md is missing. Create AGENTS.md or set context_mode to "skill".',
        file: "AGENTS.md",
      });
    } else {
      try {
        const content = await readFile(agentsMdPath, "utf-8");
        agentsMd = parseAgentsMd(content);
        agentsMd.filePath = agentsMdPath;
      } catch (cause) {
        errors.push({
          code: "INVALID_AGENTS_MD",
          message: `Failed to parse AGENTS.md: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: "AGENTS.md",
        });
      }
    }
  }

  // Cross-file warnings: name consistency
  const skillName = skill.frontmatter.name;
  const agentSlug = agentConfig.config.name.split("/")[1];
  if (agentSlug && skillName !== agentSlug) {
    warnings.push({
      code: "NAME_MISMATCH",
      message: `SKILL.md name "${skillName}" does not match agent.yaml slug "${agentSlug}"`,
    });
  }

  // Cross-file warnings: tools alignment
  const allowedTools = skill.frontmatter["allowed-tools"];
  if (allowedTools && agentConfig.config.tools.length > 0) {
    const skillTools = allowedTools.split(/\s+/).filter(Boolean);
    const agentToolNames = agentConfig.config.tools.map((t) => t.name);
    const extraTools = agentToolNames.filter((t) => !skillTools.some((st) => st.includes(t)));
    if (extraTools.length > 0) {
      warnings.push({
        code: "TOOLS_NOT_IN_SKILL",
        message: `agent.yaml declares tools [${extraTools.join(", ")}] not listed in SKILL.md allowed-tools`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed: errors.length === 0 ? { skill, agentConfig, agentsMd } : null,
  };
}
