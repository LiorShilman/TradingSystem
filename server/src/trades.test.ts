import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Trade } from '@trading/shared';
import { AlertEngine } from './alerts';
import { createApp } from './app';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/types';
import { Telegram, type TelegramApi } from './telegram';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-trades-${process.pid}`);
const T0 = Date.parse('2026-11-27T08:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

let store: Store;
let app: ReturnType<typeof createApp>;
let accountId: string;
let fillN = 0;
const fill = (kind: 'entry' | 'exit', price: string, quantity: string, min: number, extra: Record<string, unknown> = {}) => ({ id: `f${++fillN}`, kind, price, quantity, at: at(min), ...extra });

beforeEach(async () => {
  store = createMemoryStore();
  app = createApp(store, { adminKey: KEY, filesDir: TMP });
  accountId = (await request(app).post('/api/accounts').set(auth).send({ name: 'בדיקת יומן', kind: 'demo', baseCurrency: 'USD' }).expect(201)).body.id;
  await request(app).post('/api/cashflows').set(auth).send({ accountId, type: 'deposit', amount: '10000', occurredAt: at(-60) }).expect(201);
});

const balance = async () => (await request(app).get(`/api/accounts/${accountId}`).set(auth)).body.balance as string;

async function readyPlan() {
  return (
    await request(app)
      .post('/api/plans')
      .set(auth)
      .send({ symbol: 'FX:EURUSD', accountId, entryLow: '1.0800', stopLoss: '1.0780', targets: [{ price: '1.0840', sizePct: '100' }], status: 'ready' })
      .expect(201)
  ).body as { id: string };
}

describe('journal — the acceptance flow', () => {
  it('plan → trade with scale in/out → closed, $296 net, 1.2R, 2.96%, balance $10,296', async () => {
    const plan = await readyPlan();
    const created = await request(app)
      .post('/api/trades')
      .set(auth)
      .send({ symbol: 'FX:EURUSD', accountId, planId: plan.id, direction: 'long', initialStop: '1.0780', targets: [{ price: '1.0840', sizePct: '100' }], fills: [fill('entry', '1.0800', '50000', 0), fill('entry', '1.0810', '50000', 5)] });
    expect(created.status).toBe(201);
    const t = created.body as Trade;
    expect(t).toMatchObject({ status: 'open', currency: 'USD', equityAtEntry: '10000', netPnl: '0', r: null });
    expect((await request(app).get(`/api/plans/${plan.id}`).set(auth)).body.status).toBe('opened');
    const planNotes = (await request(app).get(`/api/notes?parentKind=plan&parentId=${plan.id}`).set(auth)).body;
    expect(planNotes[0].body).toContain('נפתחה עסקה');

    const closed = await request(app)
      .patch(`/api/trades/${t.id}`)
      .set(auth)
      .send({ fills: [...t.fills, fill('exit', '1.0845', '50000', 60), fill('exit', '1.0825', '50000', 90, { fee: '4' })] });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', closedAt: at(90), netPnl: '296', r: '1.2' });
    expect(closed.body.fills.filter((f: { kind: string }) => f.kind === 'exit').map((f: { pnl: string }) => f.pnl)).toEqual(['200', '100']);
    expect(await balance()).toBe('10296');

    // Filters and order.
    expect((await request(app).get(`/api/trades?planId=${plan.id}`).set(auth)).body).toHaveLength(1);
    expect((await request(app).get(`/api/trades?accountId=${accountId}`).set(auth)).body).toHaveLength(1);

    // Deleting the trade takes its P&L out of the balance.
    await request(app).delete(`/api/trades/${t.id}`).set(auth).expect(204);
    expect(await balance()).toBe('10000');
  });

  it('broker P&L entered by hand is kept; editing other fields does not recompute it', async () => {
    const t = (
      await request(app)
        .post('/api/trades')
        .set(auth)
        .send({ symbol: 'FX:EURUSD', accountId, direction: 'long', initialStop: '1.0780', fills: [fill('entry', '1.0800', '10000', 0), fill('exit', '1.0820', '10000', 30, { pnl: '19.5', pnlManual: true })] })
    ).body as Trade;
    expect(t.netPnl).toBe('19.5');
    const after = (await request(app).patch(`/api/trades/${t.id}`).set(auth).send({ lesson: 'יצאתי מוקדם', followedPlan: 'partial' })).body as Trade;
    expect(after).toMatchObject({ netPnl: '19.5', lesson: 'יצאתי מוקדם', followedPlan: 'partial', planId: null });
    expect(await balance()).toBe('10019.5');
  });
});

describe('journal — guards', () => {
  it('exit larger than open → 409 with a Hebrew reason; account with trades cannot be deleted', async () => {
    const bad = await request(app)
      .post('/api/trades')
      .set(auth)
      .send({ symbol: 'FX:EURUSD', accountId, direction: 'long', initialStop: '1.0780', fills: [fill('entry', '1.0800', '1000', 0), fill('exit', '1.0810', '2000', 1)] });
    expect(bad.status).toBe(409);
    expect(bad.body.details).toContain('יציאה בכמות גדולה מהכמות הפתוחה באותו רגע');

    await request(app).post('/api/trades').set(auth).send({ symbol: 'FX:EURUSD', accountId, direction: 'long', initialStop: '1.0780', fills: [fill('entry', '1.0800', '1000', 0)] }).expect(201);
    expect((await request(app).delete(`/api/accounts/${accountId}`).set(auth)).status).toBe(409);
    expect((await request(app).post('/api/trades').set(auth).send({ symbol: 'FX:EURUSD', accountId: 'nope', direction: 'long', initialStop: '1', fills: [fill('entry', '1.08', '1', 0)] })).status).toBe(404);
  });
});

describe('journal — export', () => {
  it('JSON export includes trades; CSV opens in Excel (BOM, Hebrew header, formula-safe)', async () => {
    await request(app)
      .post('/api/trades')
      .set(auth)
      .send({ symbol: 'FX:EURUSD', accountId, direction: 'long', initialStop: '1.0780', lesson: '=HYPERLINK("x")', fills: [fill('entry', '1.0800', '10000', 0), fill('exit', '1.0820', '10000', 30)] })
      .expect(201);
    const json = (await request(app).get('/api/export').set(auth)).body;
    expect(json.version).toBe(3);
    expect(json.trades).toHaveLength(1);

    const csv = await request(app).get('/api/export/trades.csv').set(auth).buffer(true).parse((res, cb) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (s += c));
      res.on('end', () => cb(null, s));
    });
    const text = csv.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, row] = text.slice(1).split('\r\n');
    expect(header).toContain('רווח נטו');
    expect(row).toContain('בדיקת יומן');
    expect(row).toContain('20'); // net P&L
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('journal — open-trade alerts', () => {
  it('target, approaching the stop, stop — each once; note on the trade', async () => {
    const sent: string[] = [];
    const api: TelegramApi = async (method, body) => {
      if (method === 'sendMessage') sent.push(String(body?.text));
      return {};
    };
    const telegram = new Telegram(api, store);
    await store.telegram.set({ chatId: '1', name: 'Lior', connectedAt: at(0) });
    const t = (
      await request(app)
        .post('/api/trades')
        .set(auth)
        .send({ symbol: 'FX:EURUSD', accountId, direction: 'long', initialStop: '1.0780', targets: [{ price: '1.0840', sizePct: '100' }], fills: [fill('entry', '1.0800', '10000', 0)] })
    ).body as Trade;
    const engine = new AlertEngine(store, telegram);
    expect(await engine.watchedSymbols()).toContain('FX:EURUSD');
    const q = (price: string) => ({ 'FX:EURUSD': { price, at: at(1), source: 'fxcmgr' as const } });

    for (const px of ['1.0810', '1.0841', '1.0842', '1.0788', '1.0787', '1.0779']) await engine.onQuotes(q(px));
    expect(sent.map((s) => s.split('\n')[0])).toEqual([
      '🎯 <b>FX:EURUSD</b> הגיע ליעד TP1 (1.0840)',
      '⚠️ <b>FX:EURUSD</b> מתקרב לסטופ 1.0780',
      '🔴 <b>FX:EURUSD</b> הגיע לסטופ 1.0780',
    ]);
    const log = await store.alerts.list();
    expect(log.every((a) => a.tradeId === t.id)).toBe(true);
    expect((await store.notes.list({ field: 'parentKey', value: `trade:${t.id}` })).length).toBe(3);
  });
});
