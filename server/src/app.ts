import express from 'express';
import type { FxcmgrClient } from './broker';
import { FileStore, type BinaryFetcher } from './files';
import type { Fetcher } from './fx';
import { adminAuth, errorHandler } from './http';
import { accountsRouter } from './routes/accounts';
import { brokerRouter, type BrokerDefaults } from './routes/broker';
import { cashflowsRouter } from './routes/cashflows';
import { exportRouter } from './routes/export';
import { fxRouter } from './routes/fx';
import { filesRouter, planningRouter } from './routes/planning';
import { QuoteHub } from './quotes';
import { quotesRouter } from './routes/quotes';
import { settingsRouter } from './routes/settings';
import { telegramRouter } from './routes/telegram';
import { Telegram } from './telegram';
import type { Store } from './store/types';

export interface AppOptions {
  adminKey: string;
  /** Where screenshots are written. */
  filesDir: string;
  fxFetcher?: Fetcher;
  fxcmgrClient?: FxcmgrClient;
  binaryFetcher?: BinaryFetcher;
  brokerDefaults?: BrokerDefaults;
  telegram?: Telegram;
}

export function createApp(store: Store, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // behind IIS on the same machine
  app.use(express.json({ limit: '1mb' }));

  const files = new FileStore(opts.filesDir, opts.adminKey);
  const quoteHub = new QuoteHub(store, opts.fxcmgrClient);
  app.locals.quoteHub = quoteHub;
  const api = express.Router();

  // Public: liveness only, no data.
  api.get('/health', async (_req, res) => {
    try {
      await store.ping();
      res.json({ ok: true, db: 'ok' });
    } catch {
      res.status(503).json({ ok: false, db: 'unreachable' });
    }
  });
  // Public but signed: images for <img> tags.
  api.use('/files', filesRouter(store, files));

  api.use(adminAuth(opts.adminKey));
  api.get('/auth/check', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(brokerRouter(store, opts.brokerDefaults ?? { fxcmgrUrl: 'http://localhost:11000', fxcmgrHost: '' }, opts.fxcmgrClient));
  api.use('/accounts', accountsRouter(store));
  api.use('/cashflows', cashflowsRouter(store));
  api.use('/settings', settingsRouter(store));
  api.use('/fx', fxRouter(store, { fetcher: opts.fxFetcher, fxcmgrClient: opts.fxcmgrClient }));
  api.use('/quotes', quotesRouter(quoteHub));
  api.use(planningRouter(store, files, opts.binaryFetcher));
  api.use('/telegram', telegramRouter(store, opts.telegram ?? new Telegram(null, store)));
  api.use('/export', exportRouter(store));
  api.use((_req, res) => {
    res.status(404).json({ error: 'נתיב לא קיים' });
  });

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
