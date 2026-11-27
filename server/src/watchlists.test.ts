import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sectionsFromTradingView, type Watchlist } from '@trading/shared';
import { createApp } from './app';
import type { AlertEngine } from './alerts';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-wl-${process.pid}`);

describe('watchlists', () => {
  it('default FX list is created once and is editable; symbols can be removed; the last list cannot be deleted', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP });
    const first = (await request(app).get('/api/watchlists').set(auth)).body as Watchlist[];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 'All Forex (FXCM)' });
    expect(first[0]!.sections.flatMap((s) => s.symbols)).toHaveLength(28);
    expect((await request(app).get('/api/watchlists').set(auth)).body).toHaveLength(1); // not seeded twice

    // Remove the frozen crosses from the list — no TradingView or Trading Station involved.
    const sections = first[0]!.sections.map((s) => ({ ...s, symbols: s.symbols.filter((x) => x !== 'FX:GBPJPY' && x !== 'FX:AUDNZD') }));
    const patched = (await request(app).patch(`/api/watchlists/${first[0]!.id}`).set(auth).send({ sections })).body as Watchlist;
    expect(patched.sections.flatMap((s) => s.symbols)).toHaveLength(26);

    expect((await request(app).delete(`/api/watchlists/${first[0]!.id}`).set(auth)).status).toBe(409);
  });

  it('import from a TradingView list keeps its sections; the sampler prices the new symbols', async () => {
    const app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP });
    const sections = sectionsFromTradingView(['###CRYPTO', 'BITSTAMP:BTCUSD', 'nonsense text', '###CFD', 'FX:XAUUSD', 'FX:USOIL', 'FX:XAUUSD']);
    expect(sections).toEqual([
      { name: 'CRYPTO', symbols: ['BITSTAMP:BTCUSD'] },
      { name: 'CFD', symbols: ['FX:XAUUSD', 'FX:USOIL'] },
    ]);
    const created = await request(app).post('/api/watchlists').set(auth).send({ name: 'Open Trading', sections, sourceTvId: 167105649 });
    expect(created.status).toBe(201);
    const watched = await (app.locals.alertEngine as AlertEngine).watchedSymbols();
    expect(watched).toEqual(expect.arrayContaining(['BITSTAMP:BTCUSD', 'FX:XAUUSD', 'FX:USOIL']));
    expect((await request(app).post('/api/watchlists').set(auth).send({ name: 'x', sections: [{ name: '', symbols: ['not a symbol!'] }] })).status).toBe(400);
  });
});
