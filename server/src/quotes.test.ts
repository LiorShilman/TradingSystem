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
let tvDelayed: Record<string, number>;
let fxcmAsked: string[];
let tvAsked: string[][];
let tvDown: boolean;
let now: number;

const fxcmgr: FxcmgrClient = async (_cfg, _path, body) => {
  const pair = body.replace('pairs=', '');
  fxcmAsked.push(pair);
  if (!(pair in fxcm)) throw new Error('unknown pair');
  return { pairs: [{ Updated: 0, Rates: [fxcm[pair]] }] };
};
const tvClient: TvQuoteClient = async (symbols) => {
  tvAsked.push(symbols);
  if (tvDown) throw new Error('HTTP 403');
  return Object.fromEntries(symbols.filter((s) => s in tv).map((s) => [s, { price: tv[s]!, delayedMin: tvDelayed[s] ?? 0, name: `name of ${s}` }]));
};

beforeEach(async () => {
  store = createMemoryStore();
  fxcm = {};
  tv = {};
  tvAsked = [];
  tvDown = false;
  tvDelayed = {};
  fxcmAsked = [];
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

  it('other exchanges never go to FXCM; FX: gold/oil do (XAU/USD, USOil); an unknown offer is not retried every tick', async () => {
    const h = hub();
    fxcm['XAU/USD'] = 3674.56;
    tv['BITSTAMP:BTCUSD'] = '61749.38';
    tv['FX:US2000'] = '2400';
    const q = await h.get(['BITSTAMP:BTCUSD', 'FX:XAUUSD', 'FX:US2000']);
    expect(q).toMatchObject({ 'BITSTAMP:BTCUSD': { source: 'tradingview', name: 'name of BITSTAMP:BTCUSD' }, 'FX:XAUUSD': { price: '3674.56', source: 'fxcmgr' }, 'FX:US2000': { source: 'tradingview' } });
    expect(fxcmAsked).toEqual(['XAU/USD', 'US2000F', 'US2000']);
    step();
    await h.get(['FX:US2000']);
    expect(fxcmAsked).toEqual(['XAU/USD', 'US2000F', 'US2000']); // not asked again for 10 minutes
  });

  it('a pair FXCM served before is retried within a minute when the bridge drops (weekend reconnect)', async () => {
    const h = hub();
    fxcm['EUR/USD'] = 1.0965;
    tv['FX:EURUSD'] = '1.0966';
    expect((await h.get(['FX:EURUSD']))['FX:EURUSD']!.source).toBe('fxcmgr');
    delete fxcm['EUR/USD']; // bridge reconnecting
    step();
    expect((await h.get(['FX:EURUSD']))['FX:EURUSD']!.source).toBe('tradingview');
    fxcm['EUR/USD'] = 1.0967; // back
    step(15_000);
    await h.get(['FX:EURUSD']);
    expect(fxcmAsked).toHaveLength(2); // still within the 30s back-off
    step(20_000);
    expect(await h.get(['FX:EURUSD'])).toMatchObject({ 'FX:EURUSD': { price: '1.0967', source: 'fxcmgr' } });
  });

  it('index CFDs: FX:SPX500 is FXCM "SPX500F"', async () => {
    fxcm['SPX500F'] = 7300.94;
    expect(await hub().get(['FX:SPX500'])).toMatchObject({ 'FX:SPX500': { price: '7300.94', source: 'fxcmgr' } });
    expect(fxcmAsked).toEqual(['SPX500F']);
  });

  it('delayed TradingView data is flagged and never counts as live', async () => {
    const h = hub();
    tv['NASDAQ:MSTR'] = '79.96';
    tvDelayed['NASDAQ:MSTR'] = 15;
    expect(await h.get(['NASDAQ:MSTR'])).toMatchObject({ 'NASDAQ:MSTR': { price: '79.96', delayedMin: 15 } });
    step();
    tv['NASDAQ:MSTR'] = '80.10';
    await h.get(['NASDAQ:MSTR']);
    expect(h.isLive('NASDAQ:MSTR')).toBe(false);
  });
});