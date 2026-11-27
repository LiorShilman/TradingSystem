import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AdvisorSessionView } from '@trading/shared';
import { createApp } from './app';
import type { FxcmgrClient } from './broker';
import type { AdvisorModel } from './routes/advisor';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-advisor-${process.pid}`);

// FXCM bridge: gold candles for every timeframe, a live price, no CFD spec.
const candles = Array.from({ length: 30 }, (_, i) => ({ t: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, o: 3600 + i, h: 3610 + i, l: 3590 + i, c: 3605 + i, v: 1000 }));
const fxcmgr: FxcmgrClient = async (_cfg, p, body) => {
  if (p === '/subscribe') {
    if (body === 'pairs=XAU/USD') return { pairs: [{ Updated: 0, Rates: [3634.5] }] };
    throw new Error('unknown');
  }
  if (body.startsWith('models=Candles:XAU/USD:')) return { instrument: 'XAU/USD', candles };
  return { error: 'not found' };
};

function setup(model: AdvisorModel | null) {
  const store = createMemoryStore();
  const app = createApp(store, { adminKey: KEY, filesDir: TMP, fxcmgrClient: fxcmgr, advisorModel: model });
  return { store, app };
}

async function waitReady(app: ReturnType<typeof setup>['app'], id: string): Promise<AdvisorSessionView> {
  for (let i = 0; i < 50; i++) {
    const v = (await request(app).get(`/api/advisor/sessions/${id}`).set(auth)).body as AdvisorSessionView;
    if (v.status !== 'thinking') return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('still thinking');
}

describe('chart advisor', () => {
  it('first question: real candles, plan, account and the screenshot reach the model; follow-up replays the answer', async () => {
    const seen: Parameters<AdvisorModel>[0][] = [];
    const model: AdvisorModel = async (req, onText) => {
      seen.push(structuredClone(req));
      onText('## קריאת');
      onText(' המצב');
      return { content: [{ type: 'text', text: `תשובה ${seen.length}` }], text: `תשובה ${seen.length}`, stopReason: 'end_turn' };
    };
    const { app } = setup(model);
    const acc = (await request(app).post('/api/accounts').set(auth).send({ name: 'FXCM', kind: 'forex', baseCurrency: 'USD', integration: { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' } })).body;
    await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '5000', occurredAt: '2026-11-01T00:00:00.000Z' }).expect(201);
    const plan = (await request(app).post('/api/plans').set(auth).send({ symbol: 'FX:XAUUSD', accountId: acc.id, direction: 'long', entryLow: '3620', entryHigh: '3625', stopLoss: '3600', targets: [{ price: '3680', sizePct: '100' }], riskPct: '1' })).body;

    const start = await request(app)
      .post('/api/advisor/sessions')
      .set(auth)
      .send({ symbol: 'FX:XAUUSD', planId: plan.id, image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' }, question: 'שוקל לונג מ-3620' })
      .expect(201);
    const v = await waitReady(app, start.body.id);
    expect(v.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'שוקל לונג מ-3620'],
      ['assistant', 'תשובה 1'],
    ]);
    expect(v.included).toEqual(expect.arrayContaining(['נרות D1 · H4 · H1 מ-FXCM', 'התוכנית (קנייה)', 'חשבון: FXCM', 'צילום הגרף']));

    const first = seen[0]!.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(first[0]!.type).toBe('image'); // screenshot first
    const data = first[1]!.text!;
    expect(data).toContain('Current price: 3634.5 (FXCM');
    expect(data).toContain('Candles D1 (FXCM XAU/USD, bid, 30 candles');
    expect(data).toContain('ATR(14) 20'); // h-l = 20 each
    expect(data).toContain('entry 3620–3625; stop 3600; targets 3680 (100%); risk 1% of the account');
    expect(data).toContain("the plan's risk = 50 USD");
    expect(first[2]!.text).toBe('My question:\nשוקל לונג מ-3620');

    await request(app).post(`/api/advisor/sessions/${v.id}/messages`).set(auth).send({ question: 'ואם אחכה לסגירה מעל 3640?' }).expect(200);
    const v2 = await waitReady(app, v.id);
    expect(v2.turns).toHaveLength(4);
    const msgs = seen[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]!.content).toEqual([{ type: 'text', text: 'תשובה 1' }]); // replayed unchanged
  });

  it('a symbol FXCM has no candles for says so; a model error drops the question and reports it', async () => {
    let fail = true;
    const model: AdvisorModel = async () => {
      if (fail) throw new Error('boom');
      return { content: [{ type: 'text', text: 'ok' }], text: 'ok', stopReason: 'end_turn' };
    };
    const { app } = setup(model);
    const s = (await request(app).post('/api/advisor/sessions').set(auth).send({ symbol: 'CME_MINI:ES1!', question: 'מה דעתך?' }).expect(201)).body;
    const v = await waitReady(app, s.id);
    expect(v.included).toContain('אין נרות לנכס הזה (לא מ-FXCM) — הניתוח לפי הצילום והמחיר');
    expect(v).toMatchObject({ status: 'error', error: 'boom', turns: [] });
    fail = false;
  });

  it('no API key → 503 with a clear message; unknown session → 404', async () => {
    const { app } = setup(null);
    expect((await request(app).get('/api/advisor/status').set(auth)).body).toEqual({ enabled: false, model: 'claude-opus-5-5' });
    const r = await request(app).post('/api/advisor/sessions').set(auth).send({ symbol: 'FX:XAUUSD', question: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('ANTHROPIC_API_KEY');
    expect((await request(app).get('/api/advisor/sessions/nope').set(auth)).status).toBe(404);
  });
});
