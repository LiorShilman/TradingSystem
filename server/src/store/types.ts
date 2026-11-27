import type { Account, AlertConfig, AlertEvent, AssetDoc, Cashflow, FxSnapshot, Idea, Note, Plan, Screenshot, Settings } from '@trading/shared';
import type { TelegramLink } from '../telegram';

export interface Doc {
  id: string;
}

/** Minimal persistence surface. Firestore in production, memory in tests. */
export interface Collection<T extends Doc> {
  list(where?: { field: keyof T & string; value: unknown }): Promise<T[]>;
  get(id: string): Promise<T | null>;
  create(data: Omit<T, 'id'>): Promise<T>;
  /** Create or replace with a chosen id. */
  upsert(id: string, data: Omit<T, 'id'>): Promise<T>;
  update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
}

/** Screenshot as stored (signed URLs are added on read). */
export type StoredScreenshot = Omit<Screenshot, 'thumbUrl' | 'fullUrl'>;

/** Alert engine memory (fired/armed flags), so a restart doesn't repeat alerts. */
export interface AlertStateDoc {
  id: string;
  data: unknown;
  updatedAt: string;
}

export interface Store {
  accounts: Collection<Account>;
  cashflows: Collection<Cashflow>;
  ideas: Collection<Idea>;
  plans: Collection<Plan>;
  notes: Collection<Note>;
  screenshots: Collection<StoredScreenshot>;
  assets: Collection<AssetDoc>;
  alerts: Collection<AlertEvent>;
  alertStates: Collection<AlertStateDoc>;
  alertConfig: {
    get(): Promise<AlertConfig | null>;
    set(c: AlertConfig): Promise<void>;
  };
  settings: {
    get(): Promise<Settings | null>;
    set(s: Settings): Promise<void>;
  };
  fx: {
    get(): Promise<FxSnapshot | null>;
    set(s: FxSnapshot): Promise<void>;
  };
  telegram: {
    get(): Promise<TelegramLink | null>;
    set(s: TelegramLink | null): Promise<void>;
  };
  /** Cheap round-trip to verify the backend is reachable. */
  ping(): Promise<void>;
}
