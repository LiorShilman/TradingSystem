import { z } from 'zod';
import { Decimal, dec, decStr, decString, isDecString } from './money';
import { utcIsoString } from './time';

// ---------- symbols (TradingView format everywhere: "FX:EURUSD") ----------
const SYMBOL_RE = /^[A-Z0-9_.]+:[A-Z0-9_.!&-]+$/;

/**
 * Bare FX tickers get this TradingView exchange prefix. On TradingView the FXCM feed's exchange code is "FX"
 * ("FXCM:" is not a valid TradingView symbol) — this matches the user's "All Forex (FXCM)" watchlist.
 */
export const DEFAULT_FX_EXCHANGE = 'FX';

/** "eurusd" → "FX:EURUSD", "EUR/USD" → "FX:EURUSD", "nasdaq:aapl" → "NASDAQ:AAPL". Null if not a symbol. */
export function normalizeSymbol(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!s.includes(':')) {
    const fx = s.replace('/', '');
    if (/^[A-Z]{6}$/.test(fx)) s = `${DEFAULT_FX_EXCHANGE}:${fx}`;
    else return null;
  }
  if (s.startsWith('FXCM:')) s = `${DEFAULT_FX_EXCHANGE}:${s.slice(5)}`; // legacy prefix (before 2026-11-27)
  return SYMBOL_RE.test(s) ? s : null;
}

export const symbolString = z.string().transform((v, ctx) => {
  const n = normalizeSymbol(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'סימול לא תקין (למשל EURUSD או FX:EURUSD)' });
    return z.NEVER;
  }
  return n;
});

export const symbolTicker = (symbol: string) => symbol.split(':')[1] ?? symbol;

/** "FX:EURUSD" → "EUR/USD" (FXCM pair name), or null when not a 6-letter FX ticker. */
export function fxPair(symbol: string): string | null {
  const t = symbolTicker(symbol);
  return /^[A-Z]{6}$/.test(t) ? `${t.slice(0, 3)}/${t.slice(3)}` : null;
}

/** The user's TradingView watchlist "All Forex (FXCM)" — 28 majors and crosses, by section. */
export const FX_WATCHLIST: ReadonlyArray<{ section: string; tickers: readonly string[] }> = [
  { section: 'USD', tickers: ['AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'] },
  { section: 'AUD', tickers: ['AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD'] },
  { section: 'CAD', tickers: ['CADCHF', 'CADJPY', 'CHFJPY'] },
  { section: 'EUR', tickers: ['EURAUD', 'EURCAD', 'EURCHF', 'EURGBP', 'EURJPY', 'EURNZD'] },
  { section: 'GBP', tickers: ['GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY', 'GBPNZD'] },
  { section: 'NZD', tickers: ['NZDCAD', 'NZDCHF', 'NZDJPY'] },
];

export const COMMON_FX_SYMBOLS: readonly string[] = FX_WATCHLIST.flatMap((s) => s.tickers.map((t) => `${DEFAULT_FX_EXCHANGE}:${t}`));

export const ASSET_CLASSES = ['forex', 'stock', 'crypto', 'other'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const ASSET_CLASS_LABELS: Record<AssetClass, string> = { forex: 'מט"ח', stock: 'מניה', crypto: 'קריפטו', other: 'אחר' };

const tags = z.array(z.string().trim().min(1).max(40)).max(20);

interface Stamped {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- ideas ----------
export const IDEA_STATUSES = ['raw', 'watching', 'ready', 'dropped'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = { raw: 'גולמי', watching: 'במעקב', ready: 'בשל לתוכנית', dropped: 'נזנח' };

const ideaFields = z.object({
  symbol: symbolString,
  title: z.string().trim().min(1, 'כתוב משפט אחד').max(300, 'ארוך מדי'),
  body: z.string().max(10000),
  tags,
  status: z.enum(IDEA_STATUSES),
  dropReason: z.string().trim().max(500),
  remindAt: utcIsoString.nullable(),
  planId: z.string().nullable(),
});
export const ideaCreateSchema = ideaFields.extend({
  body: ideaFields.shape.body.default(''),
  tags: tags.default([]),
  status: ideaFields.shape.status.default('raw'),
  dropReason: ideaFields.shape.dropReason.default(''),
  remindAt: ideaFields.shape.remindAt.default(null),
  planId: ideaFields.shape.planId.default(null),
});
export const ideaPatchSchema = ideaFields.omit({ planId: true }).partial();
export type IdeaCreate = z.input<typeof ideaCreateSchema>;
export interface Idea extends z.output<typeof ideaCreateSchema>, Stamped {}

export function ideaIssues(i: Pick<Idea, 'status' | 'dropReason'>): string[] {
  return i.status === 'dropped' && !i.dropReason.trim() ? ['כשרעיון נזנח, כתוב למה — כדי ללמוד מזה'] : [];
}

// ---------- plans ----------
export const PLAN_STATUSES = ['draft', 'ready', 'waiting', 'opened', 'cancelled', 'expired'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: 'טיוטה',
  ready: 'מוכנה',
  waiting: 'ממתינה לטריגר',
  opened: 'נפתחה',
  cancelled: 'בוטלה',
  expired: 'פג תוקף',
};
export const ACTIVE_PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'ready', 'waiting'];
/** Statuses that require a complete, consistent plan. */
export const COMPLETE_PLAN_STATUSES: readonly PlanStatus[] = ['ready', 'waiting', 'opened'];

export const ORDER_TYPES = ['limit', 'stop', 'market'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const ORDER_TYPE_LABELS: Record<OrderType, string> = { limit: 'Limit', stop: 'Stop', market: 'Market' };

export const DIRECTIONS = ['long', 'short'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const DIRECTION_LABELS: Record<Direction, string> = { long: 'קנייה', short: 'מכירה' };

const optPrice = decString.nullable();
const target = z.object({ price: decString, sizePct: decString });

const planFields = z.object({
  symbol: symbolString,
  assetClass: z.enum(ASSET_CLASSES),
  accountId: z.string().nullable(),
  ideaId: z.string().nullable(),
  direction: z.enum(DIRECTIONS),
  timeframe: z.string().trim().max(20),
  entryLow: optPrice,
  entryHigh: optPrice,
  stopLoss: optPrice,
  targets: z.array(target).max(5, 'עד 5 יעדים'),
  orderType: z.enum(ORDER_TYPES),
  riskPct: decString,
  entryConditions: z.string().max(5000),
  invalidation: z.string().max(2000),
  expiresAt: utcIsoString.nullable(),
  status: z.enum(PLAN_STATUSES),
  tags,
});
export const planCreateSchema = planFields.extend({
  assetClass: planFields.shape.assetClass.default('forex'),
  accountId: planFields.shape.accountId.default(null),
  ideaId: planFields.shape.ideaId.default(null),
  direction: planFields.shape.direction.default('long'),
  timeframe: planFields.shape.timeframe.default(''),
  entryLow: optPrice.default(null),
  entryHigh: optPrice.default(null),
  stopLoss: optPrice.default(null),
  targets: planFields.shape.targets.default([]),
  orderType: planFields.shape.orderType.default('limit'),
  riskPct: decString.default('1'),
  entryConditions: planFields.shape.entryConditions.default(''),
  invalidation: planFields.shape.invalidation.default(''),
  expiresAt: planFields.shape.expiresAt.default(null),
  status: planFields.shape.status.default('draft'),
  tags: tags.default([]),
});
export const planPatchSchema = planFields.partial();
export type PlanCreate = z.input<typeof planCreateSchema>;
export type PlanPatch = z.infer<typeof planPatchSchema>;
export interface Plan extends z.output<typeof planCreateSchema>, Stamped {}

type PlanLevels = Pick<Plan, 'direction' | 'entryLow' | 'entryHigh' | 'stopLoss' | 'targets' | 'riskPct'>;

const pos = (s: string | null) => !!s && isDecString(s) && dec(s).gt(0);

/** Hebrew list of what is missing or inconsistent. Empty = the plan is complete. */
export function planIssues(p: PlanLevels): string[] {
  const out: string[] = [];
  const lowOk = pos(p.entryLow);
  const highOk = p.entryHigh === null || pos(p.entryHigh);
  if (!lowOk) out.push('חסר אזור כניסה');
  if (!highOk) out.push('גבול עליון של אזור הכניסה לא תקין');
  if (!pos(p.stopLoss)) out.push('חסר סטופ לוס');
  if (p.targets.length === 0) out.push('חסר לפחות יעד אחד');
  if (!pos(p.riskPct) || dec(p.riskPct).gt(10)) out.push('אחוז סיכון חייב להיות בין 0 ל-10');

  if (lowOk && highOk) {
    const lo = dec(p.entryLow!);
    const hi = p.entryHigh ? dec(p.entryHigh) : lo;
    if (hi.lt(lo)) out.push('הגבול העליון של אזור הכניסה נמוך מהתחתון');
    const long = p.direction === 'long';
    if (pos(p.stopLoss)) {
      const sl = dec(p.stopLoss!);
      if (long && sl.gte(lo)) out.push('בקנייה הסטופ חייב להיות מתחת לאזור הכניסה');
      if (!long && sl.lte(hi)) out.push('במכירה הסטופ חייב להיות מעל אזור הכניסה');
    }
    p.targets.forEach((t, i) => {
      if (!pos(t.price)) return void out.push(`יעד ${i + 1}: מחיר לא תקין`);
      const tp = dec(t.price);
      if (long && tp.lte(hi)) out.push(`יעד ${i + 1} חייב להיות מעל אזור הכניסה`);
      if (!long && tp.gte(lo)) out.push(`יעד ${i + 1} חייב להיות מתחת לאזור הכניסה`);
    });
  }
  const sizes = p.targets.filter((t) => isDecString(t.sizePct));
  if (sizes.some((t) => dec(t.sizePct).lt(0))) out.push('אחוז יעד לא יכול להיות שלילי');
  if (sizes.reduce((s, t) => s.plus(dec(t.sizePct)), new Decimal(0)).gt(100)) out.push('סך האחוזים ביעדים מעל 100%');
  return out;
}

export interface PlanMetrics {
  /** Middle of the entry zone. */
  entry: string;
  riskPerUnit: string;
  targets: Array<{ price: string; sizePct: string; r: string }>;
  /** Weighted by sizePct (equal weights when none given). */
  avgR: string;
}

/** R multiples per target from the middle of the entry zone. Null while the plan is incomplete. */
export function planMetrics(p: PlanLevels): PlanMetrics | null {
  if (planIssues(p).length) return null;
  const lo = dec(p.entryLow!);
  const entry = p.entryHigh ? lo.plus(dec(p.entryHigh)).div(2) : lo;
  const risk = entry.minus(dec(p.stopLoss!)).abs();
  const targets = p.targets.map((t) => ({ ...t, r: decStr(dec(t.price).minus(entry).abs().div(risk).toDecimalPlaces(2)) }));
  const totalW = targets.reduce((s, t) => s.plus(dec(t.sizePct)), new Decimal(0));
  const avg = totalW.gt(0)
    ? targets.reduce((s, t) => s.plus(dec(t.r).times(dec(t.sizePct))), new Decimal(0)).div(totalW)
    : targets.reduce((s, t) => s.plus(dec(t.r)), new Decimal(0)).div(targets.length);
  return { entry: decStr(entry), riskPerUnit: decStr(risk), targets, avgR: decStr(avg.toDecimalPlaces(2)) };
}

// ---------- notes (analysis timeline) ----------
export const PARENT_KINDS = ['idea', 'plan', 'asset', 'note'] as const;
export type ParentKind = (typeof PARENT_KINDS)[number];
export const parentKey = (kind: ParentKind, id: string) => `${kind}:${id}`;

export const noteCreateSchema = z.object({
  parentKind: z.enum(['idea', 'plan', 'asset']),
  parentId: z.string().min(1),
  symbol: symbolString.nullable().default(null),
  body: z.string().trim().min(1, 'ההערה ריקה').max(20000),
});
export const notePatchSchema = z.object({ body: noteCreateSchema.shape.body });
export interface Note extends Stamped {
  parentKind: 'idea' | 'plan' | 'asset';
  parentId: string;
  parentKey: string;
  symbol: string | null;
  body: string;
}

// ---------- screenshots ----------
export const SHOT_PHASES = ['before', 'entry', 'exit', 'other'] as const;
export type ShotPhase = (typeof SHOT_PHASES)[number];
export const SHOT_PHASE_LABELS: Record<ShotPhase, string> = { before: 'לפני', entry: 'בכניסה', exit: 'ביציאה', other: 'אחר' };

export const shotMetaSchema = z.object({
  parentKind: z.enum(PARENT_KINDS),
  parentId: z.string().min(1),
  symbol: symbolString.nullable().default(null),
  phase: z.enum(SHOT_PHASES).default('before'),
  caption: z.string().trim().max(500).default(''),
});
export const shotPatchSchema = z.object({ phase: z.enum(SHOT_PHASES), caption: z.string().trim().max(500) }).partial();

export interface Screenshot {
  id: string;
  parentKind: ParentKind;
  parentId: string;
  parentKey: string;
  symbol: string | null;
  phase: ShotPhase;
  caption: string;
  source: 'upload' | 'tradingview';
  /** Original TradingView link, when it came from one. */
  tvUrl: string | null;
  /** Local copy; null when only the link could be kept. */
  file: { ext: string; mime: string; width: number; height: number; bytes: number } | null;
  createdAt: string;
  /** Added by the server on read: short-lived signed URLs (relative to the API base). */
  thumbUrl?: string;
  fullUrl?: string;
}

// ---------- assets (per-symbol research) ----------
export const assetPutSchema = z.object({
  /** alert: send a Telegram alert when the price crosses this level. */
  levels: z.array(z.object({ price: decString, label: z.string().trim().max(100), alert: z.boolean().default(false) })).max(30),
  summary: z.string().max(20000),
});
export interface AssetDoc extends z.infer<typeof assetPutSchema> {
  id: string;
  symbol: string;
  updatedAt: string;
}
export const assetDocId = (symbol: string) => symbol.replace(/\//g, '_');
