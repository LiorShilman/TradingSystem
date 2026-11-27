import { DateTime } from 'luxon';
import { Decimal, dec, decStr, isDecString } from './money';
import type { Currency, Settings } from './schemas';

// Rates everywhere are "units of the currency per 1 USD" (ILS: "3.334").

export const FX_SOURCES = ['fxcmgr', 'boi', 'frankfurter'] as const;
export type FxSource = (typeof FX_SOURCES)[number];
export const FX_SOURCE_LABELS: Record<FxSource, string> = {
  fxcmgr: 'FXCM (שער חי)',
  boi: 'בנק ישראל (שער יציג)',
  frankfurter: 'ECB (Frankfurter)',
};

/** FXCMgr pairs to request, and how each maps to "units per 1 USD". */
export const FXCMGR_PAIRS = [
  { pair: 'USD/ILS', currency: 'ILS', invert: false },
  { pair: 'EUR/USD', currency: 'EUR', invert: true },
  { pair: 'GBP/USD', currency: 'GBP', invert: true },
] as const satisfies ReadonlyArray<{ pair: string; currency: Currency; invert: boolean }>;

/** FXCMgr /subscribe → first rate, cleaned of float noise (1.0973799999999998 → "1.09738"). */
export function parseFxcmgrQuote(json: unknown): string {
  const r = (json as { pairs?: Array<{ Rates?: unknown[] }> })?.pairs?.[0]?.Rates?.[0];
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) throw new Error('FXCMgr: ציטוט לא תקין');
  return decStr(new Decimal(r).toSignificantDigits(8));
}

export interface TvQuote {
  price: string;
  /** 0 = real time; otherwise how many minutes the feed is behind (e.g. 15 for stocks without a subscription). */
  delayedMin: number;
  /** TradingView's description ("Bitcoin / U.S. dollar"). */
  name: string;
}

/**
 * TradingView scanner response (columns: close, pricescale, update_mode, description) → quotes.
 * Real-time ("streaming") and delayed ("delayed_streaming_<seconds>") rows are kept, the delay recorded,
 * so a delayed price is shown as delayed and never alerted on. Other modes (end of day…) are dropped.
 */
export function parseTvScan(json: unknown): Record<string, TvQuote> {
  const rows = (json as { data?: Array<{ s?: unknown; d?: unknown[] }> })?.data;
  const out: Record<string, TvQuote> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const [close, scale, mode, desc] = row.d ?? [];
    if (typeof row.s !== 'string' || typeof mode !== 'string') continue;
    const delayed = /^delayed_streaming_(\d+)$/.exec(mode);
    if (mode !== 'streaming' && !delayed) continue;
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
    const dp = typeof scale === 'number' && scale >= 1 ? Math.min(10, Math.round(Math.log10(scale))) : 8;
    out[row.s] = {
      price: decStr(new Decimal(close).toDecimalPlaces(dp)),
      delayedMin: delayed ? Math.max(1, Math.round(Number(delayed[1]) / 60)) : 0,
      name: typeof desc === 'string' ? desc.slice(0, 120) : '',
    };
  }
  return out;
}

/** Combine FXCMgr quotes ({ "USD/ILS": "3.29861", ... }) into units-per-USD rates. */
export function fxcmgrRates(quotes: Partial<Record<string, string>>): FxSnapshot['rates'] {
  const rates: FxSnapshot['rates'] = {};
  for (const { pair, currency, invert } of FXCMGR_PAIRS) {
    const q = quotes[pair];
    if (!q) continue;
    rates[currency] = invert ? decStr(new Decimal(1).div(dec(q)).toSignificantDigits(SIG)) : q;
  }
  if (!rates.ILS) throw new Error('FXCMgr: חסר USD/ILS');
  return rates;
}

/** Currencies the server fetches automatically. USDT is crypto — manual until Binance (stage 5). */
export const AUTO_FX_CURRENCIES = ['ILS', 'EUR', 'GBP'] as const satisfies readonly Currency[];

export interface FxSnapshot {
  rates: Partial<Record<Currency, string>>;
  source: FxSource;
  /** When the source published the rates (UTC ISO). */
  asOf: string;
  /** false when the source gives only a date (then show the date without a time). */
  asOfHasTime: boolean;
  fetchedAt: string;
}

export type ParsedFx = Pick<FxSnapshot, 'rates' | 'asOf' | 'asOfHasTime'>;

const SIG = 10; // significant digits kept after division

function numToDec(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const s = String(n);
  return isDecString(s) ? s : null;
}

/**
 * Bank of Israel: https://boi.org.il/PublicApi/GetExchangeRates?asJson=true
 * Each entry: ILS per `unit` of `key` (JPY is quoted per 100).
 */
export function parseBoiRates(json: unknown): ParsedFx {
  const list = (json as { exchangeRates?: unknown })?.exchangeRates;
  if (!Array.isArray(list)) throw new Error('BOI: unexpected response shape');

  const ilsPer = new Map<string, string>();
  let latest: string | null = null;
  for (const e of list as Array<Record<string, unknown>>) {
    const key = typeof e.key === 'string' ? e.key : null;
    const rate = numToDec(e.currentExchangeRate);
    const unit = numToDec(e.unit ?? 1);
    if (!key || !rate || !unit) continue;
    ilsPer.set(key, decStr(dec(rate).div(dec(unit))));
    if (typeof e.lastUpdate === 'string' && (!latest || e.lastUpdate > latest)) latest = e.lastUpdate;
  }

  const ilsPerUsd = ilsPer.get('USD');
  if (!ilsPerUsd) throw new Error('BOI: USD rate missing');

  const rates: FxSnapshot['rates'] = { ILS: ilsPerUsd };
  for (const c of AUTO_FX_CURRENCIES) {
    if (c === 'ILS') continue;
    const ilsPerC = ilsPer.get(c);
    if (ilsPerC) rates[c] = decStr(dec(ilsPerUsd).div(dec(ilsPerC)).toSignificantDigits(SIG));
  }

  const dt = latest ? DateTime.fromISO(latest, { zone: 'utc' }) : null;
  if (!dt?.isValid) throw new Error('BOI: lastUpdate missing');
  return { rates, asOf: dt.toUTC().toISO()!, asOfHasTime: true };
}

/** Frankfurter (ECB): https://api.frankfurter.dev/v1/latest?base=USD&symbols=ILS,EUR,GBP */
export function parseFrankfurter(json: unknown): ParsedFx {
  const j = json as { base?: unknown; date?: unknown; rates?: Record<string, unknown> };
  if (j?.base !== 'USD' || typeof j.date !== 'string' || !j.rates) throw new Error('Frankfurter: unexpected response shape');
  const rates: FxSnapshot['rates'] = {};
  for (const c of AUTO_FX_CURRENCIES) {
    const r = numToDec(j.rates[c]);
    if (r) rates[c] = r;
  }
  if (!rates.ILS) throw new Error('Frankfurter: ILS rate missing');
  const dt = DateTime.fromISO(j.date, { zone: 'utc' });
  if (!dt.isValid) throw new Error('Frankfurter: bad date');
  return { rates, asOf: dt.toISO()!, asOfHasTime: false };
}

export type RateOrigin = 'auto' | 'manual';

/** Manual entries override automatic ones, per currency. A rate missing from both stays missing. */
export function effectiveRates(
  auto: FxSnapshot | null,
  manual: Settings['rates'],
): { rates: Settings['rates']; origin: Partial<Record<Currency, RateOrigin>> } {
  const rates: Settings['rates'] = { USD: '1' };
  const origin: Partial<Record<Currency, RateOrigin>> = {};
  for (const [c, v] of Object.entries(auto?.rates ?? {}) as [Currency, string][]) {
    if (c === 'USD') continue;
    rates[c] = v;
    origin[c] = 'auto';
  }
  for (const [c, v] of Object.entries(manual) as [Currency, string | undefined][]) {
    if (c === 'USD' || !v) continue;
    rates[c] = v;
    origin[c] = 'manual';
  }
  return { rates, origin };
}
