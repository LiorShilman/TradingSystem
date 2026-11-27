import { Router } from 'express';
import { DEFAULT_SETTINGS, formatIsrael, nowUtcIso } from '@trading/shared';
import type { Store } from '../store/types';

export const EXPORT_VERSION = 2;

export function exportRouter(store: Store) {
  const r = Router();

  // Full JSON dump of every collection. Screenshot files themselves are on disk (ZIP export comes with backups).
  r.get('/', async (_req, res) => {
    const [accounts, cashflows, ideas, plans, notes, screenshots, assets, settings, fx] = await Promise.all([
      store.accounts.list(),
      store.cashflows.list(),
      store.ideas.list(),
      store.plans.list(),
      store.notes.list(),
      store.screenshots.list(),
      store.assets.list(),
      store.settings.get(),
      store.fx.get(),
    ]);
    const exportedAt = nowUtcIso();
    const filename = `trading-export-${formatIsrael(exportedAt, 'yyyy-MM-dd_HHmm')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      app: 'trading-system',
      version: EXPORT_VERSION,
      exportedAt,
      settings: settings ?? DEFAULT_SETTINGS,
      fx,
      accounts,
      cashflows,
      ideas,
      plans,
      notes,
      screenshots,
      assets,
    });
  });

  return r;
}
