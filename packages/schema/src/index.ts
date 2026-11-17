// @skrun-dev/schema — Parser & validator for Agent Skills format

export type { AgentTarEntry, UnpackAgentTarOptions, UnpackedAgentEntry } from "./bundle-tar.js";
// Bundle tar codec (.agent wire format); an archive past the decompression cap
// its reader sets rejects with BundleDecompressedTooLargeError, carrying the cap,
// and one an entry of which cannot be written out with BundleEntryError.
// The bounds of a server with the default settings, the fixed limit of an
// agent.yaml, and the one reading of BUNDLE_MAX_DECOMPRESSED_MB — and of the
// server's request-body caps (readMbSetting) —, shared by the server and the CLI
export {
  AGENT_BUNDLE_EXCLUDES,
  AGENT_YAML_MAX_BYTES,
  BUNDLE_ENTRY_NAME_MAX_BYTES,
  BUNDLE_ENTRY_PATH_MAX_BYTES,
  BundleDecompressedTooLargeError,
  BundleEntryError,
  DEFAULT_MAX_DECOMPRESSED_MB,
  DEFAULT_PUSH_MAX_BODY_MB,
  decompressedCapText,
  isExcludedEntry,
  isUnsafeName,
  maxDecompressedBytes,
  packAgentTar,
  readMbSetting,
  unpackAgentTar,
} from "./bundle-tar.js";
export type { CapabilityValidationOutcome, ModelCapabilities } from "./capability.js";
// Capability matrix
export {
  acceptsTemperature,
  getModelCapabilities,
  MODEL_CAPABILITIES,
  validateAgentCapabilities,
} from "./capability.js";
export type { ValidationIssue } from "./errors.js";
// Errors
export { SkrunError, ValidationError } from "./errors.js";
// Generators
export { outputsToZod } from "./generators/outputs-to-zod.js";
export type { AgentYamlPrompt, GeneratedAgentYaml } from "./generators/skill-importer.js";
export { generateAgentYaml } from "./generators/skill-importer.js";
export { serializeAgentYaml } from "./generators/yaml-serializer.js";
export type {
  ManifestEcosystem,
  ManifestInfo,
  NodeLockfileKind,
  PythonLockfileKind,
  PythonManifestKind,
} from "./manifests.js";
// Manifest detection (script dependency resolution)
export { detectManifest, hasNonStdlibImports } from "./manifests.js";
export type { ModelChoice } from "./model-choices.js";
// Model choices offered to an agent author (skrun init, generateAgentYaml)
export { MODEL_CHOICES } from "./model-choices.js";
export type { AgentYamlWarnings, ParsedAgentYaml } from "./parsers/agent-yaml.js";
export { parseAgentYaml, parseAgentYamlFile } from "./parsers/agent-yaml.js";
export type { ParsedAgentsMd } from "./parsers/agents-md.js";
export { parseAgentsMd, parseAgentsMdFile } from "./parsers/agents-md.js";
export type { ParsedSkill } from "./parsers/skill-md.js";
// Parsers
export { parseSkillMd, parseSkillMdFile } from "./parsers/skill-md.js";
export type {
  RunBodyReading,
  RunBodyRefusal,
  RunInputTypeRefusal,
  RunMissingInputRefusal,
} from "./run-body.js";
// A run request's body: the agent's input is its input field, or the body is refused by name;
// then an input that is not an object is refused, its type named; then each input the agent
// declares, its absence, then its type. What an absent input is — no field of the input's own,
// undefined, null, or an empty list for a file input —, and the code and the words of the
// refusal of a required one, which the runtime's reading of the files throws too
export {
  isRunInputAbsent,
  runBodyInput,
  runDeclaredInputsRefusal,
  runInputTypeRefusal,
  runMissingInputRefusal,
} from "./run-body.js";
export type {
  AgentConfig,
  EnvironmentConfig,
  FileInputField,
  InputField,
  InputSchema,
  McpServer,
  Media,
  ModelConfig,
  ModelProvider,
  NetworkingConfig,
  OutputField,
  PrimitiveInputField,
  SandboxRefusedForm,
  SandboxRefusedHost,
  SkillFrontmatter,
  StateConfig,
  TestCase,
  ToolConfig,
  WireFileSource,
} from "./schemas/index.js";
// Schemas
export {
  AgentConfigSchema,
  DEFAULT_MAX_SIZE,
  DEFAULT_MIME_TYPES,
  EnvironmentConfigSchema,
  FallbackModelSchema,
  FileInputFieldSchema,
  InputFieldSchema,
  InputSchemaSchema,
  McpServerSchema,
  MEDIA_TYPES,
  ModelConfigSchema,
  ModelProviderSchema,
  NetworkingConfigSchema,
  OutputFieldSchema,
  PrimitiveInputFieldSchema,
  resolveFileInputDefaults,
  SkillFrontmatterSchema,
  STATE_TTL_MAX_DAYS,
  STATE_TTL_MIN_DAYS,
  StateConfigSchema,
  sandboxHostForm,
  sandboxRefusalMessage,
  sandboxRefusedHosts,
  stateTtlDays,
  TestCaseSchema,
  TIMEOUT_MAX_S,
  TIMEOUT_MIN_S,
  ToolConfigSchema,
  timeoutRawSeconds,
  WireFileSourceSchema,
} from "./schemas/index.js";
// Settings of agent.yaml no code honours: valid to the schema, refused by name before anything is published
export { findRefusedSettings } from "./schemas/refused-settings.js";
// Retired agent.yaml fields: ignored, and named by whoever reads the raw document
export type { RetiredField } from "./schemas/retired-fields.js";
export { findRetiredFields, RETIRED_FIELDS } from "./schemas/retired-fields.js";
// Retired models: still valid in agent.yaml, warned about by name, refused in the catalog
export type { RetiredModel } from "./schemas/retired-models.js";
export { findRetiredModels, RETIRED_MODELS } from "./schemas/retired-models.js";
export type { ValidationResult } from "./validators/combined.js";
// Validators
export { validateAgent } from "./validators/combined.js";
