import path from 'node:path';
import dotenv from 'dotenv';

// Paths in .env are relative to the server folder (the working directory under npm -w and PM2).
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

export interface Config {
  adminKey: string;
  port: number;
  firebaseProjectId: string;
  serviceAccountPath: string;
  dataDir: string;
  fxcmgrUrl: string;
  fxcmgrHost: string;
  telegramToken: string | null;
  /** TradingView webhook secret (in the alert message body). Null → webhook disabled. */
  webhookSecret: string | null;
  /** Public base URL of the app (links in Telegram, webhook URL). */
  publicUrl: string | null;
}

export function loadConfig(): Config {
  const adminKey = process.env.ADMIN_KEY ?? '';
  if (adminKey.length < 32) {
    console.error('ADMIN_KEY חסר או קצר מדי ב-server/.env. הרץ: npm run gen:admin-key');
    process.exit(1);
  }
  return {
    adminKey,
    port: Number(process.env.PORT ?? 4100),
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'trading-system-c6921',
    serviceAccountPath: path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT ?? './firebase-service-account.json'),
    dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? './data'),
    fxcmgrUrl: process.env.FXCMGR_URL ?? 'http://localhost:11000',
    fxcmgrHost: process.env.FXCMGR_HOST ?? '',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim().replace(/^["']|["']$/g, '') || null,
    webhookSecret: (process.env.WEBHOOK_SECRET?.trim().length ?? 0) >= 24 ? process.env.WEBHOOK_SECRET!.trim() : null,
    publicUrl: process.env.PUBLIC_URL?.trim() || null,
  };
}
