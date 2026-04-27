import { Link } from "react-router-dom";

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 mb-3">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-400 dark:text-gray-600">/</span>}
          {item.to ? (
            <Link to={item.to} className="hover:text-brand-600 dark:hover:text-brand-400">
              {item.label}
            </Link>
          ) : (
            <span className="text-gray-700 dark:text-gray-300">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
