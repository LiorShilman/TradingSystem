import { assetDocId, parentKey } from '@trading/shared';
import type { Store } from '../store/types';

/** One-off (2026-11-27): "FXCM:EURUSD" → "FX:EURUSD" — TradingView's code for the FXCM feed is "FX". */
const OLD = 'FXCM:';
const NEW = 'FX:';

const fix = (s: string | null) => (s && s.startsWith(OLD) ? NEW + s.slice(OLD.length) : s);

export interface FxPrefixReport {
  ideas: number;
  plans: number;
  notes: number;
  screenshots: number;
  assets: number;
  /** Asset docs that exist under both prefixes — left untouched, to merge by hand. */
  conflicts: string[];
}

/** Rewrites every stored symbol (and asset parent links) with the old prefix. Idempotent. */
export async function migrateFxPrefix(store: Store, { dryRun = false } = {}): Promise<FxPrefixReport> {
  const report: FxPrefixReport = { ideas: 0, plans: 0, notes: 0, screenshots: 0, assets: 0, conflicts: [] };

  for (const i of await store.ideas.list()) {
    if (fix(i.symbol) === i.symbol) continue;
    report.ideas++;
    if (!dryRun) await store.ideas.update(i.id, { symbol: fix(i.symbol)! });
  }
  for (const p of await store.plans.list()) {
    if (fix(p.symbol) === p.symbol) continue;
    report.plans++;
    if (!dryRun) await store.plans.update(p.id, { symbol: fix(p.symbol)! });
  }

  // Asset research is keyed by symbol: the doc id, and the parentId of its notes/screenshots.
  const conflicts = new Set<string>();
  for (const a of await store.assets.list()) {
    if (!a.symbol.startsWith(OLD)) continue;
    const symbol = fix(a.symbol)!;
    if (await store.assets.get(assetDocId(symbol))) {
      conflicts.add(a.symbol);
      continue;
    }
    report.assets++;
    if (!dryRun) {
      const { id: _old, ...rest } = a;
      await store.assets.upsert(assetDocId(symbol), { ...rest, symbol });
      await store.assets.delete(a.id);
    }
  }
  report.conflicts = [...conflicts];

  const reparent = <T extends { parentKind: string; parentId: string; symbol: string | null }>(d: T) => {
    const patch: Partial<{ symbol: string | null; parentId: string; parentKey: string }> = {};
    if (fix(d.symbol) !== d.symbol) patch.symbol = fix(d.symbol);
    if (d.parentKind === 'asset' && d.parentId.startsWith(OLD) && !conflicts.has(d.parentId)) {
      patch.parentId = fix(d.parentId)!;
      patch.parentKey = parentKey('asset', patch.parentId);
    }
    return Object.keys(patch).length ? patch : null;
  };
  for (const n of await store.notes.list()) {
    const patch = reparent(n);
    if (!patch) continue;
    report.notes++;
    if (!dryRun) await store.notes.update(n.id, patch);
  }
  for (const s of await store.screenshots.list()) {
    const patch = reparent(s);
    if (!patch) continue;
    report.screenshots++;
    if (!dryRun) await store.screenshots.update(s.id, patch);
  }
  return report;
}
