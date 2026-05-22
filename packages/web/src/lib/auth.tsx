import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { setAuthToken } from "./api-client";

export interface AuthUser {
  id: string;
  username: string;
  namespace: string;
  email?: string;
  avatar_url?: string;
  plan?: string;
  /**
   * Instance role — `'admin'` is required to call the per-version verify
   * endpoint + delete agents across namespaces. The dashboard reads this
   * to gate admin-only UI (per-row Verify/Unverify buttons in the versions
   * table, Delete admin override visibility). Optional for compatibility
   * with older servers that pre-date the field; a missing value is treated
   * as `'user'` (least-privilege).
   */
  role?: "admin" | "user";
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isOAuthMode: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOAuthMode, setIsOAuthMode] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchUser() {
      try {
        // 1. First try the session-cookie path (OAuth mode).
        let res = await fetch("/api/me", { credentials: "same-origin" });
        let usedDevToken = false;

        if (res.status === 401) {
          // 2. Cookie didn't work — see whether the server has OAuth configured.
          const body = await res.json().catch(() => null);
          const isOAuth = body?.error?.oauth === true;
          if (!cancelled) setIsOAuthMode(isOAuth);
          if (isOAuth) {
            // OAuth-configured but no valid session → operator must log in.
            return;
          }
          // 3. Local dev mode. Wire the dev-token for future API calls AND
          // re-fetch /api/me with the Bearer header so `user` actually loads
          // (including `role: "admin"` which gates admin-only UI like the
          // Verify button). Without this 2nd fetch, `user` would stay null
          // and `user?.role === "admin"` would be falsy in dev mode.
          setAuthToken("dev-token");
          usedDevToken = true;
          res = await fetch("/api/me", {
            credentials: "same-origin",
            headers: { Authorization: "Bearer dev-token" },
          });
        }

        if (res.ok && !cancelled) {
          const data = await res.json();
          setUser(data);
          if (!usedDevToken) {
            // Cookie-authed (OAuth) — no Bearer token needed for future calls.
            setAuthToken("none");
          }
        }
      } catch {
        // API unreachable — assume local dev mode
        setAuthToken("dev-token");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchUser();
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // ignore
    }
    window.location.href = "/login";
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isOAuthMode, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
