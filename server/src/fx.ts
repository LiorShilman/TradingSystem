import {
  FXCMGR_PAIRS,
  fxcmgrRates,
  nowUtcIso,
  parseBoiRates,
  parseFrankfurter,
  parseFxcmgrQuote,
  type FxcmgrConfig,
  type FxSnapshot,
  type FxSource,
  type ParsedFx,
} from '@trading/shared';
import { defaultFxcmgrClient, type FxcmgrClient } from './broker';
import type { Store } from './store/types';

export type Fetcher = (url: string) => Promise<unknown>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'trading-system/0.1' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export interface FxDeps {
  fetcher?: Fetcher;
  fxcmgrClient?: FxcmgrClient;
}

const PUBLIC_PROVIDERS: Array<{ source: FxSource; url: string; parse: (j: unknown) => ParsedFx }> = [
  { source: 'boi', url: 'https://boi.org.il/PublicApi/GetExchangeRates?asJson=true', parse: parseBoiRates },
  { source: 'frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=ILS,EUR,GBP', parse: parseFrankfurter },
];

/** The FXCMgr link of the first account that has it switched on, if any. */
export async function activeFxcmgr(store: Store): Promise<FxcmgrConfig | null> {
  const accounts = await store.accounts.list();
  return accounts.find((a) => a.integration?.kind === 'fxcmgr' && a.integration.enabled)?.integration ?? null;
}

async function fromFxcmgr(cfg: FxcmgrConfig, client: FxcmgrClient): Promise<ParsedFx> {
  const quotes: Record<string, string> = {};
  // Sequential and each optional except USD/ILS — the bridge handles one subscribe at a time well.
  for (const { pair } of FXCMGR_PAIRS) {
    try {
      quotes[pair] = parseFxcmgrQuote(await client(cfg, '/subscribe', `pairs=${pair}`));
    } catch (e) {
      if (pair === 'USD/ILS') throw e;
    }
  }
  return { rates: fxcmgrRates(quotes), asOf: nowUtcIso(), asOfHasTime: true };
}

/** Live FXCM first (when an account has FXCMgr switched on), then Bank of Israel, then ECB. */
export async function fetchFx(store: Store, deps: FxDeps = {}): Promise<FxSnapshot> {
  const errors: string[] = [];
  const cfg = await activeFxcmgr(store);
  if (cfg) {
    try {
      const parsed = await fromFxcmgr(cfg, deps.fxcmgrClient ?? defaultFxcmgrClient);
      return { ...parsed, source: 'fxcmgr', fetchedAt: nowUtcIso() };
    } catch (e) {
      errors.push(`fxcmgr: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const p of PUBLIC_PROVIDERS) {
    try {
      const parsed = p.parse(await (deps.fetcher ?? defaultFetcher)(p.url));
      return { ...parsed, source: p.source, fetchedAt: nowUtcIso() };
    } catch (e) {
      errors.push(`${p.source}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`כל מקורות השערים נכשלו (${errors.join('; ')})`);
}

/** Fetch and store. On failure the previous snapshot is kept untouched. */
export async function refreshFx(store: Store, deps: FxDeps = {}): Promise<FxSnapshot> {
  const snap = await fetchFx(store, deps);
  await store.fx.set(snap);
  return snap;
}

const LIVE_EVERY_MS = 5 * 60 * 1000; // FXCM live rate
const DAILY_EVERY_MS = 3 * 60 * 60 * 1000; // public daily rates

/** Ticks every 5 minutes; hits public sources only every 3 hours (or when switching away from FXCM). */
export function startFxScheduler(store: Store, deps: FxDeps = {}) {
  const tick = async () => {
    try {
      const [live, last] = await Promise.all([activeFxcmgr(store), store.fx.get()]);
      const age = last ? Date.now() - Date.parse(last.fetchedAt) : Infinity;
      if (!live && last && last.source !== 'fxcmgr' && age < DAILY_EVERY_MS) return;
      const s = await refreshFx(store, deps);
      console.log(`[fx] updated from ${s.source} (as of ${s.asOf})`);
    } catch (e) {
      console.error('[fx]', e instanceof Error ? e.message : e);
    }
  };
  void tick();
  const t = setInterval(tick, LIVE_EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}
