import { randomUUID } from 'node:crypto';
import type { FxSnapshot, Settings } from '@trading/shared';
import type { TelegramLink } from '../telegram';
import type { Collection, Doc, Store } from './types';

class MemoryCollection<T extends Doc> implements Collection<T> {
  private items = new Map<string, T>();

  async list(where?: { field: keyof T & string; value: unknown }) {
    const all = [...this.items.values()];
    return structuredClone(where ? all.filter((d) => d[where.field] === where.value) : all);
  }
  async get(id: string) {
    const d = this.items.get(id);
    return d ? structuredClone(d) : null;
  }
  async create(data: Omit<T, 'id'>) {
    const doc = { ...data, id: randomUUID() } as T;
    this.items.set(doc.id, structuredClone(doc));
    return doc;
  }
  async upsert(id: string, data: Omit<T, 'id'>) {
    const doc = { ...data, id } as T;
    this.items.set(id, structuredClone(doc));
    return doc;
  }
  async update(id: string, patch: Partial<Omit<T, 'id'>>) {
    const d = this.items.get(id);
    if (!d) return null;
    const next = { ...d, ...patch };
    this.items.set(id, next);
    return structuredClone(next);
  }
  async delete(id: string) {
    return this.items.delete(id);
  }
}

export function createMemoryStore(): Store {
  let settings: Settings | null = null;
  let fx: FxSnapshot | null = null;
  let telegram: TelegramLink | null = null;
  return {
    accounts: new MemoryCollection(),
    cashflows: new MemoryCollection(),
    ideas: new MemoryCollection(),
    plans: new MemoryCollection(),
    notes: new MemoryCollection(),
    screenshots: new MemoryCollection(),
    assets: new MemoryCollection(),
    settings: {
      async get() {
        return settings ? structuredClone(settings) : null;
      },
      async set(s) {
        settings = structuredClone(s);
      },
    },
    fx: {
      async get() {
        return fx ? structuredClone(fx) : null;
      },
      async set(s) {
        fx = structuredClone(s);
      },
    },
    telegram: {
      async get() {
        return telegram ? structuredClone(telegram) : null;
      },
      async set(s) {
        telegram = s ? structuredClone(s) : null;
      },
    },
    async ping() {},
  };
}
