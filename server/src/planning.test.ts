import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { BinaryFetcher } from './files';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/types';

const KEY = 'test-admin-key-0123456789abcdef0123456789';
const auth = { 'x-admin-key': KEY };
const TMP = path.join(os.tmpdir(), `trading-planning-${process.pid}`);

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#123456' } }).png().toBuffer();
});

let tvUp = true;
const binaryFetcher: BinaryFetcher = async (url) => {
  if (!tvUp) return { ok: false, contentType: 'text/html', body: Buffer.from('') };
  if (url.includes('s3.tradingview.com/snapshots/a/AbC123xy.png')) return { ok: true, contentType: 'image/png', body: png };
  return { ok: true, contentType: 'text/html', body: Buffer.from('<html></html>') };
};

let store: Store;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  tvUp = true;
  store = createMemoryStore();
  app = createApp(store, { adminKey: KEY, filesDir: TMP, binaryFetcher });
});

const COMPLETE = {
  symbol: 'eurusd',
  direction: 'long',
  entryLow: '1.0800',
  entryHigh: '1.0810',
  stopLoss: '1.0780',
  targets: [{ price: '1.0865', sizePct: '100' }],
};

describe('ideas', () => {
  it('quick capture normalizes the symbol; dropped requires a reason', async () => {
    const res = await request(app).post('/api/ideas').set(auth).send({ symbol: 'eur/usd', title: 'פריצה מעל 1.09?' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ symbol: 'FXCM:EURUSD', status: 'raw', tags: [] });
    const drop = await request(app).patch(`/api/ideas/${res.body.id}`).set(auth).send({ status: 'dropped' });
    expect(drop.status).toBe(409);
    expect(drop.body.details[0]).toContain('למה');
    expect((await request(app).patch(`/api/ideas/${res.body.id}`).set(auth).send({ status: 'dropped', dropReason: 'השוק שינה כיוון' })).status).toBe(200);
  });

  it('rejects a bad symbol', async () => {
    expect((await request(app).post('/api/ideas').set(auth).send({ symbol: 'apple', title: 'x' })).status).toBe(400);
  });

  it('idea → draft plan, linked both ways', async () => {
    const idea = (await request(app).post('/api/ideas').set(auth).send({ symbol: 'GBPUSD', title: 'דאבל בוטום', tags: ['H4'] })).body;
    const plan = await request(app).post(`/api/ideas/${idea.id}/to-plan`).set(auth);
    expect(plan.status).toBe(201);
    expect(plan.body).toMatchObject({ symbol: 'FXCM:GBPUSD', ideaId: idea.id, status: 'draft', tags: ['H4'], entryConditions: 'דאבל בוטום' });
    const after = (await request(app).get(`/api/ideas/${idea.id}`).set(auth)).body;
    expect(after).toMatchObject({ planId: plan.body.id, status: 'ready' });
    expect((await request(app).post(`/api/ideas/${idea.id}/to-plan`).set(auth)).status).toBe(409);
  });
});

describe('plans', () => {
  it('drafts may be incomplete, but "ready" requires a consistent plan', async () => {
    const draft = await request(app).post('/api/plans').set(auth).send({ symbol: 'EURUSD' });
    expect(draft.status).toBe(201);
    const ready = await request(app).patch(`/api/plans/${draft.body.id}`).set(auth).send({ status: 'ready' });
    expect(ready.status).toBe(409);
    expect(ready.body.details).toEqual(expect.arrayContaining(['חסר אזור כניסה', 'חסר סטופ לוס']));
    const fixed = await request(app).patch(`/api/plans/${draft.body.id}`).set(auth).send({ ...COMPLETE, status: 'ready' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.status).toBe('ready');
    // can't break a ready plan
    expect((await request(app).patch(`/api/plans/${draft.body.id}`).set(auth).send({ stopLoss: '1.0900' })).status).toBe(409);
  });

  it('marks expired plans on read', async () => {
    const p = await request(app).post('/api/plans').set(auth).send({ ...COMPLETE, status: 'waiting', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(p.status).toBe(201);
    expect((await request(app).get(`/api/plans/${p.body.id}`).set(auth)).body.status).toBe('expired');
  });

  it('amounts must be decimal strings', async () => {
    expect((await request(app).post('/api/plans').set(auth).send({ symbol: 'EURUSD', entryLow: 1.08 })).status).toBe(400);
  });
});

describe('notes & screenshots', () => {
  it('note timeline per plan, newest first', async () => {
    const plan = (await request(app).post('/api/plans').set(auth).send({ symbol: 'EURUSD' })).body;
    await request(app).post('/api/notes').set(auth).send({ parentKind: 'plan', parentId: plan.id, body: 'ראשונה' }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post('/api/notes').set(auth).send({ parentKind: 'plan', parentId: plan.id, body: 'שנייה' }).expect(201);
    const list = (await request(app).get(`/api/notes?parentKind=plan&parentId=${plan.id}`).set(auth)).body;
    expect(list.map((n: { body: string }) => n.body)).toEqual(['שנייה', 'ראשונה']);
    expect((await request(app).post('/api/notes').set(auth).send({ parentKind: 'plan', parentId: plan.id, body: '  ' })).status).toBe(400);
  });

  it('upload → thumbnail + signed URLs that expire; cascade delete removes files', async () => {
    const plan = (await request(app).post('/api/plans').set(auth).send({ symbol: 'EURUSD' })).body;
    const up = await request(app)
      .post(`/api/screenshots?parentKind=plan&parentId=${plan.id}&phase=before&caption=H4`)
      .set(auth)
      .set('Content-Type', 'image/png')
      .send(png);
    expect(up.status).toBe(201);
    expect(up.body.file).toMatchObject({ ext: 'png', width: 1200, height: 600 });
    expect(up.body.thumbUrl).toMatch(/^\/files\/screenshots\/.+\/thumb\?exp=\d+&sig=/);

    // served without the admin key, thanks to the signature
    const thumb = await request(app).get(`/api${up.body.thumbUrl}`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect((await sharp(thumb.body).metadata()).width).toBe(480);
    // tampered signature → 403
    expect((await request(app).get(`/api${up.body.fullUrl.replace(/sig=./, 'sig=X')}`)).status).toBe(403);

    const full = path.join(TMP, `${up.body.id}.png`);
    expect(existsSync(full)).toBe(true);
    await request(app).delete(`/api/plans/${plan.id}`).set(auth).expect(204);
    expect(existsSync(full)).toBe(false);
    expect(await store.screenshots.list()).toHaveLength(0);
  });

  it('rejects a non-image body', async () => {
    const res = await request(app).post('/api/screenshots?parentKind=plan&parentId=x').set(auth).set('Content-Type', 'image/png').send(Buffer.from('not an image'));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('אינו תמונה');
  });

  it('TradingView link: keeps the link and a local copy; link only when the image is unreachable', async () => {
    const ok = await request(app)
      .post('/api/screenshots/tradingview')
      .set(auth)
      .send({ url: 'https://www.tradingview.com/x/AbC123xy/', parentKind: 'idea', parentId: 'i1' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ source: 'tradingview', tvUrl: 'https://www.tradingview.com/x/AbC123xy/' });
    expect(ok.body.file).not.toBeNull();

    tvUp = false;
    const linkOnly = await request(app)
      .post('/api/screenshots/tradingview')
      .set(auth)
      .send({ url: 'https://www.tradingview.com/x/AbC123xy/', parentKind: 'idea', parentId: 'i1' });
    expect(linkOnly.status).toBe(201);
    expect(linkOnly.body.file).toBeNull();
    expect(linkOnly.body.thumbUrl).toBeUndefined();

    expect((await request(app).post('/api/screenshots/tradingview').set(auth).send({ url: 'https://example.com/a.png', parentKind: 'idea', parentId: 'i1' })).status).toBe(400);
  });
});

describe('assets', () => {
  it('research page per symbol + list with counts', async () => {
    await request(app).post('/api/ideas').set(auth).send({ symbol: 'EURUSD', title: 'a' });
    await request(app).post('/api/plans').set(auth).send({ symbol: 'EURUSD' });
    const put = await request(app).put('/api/assets/FXCM:EURUSD').set(auth).send({ levels: [{ price: '1.0900', label: 'התנגדות שבועית' }], summary: 'מגמה עולה' });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/assets/eurusd').set(auth)).body.levels[0].label).toBe('התנגדות שבועית');
    const list = (await request(app).get('/api/assets').set(auth)).body;
    expect(list[0]).toMatchObject({ symbol: 'FXCM:EURUSD', ideas: 1, plans: 1, activePlans: 1, hasResearch: true });
  });
});
