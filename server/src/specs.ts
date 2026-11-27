import { nowUtcIso, specFromFxcm, type InstrumentSpec } from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import { fxcmOffers } from './quotes';
import type { Store } from './store/types';

const TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
/** FXCM instrumentType 1 = currency pair: sized from exchange rates, not from a contract spec. */
const CURRENCY_PAIR = 1;

/**
 * CFD specs (value of a 1.0 move per unit) read from FXCM through the read-only bridge
 * (get_model models=OfferSpec:<instrument>). Cached for a day; nothing is ever assumed.
 */
export class SpecHub {
  private cache = new Map<string, { spec: InstrumentSpec | null; t: number }>();

  constructor(
    private store: Store,
    private client: FxcmgrClient = defaultFxcmgrClient,
    private now: () => number = Date.now,
  ) {}

  async get(symbol: string): Promise<InstrumentSpec | null> {
    const hit = this.cache.get(symbol);
    if (hit && this.now() - hit.t < (hit.spec ? TTL_MS : MISS_TTL_MS)) return hit.spec;
    const spec = await this.fetch(symbol).catch(() => null);
    this.cache.set(symbol, { spec, t: this.now() });
    return spec;
  }

  private async fetch(symbol: string): Promise<InstrumentSpec | null> {
    const offers = fxcmOffers(symbol);
    if (!offers.length) return null;
    const account = (await this.store.accounts.list()).find((a) => a.integration?.kind === 'fxcmgr' && a.integration.enabled);
    if (!account?.integration) return null;
    for (const offer of offers) {
      const row = (await this.client(account.integration, '/trading/get_model', `models=OfferSpec:${offer}`)) as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || 'error' in row) continue;
      if (row.instrumentType === CURRENCY_PAIR) return null;
      // pipCost is in the FXCM account's currency.
      return specFromFxcm(symbol, row, account.baseCurrency, nowUtcIso());
    }
    return null;
  }
}
