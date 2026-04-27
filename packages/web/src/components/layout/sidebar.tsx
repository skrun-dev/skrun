import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  IconAgents,
  IconBook,
  IconChevLeft,
  IconExternal,
  IconHome,
  IconRuns,
  IconSettings,
} from "../shared/icons";

const navItems = [
  { to: "/", label: "Home", icon: IconHome, end: true },
  { to: "/agents", label: "Agents", icon: IconAgents },
  { to: "/runs", label: "Runs", icon: IconRuns },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

const STORAGE_KEY = "skrun-sidebar-collapsed";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  return (
    <aside
      className={`${collapsed ? "w-[60px]" : "w-[220px]"} shrink-0 h-full flex flex-col border-r border-gray-200 dark:border-gray-900 bg-gray-50/60 dark:bg-gray-950 transition-[width] duration-200`}
    >
      {/* Logo */}
      <div
        className={`h-14 flex items-center gap-2 border-b border-gray-200 dark:border-gray-900 ${collapsed ? "px-3 justify-center" : "px-4"}`}
      >
        <img src="/dashboard/logo.png" alt="Skrun" className="w-8 h-8 shrink-0 -ml-1" />
        {!collapsed && (
          <span className="text-[13px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-none">
            Skrun
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 pt-3 space-y-0.5">
        {!collapsed && (
          <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-600">
            Workspace
          </div>
        )}
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `group flex items-center ${collapsed ? "justify-center px-0" : "gap-2.5 px-2"} h-8 rounded-md text-[13px] transition-colors ${
                isActive
                  ? "bg-white dark:bg-gray-900 text-sky-700 dark:text-sky-400 shadow-[0_1px_0_rgba(0,0,0,0.02),0_0_0_1px_rgba(14,165,233,0.15)] font-medium"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100/70 dark:hover:bg-gray-900/70 hover:text-gray-900 dark:hover:text-gray-200"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={`w-[15px] h-[15px] ${
                    isActive
                      ? "text-sky-600 dark:text-sky-400"
                      : "text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-400"
                  }`}
                />
                {!collapsed && <span className="flex-1">{item.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom */}
      <div
        className={`border-t border-gray-200 dark:border-gray-900 ${collapsed ? "px-2 py-2" : "p-2.5 space-y-0.5"}`}
      >
        <a
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5 px-2"} h-7 rounded-md text-[12px] text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100/70 dark:hover:bg-gray-900/70`}
        >
          <IconBook className="w-[13px] h-[13px]" />
          {!collapsed && <span className="flex-1">API Docs</span>}
          {!collapsed && <IconExternal className="w-[11px] h-[11px] opacity-60" />}
        </a>
        <button
          type="button"
          onClick={toggle}
          className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5 px-2"} w-full h-7 rounded-md text-[12px] text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100/70 dark:hover:bg-gray-900/70`}
        >
          <IconChevLeft
            className={`w-[13px] h-[13px] transition-transform ${collapsed ? "rotate-180" : ""}`}
          />
          {!collapsed && <span className="flex-1 text-left">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
