import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import {
  ACTIVE_PLAN_STATUSES,
  COMPLETE_PLAN_STATUSES,
  NOTE_PARENT_KINDS,
  PARENT_KINDS,
  assetDocId,
  assetPutSchema,
  ideaCreateSchema,
  ideaIssues,
  ideaPatchSchema,
  normalizeSymbol,
  noteCreateSchema,
  notePatchSchema,
  nowUtcIso,
  parentKey,
  planCreateSchema,
  planIssues,
  planPatchSchema,
  shotMetaSchema,
  shotPatchSchema,
  type AssetDoc,
  type Idea,
  type Note,
  type ParentKind,
  type Plan,
} from '@trading/shared';
import { z } from 'zod';
import { FileStore, MAX_IMAGE_BYTES, fetchTradingViewImage, tradingViewSnapshotId, type BinaryFetcher } from '../files';
import { HttpError, notFound, parse } from '../http';
import type { Store, StoredScreenshot } from '../store/types';

const byUpdatedDesc = <T extends { updatedAt: string }>(a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);

/** 409 with the list of problems, so the client can show them. */
class IssuesError extends HttpError {
  constructor(issues: string[]) {
    super(409, issues.join(' · '), issues);
  }
}

export function planningRouter(store: Store, files: FileStore, binFetcher?: BinaryFetcher) {
  const r = Router();

  // ---------- cascade helpers ----------
  async function deleteChildren(kind: ParentKind, id: string) {
    const key = parentKey(kind, id);
    for (const n of await store.notes.list({ field: 'parentKey', value: key })) {
      await deleteChildren('note', n.id);
      await store.notes.delete(n.id);
    }
    for (const s of await store.screenshots.list({ field: 'parentKey', value: key })) {
      await files.remove(s);
      await store.screenshots.delete(s.id);
    }
  }

  /** Expired plans are marked lazily on read. */
  async function expireIfDue(p: Plan): Promise<Plan> {
    if (p.expiresAt && ACTIVE_PLAN_STATUSES.includes(p.status) && p.expiresAt < nowUtcIso()) {
      return (await store.plans.update(p.id, { status: 'expired', updatedAt: nowUtcIso() })) ?? p;
    }
    return p;
  }

  // ---------- ideas ----------
  r.get('/ideas', async (req, res) => {
    const sym = typeof req.query.symbol === 'string' ? normalizeSymbol(req.query.symbol) : null;
    const list = await store.ideas.list(sym ? { field: 'symbol', value: sym } : undefined);
    res.json(list.sort(byUpdatedDesc));
  });

  r.get('/ideas/:id', async (req, res) => {
    const i = await store.ideas.get(req.params.id);
    if (!i) throw notFound('הרעיון');
    res.json(i);
  });

  r.post('/ideas', async (req, res) => {
    const input = parse(ideaCreateSchema, req.body);
    const issues = ideaIssues(input);
    if (issues.length) throw new IssuesError(issues);
    const now = nowUtcIso();
    res.status(201).json(await store.ideas.create({ ...input, createdAt: now, updatedAt: now } satisfies Omit<Idea, 'id'>));
  });

  r.patch('/ideas/:id', async (req, res) => {
    const patch = parse(ideaPatchSchema, req.body);
    const cur = await store.ideas.get(req.params.id);
    if (!cur) throw notFound('הרעיון');
    const issues = ideaIssues({ ...cur, ...patch });
    if (issues.length) throw new IssuesError(issues);
    res.json(await store.ideas.update(cur.id, { ...patch, updatedAt: nowUtcIso() }));
  });

  r.delete('/ideas/:id', async (req, res) => {
    const cur = await store.ideas.get(req.params.id);
    if (!cur) throw notFound('הרעיון');
    await deleteChildren('idea', cur.id);
    await store.ideas.delete(cur.id);
    res.status(204).end();
  });

  // Idea → draft plan (keeps the idea and links both ways).
  r.post('/ideas/:id/to-plan', async (req, res) => {
    const idea = await store.ideas.get(req.params.id);
    if (!idea) throw notFound('הרעיון');
    if (idea.planId && (await store.plans.get(idea.planId))) throw new HttpError(409, 'לרעיון כבר יש תוכנית');
    const wanted = typeof req.body?.accountId === 'string' ? req.body.accountId : null;
    const accountId = wanted && (await store.accounts.get(wanted)) ? wanted : null; // the active account, when sent
    const now = nowUtcIso();
    const plan = await store.plans.create({
      ...planCreateSchema.parse({ symbol: idea.symbol, ideaId: idea.id, tags: idea.tags, entryConditions: idea.title, accountId }),
      createdAt: now,
      updatedAt: now,
    } satisfies Omit<Plan, 'id'>);
    await store.ideas.update(idea.id, { planId: plan.id, status: 'ready', updatedAt: now });
    res.status(201).json(plan);
  });

  // ---------- plans ----------
  r.get('/plans', async (req, res) => {
    const sym = typeof req.query.symbol === 'string' ? normalizeSymbol(req.query.symbol) : null;
    const list = await store.plans.list(sym ? { field: 'symbol', value: sym } : undefined);
    res.json((await Promise.all(list.map(expireIfDue))).sort(byUpdatedDesc));
  });

  r.get('/plans/:id', async (req, res) => {
    const p = await store.plans.get(req.params.id);
    if (!p) throw notFound('התוכנית');
    res.json(await expireIfDue(p));
  });

  r.post('/plans', async (req, res) => {
    const input = parse(planCreateSchema, req.body);
    if (COMPLETE_PLAN_STATUSES.includes(input.status)) {
      const issues = planIssues(input);
      if (issues.length) throw new IssuesError(issues);
    }
    const now = nowUtcIso();
    res.status(201).json(await store.plans.create({ ...input, createdAt: now, updatedAt: now } satisfies Omit<Plan, 'id'>));
  });

  r.patch('/plans/:id', async (req, res) => {
    const patch = parse(planPatchSchema, req.body);
    const cur = await store.plans.get(req.params.id);
    if (!cur) throw notFound('התוכנית');
    const merged = { ...cur, ...patch };
    // A plan can be saved incomplete as a draft, but can't be marked ready/waiting/opened.
    if (COMPLETE_PLAN_STATUSES.includes(merged.status)) {
      const issues = planIssues(merged);
      if (issues.length) throw new IssuesError(issues);
    }
    res.json(await store.plans.update(cur.id, { ...patch, updatedAt: nowUtcIso() }));
  });

  r.delete('/plans/:id', async (req, res) => {
    const cur = await store.plans.get(req.params.id);
    if (!cur) throw notFound('התוכנית');
    await deleteChildren('plan', cur.id);
    if (cur.ideaId) {
      const idea = await store.ideas.get(cur.ideaId);
      if (idea?.planId === cur.id) await store.ideas.update(idea.id, { planId: null, updatedAt: nowUtcIso() });
    }
    await store.plans.delete(cur.id);
    res.status(204).end();
  });

  // ---------- notes ----------
  r.get('/notes', async (req, res) => {
    const q = z.object({ parentKind: z.enum(NOTE_PARENT_KINDS), parentId: z.string().min(1) }).parse(req.query);
    const list = await store.notes.list({ field: 'parentKey', value: parentKey(q.parentKind, q.parentId) });
    res.json(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  r.post('/notes', async (req, res) => {
    const input = parse(noteCreateSchema, req.body);
    const now = nowUtcIso();
    const note = await store.notes.create({
      ...input,
      parentKey: parentKey(input.parentKind, input.parentId),
      createdAt: now,
      updatedAt: now,
    } satisfies Omit<Note, 'id'>);
    res.status(201).json(note);
  });

  r.patch('/notes/:id', async (req, res) => {
    const { body } = parse(notePatchSchema, req.body);
    const n = await store.notes.update(req.params.id, { body, updatedAt: nowUtcIso() });
    if (!n) throw notFound('ההערה');
    res.json(n);
  });

  r.delete('/notes/:id', async (req, res) => {
    const n = await store.notes.get(req.params.id);
    if (!n) throw notFound('ההערה');
    await deleteChildren('note', n.id);
    await store.notes.delete(n.id);
    res.status(204).end();
  });

  // ---------- screenshots ----------
  r.get('/screenshots', async (req, res) => {
    const q = z.object({ parentKind: z.enum(PARENT_KINDS).optional(), parentId: z.string().optional(), symbol: z.string().optional() }).parse(req.query);
    let list: StoredScreenshot[];
    if (q.parentKind && q.parentId) list = await store.screenshots.list({ field: 'parentKey', value: parentKey(q.parentKind, q.parentId) });
    else if (q.symbol) list = await store.screenshots.list({ field: 'symbol', value: normalizeSymbol(q.symbol) });
    else throw new HttpError(400, 'חסר parentKind+parentId או symbol');
    res.json(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => files.withUrls(s)));
  });

  // Raw image body; metadata in the query string.
  r.post(
    '/screenshots',
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const meta = parse(shotMetaSchema, req.query);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'לא התקבלה תמונה');
      const id = randomUUID().replace(/-/g, '');
      let file;
      try {
        file = await files.save(id, req.body);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'שמירת התמונה נכשלה');
      }
      const doc = await store.screenshots.upsert(id, {
        ...meta,
        parentKey: parentKey(meta.parentKind, meta.parentId),
        source: 'upload',
        tvUrl: null,
        file,
        createdAt: nowUtcIso(),
      });
      res.status(201).json(files.withUrls(doc));
    },
  );

  // TradingView snapshot link: keep the link, and a local copy when it can be downloaded.
  r.post('/screenshots/tradingview', async (req, res) => {
    const { url, ...rest } = z.object({ url: z.string().trim().max(500) }).passthrough().parse(req.body);
    const meta = parse(shotMetaSchema, rest);
    if (!tradingViewSnapshotId(url)) throw new HttpError(400, 'זה לא נראה כמו קישור snapshot של TradingView (tradingview.com/x/...)');
    const id = randomUUID().replace(/-/g, '');
    let file = null;
    const buf = await fetchTradingViewImage(url, binFetcher);
    if (buf) {
      try {
        file = await files.save(id, buf);
      } catch {
        file = null;
      }
    }
    const doc = await store.screenshots.upsert(id, {
      ...meta,
      parentKey: parentKey(meta.parentKind, meta.parentId),
      source: 'tradingview',
      tvUrl: url,
      file,
      createdAt: nowUtcIso(),
    });
    res.status(201).json(files.withUrls(doc));
  });

  r.patch('/screenshots/:id', async (req, res) => {
    const patch = parse(shotPatchSchema, req.body);
    const s = await store.screenshots.update(req.params.id, patch);
    if (!s) throw notFound('הצילום');
    res.json(files.withUrls(s));
  });

  r.delete('/screenshots/:id', async (req, res) => {
    const s = await store.screenshots.get(req.params.id);
    if (!s) throw notFound('הצילום');
    await files.remove(s);
    await store.screenshots.delete(s.id);
    res.status(204).end();
  });

  // ---------- assets ----------
  // Every symbol that has ideas, plans or research, with counts.
  r.get('/assets', async (_req, res) => {
    const [ideas, plans, assets] = await Promise.all([store.ideas.list(), store.plans.list(), store.assets.list()]);
    const map = new Map<string, { symbol: string; ideas: number; plans: number; activePlans: number; hasResearch: boolean; updatedAt: string }>();
    const touch = (symbol: string, updatedAt: string) => {
      const e = map.get(symbol) ?? { symbol, ideas: 0, plans: 0, activePlans: 0, hasResearch: false, updatedAt };
      if (updatedAt > e.updatedAt) e.updatedAt = updatedAt;
      map.set(symbol, e);
      return e;
    };
    ideas.forEach((i) => touch(i.symbol, i.updatedAt).ideas++);
    plans.forEach((p) => {
      const e = touch(p.symbol, p.updatedAt);
      e.plans++;
      if (ACTIVE_PLAN_STATUSES.includes(p.status)) e.activePlans++;
    });
    assets.forEach((a) => (touch(a.symbol, a.updatedAt).hasResearch = a.levels.length > 0 || a.summary.trim() !== ''));
    res.json([...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });

  r.get('/assets/:symbol', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!symbol) throw new HttpError(400, 'סימול לא תקין');
    const doc = await store.assets.get(assetDocId(symbol));
    res.json(doc ?? ({ id: assetDocId(symbol), symbol, levels: [], summary: '', updatedAt: '' } satisfies AssetDoc));
  });

  r.put('/assets/:symbol', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!symbol) throw new HttpError(400, 'סימול לא תקין');
    const input = parse(assetPutSchema, req.body);
    res.json(await store.assets.upsert(assetDocId(symbol), { ...input, symbol, updatedAt: nowUtcIso() }));
  });

  return r;
}

/** Public route (no admin key): serves files behind signed URLs. */
export function filesRouter(store: Store, files: FileStore) {
  const r = Router();
  r.get('/screenshots/:id/:variant', async (req, res) => {
    const { id, variant } = req.params;
    const { exp, sig } = req.query;
    if (typeof exp !== 'string' || typeof sig !== 'string' || !files.verify(id, variant, exp, sig)) {
      res.status(403).json({ error: 'קישור לא תקף' });
      return;
    }
    const s = await store.screenshots.get(id);
    if (!s?.file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=43200, immutable');
    res.type(variant === 'thumb' ? 'image/webp' : s.file.mime);
    res.sendFile(files.pathFor(id, variant as 'thumb' | 'full', s.file.ext), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
  return r;
}
