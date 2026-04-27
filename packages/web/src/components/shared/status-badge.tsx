type RunStatus = "running" | "completed" | "failed" | "cancelled";

const statusStyles: Record<RunStatus, string> = {
  completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  running: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

interface StatusBadgeProps {
  status: RunStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyles[status]}`}
    >
      {status}
    </span>
  );
}

interface VerifiedBadgeProps {
  verified: boolean;
}

export function VerifiedBadge({ verified }: VerifiedBadgeProps) {
  if (!verified) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
      verified
    </span>
  );
}
