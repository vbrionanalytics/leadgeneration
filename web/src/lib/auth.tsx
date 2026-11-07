import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, Org, User } from './api';

interface AuthState {
  user: User | null;
  org: Org | null;
  loading: boolean;
  setSession: (token: string, user: User, org: Org) => void;
  refresh: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = async () => {
    if (!localStorage.getItem('lg_token')) { setLoading(false); return; }
    try {
      const { data } = await api.get('/auth/me');
      setUser(data.user);
      setOrg(data.organization);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  return (
    <Ctx.Provider
      value={{
        user, org, loading, refresh,
        setSession: (token, u, o) => { localStorage.setItem('lg_token', token); setUser(u); setOrg(o); },
        logout: () => { localStorage.removeItem('lg_token'); setUser(null); setOrg(null); qc.clear(); }
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
