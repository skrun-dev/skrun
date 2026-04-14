import type { RunEvent } from "@skrun-dev/runtime";

/**
 * Format a RunEvent into W3C SSE format: `event: <type>\ndata: <json>\n\n`
 */
export function formatSSEEvent(event: RunEvent): { event: string; data: string } {
  return {
    event: event.type,
    data: JSON.stringify(event),
  };
}
