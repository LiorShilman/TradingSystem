import { Router } from 'express';
import { refreshFx, type FxDeps } from '../fx';
import { HttpError } from '../http';
import type { Store } from '../store/types';

export function fxRouter(store: Store, deps: FxDeps = {}) {
  const r = Router();

  // Latest automatic snapshot, or null if none fetched yet.
  r.get('/', async (_req, res) => {
    res.json(await store.fx.get());
  });

  r.post('/refresh', async (_req, res) => {
    try {
      res.json(await refreshFx(store, deps));
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'רענון השערים נכשל');
    }
  });

  return r;
}
