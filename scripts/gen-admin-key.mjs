// Creates server/.env with a random ADMIN_KEY if one is not set yet.
// Never prints the key. Open server/.env yourself to copy it.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../server/.env', import.meta.url);
let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
if (/^ADMIN_KEY=.+/m.test(content)) {
  console.log('ADMIN_KEY כבר קיים ב-server/.env — לא שיניתי כלום.');
  process.exit(0);
}
const key = randomBytes(32).toString('base64url');
const defaults = [
  `ADMIN_KEY=${key}`,
  'PORT=4100',
  'FIREBASE_PROJECT_ID=trading-system-c6921',
  'FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json',
  'DATA_DIR=./data',
];
for (const line of defaults.slice(1)) {
  const name = line.split('=')[0];
  if (!new RegExp(`^${name}=`, 'm').test(content)) content += (content && !content.endsWith('\n') ? '\n' : '') + line + '\n';
}
content = defaults[0] + '\n' + content;
writeFileSync(path, content);
console.log('נוצר מפתח admin חדש ב-server/.env (לא מוצג כאן).');
