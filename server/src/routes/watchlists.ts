import { Router } from 'express';
import { defaultWatchlist, nowUtcIso, watchlistCreateSchema, watchlistPatchSchema, type Watchlist } from '@trading/shared';
import { HttpError, notFound, parse } from '../http';
import type { Store } from '../store/types';

const byCreated = (a: Watchlist, b: Watchlist) => a.createdAt.localeCompare(b.createdAt);

/** Every watchlist, creating the default FX list the first time (there is always at least one list). */
export async function ensureWatchlists(store: Store): Promise<Watchlist[]> {
  const list = await store.watchlists.list();
  if (list.length) return list.sort(byCreated);
  const now = nowUtcIso();
  return [await store.watchlists.create({ ...defaultWatchlist(), createdAt: now, updatedAt: now })];
}

/** Your watchlists — all editable here, independent of TradingView and of the FXCM subscription. */
export function watchlistsRouter(store: Store) {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await ensureWatchlists(store));
  });

  r.post('/', async (req, res) => {
    const input = parse(watchlistCreateSchema, req.body);
    const now = nowUtcIso();
    res.status(201).json(await store.watchlists.create({ ...input, createdAt: now, updatedAt: now } satisfies Omit<Watchlist, 'id'>));
  });

  r.patch('/:id', async (req, res) => {
    const patch = parse(watchlistPatchSchema, req.body);
    const w = await store.watchlists.update(req.params.id, { ...patch, updatedAt: nowUtcIso() });
    if (!w) throw notFound('הרשימה');
    res.json(w);
  });

  r.delete('/:id', async (req, res) => {
    const all = await store.watchlists.list();
    if (!all.some((w) => w.id === req.params.id)) throw notFound('הרשימה');
    if (all.length === 1) throw new HttpError(409, 'זו הרשימה האחרונה — אפשר לרוקן או לשנות לה שם, אבל לא למחוק');
    await store.watchlists.delete(req.params.id);
    res.status(204).end();
  });

  return r;
}
