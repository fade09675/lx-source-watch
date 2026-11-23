import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthContextValue {
  status: AuthStatus;
  site: string;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [site, setSite] = useState('LX 音源监测');

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((result) => {
        if (cancelled) return;
        setSite(result.site || 'LX 音源监测');
        setStatus('authed');
      })
      .catch(() => {
        if (!cancelled) setStatus('anon');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setStatus('anon');
      window.location.assign('/login');
    }
  }, []);

  const value = useMemo(() => ({ status, site, login, logout }), [status, site, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
