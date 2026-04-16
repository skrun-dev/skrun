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
  }));

  const config: Partial<AgentConfig> = {
    // name will be prefixed with namespace by CLI: `${namespace}/${skill.frontmatter.name}`
    version: "1.0.0",
    tools,
    mcp_servers: [],
    permissions: {
      network: [],
      filesystem: "read-only",
      secrets: [],
    },
    runtime: {
      timeout: "300s",
      max_cost: undefined,
      sandbox: "strict",
    },
    context_mode: "skill",
    state: {
      type: "kv",
      ttl: "30d",
    },
    tests: [],
  };

  const prompts: AgentYamlPrompt[] = [
    {
      field: "model",
      question: "Which model provider and name?",
      type: "select",
      options: [
        "anthropic / claude-sonnet-4-20250514",
        "openai / gpt-4o",
        "mistral / mistral-large-latest",
        "groq / llama-3.3-70b-versatile",
      ],
      default: "anthropic / claude-sonnet-4-20250514",
    },
    {
      field: "inputs",
      question: "Main input name and type for your agent?",
      type: "text",
      default: "query:string",
    },
    {
      field: "permissions.network",
      question: "Domains this agent needs to access? (comma-separated, empty for none)",
      type: "text",
      default: "",
    },
  ];

  return { config, prompts };
}
