import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useTheme } from "../../lib/theme";
import { IconMoon, IconSun } from "../shared/icons";

export function Header() {
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();

  const initials = (user?.username ?? "D")[0]?.toUpperCase() ?? "D";

  return (
    <header className="h-14 shrink-0 border-b border-gray-200 dark:border-gray-900 bg-white/70 dark:bg-gray-950/70 backdrop-blur flex items-center px-5 gap-3">
      <div className="flex-1" />

      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="w-8 h-8 rounded-md text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-900 flex items-center justify-center transition-colors"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? (
          <IconSun className="w-[14px] h-[14px]" />
        ) : (
          <IconMoon className="w-[14px] h-[14px]" />
        )}
      </button>

      <div className="h-6 w-px bg-gray-200 dark:bg-gray-800" />

      {/* User → links to settings */}
      <Link
        to="/settings"
        className="flex items-center gap-2 h-8 pl-1 pr-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
      >
        {user?.avatar_url ? (
          <img src={user.avatar_url} alt="" className="w-6 h-6 rounded-full" />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white text-[10px] font-semibold">
            {initials}
          </div>
        )}
        <span className="text-[12.5px] text-gray-700 dark:text-gray-300 hidden sm:inline">
          {user?.username ?? "Local Dev"}
        </span>
      </Link>
    </header>
  );
}
