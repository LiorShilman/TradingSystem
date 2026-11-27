import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/plans', label: 'תוכניות' },
  { to: '/ideas', label: 'רעיונות' },
  { to: '/assets', label: 'נכסים' },
  { to: '/alerts', label: 'התראות' },
  { to: '/accounts', label: 'חשבונות' },
  { to: '/settings', label: 'הגדרות' },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-sky-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-[1920px] items-center justify-between gap-4 px-4 py-3">
          <Link to="/plans" className="font-bold">
            📈 מערכת מסחר
          </Link>
          <nav className="hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={link}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/ideas?new=1" className="btn-primary px-3 py-1.5" title="רעיון חדש">
              + רעיון
            </Link>
            <button className="btn-ghost px-3 md:hidden" aria-label="תפריט" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              ☰
            </button>
          </div>
        </div>
        {open && (
          <nav className="space-y-1 border-t border-slate-200 px-4 py-2 md:hidden dark:border-slate-800">
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
