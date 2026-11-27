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
});
export type AlertConfig = z.infer<typeof alertConfigSchema>;
export const DEFAULT_ALERT_CONFIG: AlertConfig = { approachPips: 10, plans: true, levels: true, reminders: true };

// ---------- log ----------
export const ALERT_KINDS = ['plan_approach', 'plan_zone', 'plan_stop', 'level_cross', 'idea_reminder', 'plan_expiring', 'plan_expired', 'tv_webhook'] as const;
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
};

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  source: 'engine' | 'tradingview';
  symbol: string | null;
  planId: string | null;
  ideaId: string | null;
  price: string | null;
  /** Plain text, Hebrew. */
  title: string;
  body: string;
  delivered: boolean;
  deliveryError: string | null;
  createdAt: string;
}

// ---------- price helpers ----------
export const pipSize = (symbol: string) => (symbolTicker(symbol).endsWith('JPY') ? new Decimal('0.01') : new Decimal('0.0001'));

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
