import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { FxcmgrClient } from './broker';
import { FXCM_FROZEN_MS, QuoteHub } from './quotes';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/types';
import type { TvQuoteClient } from './tradingview';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const TMP = path.join(os.tmpdir(), `trading-quotes-${process.pid}`);

let store: Store;
let fxcm: Record<string, number>; // FXCM pair → rate; missing pair = bridge error
let tv: Record<string, string>;
let tvAsked: string[][];
let tvDown: boolean;
let now: number;

const fxcmgr: FxcmgrClient = async (_cfg, _path, body) => {
  const pair = body.replace('pairs=', '');
  if (!(pair in fxcm)) throw new Error('unknown pair');
  return { pairs: [{ Updated: 0, Rates: [fxcm[pair]] }] };
};
const tvClient: TvQuoteClient = async (symbols) => {
  tvAsked.push(symbols);
  if (tvDown) throw new Error('HTTP 403');
  return Object.fromEntries(symbols.filter((s) => s in tv).map((s) => [s, tv[s]!]));
};

beforeEach(async () => {
  store = createMemoryStore();
  fxcm = {};
  tv = {};
  tvAsked = [];
  tvDown = false;
  now = Date.parse('2026-11-27T10:00:00Z');
  const app = createApp(store, { adminKey: KEY, filesDir: TMP });
  await request(app)
    .post('/api/accounts')
    .set({ 'x-admin-key': KEY })
    .send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' } })
    .expect(201);
});

const hub = () => new QuoteHub(store, { fxcmgr, tv: tvClient, now: () => now });
const step = (ms = 20_000) => {
  now += ms;
};

describe('QuoteHub sources', () => {
  it('moving FXCM price stays on FXCM; TradingView is not even asked', async () => {
    const h = hub();
    fxcm['EUR/USD'] = 1.0965;
    expect(await h.get(['FX:EURUSD'])).toMatchObject({ 'FX:EURUSD': { price: '1.0965', source: 'fxcmgr' } });
    expect(tvAsked).toEqual([]);
  });

  it('pair missing from FXCM → TradingView', async () => {
    tv['FX:GBPJPY'] = '209.257';
    expect(await hub().get(['FX:GBPJPY'])).toMatchObject({ 'FX:GBPJPY': { price: '209.257', source: 'tradingview' } });
  });

  it('frozen FXCM → TradingView with a fresh sparkline; back to FXCM once it moves', async () => {
    const h = hub();
    fxcm['GBP/JPY'] = 207.49;
    tv['FX:GBPJPY'] = '209.257';
    expect((await h.get(['FX:GBPJPY']))['FX:GBPJPY']!.source).toBe('fxcmgr');
    step(FXCM_FROZEN_MS);
    expect(await h.get(['FX:GBPJPY'])).toMatchObject({ 'FX:GBPJPY': { price: '209.257', source: 'tradingview' } });
    expect(h.historyFor(['FX:GBPJPY'])['FX:GBPJPY']).toEqual([[now, '209.257']]); // FXCM points dropped

    step();
    fxcm['GBP/JPY'] = 209.3;
    expect(await h.get(['FX:GBPJPY'])).toMatchObject({ 'FX:GBPJPY': { price: '209.3', source: 'fxcmgr' } });
    expect(h.historyFor(['FX:GBPJPY'])['FX:GBPJPY']).toHaveLength(1);
  });

  it('TradingView down → the frozen FXCM price is still returned (UI marks it), no throw', async () => {
    const h = hub();
    fxcm['GBP/JPY'] = 207.49;
    tvDown = true;
    await h.get(['FX:GBPJPY']);
    step(FXCM_FROZEN_MS);
    expect(await h.get(['FX:GBPJPY'])).toMatchObject({ 'FX:GBPJPY': { price: '207.49', source: 'fxcmgr' } });
    expect(h.isLive('FX:GBPJPY')).toBe(false);
  });

  it('one TradingView request for all symbols that need it', async () => {
    fxcm['EUR/USD'] = 1.0965;
    tv['FX:GBPJPY'] = '209.257';
    tv['FX:AUDNZD'] = '1.21698';
    const q = await hub().get(['FX:EURUSD', 'FX:GBPJPY', 'FX:AUDNZD']);
    expect(Object.keys(q).sort()).toEqual(['FX:AUDNZD', 'FX:EURUSD', 'FX:GBPJPY']);
    expect(tvAsked).toEqual([['FX:GBPJPY', 'FX:AUDNZD']]);
  });
});
