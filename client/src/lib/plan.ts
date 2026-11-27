import { useEffect, useState } from 'react';
import { Decimal, dec, decStr, pipSize, type Plan } from '@trading/shared';
import { api } from './api';

export interface Quote {
  price: string;
  at: string;
  source: string;
}

/** Live quotes for symbols (refreshed every 30s). Missing symbols simply have no quote. */
export function useQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const key = [...new Set(symbols)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () =>
      api<Record<string, Quote>>(`/quotes?symbols=${encodeURIComponent(key)}`)
        .then((q) => alive && setQuotes(q))
        .catch(() => undefined);
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return quotes;
}

export { pipSize };

/** Where the price is relative to the entry zone: "באזור", or distance in pips (forex) / price units. */
export function zoneDistance(p: Pick<Plan, 'symbol' | 'assetClass' | 'entryLow' | 'entryHigh'>, price: string): { inZone: boolean; text: string; abs: Decimal } | null {
  if (!p.entryLow) return null;
  const lo = dec(p.entryLow);
  const hi = p.entryHigh ? dec(p.entryHigh) : lo;
  const px = dec(price);
  if (px.gte(lo) && px.lte(hi)) return { inZone: true, text: 'באזור הכניסה', abs: new Decimal(0) };
  const d = px.lt(lo) ? lo.minus(px) : px.minus(hi);
  const side = px.lt(lo) ? 'מתחת' : 'מעל';
  if (p.assetClass === 'forex') return { inZone: false, text: `${decStr(d.div(pipSize(p.symbol)).toDecimalPlaces(1))} פיפס ${side} לאזור`, abs: d.div(pipSize(p.symbol)) };
  return { inZone: false, text: `${decStr(d)} ${side} לאזור`, abs: d };
}
