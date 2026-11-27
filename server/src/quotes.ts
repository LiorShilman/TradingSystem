import { Decimal, decStr, parseFxcmgrQuote, type TvQuote } from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import { activeFxcmgr } from './fx';
import type { Store } from './store/types';
import type { TvQuoteClient } from './tradingview';

export type QuoteSource = 'fxcmgr' | 'tradingview';

export interface Quote {
  price: string;
  at: string;
  source: QuoteSource;
  /** Minutes behind real time (TradingView without a data subscription); absent = real time. */
  delayedMin?: number;
  /** Instrument description from TradingView, when known. */
  name?: string;
}

/**
 * FXCM offer names for TradingView "FX:" tickers that aren't 6-letter pairs, most likely first.
 * The index CFDs in this account are the futures-based ones with an "F" suffix (SPX500F, NAS100F,
 * US2000F — verified 27/11/2026); the plain names are kept as a fallback for other account types.
 */
const FXCM_CFDS: Record<string, readonly string[]> = {
  USOIL: ['USOil'],
  UKOIL: ['UKOil'],
  SPX500: ['SPX500F', 'SPX500'],
  NAS100: ['NAS100F', 'NAS100'],
  US2000: ['US2000F', 'US2000'],
  US30: ['US30F', 'US30'],
  GER30: ['GER30F', 'GER30'],
  UK100: ['UK100F', 'UK100'],
  JPN225: ['JPN225F', 'JPN225'],
  FRA40: ['FRA40F', 'FRA40'],
  AUS200: ['AUS200F', 'AUS200'],
  NGAS: ['NGAS'],
  COPPER: ['Copper'],
};

/**
 * FXCM offer names to try for a TradingView symbol: only the "FX:" exchange (TradingView's FXCM feed) —
 * "BITSTAMP:BTCUSD" also has 6 letters but is not an FXCM pair. Gold/silver are XAU/USD, XAG/USD.
 */
export function fxcmOffers(symbol: string): readonly string[] {
  const [ex, t] = symbol.split(':');
  if (ex !== 'FX' || !t) return [];
  if (/^[A-Z]{6}$/.test(t)) return [`${t.slice(0, 3)}/${t.slice(3)}`];
  return FXCM_CFDS[t] ?? [];
}

/** An offer FXCM doesn't serve (not in the subscription) is retried only this often. */
const UNKNOWN_OFFER_RETRY_MS = 10 * 60 * 1000;

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

  private unknownOffer = new Map<string, number>();
  private names = new Map<string, string>();

  private record(symbol: string, price: string, source: QuoteSource, delayedMin = 0) {
    const now = this.now();
    const name = this.names.get(symbol);
    const q: Quote = { price, at: new Date(now).toISOString(), source, ...(delayedMin ? { delayedMin } : {}), ...(name ? { name } : {}) };
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
        for (const offer of fxcmOffers(symbol)) {
          if (this.now() - (this.unknownOffer.get(offer) ?? -Infinity) < UNKNOWN_OFFER_RETRY_MS) continue;
          try {
            const price = decStr(new Decimal(parseFxcmgrQuote(await this.fxcmgr(cfg, '/subscribe', `pairs=${offer}`))));
            fromFxcm[symbol] = price;
            this.noteFxcm(symbol, price);
            this.unknownOffer.delete(offer);
            break;
          } catch {
            this.unknownOffer.set(offer, this.now()); // not in the FXCM subscription, or the bridge is down
          }
        }
      }
    }

    let fromTv: Record<string, TvQuote> = {};
    const needTv = stale.filter((s) => !(s in fromFxcm) || this.fxcmFrozen(s));
    if (this.tv && needTv.length) {
      try {
        fromTv = await this.tv(needTv);
        for (const [s, q] of Object.entries(fromTv)) if (q.name) this.names.set(s, q.name);
      } catch (e) {
        console.error('[quotes] TradingView:', e instanceof Error ? e.message : e);
      }
    }

    for (const symbol of stale) {
      const tv = fromTv[symbol];
      const fx = fromFxcm[symbol];
      // A frozen FXCM price is still returned when TradingView has nothing — the UI marks it as not updating.
      if (tv) out[symbol] = this.record(symbol, tv.price, 'tradingview', tv.delayedMin);
      else if (fx) out[symbol] = this.record(symbol, fx, 'fxcmgr');
    }
    return out;
  }

  /**
   * The price actually moved within the window. A frozen feed (or right after a restart) is never
   * treated as live — alerts skip it.
   */
  isLive(symbol: string, windowMs = 15 * 60 * 1000): boolean {
    if (this.latest.get(symbol)?.q.delayedMin) return false; // delayed data never triggers alerts
    const since = this.now() - windowMs;
    const recent = (this.history.get(symbol) ?? []).filter(([t]) => t >= since);
    return new Set(recent.map(([, p]) => p)).size > 1;
  }

  historyFor(symbols: string[]): Record<string, Array<[number, string]>> {
    return Object.fromEntries(symbols.map((s) => [s, this.history.get(s) ?? []]));
  }

  /** Background sampling of every watched symbol (watchlists, plans, trades…), so sparklines fill even with no page open. */
  startSampler(symbols_: () => Promise<string[]>, onTick?: (quotes: Record<string, Quote>) => Promise<void>) {
    const tick = async () => {
      try {
        // Force a refresh by treating everything as stale for this tick.
        const symbols = [...new Set(await symbols_())];
        for (const s of symbols) this.latest.delete(s);
        const quotes = await this.get(symbols);
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
