import { z } from 'zod';
import { convert } from './balance';
import { Decimal, dec, decStr, decString, isDecString } from './money';
import { ASSET_CLASSES, DIRECTIONS, symbolString, symbolTicker, type AssetClass, type Direction } from './planning';
import { CURRENCIES, type Currency, type Settings } from './schemas';
import { utcIsoString } from './time';

// ---------- enums ----------
export const FILL_KINDS = ['entry', 'exit'] as const;
export type FillKind = (typeof FILL_KINDS)[number];
export const FILL_KIND_LABELS: Record<FillKind, string> = { entry: 'כניסה', exit: 'יציאה' };

export const COST_KINDS = ['commission', 'swap', 'funding', 'other'] as const;
export type CostKind = (typeof COST_KINDS)[number];
export const COST_KIND_LABELS: Record<CostKind, string> = { commission: 'עמלה', swap: 'Swap', funding: 'Funding', other: 'אחר' };

export const ADHERENCE = ['yes', 'partial', 'no'] as const;
export type Adherence = (typeof ADHERENCE)[number];
export const ADHERENCE_LABELS: Record<Adherence, string> = { yes: 'כן', partial: 'חלקית', no: 'לא' };

export const TRADE_STATUSES = ['open', 'closed'] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];
export const TRADE_STATUS_LABELS: Record<TradeStatus, string> = { open: 'פתוחה', closed: 'סגורה' };

// ---------- schemas ----------
const positive = decString.refine((s) => dec(s).gt(0), 'חייב להיות גדול מ-0');
const nonNegative = decString.refine((s) => dec(s).gte(0), 'לא יכול להיות שלילי');

export const fillSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(FILL_KINDS),
  at: utcIsoString,
  price: positive,
  /** Units of the base asset (forex: 100000 = 1 lot). */
  quantity: positive,
  /** Commission on this fill, account currency, ≥ 0. */
  fee: nonNegative.default('0'),
  /** Exits: realized P&L in account currency, before fees. Computed unless pnlManual (the broker's figure). */
  pnl: decString.nullable().default(null),
  pnlManual: z.boolean().default(false),
  note: z.string().trim().max(300).default(''),
});
export type Fill = z.output<typeof fillSchema>;

export const costSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(COST_KINDS),
  at: utcIsoString,
  /** Effect on P&L in account currency: negative = a cost (swap can also be positive). */
  amount: decString,
  note: z.string().trim().max(300).default(''),
});
export type Cost = z.output<typeof costSchema>;

const emotion = z.object({ score: z.number().int().min(1).max(5), word: z.string().trim().max(40).default('') }).nullable();

const tradeFields = z.object({
  symbol: symbolString,
  assetClass: z.enum(ASSET_CLASSES),
  accountId: z.string().min(1, 'בחר חשבון'),
  planId: z.string().nullable(),
  ideaId: z.string().nullable(),
  direction: z.enum(DIRECTIONS),
  timeframe: z.string().trim().max(20),
  strategy: z.string().trim().max(100),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  /** The stop at entry — defines 1R. */
  initialStop: positive,
  /** Where the stop is now (moved to break-even, trailed…); null = still the initial stop. */
  currentStop: positive.nullable(),
  targets: z.array(z.object({ price: positive, sizePct: decString })).max(5, 'עד 5 יעדים'),
  fills: z.array(fillSchema).min(1, 'עסקה צריכה לפחות כניסה אחת').max(100),
  costs: z.array(costSchema).max(100),
  /** Account balance when the trade was opened (for % of account). */
  equityAtEntry: positive.nullable(),
  emotionEntry: emotion,
  emotionExit: emotion,
  followedPlan: z.enum(ADHERENCE).nullable(),
  deviation: z.string().max(2000),
  lesson: z.string().max(2000),
  /** CFD: value of a 1.0 move per unit (from the broker spec at opening), in pointValueCurrency. Null = currency pair / plain asset. */
  pointValue: decString.nullable(),
  pointValueCurrency: z.enum(CURRENCIES).nullable(),
});

export const tradeCreateSchema = tradeFields.extend({
  assetClass: tradeFields.shape.assetClass.default('forex'),
  planId: tradeFields.shape.planId.default(null),
  ideaId: tradeFields.shape.ideaId.default(null),
  timeframe: tradeFields.shape.timeframe.default(''),
  strategy: tradeFields.shape.strategy.default(''),
  tags: tradeFields.shape.tags.default([]),
  currentStop: tradeFields.shape.currentStop.default(null),
  targets: tradeFields.shape.targets.default([]),
  costs: tradeFields.shape.costs.default([]),
  equityAtEntry: tradeFields.shape.equityAtEntry.default(null),
  emotionEntry: emotion.default(null),
  emotionExit: emotion.default(null),
  followedPlan: tradeFields.shape.followedPlan.default(null),
  deviation: tradeFields.shape.deviation.default(''),
  lesson: tradeFields.shape.lesson.default(''),
  pointValue: tradeFields.shape.pointValue.default(null),
  pointValueCurrency: tradeFields.shape.pointValueCurrency.default(null),
});
/** The account of a trade can't change (its P&L is in that account's currency). */
export const tradePatchSchema = tradeFields.omit({ accountId: true, pointValue: true, pointValueCurrency: true }).partial();
export type TradeInput = z.output<typeof tradeCreateSchema>;

/** Derived on every save, stored for lists, filters and the account balance. */
export interface TradeDerived {
  status: TradeStatus;
  openedAt: string;
  closedAt: string | null;
  /** Net realized P&L in account currency (exits − all fees + costs); null if a rate was missing. */
  netPnl: string | null;
  /** Realized R from prices only; null while nothing was closed. */
  r: string | null;
}

export interface Trade extends TradeInput, TradeDerived {
  id: string;
  /** Copied from the account at creation. */
  currency: Currency;
  createdAt: string;
  updatedAt: string;
}

// ---------- money ----------
const isCurrency = (c: string): c is Currency => (CURRENCIES as readonly string[]).includes(c);

/**
 * A price move × quantity, in the account currency.
 * Forex: the move is in the quote currency — converted directly when the account is the quote,
 * at `price` when the account is the base (USDJPY in a USD account), otherwise via the rates.
 * Other assets: the price is assumed to be in the account currency.
 */
export function moveToAccount(
  t: { assetClass: AssetClass; symbol: string; pointValue?: string | null; pointValueCurrency?: Currency | null },
  move: Decimal,
  quantity: Decimal,
  price: Decimal,
  acct: Currency,
  rates: Settings['rates'],
): Decimal | null {
  // CFD with a broker spec: move × units × value of a 1.0 move.
  if (t.pointValue && t.pointValueCurrency) {
    const v = move.times(quantity).times(dec(t.pointValue));
    if (t.pointValueCurrency === acct) return v;
    const c = convert(decStr(v), t.pointValueCurrency, acct, rates);
    return c === null ? null : dec(c);
  }
  const inQuote = move.times(quantity);
  if (t.assetClass !== 'forex') return inQuote;
  const tk = symbolTicker(t.symbol);
  if (!/^[A-Z]{6}$/.test(tk)) return null;
  const base = tk.slice(0, 3);
  const quote = tk.slice(3);
  if (quote === acct) return inQuote;
  if (base === acct) return inQuote.div(price);
  if (!isCurrency(quote)) return null;
  const v = convert(decStr(inQuote), quote, acct, rates);
  return v === null ? null : dec(v);
}

const money = (d: Decimal) => decStr(d.toDecimalPlaces(2));
const sign = (dir: Direction) => (dir === 'long' ? 1 : -1);
const byTime = <T extends { at: string }>(xs: readonly T[]) => [...xs].sort((a, b) => a.at.localeCompare(b.at));

// ---------- validation ----------
type TradeShape = Pick<TradeInput, 'direction' | 'initialStop' | 'fills' | 'targets'>;

/** Hebrew list of problems. Empty = consistent. */
export function tradeIssues(t: TradeShape): string[] {
  const out: string[] = [];
  const fills = byTime(t.fills);
  if (!fills.some((f) => f.kind === 'entry')) out.push('חסרה כניסה');
  let open = new Decimal(0);
  for (const f of fills) {
    if (!isDecString(f.quantity)) continue;
    open = f.kind === 'entry' ? open.plus(dec(f.quantity)) : open.minus(dec(f.quantity));
    if (open.isNegative()) {
      out.push('יציאה בכמות גדולה מהכמות הפתוחה באותו רגע');
      break;
    }
  }
  if (fills[0] && fills[0].kind !== 'entry') out.push('הביצוע הראשון חייב להיות כניסה');
  const s = tradeStats(t);
  if (s.avgEntry && isDecString(t.initialStop)) {
    const stop = dec(t.initialStop);
    const avg = dec(s.avgEntry);
    if (t.direction === 'long' && stop.gte(avg)) out.push('בקנייה הסטופ ההתחלתי חייב להיות מתחת למחיר הכניסה');
    if (t.direction === 'short' && stop.lte(avg)) out.push('במכירה הסטופ ההתחלתי חייב להיות מעל מחיר הכניסה');
  }
  return out;
}

// ---------- stats ----------
export interface TradeStats {
  entryQty: string;
  exitQty: string;
  openQty: string;
  avgEntry: string | null;
  avgExit: string | null;
  status: TradeStatus;
  /** Price distance entry → initial stop. */
  riskPerUnit: string | null;
  /** Initial risk in price units × quantity (for R). */
  r: string | null;
  /** Sum of exit P&L (before fees); null if any exit P&L is unknown. */
  grossPnl: string | null;
  fees: string;
  costs: string;
  netPnl: string | null;
  /** Net P&L as % of equityAtEntry. */
  pct: string | null;
}

/** Pure numbers from fills/costs. Exit P&L must already be set on the fills (see withComputedPnl). */
export function tradeStats(t: TradeShape & Partial<Pick<TradeInput, 'costs' | 'equityAtEntry'>>): TradeStats {
  const entries = t.fills.filter((f) => f.kind === 'entry' && isDecString(f.quantity) && isDecString(f.price));
  const exits = t.fills.filter((f) => f.kind === 'exit' && isDecString(f.quantity) && isDecString(f.price));
  const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), new Decimal(0));
  const entryQty = sum(entries.map((f) => dec(f.quantity)));
  const exitQty = sum(exits.map((f) => dec(f.quantity)));
  const openQty = entryQty.minus(exitQty);
  const avg = (xs: typeof entries, q: Decimal) => (q.gt(0) ? sum(xs.map((f) => dec(f.price).times(dec(f.quantity)))).div(q) : null);
  const avgEntry = avg(entries, entryQty);
  const avgExit = avg(exits, exitQty);
  const status: TradeStatus = exits.length > 0 && openQty.lte(0) ? 'closed' : 'open';

  let riskPerUnit: Decimal | null = null;
  let r: Decimal | null = null;
  if (avgEntry && isDecString(t.initialStop)) {
    riskPerUnit = avgEntry.minus(dec(t.initialStop)).abs();
    if (riskPerUnit.gt(0) && exits.length) {
      const moved = sum(exits.map((f) => dec(f.price).minus(avgEntry).times(sign(t.direction)).times(dec(f.quantity))));
      r = moved.div(riskPerUnit.times(entryQty));
    }
  }

  const gross = exits.every((f) => f.pnl !== null && isDecString(f.pnl)) ? sum(exits.map((f) => dec(f.pnl!))) : null;
  const fees = sum(t.fills.filter((f) => isDecString(f.fee)).map((f) => dec(f.fee)));
  const costs = sum((t.costs ?? []).filter((c) => isDecString(c.amount)).map((c) => dec(c.amount)));
  const net = gross === null ? null : gross.minus(fees).plus(costs);
  const eq = t.equityAtEntry && isDecString(t.equityAtEntry) ? dec(t.equityAtEntry) : null;

  return {
    entryQty: decStr(entryQty),
    exitQty: decStr(exitQty),
    openQty: decStr(openQty),
    avgEntry: avgEntry ? decStr(avgEntry.toSignificantDigits(10)) : null,
    avgExit: avgExit ? decStr(avgExit.toSignificantDigits(10)) : null,
    status,
    riskPerUnit: riskPerUnit ? decStr(riskPerUnit.toSignificantDigits(10)) : null,
    r: r ? decStr(r.toDecimalPlaces(2)) : null,
    grossPnl: gross === null ? null : money(gross),
    fees: money(fees),
    costs: money(costs),
    netPnl: net === null ? null : money(net),
    pct: net !== null && eq && eq.gt(0) ? decStr(net.div(eq).times(100).toDecimalPlaces(2)) : null,
  };
}

/**
 * Fill in each exit's P&L (account currency, vs the average entry) unless it was entered by hand.
 * Rates are the current ones — the figure is stored, so it reflects the rate when the exit was saved.
 */
export function withComputedPnl<T extends TradeShape & { symbol: string; assetClass: AssetClass; pointValue?: string | null; pointValueCurrency?: Currency | null }>(t: T, acct: Currency, rates: Settings['rates']): T {
  const { avgEntry } = tradeStats(t);
  const fills = t.fills.map((f) => {
    if (f.kind !== 'exit' || f.pnlManual) return f;
    if (!avgEntry) return { ...f, pnl: null };
    const px = dec(f.price);
    const v = moveToAccount(t, px.minus(dec(avgEntry)).times(sign(t.direction)), dec(f.quantity), px, acct, rates);
    return { ...f, pnl: v === null ? null : money(v) };
  });
  return { ...t, fills };
}

/** Status/dates/net P&L/R stored with the trade. */
export function tradeDerived(t: TradeShape & Partial<Pick<TradeInput, 'costs' | 'equityAtEntry'>>): TradeDerived {
  const s = tradeStats(t);
  const fills = byTime(t.fills);
  return {
    status: s.status,
    openedAt: fills.find((f) => f.kind === 'entry')?.at ?? fills[0]?.at ?? '',
    closedAt: s.status === 'closed' ? (fills.at(-1)?.at ?? null) : null,
    netPnl: s.netPnl,
    r: s.r,
  };
}

/** Unrealized P&L of the open quantity at `price`, in account currency (null if it can't be converted). */
export function unrealizedPnl(
  t: Pick<TradeInput, 'symbol' | 'assetClass' | 'direction' | 'initialStop' | 'fills' | 'targets'> & Partial<Pick<TradeInput, 'pointValue' | 'pointValueCurrency'>>,
  price: string,
  acct: Currency,
  rates: Settings['rates'],
): { amount: string; r: string | null } | null {
  const s = tradeStats(t);
  if (!s.avgEntry || dec(s.openQty).lte(0)) return null;
  const px = dec(price);
  const move = px.minus(dec(s.avgEntry)).times(sign(t.direction));
  const v = moveToAccount(t, move, dec(s.openQty), px, acct, rates);
  if (v === null) return null;
  const risk = s.riskPerUnit ? dec(s.riskPerUnit) : null;
  return { amount: money(v), r: risk && risk.gt(0) ? decStr(move.div(risk).toDecimalPlaces(2)) : null };
}

/** Realized net P&L of every trade of an account (counts toward its balance). */
export function realizedTotal(trades: Iterable<Pick<Trade, 'netPnl'>>): string {
  let total = new Decimal(0);
  for (const t of trades) if (t.netPnl && isDecString(t.netPnl)) total = total.plus(dec(t.netPnl));
  return decStr(total);
}
