import type { RunEvent } from "../../lib/api-client";

const eventStyles: Record<string, string> = {
  tool_call: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  tool_result: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  llm_complete: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  run_start: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  run_complete: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  run_error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

interface EventsTimelineProps {
  events: RunEvent[];
}

export function EventsTimeline({ events }: EventsTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">No events recorded for this run.</p>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((event, i) => (
        <div
          key={`event-${i}-${event.type}`}
          className="flex items-start gap-3 p-2.5 rounded-lg border border-gray-100 dark:border-gray-800"
        >
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shrink-0 ${eventStyles[event.type] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
          >
            {event.type}
          </span>
          <div className="flex-1 min-w-0">
            <pre className="text-xs font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words truncate max-h-20 overflow-hidden">
              {typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
          {event.timestamp && (
            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
