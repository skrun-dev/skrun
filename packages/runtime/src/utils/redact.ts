/** Fields that contain caller-provided LLM API keys and must be redacted from logs. */
export const CALLER_KEY_FIELDS = ["callerKeys"];

const REDACTED = "[REDACTED]";

/**
 * Deep-clone an object, replacing any value whose key matches `fieldsToRedact` with "[REDACTED]".
 * Used to sanitize audit logs and error responses that might contain caller API keys.
 */
export function redactCallerKeys(
  obj: Record<string, unknown>,
  fieldsToRedact: string[] = CALLER_KEY_FIELDS,
): Record<string, unknown> {
  const redactSet = new Set(fieldsToRedact);
  return redactDeep(obj, redactSet) as Record<string, unknown>;
}

function redactDeep(value: unknown, fields: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, fields));

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(key)) {
      result[key] = REDACTED;
    } else if (typeof val === "object" && val !== null) {
      result[key] = redactDeep(val, fields);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Check if a string contains any of the given secret values and replace them with "[REDACTED]".
 * Used to sanitize LLM provider error messages that might include the API key.
 */
export function redactSecretsFromString(str: string, secrets: string[]): string {
  let result = str;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) {
      result = result.replaceAll(secret, REDACTED);
    }
  }
  return result;
}
