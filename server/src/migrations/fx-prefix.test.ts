import { describe, expect, it } from 'vitest';
import { planCreateSchema } from '@trading/shared';
import { createMemoryStore } from '../store/memory';
import { migrateFxPrefix } from './fx-prefix';

const now = '2026-11-27T00:00:00.000Z';

async function seed() {
  const store = createMemoryStore();
  const plan = await store.plans.create({ ...planCreateSchema.parse({ symbol: 'NASDAQ:AAPL' }), symbol: 'FXCM:EURUSD', createdAt: now, updatedAt: now });
  await store.ideas.create({ symbol: 'FXCM:GBPJPY', title: 't', body: '', tags: [], status: 'raw', dropReason: '', remindAt: null, planId: null, createdAt: now, updatedAt: now });
  await store.ideas.create({ symbol: 'NASDAQ:AAPL', title: 't', body: '', tags: [], status: 'raw', dropReason: '', remindAt: null, planId: null, createdAt: now, updatedAt: now });
  await store.assets.upsert('FXCM:EURUSD', { symbol: 'FXCM:EURUSD', levels: [{ price: '1.09', label: 'R', alert: false }], summary: 's', updatedAt: now });
  const assetNote = await store.notes.create({ parentKind: 'asset', parentId: 'FXCM:EURUSD', parentKey: 'asset:FXCM:EURUSD', symbol: 'FXCM:EURUSD', body: 'b', createdAt: now, updatedAt: now });
  const planNote = await store.notes.create({ parentKind: 'plan', parentId: plan.id, parentKey: `plan:${plan.id}`, symbol: 'FXCM:EURUSD', body: 'b', createdAt: now, updatedAt: now });
  const shot = await store.screenshots.upsert('s1', {
    parentKind: 'asset', parentId: 'FXCM:EURUSD', parentKey: 'asset:FXCM:EURUSD', symbol: 'FXCM:EURUSD',
    phase: 'before', caption: '', source: 'upload', tvUrl: null, file: null, createdAt: now,
  });
  return { store, plan, assetNote, planNote, shot };
}

describe('FXCM: → FX: migration', () => {
  it('dry run counts without writing', async () => {
    const { store, plan } = await seed();
    const r = await migrateFxPrefix(store, { dryRun: true });
    expect(r).toEqual({ ideas: 1, plans: 1, notes: 2, screenshots: 1, assets: 1, conflicts: [] });
    expect((await store.plans.get(plan.id))!.symbol).toBe('FXCM:EURUSD');
  });

  it('rewrites symbols, re-keys asset docs and re-parents their notes and screenshots; idempotent', async () => {
    const { store, plan, assetNote, planNote, shot } = await seed();
    await migrateFxPrefix(store);
    expect((await store.plans.get(plan.id))!.symbol).toBe('FX:EURUSD');
    expect((await store.ideas.list()).map((i) => i.symbol).sort()).toEqual(['FX:GBPJPY', 'NASDAQ:AAPL']);
    expect(await store.assets.get('FXCM:EURUSD')).toBeNull();
    expect(await store.assets.get('FX:EURUSD')).toMatchObject({ symbol: 'FX:EURUSD', summary: 's', levels: [{ price: '1.09', label: 'R', alert: false }] });
    expect(await store.notes.get(assetNote.id)).toMatchObject({ parentId: 'FX:EURUSD', parentKey: 'asset:FX:EURUSD', symbol: 'FX:EURUSD' });
    expect(await store.notes.get(planNote.id)).toMatchObject({ parentId: plan.id, parentKey: `plan:${plan.id}`, symbol: 'FX:EURUSD' });
    expect(await store.screenshots.get(shot.id)).toMatchObject({ parentId: 'FX:EURUSD', parentKey: 'asset:FX:EURUSD', symbol: 'FX:EURUSD' });
    expect(await migrateFxPrefix(store)).toEqual({ ideas: 0, plans: 0, notes: 0, screenshots: 0, assets: 0, conflicts: [] });
  });

  it('leaves an asset that exists under both prefixes for manual merge', async () => {
    const { store, assetNote } = await seed();
    await store.assets.upsert('FX:EURUSD', { symbol: 'FX:EURUSD', levels: [], summary: 'new', updatedAt: now });
    const r = await migrateFxPrefix(store);
    expect(r.conflicts).toEqual(['FXCM:EURUSD']);
    expect(await store.assets.get('FXCM:EURUSD')).not.toBeNull();
    expect(await store.notes.get(assetNote.id)).toMatchObject({ parentId: 'FXCM:EURUSD', symbol: 'FX:EURUSD' });
  });
});
