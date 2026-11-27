import os from 'node:os';
import path from 'node:path';
const TMP = path.join(os.tmpdir(), 'trading-test-files');
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { FxcmgrClient } from './broker';
import type { Fetcher } from './fx';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };

const BOI = {
  exchangeRates: [
    { key: 'USD', currentExchangeRate: 3.334, unit: 1, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
    { key: 'EUR', currentExchangeRate: 3.6594, unit: 1, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
  ],
};
const FRANKFURTER = { amount: 1, base: 'USD', date: '2026-11-26', rates: { ILS: 3.3273, EUR: 0.91116, GBP: 0.76314 } };

const fetcherFrom =
  (routes: { boi?: unknown; frankfurter?: unknown }): Fetcher =>
  async (url) => {
    const body = url.includes('boi.org.il') ? routes.boi : routes.frankfurter;
    if (body === undefined) throw new Error('down');
    return body;
  };

describe('fx', () => {
  it('no snapshot before the first refresh', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxFetcher: fetcherFrom({}) });
    const res = await request(app).get('/api/fx').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('uses Bank of Israel first', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxFetcher: fetcherFrom({ boi: BOI, frankfurter: FRANKFURTER }) });
    const res = await request(app).post('/api/fx/refresh').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('boi');
    expect(res.body.rates.ILS).toBe('3.334');
    expect((await request(app).get('/api/fx').set(auth)).body.source).toBe('boi');
  });

  it('falls back to Frankfurter when BOI is down or broken', async () => {
    for (const boi of [undefined, { nonsense: true }]) {
      const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxFetcher: fetcherFrom({ boi, frankfurter: FRANKFURTER }) });
      const res = await request(app).post('/api/fx/refresh').set(auth);
      expect(res.body.source).toBe('frankfurter');
      expect(res.body.rates.ILS).toBe('3.3273');
    }
  });

  it('when every source fails: 502 and the previous snapshot is kept', async () => {
    const store = createMemoryStore();
    let up = true;
    const fetcher: Fetcher = async (url) => {
      if (!up) throw new Error('down');
      return url.includes('boi.org.il') ? BOI : FRANKFURTER;
    };
    const app = createApp(store, { adminKey: KEY, filesDir: TMP, fxFetcher: fetcher });
    await request(app).post('/api/fx/refresh').set(auth).expect(200);
    up = false;
    const res = await request(app).post('/api/fx/refresh').set(auth);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('נכשלו');
    expect((await store.fx.get())?.rates.ILS).toBe('3.334');
  });

  it('uses live FXCM first when an account has FXCMgr switched on, sending the raw pair', async () => {
    const bodies: string[] = [];
    const fxcmgrClient: FxcmgrClient = async (_cfg, path, body) => {
      bodies.push(`${path} ${body}`);
      const rate = { 'pairs=USD/ILS': 3.29861, 'pairs=EUR/USD': 1.25, 'pairs=GBP/USD': 1.0973799999999998 }[body];
      return { pairs: [{ Updated: 0, Rates: [rate] }] };
    };
    const store = createMemoryStore();
    const app = createApp(store, { adminKey: KEY, filesDir: TMP, fxFetcher: fetcherFrom({ boi: BOI }), fxcmgrClient });
    const cfg = { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' };
    const acc = await request(app).post('/api/accounts').set(auth).send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: cfg });

    const res = await request(app).post('/api/fx/refresh').set(auth);
    expect(res.body.source).toBe('fxcmgr');
    expect(res.body.rates).toMatchObject({ ILS: '3.29861', EUR: '0.8' });
    expect(bodies).toContain('/subscribe pairs=USD/ILS'); // not "USD%2FILS" — the bridge does not decode

    // switched off → back to Bank of Israel
    await request(app).patch(`/api/accounts/${acc.body.id}`).set(auth).send({ integration: { ...cfg, enabled: false } });
    expect((await request(app).post('/api/fx/refresh').set(auth)).body.source).toBe('boi');
  });

  it('FXCM down → falls back to Bank of Israel', async () => {
    const app = createApp(createMemoryStore(), {
      adminKey: KEY,
      filesDir: TMP,
      fxFetcher: fetcherFrom({ boi: BOI }),
      fxcmgrClient: async () => {
        throw new Error('FXCMgr לא זמין');
      },
    });
    await request(app)
      .post('/api/accounts')
      .set(auth)
      .send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' } });
    expect((await request(app).post('/api/fx/refresh').set(auth)).body.source).toBe('boi');
  });

  it('requires the admin key', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxFetcher: fetcherFrom({}) });
    expect((await request(app).post('/api/fx/refresh')).status).toBe(401);
  });
});
