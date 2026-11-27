import express from 'express';
import { AlertEngine } from './alerts';
import type { FxcmgrClient } from './broker';
import { FileStore, type BinaryFetcher } from './files';
import type { Fetcher } from './fx';
import { adminAuth, errorHandler } from './http';
import { accountsRouter } from './routes/accounts';
import { alertsRouter, webhookRouter } from './routes/alerts';
import { brokerRouter, type BrokerDefaults } from './routes/broker';
import { cashflowsRouter } from './routes/cashflows';
import { exportRouter } from './routes/export';
import { fxRouter } from './routes/fx';
import { filesRouter, planningRouter } from './routes/planning';
import { QuoteHub } from './quotes';
import type { TvQuoteClient } from './tradingview';
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
  webhookSecret?: string | null;
  publicUrl?: string | null;
  webhookUrl?: string | null;
  /** TradingView price fallback for pairs FXCM doesn't update. Off unless given (tests stay offline). */
  tvQuoteClient?: TvQuoteClient | null;
}

export function createApp(store: Store, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // behind IIS on the same machine
  app.use(express.json({ limit: '1mb' }));

  const files = new FileStore(opts.filesDir, opts.adminKey);
  const quoteHub = new QuoteHub(store, { fxcmgr: opts.fxcmgrClient, tv: opts.tvQuoteClient });
  app.locals.quoteHub = quoteHub;
  const telegram = opts.telegram ?? new Telegram(null, store);
  const alertEngine = new AlertEngine(store, telegram, { publicUrl: opts.publicUrl, isLive: (s) => quoteHub.isLive(s) });
  app.locals.alertEngine = alertEngine;
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
  // Public, secret in the body: TradingView alerts.
  api.use(webhookRouter(alertEngine, opts.webhookSecret ?? null));

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
  // Any change to plans/ideas/assets → the alert engine reloads its cached copy.
  api.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => alertEngine.invalidate());
    next();
  });
  api.use(planningRouter(store, files, opts.binaryFetcher));
  api.use('/alerts', alertsRouter(store, alertEngine, { secret: opts.webhookSecret ?? null, publicUrl: opts.publicUrl ?? null, webhookUrl: opts.webhookUrl ?? null }));
  api.use('/telegram', telegramRouter(store, telegram));
  api.use('/export', exportRouter(store));
  api.use((_req, res) => {
    res.status(404).json({ error: 'נתיב לא קיים' });
  });

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
