export type AuditAction =
  | "run_start"
  | "llm_call"
  | "tool_call"
  | "run_complete"
  | "run_failed"
  | "timeout"
  | "cost_exceeded";

export interface AuditEntry {
  runId: string;
  agentName: string;
  timestamp: string;
  action: AuditAction;
  details: Record<string, unknown>;
}

export class AuditLogger {
  log(entry: AuditEntry): void {
    // Safety net: strip callerKeys from details before logging
    const sanitized = entry.details?.callerKeys
      ? { ...entry, details: { ...entry.details, callerKeys: "[REDACTED]" } }
      : entry;
    console.log(JSON.stringify(sanitized));
  }
}
