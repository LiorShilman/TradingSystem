import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getAdminKey, setAdminKey } from './api';

interface AuthState {
  loggedIn: boolean;
  login(key: string): Promise<void>;
  logout(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(() => !!getAdminKey());

  const logout = useCallback(() => {
    setAdminKey(null);
    setLoggedIn(false);
  }, []);

  const login = useCallback(async (key: string) => {
    await api('/auth/check', { key: key.trim() });
    setAdminKey(key.trim());
    setLoggedIn(true);
  }, []);

  useEffect(() => {
    window.addEventListener('auth:logout', logout);
    return () => window.removeEventListener('auth:logout', logout);
  }, [logout]);

  return <AuthContext.Provider value={{ loggedIn, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
