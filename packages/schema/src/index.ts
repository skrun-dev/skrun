// @skrun-dev/schema — Parser & validator for Agent Skills format

// Errors
export { SkrunError, ValidationError } from "./errors.js";
export type { ValidationIssue } from "./errors.js";

// Schemas
export {
  AgentConfigSchema,
  InputFieldSchema,
  OutputFieldSchema,
  McpServerSchema,
  ModelConfigSchema,
  ModelProviderSchema,
  FallbackModelSchema,
  EnvironmentConfigSchema,
  NetworkingConfigSchema,
  SkillFrontmatterSchema,
  StateConfigSchema,
  TestCaseSchema,
  ToolConfigSchema,
  InputSchemaSchema,
} from "./schemas/index.js";

export type {
  AgentConfig,
  InputField,
  OutputField,
  McpServer,
  ModelConfig,
  ModelProvider,
  EnvironmentConfig,
  NetworkingConfig,
  SkillFrontmatter,
  StateConfig,
  TestCase,
  ToolConfig,
  InputSchema,
} from "./schemas/index.js";

// Parsers
export { parseSkillMd, parseSkillMdFile } from "./parsers/skill-md.js";
export type { ParsedSkill } from "./parsers/skill-md.js";

export { parseAgentsMd, parseAgentsMdFile } from "./parsers/agents-md.js";
export type { ParsedAgentsMd } from "./parsers/agents-md.js";

export { parseAgentYaml, parseAgentYamlFile } from "./parsers/agent-yaml.js";
export type { ParsedAgentYaml } from "./parsers/agent-yaml.js";

// Validators
export { validateAgent } from "./validators/combined.js";
export type { ValidationResult } from "./validators/combined.js";

// Generators
export { generateAgentYaml } from "./generators/skill-importer.js";
export type { GeneratedAgentYaml, AgentYamlPrompt } from "./generators/skill-importer.js";

export { serializeAgentYaml } from "./generators/yaml-serializer.js";
