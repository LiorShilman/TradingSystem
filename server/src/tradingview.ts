import { parseTvScan } from '@trading/shared';

/** Real-time prices by TradingView symbol ("FX:GBPJPY" → "209.257"). Symbols without a live price are absent. */
export type TvQuoteClient = (symbols: string[]) => Promise<Record<string, string>>;

const SCAN_URL = 'https://scanner.tradingview.com/global/scan';

/**
 * TradingView's public scanner (no account, no key). Unofficial: if it changes or refuses, this throws
 * and the caller simply has no TradingView price — the same as before this source existed.
 */
export const defaultTvQuoteClient: TvQuoteClient = async (symbols) => {
  if (!symbols.length) return {};
  const res = await fetch(SCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (trading-journal)' },
    body: JSON.stringify({ symbols: { tickers: symbols }, columns: ['close', 'pricescale', 'update_mode'] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`TradingView scanner: HTTP ${res.status}`);
  return parseTvScan(await res.json());
};
