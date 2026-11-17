import { MODEL_CHOICES } from "../model-choices.js";
import type { ParsedSkill } from "../parsers/skill-md.js";
import type { AgentConfig } from "../schemas/agent-config.js";
import type { ToolConfig } from "../schemas/tool-config.js";

export interface AgentYamlPrompt {
  field: string;
  question: string;
  type: "select" | "text";
  options?: string[];
  default?: string;
}

export interface GeneratedAgentYaml {
  config: Partial<AgentConfig>;
  prompts: AgentYamlPrompt[];
}

export function generateAgentYaml(skill: ParsedSkill): GeneratedAgentYaml {
  const allowedTools = skill.frontmatter["allowed-tools"];
  // SKILL.md allowed-tools uses Claude Code permission patterns like "Bash(git:*)".
  // For Skrun tool declarations we only want the base tool name (prefix before "(").
  const toolNames = allowedTools
    ? [
        ...new Set(
          allowedTools
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => t.split("(")[0])
            .filter(Boolean),
        ),
      ]
    : [];
  const tools: ToolConfig[] = toolNames.map((name) => ({
    name,
    description: `Execute ${name} script`,
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    required: false,
  }));

  const config: Partial<AgentConfig> = {
    // name is set to skill.frontmatter.name (slug-only); namespace is assigned at push by the registry
    version: "1.0.0",
    tools,
    mcp_servers: [],
    environment: {
      networking: { allowed_hosts: [] },
      timeout: "300s",
    },
    context_mode: "skill",
    state: {
      type: "none",
      scope: "per_caller",
      ttl: "30d",
    },
    tests: [],
  };

  // The same choices `skrun init` offers, as "provider / name".
  const modelOptions = MODEL_CHOICES.map((c) => `${c.provider} / ${c.name}`);
  const prompts: AgentYamlPrompt[] = [
    {
      field: "model",
      question: "Which model provider and name?",
      type: "select",
      options: modelOptions,
      default: modelOptions[0],
    },
    {
      field: "inputs",
      question: "Main input name and type for your agent?",
      type: "text",
      default: "query:string",
    },
    {
      field: "environment.networking.allowed_hosts",
      question: "Domains this agent needs to access? (comma-separated, empty for none)",
      type: "text",
      default: "",
    },
  ];

  return { config, prompts };
}
