import { readFileSync } from 'node:fs';
import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { AlertConfig, FxSnapshot, Settings } from '@trading/shared';
import type { TelegramLink } from '../telegram';
import type { Config } from '../config';
import type { Collection, Doc, Store } from './types';

export function connectFirestore(config: Config): Firestore {
  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(readFileSync(config.serviceAccountPath, 'utf8')) as ServiceAccount;
  } catch {
    // Never echo the file contents — only where we looked.
    throw new Error(`לא הצלחתי לקרוא את קובץ ה-service account בנתיב ${config.serviceAccountPath}`);
  }
  const app = initializeApp({ credential: cert(serviceAccount), projectId: config.firebaseProjectId });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

class FirestoreCollection<T extends Doc> implements Collection<T> {
  constructor(
    private db: Firestore,
    private name: string,
  ) {}

  private get col() {
    return this.db.collection(this.name);
  }

  async list(where?: { field: keyof T & string; value: unknown }) {
    // Single equality filters only → no composite indexes needed. Sorting happens in code.
    const snap = await (where ? this.col.where(where.field, '==', where.value) : this.col).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as T);
  }
  async get(id: string) {
    const d = await this.col.doc(id).get();
    return d.exists ? ({ ...d.data(), id: d.id } as T) : null;
  }
  async create(data: Omit<T, 'id'>) {
    const ref = await this.col.add(data as FirebaseFirestore.DocumentData);
    return { ...data, id: ref.id } as T;
  }
  async upsert(id: string, data: Omit<T, 'id'>) {
    await this.col.doc(id).set(data as FirebaseFirestore.DocumentData);
    return { ...data, id } as T;
  }
  async update(id: string, patch: Partial<Omit<T, 'id'>>) {
    const ref = this.col.doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update(patch as FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>);
    return this.get(id);
  }
  async delete(id: string) {
    const ref = this.col.doc(id);
    if (!(await ref.get()).exists) return false;
    await ref.delete();
    return true;
  }
}

export function createFirestoreStore(db: Firestore): Store {
  const settingsRef = db.collection('settings').doc('main');
  const fxRef = db.collection('fx').doc('latest');
  const telegramRef = db.collection('settings').doc('telegram');
  const alertConfigRef = db.collection('settings').doc('alerts');
  return {
    accounts: new FirestoreCollection(db, 'accounts'),
    cashflows: new FirestoreCollection(db, 'cashflows'),
    ideas: new FirestoreCollection(db, 'ideas'),
    plans: new FirestoreCollection(db, 'plans'),
    trades: new FirestoreCollection(db, 'trades'),
    watchlists: new FirestoreCollection(db, 'watchlists'),
    notes: new FirestoreCollection(db, 'notes'),
    screenshots: new FirestoreCollection(db, 'screenshots'),
    assets: new FirestoreCollection(db, 'assets'),
    alerts: new FirestoreCollection(db, 'alerts'),
    alertStates: new FirestoreCollection(db, 'alertStates'),
    alertConfig: {
      async get() {
        const d = await alertConfigRef.get();
        return d.exists ? (d.data() as AlertConfig) : null;
      },
      async set(c) {
        await alertConfigRef.set(c);
      },
    },
    settings: {
      async get() {
        const d = await settingsRef.get();
        return d.exists ? (d.data() as Settings) : null;
      },
      async set(s) {
        await settingsRef.set(s);
      },
    },
    fx: {
      async get() {
        const d = await fxRef.get();
        return d.exists ? (d.data() as FxSnapshot) : null;
      },
      async set(s) {
        await fxRef.set(s);
      },
    },
    telegram: {
      async get() {
        const d = await telegramRef.get();
        return d.exists ? (d.data() as TelegramLink) : null;
      },
      async set(s) {
        if (s) await telegramRef.set(s);
        else await telegramRef.delete();
      },
    },
    async ping() {
      await settingsRef.get();
    },
  };
}
