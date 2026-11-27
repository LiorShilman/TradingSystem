import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { ACTIVE_PLAN_STATUSES } from '@trading/shared';
import { startFxScheduler } from './fx';
import type { QuoteHub } from './quotes';
import { Telegram, makeTelegramApi } from './telegram';
import { connectFirestore, createFirestoreStore } from './store/firestore';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = createFirestoreStore(connectFirestore(config));
const telegram = new Telegram(config.telegramToken ? makeTelegramApi(config.telegramToken) : null, store);
const app = createApp(store, {
  adminKey: config.adminKey,
  filesDir: path.join(config.dataDir, 'screenshots'),
  brokerDefaults: { fxcmgrUrl: config.fxcmgrUrl, fxcmgrHost: config.fxcmgrHost },
  telegram,
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${config.port} (project ${config.firebaseProjectId})`);
  startFxScheduler(store); // FXCM every 5 min, public sources every 3 hours
  // Watchlist + active-plan symbols every 20s → live tiles and sparklines.
  (app.locals.quoteHub as QuoteHub).startSampler(async () => {
    const plans = await store.plans.list();
    return plans.filter((p) => ACTIVE_PLAN_STATUSES.includes(p.status)).map((p) => p.symbol);
  });
});
