import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
  /**
   * Operator verification policy (read-only, from `/api/me`). The dashboard
   * reads it to render the Verify control: `admin` → admins only; `owner` → the
   * agent owner too; `disabled` → hidden. Missing = treat as `'admin'` (legacy
   * servers that pre-date the field).
   */
  verification_policy?: "admin" | "owner" | "disabled";
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isOAuthMode: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The model key typed in the Playground. It lives in this provider's memory
 * only — never in Web Storage — so it outlives a move between dashboard pages
 * but not a reload, a closed tab, or a sign-out (which clears it). The
 * session's provider holds it so that sign-out clears it in the same place.
 */
interface LlmKeyContextValue {
  llmKey: string;
  setLlmKey: (key: string) => void;
}

const LlmKeyContext = createContext<LlmKeyContextValue | null>(null);

/** Where the dashboard up to 1.2.1 kept that key, in `localStorage`. Removed at load, never read. */
const LEGACY_LLM_KEY_STORAGE = "skrun-llm-key";

/** Removes a key an earlier dashboard left in `localStorage`. Storage access can throw (blocked site data): ignored. */
function removeLegacyLlmKey(): void {
  try {
    window.localStorage.removeItem(LEGACY_LLM_KEY_STORAGE);
  } catch {
    // Storage unavailable: there is nothing this page can remove.
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOAuthMode, setIsOAuthMode] = useState(false);
  const [llmKey, setLlmKey] = useState("");

  useEffect(() => {
    removeLegacyLlmKey();
  }, []);

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
          // 3. No OAuth — try the dev-token admin shortcut. It only works when
          // the server has SKRUN_DEV_AUTH enabled (localhost dev). Send the
          // Bearer header on the retry directly and only wire the token globally
          // if it actually authenticates — a hardened (dev-auth off) server
          // returns 401, and we must NOT leave a dead `dev-token` wired for
          // every later apiFetch call (that would be a phantom-auth state).
          res = await fetch("/api/me", {
            credentials: "same-origin",
            headers: { Authorization: "Bearer dev-token" },
          });
          usedDevToken = res.ok;
        }

        if (res.ok && !cancelled) {
          const data = await res.json();
          setUser(data);
          // OAuth/cookie path needs no token; the dev-token path wires it for
          // future calls. A rejected dev-token (above) leaves it unset → the
          // dashboard renders an unauthenticated / auth-required state.
          setAuthToken(usedDevToken ? "dev-token" : "none");
        }
      } catch {
        // API unreachable or errored — unauthenticated state, never a phantom token.
        setAuthToken("none");
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
    // Cleared first: the key does not wait on the sign-out request.
    setLlmKey("");
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // ignore
    }
    window.location.href = "/login";
  }, []);

  // Both values memoized: a keystroke in the key field re-renders this provider,
  // and must not re-render every reader of the session.
  const authValue = useMemo(
    () => ({ user, isLoading, isOAuthMode, logout }),
    [user, isLoading, isOAuthMode, logout],
  );
  const llmKeyValue = useMemo(() => ({ llmKey, setLlmKey }), [llmKey]);

  return (
    <AuthContext.Provider value={authValue}>
      <LlmKeyContext.Provider value={llmKeyValue}>{children}</LlmKeyContext.Provider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useLlmKey(): LlmKeyContextValue {
  const ctx = useContext(LlmKeyContext);
  if (!ctx) throw new Error("useLlmKey must be used within AuthProvider");
  return ctx;
}
