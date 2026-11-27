import type { Candle } from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import { activeFxcmgr } from './fx';
import { fxcmOffers } from './quotes';
import type { Store } from './store/types';

const TTL_MS = 60 * 1000;

export interface CandleSet {
  offer: string;
  timeframe: string;
  candles: Candle[];
}

function parseCandles(raw: unknown): Candle[] | null {
  if (!raw || typeof raw !== 'object' || 'error' in raw) return null;
  const list = (raw as { candles?: unknown }).candles;
  if (!Array.isArray(list)) return null;
  const out: Candle[] = [];
  for (const c of list) {
    const { t, o, h, l, c: close, v } = (c ?? {}) as Record<string, unknown>;
    if (typeof t !== 'string' || ![o, h, l, close].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return null;
    out.push({ t, o: o as number, h: h as number, l: l as number, c: close as number, v: typeof v === 'number' ? v : 0 });
  }
  return out;
}

/**
 * Real candles from FXCM through the read-only bridge (get_model models=Candles:<offer>:<tf>:<count>).
 * Only FX: symbols the bridge knows; anything else → null (nothing is ever estimated). Cached for a minute.
 */
export class CandleHub {
  private cache = new Map<string, { v: CandleSet | null; t: number }>();

  constructor(
    private store: Store,
    private client: FxcmgrClient = defaultFxcmgrClient,
    private now: () => number = Date.now,
  ) {}

  async get(symbol: string, timeframe: string, count: number): Promise<CandleSet | null> {
    const key = `${symbol}|${timeframe}|${count}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.t < TTL_MS) return hit.v;
    const v = await this.fetch(symbol, timeframe, count).catch(() => null);
    this.cache.set(key, { v, t: this.now() });
    return v;
  }

  private async fetch(symbol: string, timeframe: string, count: number): Promise<CandleSet | null> {
    const offers = fxcmOffers(symbol);
    if (!offers.length) return null;
    const cfg = await activeFxcmgr(this.store);
    if (!cfg) return null;
    for (const offer of offers) {
      const candles = parseCandles(await this.client(cfg, '/trading/get_model', `models=Candles:${offer}:${timeframe}:${count}`));
      if (candles?.length) return { offer, timeframe, candles };
    }
    return null;
  }
}
