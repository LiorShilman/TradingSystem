// Verifies the service account works and the Firestore database exists. Prints no secrets.
import { loadConfig } from '../config';
import { connectFirestore } from '../store/firestore';

const config = loadConfig();
try {
  const db = connectFirestore(config);
  await db.collection('settings').doc('main').get();
  console.log(`✅ Firestore מחובר (פרויקט ${config.firebaseProjectId}).`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_FOUND|5 NOT_FOUND/.test(msg)) {
    console.error('❌ מסד הנתונים של Firestore לא קיים. צור אותו ב-Firebase Console: Build ← Firestore Database ← Create database.');
  } else if (/PERMISSION_DENIED|7 PERMISSION_DENIED/.test(msg)) {
    console.error('❌ אין הרשאה. ודא שהקובץ שייך לפרויקט הנכון ושה-Cloud Firestore API מופעל.');
  } else {
    console.error('❌ החיבור נכשל:', msg.split('\n')[0]);
  }
  process.exit(1);
}
