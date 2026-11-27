import { Router } from 'express';
import { fxcmgrConfigSchema } from '@trading/shared';
import { fetchFxcmgrSnapshot, type FxcmgrClient } from '../broker';
import { HttpError, notFound, parse } from '../http';
import type { Store } from '../store/types';

export interface BrokerDefaults {
  fxcmgrUrl: string;
  fxcmgrHost: string;
}

export function brokerRouter(store: Store, defaults: BrokerDefaults, client?: FxcmgrClient) {
  const r = Router();

  // Prefill for the connect form (kept in .env, not in the code/repo).
  r.get('/integrations/fxcmgr/defaults', (_req, res) => {
    res.json(defaults);
  });

  // Try a config before saving it.
  r.post('/integrations/fxcmgr/test', async (req, res) => {
    const cfg = parse(fxcmgrConfigSchema, { kind: 'fxcmgr', enabled: true, ...req.body });
    try {
      const snap = await fetchFxcmgrSnapshot(cfg, client);
      res.json({ ok: true, equity: snap.equity, positions: snap.positions.length });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'החיבור נכשל');
    }
  });

  // Live read-only snapshot for a connected account.
  r.get('/accounts/:id/broker', async (req, res) => {
    const account = await store.accounts.get(req.params.id);
    if (!account) throw notFound('החשבון');
    const cfg = account.integration;
    if (!cfg) throw new HttpError(404, 'החשבון לא מחובר לברוקר');
    if (!cfg.enabled) throw new HttpError(409, 'החיבור לברוקר כבוי');
    try {
      res.json(await fetchFxcmgrSnapshot(cfg, client));
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'FXCMgr לא זמין');
    }
  });

  return r;
}
