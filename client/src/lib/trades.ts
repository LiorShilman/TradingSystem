import { effectiveRates, normalizeDecInput, type Account, type FxSnapshot, type Settings } from '@trading/shared';
import { api } from './api';
import { useAsync } from './useAsync';

/** Current conversion rates (live/auto snapshot + manual settings), for P&L shown on screen. */
export function useRates(): Settings['rates'] | null {
  const settings = useAsync(() => api<Settings>('/settings'), []);
  const fx = useAsync(() => api<FxSnapshot | null>('/fx'), []);
  return settings.data ? effectiveRates(fx.data ?? null, settings.data.rates).rates : null;
}

export function useAccounts() {
  return useAsync(() => api<Account[]>('/accounts'), []);
}

/** Short id for a fill/cost inside a trade. */
export const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 16);

/** "50K" / "1.5k" / "100,000" → "50000". Null when not a positive number. */
export function parseQty(raw: string): string | null {
  const s = raw.trim().replace(/,/g, '');
  const m = /^([\d.]+)\s*[kK]$/.exec(s);
  const n = normalizeDecInput(m ? m[1]! : s);
  if (n === null || Number(n) <= 0) return null;
  return m ? String(Number(n) * 1000) : n;
}

/** 100000 → "100K" for forex quantities, otherwise as is. */
export function fmtQty(q: string, forex: boolean): string {
  const n = Number(q);
  if (forex && n >= 1000 && n % 1000 === 0) return `${(n / 1000).toLocaleString('en-US')}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Forex prices keep at least pip precision ("1.08" → "1.0800", "159.5" → "159.50"), like the broker shows them. */
/** A real currency pair (EURUSD) — not gold/silver (XAUUSD) or CFDs on the FX: exchange. */
export const isCurrencyPair = (symbol: string) => {
  const t = symbol.split(':')[1] ?? symbol;
  return /^[A-Z]{6}$/.test(t) && !/^X(AU|AG|PT|PD)/.test(t);
};

export function fmtPx(p: string | null | undefined, symbol: string, assetClass: string): string {
  if (!p) return '—';
  if (assetClass !== 'forex' || !isCurrencyPair(symbol)) return p;
  const min = symbol.toUpperCase().endsWith('JPY') ? 2 : 4;
  const [i, f = ''] = p.split('.');
  return f.length >= min ? p : `${i}.${f.padEnd(min, '0')}`;
}
