import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { setAuthToken } from "./api-client";

export interface AuthUser {
  id: string;
  username: string;
  namespace: string;
  email?: string;
  avatar_url?: string;
  plan?: string;
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
        const res = await fetch("/api/me", { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setUser(data);
            // In OAuth mode with valid session, no token needed (cookies handle it)
            setAuthToken("none");
          }
        } else if (res.status === 401) {
          const body = await res.json().catch(() => null);
          const isOAuth = body?.error?.oauth === true;
          if (!cancelled) {
            setIsOAuthMode(isOAuth);
            if (!isOAuth) {
              // Local dev mode — use dev-token for all API calls
              setAuthToken("dev-token");
            }
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
