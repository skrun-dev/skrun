import type { ValidationIssue } from "../errors.js";
import { TIMEOUT_MAX_S, TIMEOUT_MIN_S, timeoutRawSeconds } from "./environment-config.js";

/** The form the schema requires of a timeout: whole seconds. */
const TIMEOUT_FORM = /^\d+s$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The settings of `agent.yaml` that no code honours — or that no timer can
 * hold —, one issue each, naming its field, in this order:
 *  - `model.provider` meta without a `model.base_url` (`MODEL_BASE_URL_REQUIRED`):
 *    meta has no endpoint of its own, only a `base_url` serves it;
 *  - `model.fallback.provider` meta (`MODEL_BASE_URL_REQUIRED`): a fallback is
 *    called at its provider's own endpoint;
 *  - each `mcp_servers[i].auth` other than `none`, whatever the transport
 *    (`UNSUPPORTED_FIELD`): no credential is sent to the server;
 *  - a non-empty `environment.secrets` (`UNSUPPORTED_FIELD`): no secret is
 *    injected into a run;
 *  - an `environment.timeout` outside TIMEOUT_MIN_S to TIMEOUT_MAX_S seconds
 *    (`TIMEOUT_OUT_OF_RANGE`): a run given `0s`, or more than a timer arms,
 *    ends at once.
 * The schema accepts each of them, so that a version already published stays
 * readable; they are refused, by name, before anything is published.
 *
 * The input is read for its shape, every field optional: a parsed configuration,
 * or an environment override as a request sends it. A value without the shape
 * the schema gives it — a `secrets` that is not a list, a `timeout` not written
 * in whole seconds — is not judged here: the schema's own check refuses it.
 */
export function findRefusedSettings(config: {
  model?: unknown;
  mcp_servers?: unknown;
  environment?: unknown;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const model = isRecord(config.model) ? config.model : undefined;
  if (model !== undefined && model.provider === "meta" && model.base_url === undefined) {
    issues.push({
      code: "MODEL_BASE_URL_REQUIRED",
      message:
        "model.provider meta has no endpoint of its own: set model.base_url to the OpenAI-compatible endpoint that serves the model.",
      field: "model.provider",
    });
  }
  const fallback = model !== undefined && isRecord(model.fallback) ? model.fallback : undefined;
  if (fallback !== undefined && fallback.provider === "meta") {
    issues.push({
      code: "MODEL_BASE_URL_REQUIRED",
      message:
        "model.fallback.provider meta cannot be served: a fallback model is called at its provider's own endpoint, and meta has none. Pick another provider for the fallback.",
      field: "model.fallback.provider",
    });
  }

  if (Array.isArray(config.mcp_servers)) {
    config.mcp_servers.forEach((server: unknown, i) => {
      if (!isRecord(server)) return;
      const { auth } = server;
      if (auth === undefined || auth === "none") return;
      issues.push({
        code: "UNSUPPORTED_FIELD",
        message: `mcp_servers[${i}].auth: ${String(auth)} is not yet supported — no credential would be sent to the server. Remove the line: none, the default, is accepted.`,
        field: `mcp_servers[${i}].auth`,
      });
    });
  }

  const environment = isRecord(config.environment) ? config.environment : undefined;
  const secrets = environment?.secrets;
  if (Array.isArray(secrets) && secrets.length > 0) {
    issues.push({
      code: "UNSUPPORTED_FIELD",
      message:
        "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.",
      field: "environment.secrets",
    });
  }
  const timeout = environment?.timeout;
  if (typeof timeout === "string" && TIMEOUT_FORM.test(timeout)) {
    const seconds = timeoutRawSeconds(timeout);
    if (!(seconds >= TIMEOUT_MIN_S && seconds <= TIMEOUT_MAX_S)) {
      issues.push({
        code: "TIMEOUT_OUT_OF_RANGE",
        message: `environment.timeout "${timeout}" is outside the allowed range: a run's timeout is between ${TIMEOUT_MIN_S}s and ${TIMEOUT_MAX_S}s (about 24.8 days), e.g. "300s".`,
        field: "environment.timeout",
      });
    }
  }

  return issues;
}
