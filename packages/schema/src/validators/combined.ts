import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { acceptsTemperature, getModelCapabilities } from "../capability.js";
import { ValidationError, type ValidationIssue } from "../errors.js";
import { detectManifest, hasNonStdlibImports } from "../manifests.js";
import type { ParsedAgentYaml } from "../parsers/agent-yaml.js";
import { AGENT_YAML_READING, parseAgentYaml } from "../parsers/agent-yaml.js";
import type { ParsedAgentsMd } from "../parsers/agents-md.js";
import { parseAgentsMd } from "../parsers/agents-md.js";
import type { ParsedSkill } from "../parsers/skill-md.js";
import { parseSkillMd } from "../parsers/skill-md.js";
import { sandboxRefusalMessage, sandboxRefusedHosts } from "../schemas/environment-config.js";
import { findRefusedSettings } from "../schemas/refused-settings.js";
import { findRetiredFields } from "../schemas/retired-fields.js";
import { findRetiredModels } from "../schemas/retired-models.js";
import {
  STATE_TTL_MAX_DAYS,
  STATE_TTL_MIN_DAYS,
  stateTtlRawDays,
} from "../schemas/state-config.js";

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
    // Surface every field-level issue from a ValidationError so the user sees
    // the actual remediation hint (e.g., "drop the namespace prefix"). Without
    // this, the CLI flattens to a generic "Invalid agent.yaml" and the Zod
    // message gets lost.
    if (cause instanceof ValidationError && cause.issues.length > 0) {
      for (const issue of cause.issues) {
        errors.push({
          code: "INVALID_AGENT_YAML",
          message: issue.message,
          file: "agent.yaml",
        });
      }
    } else {
      errors.push({
        code: "INVALID_AGENT_YAML",
        message: `Failed to parse agent.yaml: ${cause instanceof Error ? cause.message : String(cause)}`,
        file: "agent.yaml",
      });
    }
    return { valid: false, errors, warnings, parsed: null };
  }

  // The state ttl, refused outside its bounds before anything is published. The
  // schema accepts any number of days so that a version already published stays
  // runnable — the server reads it through stateTtlDays, which bounds it without
  // refusing. Both read the number of days through stateTtlRawDays, so the value
  // refused here is the one bounded there. Checked whatever the state type: a
  // declared field is a validated one.
  const ttl = agentConfig.config.state.ttl;
  const ttlDays = stateTtlRawDays(ttl);
  if (!(ttlDays >= STATE_TTL_MIN_DAYS && ttlDays <= STATE_TTL_MAX_DAYS)) {
    errors.push({
      code: "STATE_TTL_OUT_OF_RANGE",
      message: `state.ttl "${ttl}" is outside the allowed range: a notebook is kept between ${STATE_TTL_MIN_DAYS} and ${STATE_TTL_MAX_DAYS} days after its last write (e.g., "30d").`,
      file: "agent.yaml",
      field: "state.ttl",
    });
  }

  // Settings no code honours — an MCP server's auth, a secret, meta without an
  // endpoint — and a timeout no timer can hold: refused, by name, before
  // anything is published. The schema accepts them, so that a version already
  // published stays readable.
  for (const issue of findRefusedSettings(agentConfig.config)) {
    errors.push({ ...issue, file: "agent.yaml" });
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

  // Retired fields: still valid, ignored, and named — the schema alone would
  // drop them without a word (it is not strict). Read from the raw document,
  // which parsed above, before the schema touched it — and read as that parse
  // reads it (`AGENT_YAML_READING`: YAML 1.2, the core schema). That parse
  // refused a repeated key: the library's own check, which compares each key
  // with every earlier one, is left off. Its warnings are that parse's, said
  // below: this read emits none (`logLevel: "error"`).
  const raw = parseYaml(agentConfig.raw, {
    ...AGENT_YAML_READING,
    uniqueKeys: false,
    logLevel: "error",
  });
  for (const issue of findRetiredFields(raw)) {
    warnings.push({ ...issue, file: "agent.yaml" });
  }

  // The yaml library's warnings — an unresolved tag, say: the file reads,
  // the value may not be the one its author meant. The first few, each by
  // its line, then how many more.
  const yamlWarnings = agentConfig.warnings;
  for (const message of yamlWarnings.first) {
    warnings.push({ code: "YAML_WARNING", message, file: "agent.yaml" });
  }
  const unsaid = yamlWarnings.count - yamlWarnings.first.length;
  if (unsaid > 0) {
    warnings.push({
      code: "YAML_WARNING",
      message: `${unsaid} more YAML warning${unsaid > 1 ? "s" : ""} of the same file.`,
      file: "agent.yaml",
    });
  }

  // Retired models the list names: still valid. From the day of the
  // retirement, which may be still to come, a call to one fails at the
  // provider — or, for an id the provider redirects, is answered by another
  // model. Said here, by the model's exact id, primary or fallback.
  warnings.push(...findRetiredModels(agentConfig.config));

  // Allowed hosts the cloud sandbox cannot enforce: valid — a host pattern
  // honoured by the local runtime, any other such form by none —, refused by the
  // cloud runtime before any machine. Said here, at build time, not at the first
  // call, each entry by its form.
  const hosts = agentConfig.config.environment.networking.allowed_hosts;
  const refused = sandboxRefusedHosts(hosts);
  if (refused.length > 0) {
    warnings.push({
      code: "EGRESS_HOST_UNSUPPORTED",
      message: `${sandboxRefusalMessage(hosts, refused)} The cloud runtime refuses the run before any machine.`,
      file: "agent.yaml",
      field: "environment.networking.allowed_hosts",
    });
  }

  // A temperature the model refuses — or, unlisted and at its provider's own
  // API, that its provider's default leaves out: valid, and never sent to
  // that model by the runtime, which uses the model's default instead. Said
  // here, by the model's name — primary or fallback, each gets the declared
  // value; only the primary is called at the agent's `base_url`.
  const { model } = agentConfig.config;
  if (model.temperature !== undefined) {
    for (const m of model.fallback ? [model, model.fallback] : [model]) {
      const baseUrl = m === model ? model.base_url : undefined;
      if (acceptsTemperature(m.provider, m.name, baseUrl)) continue;
      const why =
        getModelCapabilities(m.provider, m.name) === undefined
          ? `is not in the capability matrix, and the latest ${m.provider} models take no temperature`
          : "does not accept a temperature";
      warnings.push({
        code: "TEMPERATURE_UNSUPPORTED",
        message: `model ${m.provider}/${m.name} ${why}: model.temperature (${model.temperature}) is not sent to it, which uses its default — remove it, or pick a model that accepts one.`,
        file: "agent.yaml",
        field: "model.temperature",
      });
    }
  }

  // A forced tool choice the model refuses: valid, and sent as `auto` to that
  // model by the runtime — the model may then answer without the tool. A
  // choice is forced by tool_choice `required` or a tool's name, or by a tool
  // marked required under `auto`; `none` forces nothing.
  const { tool_choice: choice, tools } = agentConfig.config;
  const forced = choice !== "none" && (choice !== "auto" || tools.some((tool) => tool.required));
  if (forced) {
    for (const m of model.fallback ? [model, model.fallback] : [model]) {
      if (getModelCapabilities(m.provider, m.name)?.forcedToolChoice !== false) continue;
      warnings.push({
        code: "TOOL_CHOICE_UNSUPPORTED",
        message: `model ${m.provider}/${m.name} refuses a forced tool choice: it gets tool_choice auto instead of ${choice === "auto" ? "the tools marked required" : `"${choice}"`}, and may answer without calling the tool — remove the forced choice, or pick a model that accepts one.`,
        file: "agent.yaml",
        field: "tool_choice",
      });
    }
  }

  // Cross-file warnings: name consistency
  const skillName = skill.frontmatter.name;
  const agentName = agentConfig.config.name;
  if (skillName !== agentName) {
    warnings.push({
      code: "NAME_MISMATCH",
      message: `SKILL.md name "${skillName}" does not match agent.yaml name "${agentName}"`,
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

  // tool_choice referential integrity: if tool_choice is a custom value
  // (not auto/required/none), it must match a declared tool name.
  const toolChoice = agentConfig.config.tool_choice;
  if (toolChoice && !["auto", "required", "none"].includes(toolChoice)) {
    const declaredToolNames = agentConfig.config.tools.map((t) => t.name);
    if (!declaredToolNames.includes(toolChoice)) {
      errors.push({
        code: "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL",
        message: `agent.yaml tool_choice "${toolChoice}" references an undeclared tool. Available tools: [${declaredToolNames.join(", ") || "none"}].`,
        file: "agent.yaml",
      });
    }
  }

  // Script dependency manifest warning: if scripts/ contains imports
  // beyond the language stdlib but no manifest is present at the bundle root,
  // the runtime cannot resolve those dependencies. Warn the agent author so
  // they can add a manifest before deploying.
  const scriptsDir = join(dir, "scripts");
  if (await fileExists(scriptsDir)) {
    const manifest = detectManifest(dir);
    if (manifest.ecosystem === "none") {
      const flagged =
        hasNonStdlibImports(scriptsDir, "python") || hasNonStdlibImports(scriptsDir, "node");
      if (flagged) {
        warnings.push({
          code: "SCRIPTS_NO_MANIFEST",
          message:
            "scripts/ contains non-stdlib imports but no manifest (package.json/requirements.txt/pyproject.toml) found at bundle root. Add a manifest to enable dependency resolution.",
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed: errors.length === 0 ? { skill, agentConfig, agentsMd } : null,
  };
}
