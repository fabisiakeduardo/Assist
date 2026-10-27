import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { PublicUser, Usage } from "./types";

interface AuthState {
  user: PublicUser | null;
  usage: Usage | null;
  engine: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  setUsage: (u: Usage) => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [usage, setUsageState] = useState<Usage | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setUser(r.user);
        setUsageState(r.usage);
        setEngine(r.engine);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setUser(r.user);
    const me = await api.me();
    setUsageState(me.usage);
    setEngine(me.engine);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const setUsage = useCallback((u: Usage) => setUsageState(u), []);

  return (
    <AuthCtx.Provider value={{ user, usage, engine, loading, login, logout, setUsage }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth fora do AuthProvider");
  return ctx;
}
