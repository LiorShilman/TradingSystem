// One-off: FXCM:XXX → FX:XXX in Firestore. Writes a JSON backup first. Prints counts only.
// Usage: npm run migrate:fx-prefix -w server            (dry run)
//        npm run migrate:fx-prefix -w server -- --apply
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import { migrateFxPrefix } from '../migrations/fx-prefix';
import { connectFirestore, createFirestoreStore } from '../store/firestore';

const apply = process.argv.includes('--apply');
const config = loadConfig();
const store = createFirestoreStore(connectFirestore(config));

const backup = {
  takenAt: new Date().toISOString(),
  ideas: await store.ideas.list(),
  plans: await store.plans.list(),
  notes: await store.notes.list(),
  screenshots: await store.screenshots.list(),
  assets: await store.assets.list(),
};
const dir = path.join(config.dataDir, 'backups');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `before-fx-prefix-${backup.takenAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`גיבוי: ${file}`);

const report = await migrateFxPrefix(store, { dryRun: !apply });
console.log(apply ? 'בוצע:' : 'הרצת ניסיון (בלי שינוי). להרצה אמיתית הוסף --apply:', report);
process.exit(0);
