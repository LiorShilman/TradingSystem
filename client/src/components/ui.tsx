import type { ReactNode } from 'react';
import { CURRENCY_SYMBOLS, dec, formatDec, type Currency } from '@trading/shared';

/** Money is always LTR inside the RTL page; negative in red. */
export function Money({ value, currency, decimals = 2, colored = false }: { value: string; currency?: Currency; decimals?: number; colored?: boolean }) {
  const neg = dec(value).isNegative();
  const color = colored ? (neg ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400') : '';
  const sym = currency ? CURRENCY_SYMBOLS[currency] : '';
  const symLeft = currency && sym.length === 1;
  return (
    <span dir="ltr" className={`tabular-nums ${color}`}>
      {symLeft ? `${neg ? '-' : ''}${sym}${formatDec(value, decimals).replace('-', '')}` : formatDec(value, decimals)}
      {currency && !symLeft ? ` ${sym}` : ''}
    </span>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-slate-500">{hint}</span>}
      {error && <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {message}
    </div>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{children}</h1>
      {actions}
    </div>
  );
}
