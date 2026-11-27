import { z } from 'zod';
import { DEFAULT_FX_EXCHANGE, FX_WATCHLIST, normalizeSymbol, symbolString } from './planning';

export const watchlistSectionSchema = z.object({
  name: z.string().trim().max(60),
  symbols: z.array(symbolString).max(300),
});
export type WatchlistSection = z.output<typeof watchlistSectionSchema>;

export const watchlistCreateSchema = z.object({
  name: z.string().trim().min(1, 'תן לרשימה שם').max(60),
  sections: z.array(watchlistSectionSchema).max(40).default([{ name: '', symbols: [] }]),
  /** TradingView watchlist id when imported from there. */
  sourceTvId: z.number().int().nullable().default(null),
});
export const watchlistPatchSchema = watchlistCreateSchema.omit({ sourceTvId: true }).partial();
export type WatchlistInput = z.output<typeof watchlistCreateSchema>;

export interface Watchlist extends WatchlistInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A TradingView watchlist's symbol list → sections. TradingView marks sections with "###NAME" entries;
 * symbols before the first marker go to an unnamed section. Invalid entries (free text) are dropped.
 */
export function sectionsFromTradingView(symbols: readonly string[]): WatchlistSection[] {
  const out: WatchlistSection[] = [];
  let cur: WatchlistSection = { name: '', symbols: [] };
  for (const raw of symbols) {
    if (raw.startsWith('###')) {
      if (cur.symbols.length || cur.name) out.push(cur);
      cur = { name: raw.slice(3).trim(), symbols: [] };
      continue;
    }
    const s = normalizeSymbol(raw);
    if (s && !cur.symbols.includes(s)) cur.symbols.push(s);
  }
  if (cur.symbols.length || cur.name) out.push(cur);
  return out;
}

export const watchlistSymbols = (w: Pick<Watchlist, 'sections'>) => [...new Set(w.sections.flatMap((s) => s.symbols))];

/** The original 28-pair list (as in TradingView "All Forex (FXCM)"), created once as an ordinary, editable list. */
export function defaultWatchlist(): WatchlistInput {
  return {
    name: 'All Forex (FXCM)',
    sections: FX_WATCHLIST.map((g) => ({ name: g.section, symbols: g.tickers.map((t) => `${DEFAULT_FX_EXCHANGE}:${t}`) })),
    sourceTvId: 178660709,
  };
}
