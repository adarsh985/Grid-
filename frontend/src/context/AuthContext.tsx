import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loginApi, setAuthToken } from '../api';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  offlineDemoMode: boolean;
  canMutate: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
  enterOfflineDemo: () => void;
}

const DEFAULT_OFFLINE_DEMO_USER: User = {
  id: 2,
  email: 'operator@gridsense.local',
  role: 'operator',
};

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: React.ReactNode;
  initialUser?: User | null;
  initialToken?: string | null;
  initialOfflineDemo?: boolean;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({
  children,
  initialUser = null,
  initialToken = null,
  initialOfflineDemo = false,
}) => {
  const [token, setToken] = useState<string | null>(initialToken);
  const [offlineDemoMode, setOfflineDemoMode] = useState<boolean>(initialOfflineDemo);
  const [user, setUser] = useState<User | null>(
    initialUser ?? (initialOfflineDemo ? DEFAULT_OFFLINE_DEMO_USER : null),
  );

  // Keep module API client token synchronized with in-memory React state only (never localStorage).
  useEffect(() => {
    setAuthToken(token);
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await loginApi(email, password);
    setAuthToken(res.token);
    setToken(res.token);
    setUser(res.user);
    setOfflineDemoMode(false);
    return res.user;
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
    setOfflineDemoMode(false);
  }, []);

  const enterOfflineDemo = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(DEFAULT_OFFLINE_DEMO_USER);
    setOfflineDemoMode(true);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      offlineDemoMode,
      canMutate: user?.role === 'admin' || user?.role === 'operator',
      isAdmin: user?.role === 'admin',
      login,
      logout,
      enterOfflineDemo,
    }),
    [user, token, offlineDemoMode, login, logout, enterOfflineDemo],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
