import { stringify } from "yaml";
import type { AgentConfig } from "../schemas/agent-config.js";

/**
 * An `agent.yaml` for `config`. A value the configuration holds in two places
 * is written out twice, never anchored and aliased: `parseAgentYaml` refuses
 * an alias.
 */
export function serializeAgentYaml(config: AgentConfig): string {
  return stringify(config, {
    indent: 2,
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
    aliasDuplicateObjects: false,
  });
}
