import { useState } from "react";

interface JsonViewerProps {
  data: unknown;
  maxCollapsedLines?: number;
}

export function JsonViewer({ data, maxCollapsedLines = 10 }: JsonViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const formatted = JSON.stringify(data, null, 2);
  const lines = formatted.split("\n");
  const shouldCollapse = lines.length > maxCollapsedLines;
  const displayText =
    shouldCollapse && !expanded
      ? `${lines.slice(0, maxCollapsedLines).join("\n")}\n...`
      : formatted;

  return (
    <div className="relative">
      <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-800 rounded-lg p-4 overflow-x-auto text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
        {displayText}
      </pre>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          {expanded ? "Collapse" : `Show full (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}
