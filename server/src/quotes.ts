import { COMMON_FX_SYMBOLS, Decimal, decStr, fxPair, parseFxcmgrQuote } from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import { activeFxcmgr } from './fx';
import type { Store } from './store/types';
import type { TvQuoteClient } from './tradingview';

export type QuoteSource = 'fxcmgr' | 'tradingview';

export interface Quote {
  price: string;
  at: string;
  source: QuoteSource;
}

const FRESH_MS = 15_000;
const HISTORY_MS = 60 * 60 * 1000; // keep one hour
const SAMPLE_MS = 20_000;
/** An FXCM price unchanged this long is treated as frozen (pair missing from the FXCM subscription list). */
export const FXCM_FROZEN_MS = 3 * 60 * 1000;

export interface QuoteHubOptions {
  fxcmgr?: FxcmgrClient;
  /** TradingView fallback; null = FXCM only. */
  tv?: TvQuoteClient | null;
  now?: () => number;
}

/**
 * Live prices + a short in-memory history for sparklines.
 * Source per symbol: FXCM (the broker) while its price moves; TradingView when FXCM has no such pair
 * or its price has been frozen for FXCM_FROZEN_MS. FXCM keeps being polled, so a pair that comes
 * alive there switches back. History holds only prices actually observed — nothing interpolated —
 * and restarts when the source changes, so a jump between feeds never looks like a price move.
 */
export class QuoteHub {
  private latest = new Map<string, { q: Quote; t: number }>();
  private history = new Map<string, Array<[number, string]>>();
  private historySource = new Map<string, QuoteSource>();
  /** Last FXCM price per symbol and since when it has been that price. */
  private fxcm = new Map<string, { price: string; since: number }>();
  private fxcmgr: FxcmgrClient;
  private tv: TvQuoteClient | null;
  private now: () => number;

  constructor(
    private store: Store,
    opts: QuoteHubOptions = {},
  ) {
    this.fxcmgr = opts.fxcmgr ?? defaultFxcmgrClient;
    this.tv = opts.tv ?? null;
    this.now = opts.now ?? Date.now;
  }

  private record(symbol: string, price: string, source: QuoteSource) {
    const now = this.now();
    const q: Quote = { price, at: new Date(now).toISOString(), source };
    this.latest.set(symbol, { q, t: now });
    const prevSource = this.historySource.get(symbol);
    this.historySource.set(symbol, source);
    const h = prevSource && prevSource !== source ? [] : (this.history.get(symbol) ?? []);
    h.push([now, price]);
    while (h.length && h[0]![0] < now - HISTORY_MS) h.shift();
    this.history.set(symbol, h);
    return q;
  }

  private noteFxcm(symbol: string, price: string) {
    const prev = this.fxcm.get(symbol);
    if (!prev || prev.price !== price) this.fxcm.set(symbol, { price, since: this.now() });
  }

  private fxcmFrozen(symbol: string) {
    const s = this.fxcm.get(symbol);
    return !!s && this.now() - s.since >= FXCM_FROZEN_MS;
  }

  /** Fresh quotes for symbols; fetches the stale ones. Symbols without any source are absent. */
  async get(symbols: string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const stale = symbols.filter((s) => {
      const hit = this.latest.get(s);
      if (hit && this.now() - hit.t < FRESH_MS) {
        out[s] = hit.q;
        return false;
      }
      return true;
    });
    if (!stale.length) return out;

    const fromFxcm: Record<string, string> = {};
    const cfg = await activeFxcmgr(this.store);
    if (cfg) {
      for (const symbol of stale) {
        const pair = fxPair(symbol);
        if (!pair) continue;
        try {
          const price = decStr(new Decimal(parseFxcmgrQuote(await this.fxcmgr(cfg, '/subscribe', `pairs=${pair}`))));
          fromFxcm[symbol] = price;
          this.noteFxcm(symbol, price);
        } catch {
          /* unknown pair or bridge down */
        }
      }
    }

    let fromTv: Record<string, string> = {};
    const needTv = stale.filter((s) => !(s in fromFxcm) || this.fxcmFrozen(s));
    if (this.tv && needTv.length) {
      try {
        fromTv = await this.tv(needTv);
      } catch (e) {
        console.error('[quotes] TradingView:', e instanceof Error ? e.message : e);
      }
    }

    for (const symbol of stale) {
      const tv = fromTv[symbol];
      const fx = fromFxcm[symbol];
      // A frozen FXCM price is still returned when TradingView has nothing — the UI marks it as not updating.
      if (tv) out[symbol] = this.record(symbol, tv, 'tradingview');
      else if (fx) out[symbol] = this.record(symbol, fx, 'fxcmgr');
    }
    return out;
  }

  /**
   * The price actually moved within the window. A frozen feed (or right after a restart) is never
   * treated as live — alerts skip it.
   */
  isLive(symbol: string, windowMs = 15 * 60 * 1000): boolean {
    const since = this.now() - windowMs;
    const recent = (this.history.get(symbol) ?? []).filter(([t]) => t >= since);
    return new Set(recent.map(([, p]) => p)).size > 1;
  }

  historyFor(symbols: string[]): Record<string, Array<[number, string]>> {
    return Object.fromEntries(symbols.map((s) => [s, this.history.get(s) ?? []]));
  }

  /** Background sampling of the watchlist + symbols of active plans, so sparklines fill even with no page open. */
  startSampler(extraSymbols: () => Promise<string[]> = async () => [], onTick?: (quotes: Record<string, Quote>) => Promise<void>) {
    const tick = async () => {
      try {
        const extra = await extraSymbols();
        // Force a refresh by treating everything as stale for this tick.
        for (const s of [...COMMON_FX_SYMBOLS, ...extra]) this.latest.delete(s);
        const quotes = await this.get([...new Set([...COMMON_FX_SYMBOLS, ...extra])]);
        if (onTick) await onTick(quotes);
      } catch (e) {
        console.error('[quotes]', e instanceof Error ? e.message : e);
      }
    };
    void tick();
    const t = setInterval(tick, SAMPLE_MS);
    t.unref();
    return () => clearInterval(t);
  }
}
