import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Trade } from '@trading/shared';
import { createApp } from './app';
import type { FxcmgrClient } from './broker';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-specs-${process.pid}`);

// FXCMgr answers as it did on 27/11/2026.
const ROWS: Record<string, unknown> = {
  USOil: { instrument: 'USOil', pointSize: 0.01, pipCost: 0.1, baseUnitSize: 1, minQuantity: 1, instrumentType: 3 },
  'EUR/USD': { instrument: 'EUR/USD', pointSize: 0.0001, pipCost: 0.1, baseUnitSize: 1000, minQuantity: 1000, instrumentType: 1 },
};
const asked: string[] = [];
const fxcmgr: FxcmgrClient = async (_cfg, p, body) => {
  if (p !== '/trading/get_model') throw new Error('unexpected');
  const ins = body.replace('models=OfferSpec:', '');
  asked.push(ins);
  return ROWS[ins] ?? { error: 'instrument not found', instrument: ins };
};

describe('CFD specs from FXCM', () => {
  it('spec endpoint: oil has a point value, a currency pair does not; cached', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxcmgrClient: fxcmgr });
    await request(app).post('/api/accounts').set(auth).send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' } }).expect(201);
    expect((await request(app).get('/api/instruments/spec?symbol=FX:USOIL').set(auth)).body).toMatchObject({ offer: 'USOil', pointValue: '10', currency: 'USD', step: '1' });
    expect((await request(app).get('/api/instruments/spec?symbol=FX:EURUSD').set(auth)).body).toBeNull();
    expect((await request(app).get('/api/instruments/spec?symbol=BITSTAMP:BTCUSD').set(auth)).body).toBeNull();
    const n = asked.length;
    await request(app).get('/api/instruments/spec?symbol=FX:USOIL').set(auth);
    expect(asked.length).toBe(n); // from cache
  });

  it('an oil trade stores the point value at opening and books P&L with it', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP, fxcmgrClient: fxcmgr });
    const acc = (await request(app).post('/api/accounts').set(auth).send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' } })).body;
    const at = '2026-11-27T12:00:00.000Z';
    const t = (
      await request(app)
        .post('/api/trades')
        .set(auth)
        .send({ symbol: 'FX:USOIL', accountId: acc.id, direction: 'long', initialStop: '84', fills: [{ id: 'e', kind: 'entry', at, price: '85', quantity: '10' }, { id: 'x', kind: 'exit', at, price: '86.5', quantity: '10' }] })
    ).body as Trade;
    expect(t).toMatchObject({ pointValue: '10', pointValueCurrency: 'USD', netPnl: '150', r: '1.5' });
    // A patch can't change the frozen point value.
    const p = await request(app).patch(`/api/trades/${t.id}`).set(auth).send({ pointValue: '1', lesson: 'x' });
    expect(p.body.pointValue).toBe('10');
  });
});
