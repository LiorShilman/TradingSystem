import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import type { AlertEngine } from './alerts';
import { startFxScheduler } from './fx';
import type { QuoteHub } from './quotes';
import { Telegram, makeTelegramApi } from './telegram';
import { defaultTvQuoteClient } from './tradingview';
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
  webhookSecret: config.webhookSecret,
  publicUrl: config.publicUrl,
  webhookUrl: config.webhookUrl,
  tvQuoteClient: defaultTvQuoteClient,
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${config.port} (project ${config.firebaseProjectId})`);
  startFxScheduler(store); // FXCM every 5 min, public sources every 3 hours
  // Watchlist + active-plan + 🔔-level symbols every 20s → live tiles, sparklines and price alerts.
  const engine = app.locals.alertEngine as AlertEngine;
  (app.locals.quoteHub as QuoteHub).startSampler(
    () => engine.watchedSymbols(),
    config.alertsEnabled ? (quotes) => engine.onQuotes(quotes) : undefined,
  );
  if (config.alertsEnabled) {
    // Idea reminders and plan expiry, every minute.
    void engine.onClock();
    setInterval(() => void engine.onClock(), 60_000).unref();
  } else {
    console.log('[alerts] מנוע ההתראות כבוי בשרת הזה (פועל רק ב-production, או ALERTS_ENABLED=true)');
  }
  if (!config.webhookSecret) console.log('[alerts] WEBHOOK_SECRET לא מוגדר — webhook של TradingView כבוי');
});
