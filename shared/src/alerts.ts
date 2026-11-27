import { z } from 'zod';
import { Decimal, dec } from './money';
import { symbolTicker, type Plan } from './planning';

// ---------- config ----------
export const alertConfigSchema = z.object({
  /** "Approaching the zone" distance, in pips (forex). */
  approachPips: z.number().int().min(1).max(500),
  plans: z.boolean(),
  levels: z.boolean(),
  reminders: z.boolean(),
  /** Open trades: target reached, approaching / hitting the stop. */
  trades: z.boolean().default(true),
});
export type AlertConfig = z.output<typeof alertConfigSchema>;
export const DEFAULT_ALERT_CONFIG: AlertConfig = { approachPips: 10, plans: true, levels: true, reminders: true, trades: true };

// ---------- log ----------
export const ALERT_KINDS = ['plan_approach', 'plan_zone', 'plan_stop', 'level_cross', 'idea_reminder', 'plan_expiring', 'plan_expired', 'tv_webhook', 'trade_target', 'trade_stop_near', 'trade_stop'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  plan_approach: 'מתקרב לאזור',
  plan_zone: 'באזור הכניסה',
  plan_stop: 'סטופ לפני כניסה',
  level_cross: 'חציית רמה',
  idea_reminder: 'תזכורת לרעיון',
  plan_expiring: 'תוכנית עומדת לפוג',
  plan_expired: 'תוכנית פגה',
  tv_webhook: 'TradingView',
  trade_target: 'עסקה: הגיע ליעד',
  trade_stop_near: 'עסקה: מתקרב לסטופ',
  trade_stop: 'עסקה: הגיע לסטופ',
};

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  source: 'engine' | 'tradingview';
  symbol: string | null;
  planId: string | null;
  ideaId: string | null;
  /** Open-trade alerts (absent in older log entries). */
  tradeId?: string | null;
  price: string | null;
  /** Plain text, Hebrew. */
  title: string;
  body: string;
  delivered: boolean;
  deliveryError: string | null;
  createdAt: string;
}

// ---------- price helpers ----------
/** Pip size: 0.01 for JPY pairs and for gold/silver (as at FXCM), 0.0001 for other currency pairs. */
export const pipSize = (symbol: string) => {
  const t = symbolTicker(symbol);
  return t.endsWith('JPY') || /^X(AU|AG)/.test(t) ? new Decimal('0.01') : new Decimal('0.0001');
};

/** Distance from the entry zone in price units (0 inside). */
export function distanceToZone(lo: Decimal, hi: Decimal, px: Decimal): Decimal {
  if (px.lt(lo)) return lo.minus(px);
  if (px.gt(hi)) return px.minus(hi);
  return new Decimal(0);
}

// ---------- plan price alerts ----------
export type PlanFire = 'plan_approach' | 'plan_zone' | 'plan_stop';

export interface PlanAlertState {
  /** Levels the flags refer to; a change of levels re-arms everything. */
  sig: string;
  approach: boolean;
  zone: boolean;
  stop: boolean;
}

type PlanPriceInput = Pick<Plan, 'symbol' | 'assetClass' | 'direction' | 'entryLow' | 'entryHigh' | 'stopLoss'>;

export const planLevelSig = (p: PlanPriceInput) => [p.direction, p.entryLow, p.entryHigh, p.stopLoss].join('|');

/**
 * One observed price against a complete plan. Each alert fires once, and re-arms only after the price
 * has moved clearly away (approach distance + 50%), so a price hovering at an edge doesn't spam.
 * The most urgent alert wins: stop > zone > approach. "Approach" is forex only (needs pips).
 */
export function evaluatePlanPrice(p: PlanPriceInput, price: string, prev: PlanAlertState | null, approachPips: number): { state: PlanAlertState; fire: PlanFire | null } {
  const sig = planLevelSig(p);
  const s: PlanAlertState = prev && prev.sig === sig ? { ...prev } : { sig, approach: false, zone: false, stop: false };
  if (!p.entryLow || !p.stopLoss) return { state: s, fire: null };

  const px = dec(price);
  const lo = dec(p.entryLow);
  const hi = p.entryHigh ? dec(p.entryHigh) : lo;
  const sl = dec(p.stopLoss);
  const forex = p.assetClass === 'forex';
  const approach = forex ? pipSize(p.symbol).times(approachPips) : new Decimal(0);
  const rearm = forex ? approach.times(1.5) : hi.minus(lo).plus(lo.times('0.002')); // non-forex: zone width + 0.2%
  const d = distanceToZone(lo, hi, px);
  const long = p.direction === 'long';
  const stopHit = long ? px.lte(sl) : px.gte(sl);

  // Re-arm first (price is clearly away).
  if (d.gt(rearm)) {
    s.approach = false;
    s.zone = false;
  }
  if (s.stop && (long ? px.gt(sl.plus(rearm)) : px.lt(sl.minus(rearm)))) s.stop = false;

  let fire: PlanFire | null = null;
  if (stopHit) {
    if (!s.stop) fire = 'plan_stop';
    s.stop = s.zone = s.approach = true;
  } else if (d.isZero()) {
    if (!s.zone) fire = 'plan_zone';
    s.zone = s.approach = true;
  } else if (forex && d.lte(approach)) {
    if (!s.approach) fire = 'plan_approach';
    s.approach = true;
  }
  return { state: s, fire };
}

// ---------- open-trade alerts ----------
export type TradeFire = { kind: 'trade_stop' } | { kind: 'trade_stop_near' } | { kind: 'trade_target'; index: number };

export interface TradeAlertState {
  sig: string;
  stopNear: boolean;
  stop: boolean;
  targets: boolean[];
}

export interface TradePriceInput {
  symbol: string;
  assetClass: Plan['assetClass'];
  direction: Plan['direction'];
  /** Current stop (or the initial one). */
  stop: string;
  targets: Array<{ price: string }>;
}

/**
 * One observed price against an open trade. Same rules as plans: each alert once, re-armed only after
 * the price moved clearly away. Stop hit silences "approaching". "Approaching the stop" is forex only.
 */
export function evaluateTradePrice(t: TradePriceInput, price: string, prev: TradeAlertState | null, approachPips: number): { state: TradeAlertState; fires: TradeFire[] } {
  const sig = [t.direction, t.stop, ...t.targets.map((x) => x.price)].join('|');
  const s: TradeAlertState = prev && prev.sig === sig ? { ...prev, targets: [...prev.targets] } : { sig, stopNear: false, stop: false, targets: t.targets.map(() => false) };
  const px = dec(price);
  const sl = dec(t.stop);
  const long = t.direction === 'long';
  const forex = t.assetClass === 'forex';
  const approach = forex ? pipSize(t.symbol).times(approachPips) : new Decimal(0);
  const rearm = (level: Decimal) => (forex ? approach.times(1.5) : level.times('0.002'));
  const fires: TradeFire[] = [];

  // Distance from the stop on the safe side (negative = beyond the stop).
  const room = long ? px.minus(sl) : sl.minus(px);
  if (room.gt(rearm(sl))) s.stop = false;
  if (forex && room.gt(approach.times(1.5))) s.stopNear = false;
  if (room.lte(0)) {
    if (!s.stop) fires.push({ kind: 'trade_stop' });
    s.stop = s.stopNear = true;
  } else if (forex && room.lte(approach)) {
    if (!s.stopNear) fires.push({ kind: 'trade_stop_near' });
    s.stopNear = true;
  }

  t.targets.forEach((tg, i) => {
    const tp = dec(tg.price);
    const beyond = long ? px.minus(tp) : tp.minus(px); // ≥ 0 = reached
    if (beyond.gte(0)) {
      if (!s.targets[i]) fires.push({ kind: 'trade_target', index: i });
      s.targets[i] = true;
    } else if (beyond.abs().gt(rearm(tp))) s.targets[i] = false;
  });
  return { state: s, fires };
}

// ---------- key-level crossings ----------
export interface LevelAlertState {
  side: 'above' | 'below';
  armed: boolean;
}

/** Re-arm buffer around a level: 5 pips for forex, 0.1% otherwise. */
export const levelBuffer = (symbol: string, forex: boolean, level: Decimal) => (forex ? pipSize(symbol).times(5) : level.times('0.001'));

/**
 * Fires when the price crosses the level (side flips). After firing it stays quiet until the price
 * has been at least `buffer` away from the level. The first observation only records the side.
 */
export function evaluateLevel(level: string, price: string, prev: LevelAlertState | null, buffer: Decimal): { state: LevelAlertState; fire: 'up' | 'down' | null } {
  const L = dec(level);
  const px = dec(price);
  const side: LevelAlertState['side'] = px.gte(L) ? 'above' : 'below';
  if (!prev) return { state: { side, armed: px.minus(L).abs().gte(buffer) }, fire: null };
  let armed = prev.armed || px.minus(L).abs().gte(buffer);
  let fire: 'up' | 'down' | null = null;
  if (side !== prev.side && prev.armed) {
    fire = side === 'above' ? 'up' : 'down';
    armed = px.minus(L).abs().gte(buffer); // usually false right after a cross
  }
  return { state: { side, armed }, fire };
}

// ---------- TradingView webhook ----------
export const tvWebhookSchema = z.object({
  secret: z.string().min(1).max(200),
  symbol: z.string().max(60).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  planId: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
  alert: z.string().max(300).optional(),
  time: z.string().max(60).optional(),
});
export type TvWebhook = z.infer<typeof tvWebhookSchema>;

/** Template for the TradingView alert "Message" box. {{...}} are TradingView placeholders. */
export function tvWebhookTemplate(secret: string, planId?: string): string {
  return JSON.stringify(
    {
      secret,
      symbol: '{{exchange}}:{{ticker}}',
      price: '{{close}}',
      ...(planId ? { planId } : {}),
      alert: 'שם ההתראה',
      message: '{{ticker}} חצה רמה · {{interval}}',
      time: '{{timenow}}',
    },
    null,
    2,
  );
}
