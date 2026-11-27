import { z } from 'zod';
import { Decimal, dec, decStr, isDecString } from './money';

// Read-only broker links. Today: FXCMgr — the local ForexConnect→HTTP bridge (port 11000).
// Nothing is ever sent to the broker except read requests.

export const fxcmgrConfigSchema = z.object({
  kind: z.literal('fxcmgr'),
  enabled: z.boolean(),
  baseUrl: z.url({ protocol: /^https?$/, error: 'כתובת לא תקינה (למשל http://localhost:11000)' }),
  /** Some HTTP.sys listeners accept only their registered host name; empty = use the URL's host. */
  hostHeader: z.string().trim().max(200),
});
export type FxcmgrConfig = z.infer<typeof fxcmgrConfigSchema>;
export type BrokerIntegration = FxcmgrConfig;

export interface BrokerPosition {
  instrument: string;
  direction: 'long' | 'short' | 'unknown';
  amountK: string;
  grossPL: string;
  takeProfit: string | null;
}

export interface BrokerSnapshot {
  equity: string;
  dayPL: string;
  positions: BrokerPosition[];
  /** Sum of open positions' gross P&L. */
  openPL: string;
  /** equity − openPL ≈ the broker's balance, comparable to the journal balance. */
  balanceApprox: string;
  fetchedAt: string;
}

function num(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const s = String(v);
    return isDecString(s) ? s : decStr(new Decimal(v));
  }
  if (typeof v === 'string' && isDecString(v.trim())) return v.trim();
  return null;
}

export function parseFxcmgrAccount(json: unknown): { equity: string; dayPL: string } {
  const a = (json as { accounts?: Array<Record<string, unknown>> })?.accounts?.[0];
  const equity = num(a?.equity);
  if (!a || equity === null) throw new Error('FXCMgr: תשובת Account לא תקינה');
  return { equity, dayPL: num(a.dayPL) ?? '0' };
}

export function parseFxcmgrPositions(json: unknown): BrokerPosition[] {
  const list = (json as { open_positions?: unknown })?.open_positions;
  if (!Array.isArray(list)) throw new Error('FXCMgr: תשובת OpenPosition לא תקינה');
  return (list as Array<Record<string, unknown>>).map((p) => {
    const t = String(p.type ?? p.isBuy ?? '').toUpperCase();
    return {
      instrument: String(p.currency ?? p.instrument ?? '?'),
      direction: t === 'B' || t === 'BUY' || t === 'TRUE' ? 'long' : t === 'S' || t === 'SELL' || t === 'FALSE' ? 'short' : 'unknown',
      amountK: num(p.amountK) ?? '0',
      grossPL: num(p.grossPL) ?? '0',
      takeProfit: num(p.takeProfit) && num(p.takeProfit) !== '0' ? num(p.takeProfit) : null,
    };
  });
}

export function buildBrokerSnapshot(
  account: { equity: string; dayPL: string },
  positions: BrokerPosition[],
  fetchedAt: string,
): BrokerSnapshot {
  const openPL = positions.reduce((s, p) => s.plus(dec(p.grossPL)), new Decimal(0));
  return {
    ...account,
    positions,
    openPL: decStr(openPL),
    balanceApprox: decStr(dec(account.equity).minus(openPL)),
    fetchedAt,
  };
}
