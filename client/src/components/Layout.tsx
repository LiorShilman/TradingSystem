import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useActiveAccount } from '../lib/activeAccount';
import { Money } from './ui';

const NAV = [
  { to: '/plans', label: 'תוכניות' },
  { to: '/trades', label: 'יומן' },
  { to: '/ideas', label: 'רעיונות' },
  { to: '/assets', label: 'נכסים' },
  { to: '/alerts', label: 'התראות' },
  { to: '/accounts', label: 'חשבונות' },
  { to: '/settings', label: 'הגדרות' },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const { active } = useActiveAccount();
  const demo = active?.kind === 'demo';
  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-sky-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`;

  return (
    <div className="min-h-screen">
      <header
        className={`sticky top-0 z-30 border-b backdrop-blur ${demo ? 'border-b-2 border-amber-500 bg-amber-50/90 dark:bg-amber-950/60' : 'border-slate-200 bg-white/90 dark:border-slate-800 dark:bg-slate-900/90'}`}
      >
        <div className="mx-auto flex max-w-[1920px] items-center justify-between gap-4 px-4 py-3">
          <Link to="/plans" className="shrink-0 font-bold">
            📈 מערכת מסחר
          </Link>
          <nav className="hidden gap-1 lg:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={link}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <AccountSwitcher />
            <Link to="/ideas?new=1" className="btn-primary px-3 py-1.5" title="רעיון חדש">
              + רעיון
            </Link>
            <button className="btn-ghost px-3 lg:hidden" aria-label="תפריט" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              ☰
            </button>
          </div>
        </div>
        {open && (
          <nav className="space-y-1 border-t border-slate-200 px-4 py-2 lg:hidden dark:border-slate-800">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={link} onClick={() => setOpen(false)}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-[1920px] px-4 py-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}

/** "Which account am I working in" — always visible. Demo is shouted, so it's never mistaken for real money. */
function AccountSwitcher() {
  const { accounts, active, setActiveId } = useActiveAccount();
  const list = accounts.filter((a) => !a.isArchived);
  if (!list.length) return null;
  const demo = active?.kind === 'demo';
  return (
    <label
      className={`flex items-center gap-2 rounded-xl border px-2.5 py-1 text-sm ${demo ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/40' : active ? 'border-sky-500/60 bg-sky-500/10' : 'border-slate-300 dark:border-slate-700'}`}
      title="החשבון שבו אתה עובד: נבחר מראש בתוכניות ועסקאות חדשות, במחשבון הגודל ובסינון היומן"
    >
      {demo && <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-white">דמו</span>}
      <select className="max-w-44 bg-transparent font-medium outline-none" value={active?.id ?? ''} onChange={(e) => setActiveId(e.target.value || null)} aria-label="חשבון פעיל">
        <option value="">כל החשבונות</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.baseCurrency}){a.kind === 'demo' ? ' · דמו' : ''}
          </option>
        ))}
      </select>
      {active && (
        <span className="hidden text-xs text-slate-500 sm:inline dark:text-slate-400">
          <Money value={active.balance} currency={active.baseCurrency} />
        </span>
      )}
    </label>
  );
}
