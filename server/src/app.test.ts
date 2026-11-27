import os from 'node:os';
import path from 'node:path';
const TMP = path.join(os.tmpdir(), 'trading-test-files');
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createMemoryStore } from './store/memory';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
let app: ReturnType<typeof createApp>;
const auth = { 'x-admin-key': KEY };

beforeEach(() => {
  app = createApp(createMemoryStore(), { adminKey: KEY, filesDir: TMP });
});

async function newAccount(body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/accounts')
    .set(auth)
    .send({ name: 'IBKR', kind: 'stocks', baseCurrency: 'USD', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; balance: string };
}

describe('auth', () => {
  it('health is public', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
  it('401 without key or with wrong key', async () => {
    expect((await request(app).get('/api/accounts')).status).toBe(401);
    expect((await request(app).get('/api/accounts').set('x-admin-key', 'nope')).status).toBe(401);
    expect((await request(app).get('/api/export')).status).toBe(401);
  });
  it('200 with the right key', async () => {
    expect((await request(app).get('/api/auth/check').set(auth)).status).toBe(200);
  });
});

describe('accounts & cashflows', () => {
  it('deposit 10,000 and withdraw 1,500.25 → balance 8,499.75', async () => {
    const acc = await newAccount();
    expect(acc.balance).toBe('0');
    const at = '2026-11-27T06:00:00.000Z';
    await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '10000', occurredAt: at }).expect(201);
    const w = await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'withdrawal', amount: '1500.25', occurredAt: at }).expect(201);
    expect(w.body.currency).toBe('USD');

    let got = await request(app).get(`/api/accounts/${acc.id}`).set(auth);
    expect(got.body.balance).toBe('8499.75');

    // edit then delete the withdrawal → balance follows
    await request(app).patch(`/api/cashflows/${w.body.id}`).set(auth).send({ amount: '500' }).expect(200);
    got = await request(app).get(`/api/accounts/${acc.id}`).set(auth);
    expect(got.body.balance).toBe('9500');
    await request(app).delete(`/api/cashflows/${w.body.id}`).set(auth).expect(204);
    got = await request(app).get(`/api/accounts/${acc.id}`).set(auth);
    expect(got.body.balance).toBe('10000');
  });

  it('rejects bad input with Hebrew messages and saves nothing', async () => {
    const acc = await newAccount();
    const at = '2026-11-27T06:00:00.000Z';
    const neg = await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '-5', occurredAt: at });
    expect(neg.status).toBe(400);
    expect(neg.body.issues[0].message).toContain('חיובי');
    const empty = await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '', occurredAt: at });
    expect(empty.status).toBe(400);
    const float = await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: 10.5, occurredAt: at });
    expect(float.status).toBe(400); // numbers must arrive as decimal strings
    const noName = await request(app).post('/api/accounts').set(auth).send({ name: ' ', kind: 'stocks', baseCurrency: 'USD' });
    expect(noName.status).toBe(400);
    expect((await request(app).get('/api/cashflows').set(auth)).body).toHaveLength(0);
  });

  it('patch to negative deposit is rejected', async () => {
    const acc = await newAccount();
    const c = await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '5', occurredAt: '2026-11-27T06:00:00.000Z' });
    expect((await request(app).patch(`/api/cashflows/${c.body.id}`).set(auth).send({ amount: '-5' })).status).toBe(400);
  });

  it('cannot delete an account with movements (409), can archive it', async () => {
    const acc = await newAccount();
    await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '1', occurredAt: '2026-11-27T06:00:00.000Z' });
    expect((await request(app).delete(`/api/accounts/${acc.id}`).set(auth)).status).toBe(409);
    const arch = await request(app).patch(`/api/accounts/${acc.id}`).set(auth).send({ isArchived: true });
    expect(arch.body.isArchived).toBe(true);
    expect(arch.body.name).toBe('IBKR'); // patch did not reset other fields
  });

  it('export contains accounts, cashflows and settings', async () => {
    const acc = await newAccount();
    await request(app).post('/api/cashflows').set(auth).send({ accountId: acc.id, type: 'deposit', amount: '1', occurredAt: '2026-11-27T06:00:00.000Z' });
    const res = await request(app).get('/api/export').set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="trading-export-/);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.cashflows).toHaveLength(1);
    expect(res.body.settings.displayCurrency).toBe('ILS');
  });
});
