import { Router } from 'express';
import { DEFAULT_SETTINGS, settingsSchema } from '@trading/shared';
import { parse } from '../http';
import type { Store } from '../store/types';

export function settingsRouter(store: Store) {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json((await store.settings.get()) ?? DEFAULT_SETTINGS);
  });

  r.put('/', async (req, res) => {
    const s = parse(settingsSchema, req.body);
    await store.settings.set(s);
    res.json(s);
  });

  return r;
}
