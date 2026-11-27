import os from 'node:os';
import path from 'node:path';
const TMP = path.join(os.tmpdir(), 'trading-test-files');
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { FxcmgrClient } from './broker';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const CFG = { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: 'example.test:11000' };

let up = true;
const calls: string[] = [];
const fake: FxcmgrClient = async (cfg, _path, body) => {
  const model = body.replace('models=', '');
  calls.push(`${model}@${cfg.hostHeader}`);
  if (!up) throw new Error('FXCMgr לא זמין (האפליקציה כבויה?)');
  return model === 'Account'
    ? { accounts: [{ equity: 10017.5, dayPL: 5 }] }
    : { open_positions: [{ amountK: 10, currency: 'EUR/USD', grossPL: 17.5, type: 'B' }] };
};

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  up = true;
  calls.length = 0;
  app = createApp(createMemoryStore(), {
    adminKey: KEY,
    filesDir: TMP,
    fxcmgrClient: fake,
    brokerDefaults: { fxcmgrUrl: 'http://localhost:11000', fxcmgrHost: 'example.test:11000' },
  });
});

async function account(integration: unknown = null) {
  const res = await request(app).post('/api/accounts').set(auth).send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('broker integration (FXCMgr)', () => {
  it('serves defaults from config', async () => {
    const res = await request(app).get('/api/integrations/fxcmgr/defaults').set(auth);
    expect(res.body).toEqual({ fxcmgrUrl: 'http://localhost:11000', fxcmgrHost: 'example.test:11000' });
  });

  it('not connected → 404; disabled → 409', async () => {
    expect((await request(app).get(`/api/accounts/${await account()}/broker`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/api/accounts/${await account({ ...CFG, enabled: false })}/broker`).set(auth)).status).toBe(409);
    expect(calls).toHaveLength(0); // never contacts the bridge when off
  });

  it('connected → live snapshot with decimals and balanceApprox, using the Host header', async () => {
    const res = await request(app).get(`/api/accounts/${await account(CFG)}/broker`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ equity: '10017.5', dayPL: '5', openPL: '17.5', balanceApprox: '10000' });
    expect(res.body.positions[0]).toMatchObject({ instrument: 'EUR/USD', direction: 'long' });
    expect(calls).toEqual(['Account@example.test:11000', 'OpenPosition@example.test:11000']);
  });

  it('bridge down → 502 with a clear message (no stale numbers)', async () => {
    const id = await account(CFG);
    up = false;
    const res = await request(app).get(`/api/accounts/${id}/broker`).set(auth);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('לא זמין');
  });

  it('connect / toggle / disconnect via account PATCH', async () => {
    const id = await account();
    const on = await request(app).patch(`/api/accounts/${id}`).set(auth).send({ integration: CFG });
    expect(on.body.integration.enabled).toBe(true);
    const off = await request(app).patch(`/api/accounts/${id}`).set(auth).send({ integration: { ...CFG, enabled: false } });
    expect(off.body.integration.enabled).toBe(false);
    const gone = await request(app).patch(`/api/accounts/${id}`).set(auth).send({ integration: null });
    expect(gone.body.integration).toBeNull();
    expect((await request(app).patch(`/api/accounts/${id}`).set(auth).send({ integration: { ...CFG, baseUrl: 'nope' } })).status).toBe(400);
  });

  it('test endpoint reports success or failure', async () => {
    const ok = await request(app).post('/api/integrations/fxcmgr/test').set(auth).send({ baseUrl: CFG.baseUrl, hostHeader: CFG.hostHeader });
    expect(ok.body).toEqual({ ok: true, equity: '10017.5', positions: 1 });
    up = false;
    expect((await request(app).post('/api/integrations/fxcmgr/test').set(auth).send({ baseUrl: CFG.baseUrl, hostHeader: '' })).status).toBe(502);
  });
});
