import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { planCreateSchema, type Plan } from '@trading/shared';
import { AlertEngine } from './alerts';
import { createApp } from './app';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/types';
import { Telegram, type TelegramApi } from './telegram';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const SECRET = 'webhook-secret-0123456789abcdef';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-alerts-${process.pid}`);
const q = (price: string) => ({ price, at: new Date().toISOString(), source: 'fxcmgr' as const });

let store: Store;
let sent: string[];
let tgDown: boolean;
let telegram: Telegram;

beforeEach(async () => {
  store = createMemoryStore();
  sent = [];
  tgDown = false;
  const api: TelegramApi = async (method, body) => {
    if (method !== 'sendMessage') return {};
    if (tgDown) throw new Error('Telegram: Bad Gateway');
    sent.push(String(body?.text));
    return {};
  };
  telegram = new Telegram(api, store);
  await store.telegram.set({ chatId: '1', name: 'Lior', connectedAt: '2026-11-27T00:00:00.000Z' });
});

async function readyPlan(over: Partial<Plan> = {}) {
  const now = '2026-11-27T00:00:00.000Z';
  return store.plans.create({
    ...planCreateSchema.parse({
      symbol: 'FX:EURUSD',
      entryLow: '1.0800',
      entryHigh: '1.0810',
      stopLoss: '1.0780',
      targets: [{ price: '1.0900', sizePct: '100' }],
      status: 'ready',
      entryConditions: 'פין בר ב-H1',
    }),
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('AlertEngine — prices', () => {
  it('zone alert → Telegram + log + timeline note; not repeated, also not after a restart', async () => {
    const plan = await readyPlan();
    const engine = new AlertEngine(store, telegram);
    await engine.onQuotes({ 'FX:EURUSD': q('1.0850') });
    await engine.onQuotes({ 'FX:EURUSD': q('1.0805') });
    await engine.onQuotes({ 'FX:EURUSD': q('1.0806') });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('נכנס לאזור הכניסה');
    expect(sent[0]).toContain('פין בר ב-H1');

    const log = await store.alerts.list();
    expect(log).toMatchObject([{ kind: 'plan_zone', planId: plan.id, symbol: 'FX:EURUSD', price: '1.0805', delivered: true, deliveryError: null }]);
    const notes = await store.notes.list({ field: 'parentKey', value: `plan:${plan.id}` });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('באזור הכניסה');
    expect((await store.plans.get(plan.id))!.status).toBe('ready'); // never changed by alerts

    const restarted = new AlertEngine(store, telegram);
    await restarted.onQuotes({ 'FX:EURUSD': q('1.0804') });
    expect(sent).toHaveLength(1);
  });

  it('skips drafts, incomplete plans, symbols without live movement, and respects the config switch', async () => {
    await readyPlan({ status: 'draft' });
    await readyPlan({ symbol: 'FX:GBPUSD' });
    const engine = new AlertEngine(store, telegram, { isLive: (s) => s !== 'FX:GBPUSD' });
    await engine.onQuotes({ 'FX:EURUSD': q('1.0805'), 'FX:GBPUSD': q('1.0805') });
    expect(sent).toHaveLength(0);

    await readyPlan();
    engine.invalidate();
    await store.alertConfig.set({ approachPips: 10, plans: false, levels: true, reminders: true, trades: true });
    await engine.onQuotes({ 'FX:EURUSD': q('1.0805') });
    expect(sent).toHaveLength(0);
  });

  it('a Telegram failure is logged, not thrown', async () => {
    await readyPlan();
    tgDown = true;
    const engine = new AlertEngine(store, telegram);
    await engine.onQuotes({ 'FX:EURUSD': q('1.0779') });
    expect(await store.alerts.list()).toMatchObject([{ kind: 'plan_stop', delivered: false, deliveryError: 'Telegram: Bad Gateway' }]);
  });

  it('🔔 levels: alert on cross only for flagged levels', async () => {
    await store.assets.upsert('FX:EURUSD', {
      symbol: 'FX:EURUSD',
      summary: '',
      updatedAt: '2026-11-27T00:00:00.000Z',
      levels: [
        { price: '1.0900', label: 'התנגדות שבועית', alert: true },
        { price: '1.0950', label: 'בלי פעמון', alert: false },
      ],
    });
    const engine = new AlertEngine(store, telegram);
    expect(await engine.watchedSymbols()).toEqual(['FX:EURUSD']);
    for (const px of ['1.0880', '1.0903', '1.0899', '1.0960']) await engine.onQuotes({ 'FX:EURUSD': q(px) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('חצה את <b>1.0900</b> (התנגדות שבועית) כלפי מעלה');
  });
});

describe('AlertEngine — clock', () => {
  it('idea reminder once per remindAt; not for dropped ideas', async () => {
    const at = new Date('2026-11-27T10:00:00.000Z');
    const base = { body: '', tags: [], dropReason: '', planId: null, createdAt: at.toISOString(), updatedAt: at.toISOString() };
    await store.ideas.create({ ...base, symbol: 'FX:EURUSD', title: 'לבדוק דאבל טופ', status: 'watching', remindAt: '2026-11-27T09:59:00.000Z' });
    await store.ideas.create({ ...base, symbol: 'FX:EURUSD', title: 'נזנח', status: 'dropped', dropReason: 'x', remindAt: '2026-11-27T09:59:00.000Z' });
    await store.ideas.create({ ...base, symbol: 'FX:EURUSD', title: 'עתידי', status: 'raw', remindAt: '2026-11-27T11:00:00.000Z' });
    const engine = new AlertEngine(store, telegram, { now: () => at });
    await engine.onClock();
    await engine.onClock();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('לבדוק דאבל טופ');
  });

  it('plan expiry: warns 2h before, then marks expired and alerts', async () => {
    let now = new Date('2026-11-27T10:00:00.000Z');
    const plan = await readyPlan({ expiresAt: '2026-11-27T11:30:00.000Z' });
    const engine = new AlertEngine(store, telegram, { now: () => now });
    await engine.onClock();
    await engine.onClock();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('פגה בעוד');
    now = new Date('2026-11-27T11:31:00.000Z');
    await engine.onClock();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('פג תוקף');
    expect((await store.plans.get(plan.id))!.status).toBe('expired');
  });
});

describe('TradingView webhook', () => {
  const app = () => createApp(store, { adminKey: KEY, filesDir: TMP, telegram, webhookSecret: SECRET });
  const wait = () => new Promise((r) => setTimeout(r, 30));

  it('rejects a wrong or missing secret and non-JSON', async () => {
    const a = app();
    expect((await request(a).post('/api/webhooks/tradingview').send({ secret: 'nope', symbol: 'FX:EURUSD' })).status).toBe(401);
    expect((await request(a).post('/api/webhooks/tradingview').send({ symbol: 'FX:EURUSD' })).status).toBe(401);
    expect((await request(a).post('/api/webhooks/tradingview').set('Content-Type', 'text/plain').send('EURUSD crossed')).status).toBe(400);
    await wait();
    expect(sent).toHaveLength(0);
  });

  it('accepts text/plain JSON (as TradingView sends), matches the active plan by symbol, notes it', async () => {
    const plan = await readyPlan({ status: 'waiting' });
    const a = app();
    const res = await request(a)
      .post('/api/webhooks/tradingview')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ secret: SECRET, symbol: 'FX:EURUSD', price: 1.0806, alert: 'חציית 1.08', message: 'EURUSD crossed 1.08' }));
    expect(res.status).toBe(200);
    await wait();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('חציית 1.08');
    expect(await store.alerts.list()).toMatchObject([{ kind: 'tv_webhook', source: 'tradingview', planId: plan.id, price: '1.0806' }]);
    const notes = await store.notes.list({ field: 'parentKey', value: `plan:${plan.id}` });
    expect(notes[0]!.body).toContain('התראת TradingView');
    expect((await store.plans.get(plan.id))!.status).toBe('waiting');
  });

  it('legacy FXCM: symbol from TradingView still matches; 503 when no secret is configured', async () => {
    await readyPlan();
    await request(app()).post('/api/webhooks/tradingview').send({ secret: SECRET, symbol: 'FXCM:EURUSD' });
    await wait();
    expect((await store.alerts.list())[0]!.planId).not.toBeNull();
    const off = createApp(store, { adminKey: KEY, filesDir: TMP, telegram });
    expect((await request(off).post('/api/webhooks/tradingview').send({ secret: SECRET })).status).toBe(503);
  });

  it('admin: log, config round-trip, webhook template', async () => {
    const a = app();
    expect((await request(a).get('/api/alerts')).status).toBe(401);
    expect((await request(a).get('/api/alerts/config').set(auth)).body).toEqual({ approachPips: 10, plans: true, levels: true, reminders: true, trades: true });
    const put = await request(a).put('/api/alerts/config').set(auth).send({ approachPips: 15, plans: true, levels: false, reminders: true });
    expect(put.status).toBe(200);
    expect((await request(a).get('/api/alerts/config').set(auth)).body.approachPips).toBe(15);
    const wh = (await request(a).get('/api/alerts/webhook?planId=abc').set(auth)).body;
    expect(wh).toMatchObject({ configured: true, path: '/api/webhooks/tradingview' });
    expect(JSON.parse(wh.template)).toMatchObject({ secret: SECRET, symbol: '{{exchange}}:{{ticker}}', planId: 'abc' });
  });
});
