import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: ReactNode;
  icon?: ReactNode;
}

export function StatCard({ label, value, trend, icon }: StatCardProps) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
        {icon && <span className="text-gray-400 dark:text-gray-500">{icon}</span>}
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
      {trend && <div className="mt-2">{trend}</div>}
    </div>
  );
}
