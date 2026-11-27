import { COMMON_FX_SYMBOLS, Decimal, decStr, fxPair, parseFxcmgrQuote } from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import { activeFxcmgr } from './fx';
import type { Store } from './store/types';

export interface Quote {
  price: string;
  at: string;
  source: 'fxcmgr';
}

const FRESH_MS = 15_000;
const HISTORY_MS = 60 * 60 * 1000; // keep one hour
const SAMPLE_MS = 20_000;

/**
 * Live prices (forex via FXCMgr) + a short in-memory history for sparklines.
 * History holds only prices actually observed — nothing interpolated or invented.
 */
export class QuoteHub {
  private latest = new Map<string, { q: Quote; t: number }>();
  private history = new Map<string, Array<[number, string]>>();

  constructor(
    private store: Store,
    private client: FxcmgrClient = defaultFxcmgrClient,
  ) {}

  private record(symbol: string, price: string) {
    const now = Date.now();
    const q: Quote = { price, at: new Date(now).toISOString(), source: 'fxcmgr' };
    this.latest.set(symbol, { q, t: now });
    const h = this.history.get(symbol) ?? [];
    h.push([now, price]);
    while (h.length && h[0]![0] < now - HISTORY_MS) h.shift();
    this.history.set(symbol, h);
    return q;
  }

  /** Fresh quotes for symbols; fetches the stale ones. Symbols without a source are absent. */
  async get(symbols: string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const stale = symbols.filter((s) => {
      const hit = this.latest.get(s);
      if (hit && Date.now() - hit.t < FRESH_MS) {
        out[s] = hit.q;
        return false;
      }
      return true;
    });
    if (!stale.length) return out;
    const cfg = await activeFxcmgr(this.store);
    if (!cfg) return out;
    for (const symbol of stale) {
      const pair = fxPair(symbol);
      if (!pair) continue;
      try {
        const price = decStr(new Decimal(parseFxcmgrQuote(await this.client(cfg, '/subscribe', `pairs=${pair}`))));
        out[symbol] = this.record(symbol, price);
      } catch {
        /* unknown pair or bridge down — leave it out */
      }
    }
    return out;
  }

  historyFor(symbols: string[]): Record<string, Array<[number, string]>> {
    return Object.fromEntries(symbols.map((s) => [s, this.history.get(s) ?? []]));
  }

  /** Background sampling of the watchlist + symbols of active plans, so sparklines fill even with no page open. */
  startSampler(extraSymbols: () => Promise<string[]> = async () => []) {
    const tick = async () => {
      try {
        const extra = await extraSymbols();
        // Force a refresh by treating everything as stale for this tick.
        for (const s of [...COMMON_FX_SYMBOLS, ...extra]) this.latest.delete(s);
        await this.get([...new Set([...COMMON_FX_SYMBOLS, ...extra])]);
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


