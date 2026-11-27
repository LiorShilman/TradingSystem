import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { Account } from '@trading/shared';
import { api } from './api';

const STORAGE = 'activeAccountId';

interface ActiveAccountState {
  accounts: Account[];
  /** null = "all accounts". */
  active: Account | null;
  setActiveId(id: string | null): void;
}

const Ctx = createContext<ActiveAccountState | null>(null);

/**
 * The account you're working in, chosen in the top bar and remembered on this device.
 * It only preselects (new plans/trades, the sizing account, the journal filter) — it never moves anything.
 */
export function ActiveAccountProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActive] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE);
    } catch {
      return null;
    }
  });
  const { pathname } = useLocation();

  // Balances change with trades/cashflows: refresh on every page change.
  useEffect(() => {
    let alive = true;
    api<Account[]>('/accounts')
      .then((a) => alive && setAccounts(a))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pathname]);

  const setActiveId = useCallback((id: string | null) => {
    setActive(id);
    try {
      if (id) localStorage.setItem(STORAGE, id);
      else localStorage.removeItem(STORAGE);
    } catch {
      /* private mode */
    }
  }, []);

  // An archived or deleted account can't stay active.
  const active = accounts.find((a) => a.id === activeId && !a.isArchived) ?? null;
  useEffect(() => {
    if (activeId && accounts.length && !active) setActiveId(null);
  }, [activeId, accounts.length, active, setActiveId]);

  return <Ctx.Provider value={{ accounts, active, setActiveId }}>{children}</Ctx.Provider>;
}

export function useActiveAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActiveAccount outside ActiveAccountProvider');
  return ctx;
}
