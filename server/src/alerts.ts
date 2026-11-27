import {
  ACTIVE_PLAN_STATUSES,
  DEFAULT_ALERT_CONFIG,
  DIRECTION_LABELS,
  PLAN_STATUS_LABELS,
  dec,
  decStr,
  evaluateLevel,
  evaluatePlanPrice,
  evaluateTradePrice,
  levelBuffer,
  nowUtcIso,
  parentKey,
  pipSize,
  planIssues,
  type AlertConfig,
  type AlertEvent,
  type AlertKind,
  type AssetDoc,
  type Idea,
  type LevelAlertState,
  type Plan,
  type PlanAlertState,
  type PlanFire,
  type TvWebhook,
  type Trade,
  type TradeAlertState,
  type TradeFire,
  type Watchlist,
  watchlistSymbols,
  tradeStats,
  normalizeSymbol,
} from '@trading/shared';
import type { Quote } from './quotes';
import type { Store } from './store/types';
import { escapeHtml, type Telegram } from './telegram';

const CACHE_SAFETY_MS = 10 * 60 * 1000;
const EXPIRY_WARN_MS = 2 * 60 * 60 * 1000;
/** Reminders/expiries older than this are not sent late (e.g. after a long downtime). */
const LATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_KEEP_DAYS = 90;

/** Plans the engine watches for price alerts. Drafts are excluded (they may be incomplete). */
const PRICE_ALERT_STATUSES: readonly Plan['status'][] = ['ready', 'waiting'];

interface Snapshot {
  plans: Plan[];
  trades: Trade[];
  watchlists: Watchlist[];
  ideas: Idea[];
  assets: AssetDoc[];
  at: number;
}

export interface AlertEngineOptions {
  /** e.g. https://example.com/trading — enables links in Telegram messages. */
  publicUrl?: string | null;
  /** Live-price check; defaults to "always live" (tests). */
  isLive?: (symbol: string) => boolean;
  now?: () => Date;
}

type Draft = Omit<AlertEvent, 'id' | 'createdAt' | 'delivered' | 'deliveryError'> & { html: string; note?: string };


/**
 * Price alerts on plans and key levels, idea reminders and plan expiry → Telegram + alert log
 * (+ a timeline note on the plan). Never changes a plan's status, except marking it expired,
 * which the planning routes already do on read.
 */
export class AlertEngine {
  private snap: Snapshot | null = null;
  private states: Map<string, unknown> | null = null;
  private config: AlertConfig | null = null;
  private lastPrice = new Map<string, string>();
  private running = Promise.resolve();

  constructor(
    private store: Store,
    private telegram: Telegram,
    private opts: AlertEngineOptions = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Call after any change to plans/ideas/assets/config; the next run reloads. */
  invalidate() {
    this.snap = null;
    this.config = null;
  }

  async getConfig(): Promise<AlertConfig> {
    this.config ??= { ...DEFAULT_ALERT_CONFIG, ...((await this.store.alertConfig.get()) ?? {}) };
    return this.config;
  }

  private async data(): Promise<Snapshot> {
    if (!this.snap || Date.now() - this.snap.at > CACHE_SAFETY_MS) {
      const [plans, trades, watchlists, ideas, assets] = await Promise.all([
        this.store.plans.list(),
        this.store.trades.list({ field: 'status', value: 'open' }),
        this.store.watchlists.list(),
        this.store.ideas.list(),
        this.store.assets.list(),
      ]);
      this.snap = { plans, trades, watchlists, ideas, assets, at: Date.now() };
    }
    return this.snap;
  }

  private async stateMap() {
    if (!this.states) this.states = new Map((await this.store.alertStates.list()).map((d) => [d.id, d.data]));
    return this.states;
  }
  private async getState<T>(id: string): Promise<T | null> {
    return ((await this.stateMap()).get(id) as T | undefined) ?? null;
  }
  private async setState(id: string, data: unknown) {
    const map = await this.stateMap();
    if (JSON.stringify(map.get(id)) === JSON.stringify(data)) return;
    map.set(id, data);
    await this.store.alertStates.upsert(id, { data, updatedAt: nowUtcIso() });
  }

  /** Symbols the sampler should price: watchlists, active plans, open trades and assets with 🔔 levels. */
  async watchedSymbols(): Promise<string[]> {
    const { plans, trades, watchlists, assets } = await this.data();
    return [
      ...new Set([
        ...watchlists.flatMap(watchlistSymbols),
        ...plans.filter((p) => ACTIVE_PLAN_STATUSES.includes(p.status)).map((p) => p.symbol),
        ...trades.map((t) => t.symbol),
        ...assets.filter((a) => a.levels.some((l) => l.alert)).map((a) => a.symbol),
      ]),
    ];
  }

  /** Serialize runs (a slow Telegram call must not overlap the next tick). */
  private serial(fn: () => Promise<void>) {
    this.running = this.running.then(fn).catch((e) => console.error('[alerts]', e instanceof Error ? e.message : e));
    return this.running;
  }

  // ---------- prices ----------
  onQuotes(quotes: Record<string, Quote>) {
    return this.serial(async () => {
      const cfg = await this.getConfig();
      const { plans, trades, assets } = await this.data();
      const live = (s: string) => (this.opts.isLive ? this.opts.isLive(s) : true);

      if (cfg.plans) {
        for (const p of plans) {
          const q = quotes[p.symbol];
          if (!q || !PRICE_ALERT_STATUSES.includes(p.status) || planIssues(p).length || !live(p.symbol)) continue;
          const id = `plan:${p.id}`;
          const { state, fire } = evaluatePlanPrice(p, q.price, await this.getState<PlanAlertState>(id), cfg.approachPips);
          await this.setState(id, state);
          if (fire) await this.emit(planPriceAlert(p, fire, q.price, this.opts.publicUrl));
        }
      }

      if (cfg.trades) {
        for (const t of trades) {
          const q = quotes[t.symbol];
          if (!q || t.status !== 'open' || !live(t.symbol)) continue;
          const id = `trade:${t.id}`;
          const stop = t.currentStop ?? t.initialStop;
          const { state, fires } = evaluateTradePrice({ ...t, stop }, q.price, await this.getState<TradeAlertState>(id), cfg.approachPips);
          await this.setState(id, state);
          for (const f of fires) await this.emit(tradePriceAlert(t, f, q.price, stop, this.opts.publicUrl));
        }
      }

      if (cfg.levels) {
        for (const a of assets) {
          const q = quotes[a.symbol];
          if (!q || !live(a.symbol)) continue;
          const forex = /^[A-Z]{6}$/.test(a.symbol.split(':')[1] ?? '');
          for (const l of a.levels) {
            if (!l.alert) continue;
            const id = `level:${a.symbol}:${l.price}`;
            const { state, fire } = evaluateLevel(l.price, q.price, await this.getState<LevelAlertState>(id), levelBuffer(a.symbol, forex, dec(l.price)));
            await this.setState(id, state);
            if (fire) {
              const dir = fire === 'up' ? 'כלפי מעלה ⬆️' : 'כלפי מטה ⬇️';
              const label = l.label ? ` (${l.label})` : '';
              await this.emit({
                kind: 'level_cross',
                source: 'engine',
                symbol: a.symbol,
                planId: null,
                ideaId: null,
                price: q.price,
                title: `${a.symbol} חצה את ${l.price}${label}`,
                body: `${dir} · מחיר ${q.price}`,
                html: `🔔 <b>${escapeHtml(a.symbol)}</b> חצה את <b>${escapeHtml(l.price)}</b>${escapeHtml(label)} ${dir}\nמחיר: ${escapeHtml(q.price)}${link(this.opts.publicUrl, `/assets/${encodeURIComponent(a.symbol)}`, 'לדף הנכס')}`,
              });
            }
          }
        }
      }
      for (const [s, q] of Object.entries(quotes)) this.lastPrice.set(s, q.price);
    });
  }

  // ---------- time-based: idea reminders, plan expiry ----------
  onClock() {
    return this.serial(async () => {
      const cfg = await this.getConfig();
      const now = this.now();
      const nowIso = now.toISOString();
      const lateIso = new Date(now.getTime() - LATE_LIMIT_MS).toISOString();
      const { plans, ideas } = await this.data();

      if (cfg.reminders) {
        for (const i of ideas) {
          if (!i.remindAt || i.status === 'dropped' || i.remindAt > nowIso || i.remindAt < lateIso) continue;
          const id = `idea:${i.id}`;
          if ((await this.getState<{ remindAt: string }>(id))?.remindAt === i.remindAt) continue;
          await this.setState(id, { remindAt: i.remindAt });
          await this.emit({
            kind: 'idea_reminder',
            source: 'engine',
            symbol: i.symbol,
            planId: null,
            ideaId: i.id,
            price: this.lastPrice.get(i.symbol) ?? null,
            title: `תזכורת: ${i.title}`,
            body: `${i.symbol}`,
            html: `⏰ <b>תזכורת לרעיון</b> · ${escapeHtml(i.symbol)}\n${escapeHtml(i.title)}${link(this.opts.publicUrl, `/ideas/${i.id}`, 'לרעיון')}`,
          });
        }

        for (const p of plans) {
          if (!p.expiresAt || p.expiresAt < lateIso) continue;
          const id = `planexp:${p.id}`;
          const st = (await this.getState<{ expiresAt: string; warned: boolean; expired: boolean }>(id)) ?? null;
          const cur = st?.expiresAt === p.expiresAt ? st : { expiresAt: p.expiresAt, warned: false, expired: false };
          const active = ACTIVE_PLAN_STATUSES.includes(p.status);
          const msLeft = new Date(p.expiresAt).getTime() - now.getTime();

          if (msLeft <= 0 && !cur.expired && (active || p.status === 'expired')) {
            cur.expired = cur.warned = true;
            await this.setState(id, cur);
            if (active) {
              await this.store.plans.update(p.id, { status: 'expired', updatedAt: nowUtcIso() });
              this.invalidate();
            }
            await this.emit({
              ...planBase(p),
              kind: 'plan_expired',
              title: `פג תוקף התוכנית ב-${p.symbol}`,
              body: `${DIRECTION_LABELS[p.direction]} · הסטטוס עודכן ל"${PLAN_STATUS_LABELS.expired}"`,
              html: `⌛ <b>פג תוקף התוכנית</b> · ${escapeHtml(p.symbol)} ${DIRECTION_LABELS[p.direction]}${link(this.opts.publicUrl, `/plans/${p.id}`, 'לתוכנית')}`,
              note: '⌛ התראה: התוכנית פגה (תוקף הסתיים).',
            });
          } else if (msLeft > 0 && msLeft <= EXPIRY_WARN_MS && !cur.warned && active) {
            cur.warned = true;
            await this.setState(id, cur);
            const mins = Math.round(msLeft / 60000);
            const left = mins >= 60 ? `כ-${Math.round(mins / 60)} שעות` : `${mins} דקות`;
            await this.emit({
              ...planBase(p),
              kind: 'plan_expiring',
              title: `התוכנית ב-${p.symbol} פגה בעוד ${left}`,
              body: `${DIRECTION_LABELS[p.direction]} · ${PLAN_STATUS_LABELS[p.status]}`,
              html: `⏳ <b>התוכנית פגה בעוד ${left}</b> · ${escapeHtml(p.symbol)} ${DIRECTION_LABELS[p.direction]}\nלהאריך, או לתת לה לפוג?${link(this.opts.publicUrl, `/plans/${p.id}`, 'לתוכנית')}`,
            });
          } else if (cur !== st) {
            await this.setState(id, cur);
          }
        }
      }
      await this.pruneLog(now);
    });
  }

  private lastPrune = 0;
  private async pruneLog(now: Date) {
    if (now.getTime() - this.lastPrune < 24 * 60 * 60 * 1000) return;
    this.lastPrune = now.getTime();
    const cutoff = new Date(now.getTime() - LOG_KEEP_DAYS * 86400000).toISOString();
    for (const a of await this.store.alerts.list()) if (a.createdAt < cutoff) await this.store.alerts.delete(a.id);
  }

  // ---------- TradingView webhook ----------
  /** Already authenticated by the route. Runs after the HTTP response was sent. */
  handleWebhook(w: Omit<TvWebhook, 'secret'>) {
    return this.serial(async () => {
      const symbol = w.symbol ? normalizeSymbol(w.symbol) : null;
      const price = w.price !== undefined && w.price !== '' ? String(w.price) : null;
      const { plans } = await this.data();
      let matched: Plan[] = [];
      if (w.planId) matched = plans.filter((p) => p.id === w.planId);
      if (!matched.length && symbol) matched = plans.filter((p) => p.symbol === symbol && ACTIVE_PLAN_STATUSES.includes(p.status));

      const head = w.alert?.trim() || 'התראת TradingView';
      const text = w.message?.trim() ?? '';
      const planLine =
        matched.length === 1
          ? `\nתוכנית: ${DIRECTION_LABELS[matched[0]!.direction]} ${matched[0]!.entryLow ?? ''} (${PLAN_STATUS_LABELS[matched[0]!.status]})${link(this.opts.publicUrl, `/plans/${matched[0]!.id}`, 'לתוכנית')}`
          : matched.length > 1
            ? `\n${matched.length} תוכניות פעילות לנכס`
            : '';
      await this.emit(
        {
          kind: 'tv_webhook',
          source: 'tradingview',
          symbol: symbol ?? matched[0]?.symbol ?? null,
          planId: matched.length === 1 ? matched[0]!.id : null,
          ideaId: null,
          price,
          title: `${head}${symbol ? ` · ${symbol}` : ''}`,
          body: [text, price ? `מחיר ${price}` : ''].filter(Boolean).join(' · '),
          html: `📡 <b>${escapeHtml(head)}</b>${symbol ? ` · ${escapeHtml(symbol)}` : ''}${text ? `\n${escapeHtml(text)}` : ''}${price ? `\nמחיר: ${escapeHtml(price)}` : ''}${planLine}`,
          note: `📡 התראת TradingView: ${head}${text ? ` — ${text}` : ''}${price ? ` (מחיר ${price})` : ''}`,
        },
        matched.map((p) => p.id),
      );
    });
  }

  // ---------- delivery ----------
  /** Telegram + log + timeline note(s). Delivery failure is logged, never thrown. */
  private async emit(d: Draft, notePlanIds?: string[]): Promise<AlertEvent> {
    const { html, note, ...rest } = d;
    let delivered = false;
    let deliveryError: string | null = null;
    try {
      delivered = await this.telegram.send(html);
      if (!delivered) deliveryError = 'טלגרם לא מחובר';
    } catch (e) {
      deliveryError = e instanceof Error ? e.message : 'שליחה נכשלה';
    }
    const ev = await this.store.alerts.create({ ...rest, delivered, deliveryError, createdAt: nowUtcIso() });
    const ids = notePlanIds ?? (d.planId ? [d.planId] : []);
    for (const planId of ids) {
      const now = nowUtcIso();
      await this.store.notes.create({
        parentKind: 'plan',
        parentId: planId,
        parentKey: parentKey('plan', planId),
        symbol: d.symbol,
        body: note ?? `🔔 התראה: ${d.title}${d.body ? ` — ${d.body}` : ''}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (d.tradeId) {
      const now = nowUtcIso();
      await this.store.notes.create({
        parentKind: 'trade',
        parentId: d.tradeId,
        parentKey: parentKey('trade', d.tradeId),
        symbol: d.symbol,
        body: note ?? `🔔 התראה: ${d.title}${d.body ? ` — ${d.body}` : ''}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    return ev;
  }
}

// ---------- message builders ----------
const link = (base: string | null | undefined, path: string, text: string) => (base ? `\n<a href="${escapeHtml(base.replace(/\/$/, '') + path)}">${text}</a>` : '');

const planBase = (p: Plan) => ({ source: 'engine' as const, symbol: p.symbol, planId: p.id, ideaId: p.ideaId, price: null });

function zoneText(p: Plan) {
  return p.entryHigh && p.entryHigh !== p.entryLow ? `${p.entryLow}–${p.entryHigh}` : `${p.entryLow}`;
}

function tradePriceAlert(t: Trade, f: TradeFire, price: string, stop: string, publicUrl?: string | null): Draft {
  const dir = DIRECTION_LABELS[t.direction];
  const sym = escapeHtml(t.symbol);
  const open = tradeStats(t).openQty;
  const linkHtml = link(publicUrl, `/trades/${t.id}`, 'לעסקה');
  const base = { source: 'engine' as const, symbol: t.symbol, planId: t.planId, ideaId: t.ideaId, tradeId: t.id, price };
  if (f.kind === 'trade_target') {
    const tp = t.targets[f.index]!.price;
    return {
      ...base,
      kind: 'trade_target',
      title: `${t.symbol} הגיע ליעד TP${f.index + 1} (${tp})`,
      body: `${dir} · מחיר ${price} · כמות פתוחה ${open}`,
      html: `🎯 <b>${sym}</b> הגיע ליעד TP${f.index + 1} (${escapeHtml(tp)})\n${dir} · מחיר ${escapeHtml(price)} · כמות פתוחה ${escapeHtml(open)}\nאם מימשת — עדכן יציאה ביומן. אולי להזיז סטופ?${linkHtml}`,
    };
  }
  if (f.kind === 'trade_stop_near') {
    const pips = t.assetClass === 'forex' ? decStr(dec(price).minus(dec(stop)).abs().div(pipSize(t.symbol)).toDecimalPlaces(1)) : null;
    return {
      ...base,
      kind: 'trade_stop_near',
      title: `${t.symbol} מתקרב לסטופ ${stop}`,
      body: `${dir} · מחיר ${price}${pips ? ` (${pips} פיפס מהסטופ)` : ''}`,
      html: `⚠️ <b>${sym}</b> מתקרב לסטופ ${escapeHtml(stop)}\n${dir} · מחיר ${escapeHtml(price)}${pips ? ` (${pips} פיפס)` : ''}\nלא להזיז את הסטופ מתוך פחד — רק לפי התוכנית.${linkHtml}`,
    };
  }
  return {
    ...base,
    kind: 'trade_stop',
    title: `${t.symbol} הגיע לסטופ ${stop}`,
    body: `${dir} · מחיר ${price} · כמות פתוחה ${open}`,
    html: `🔴 <b>${sym}</b> הגיע לסטופ ${escapeHtml(stop)}\n${dir} · מחיר ${escapeHtml(price)}\nאם העסקה נסגרה — עדכן יציאה ביומן, ורשום מצב רגשי ולקח.${linkHtml}`,
  };
}

function planPriceAlert(p: Plan, fire: PlanFire, price: string, publicUrl?: string | null): Draft {
  const dir = DIRECTION_LABELS[p.direction];
  const zone = zoneText(p);
  const lo = dec(p.entryLow!);
  const hi = p.entryHigh ? dec(p.entryHigh) : lo;
  const px = dec(price);
  const distPips = p.assetClass === 'forex' ? decStr((px.lt(lo) ? lo.minus(px) : px.minus(hi)).div(pipSize(p.symbol)).toDecimalPlaces(1)) : null;
  const linkHtml = link(publicUrl, `/plans/${p.id}`, 'לתוכנית');
  const sym = escapeHtml(p.symbol);
  const conds = p.entryConditions.trim() ? `\nתנאי כניסה: ${escapeHtml(p.entryConditions.trim().slice(0, 300))}` : '';
  const M: Record<PlanFire, { kind: AlertKind; title: string; body: string; html: string }> = {
    plan_approach: {
      kind: 'plan_approach',
      title: `${p.symbol} מתקרב לאזור הכניסה`,
      body: `${dir} · אזור ${zone} · מחיר ${price}${distPips ? ` (${distPips} פיפס)` : ''}`,
      html: `🟡 <b>${sym}</b> מתקרב לאזור הכניסה\n${dir} · אזור ${escapeHtml(zone)} · מחיר ${escapeHtml(price)}${distPips ? ` (${distPips} פיפס)` : ''}${linkHtml}`,
    },
    plan_zone: {
      kind: 'plan_zone',
      title: `${p.symbol} באזור הכניסה`,
      body: `${dir} · אזור ${zone} · מחיר ${price}`,
      html: `🟢 <b>${sym}</b> נכנס לאזור הכניסה\n${dir} · אזור ${escapeHtml(zone)} · מחיר ${escapeHtml(price)} · סטופ ${escapeHtml(p.stopLoss ?? '')}${conds}\nזמן לבדוק את תנאי הכניסה — הכניסה עצמה אצל הברוקר.${linkHtml}`,
    },
    plan_stop: {
      kind: 'plan_stop',
      title: `${p.symbol} הגיע לסטופ לפני כניסה`,
      body: `${dir} · סטופ ${p.stopLoss} · מחיר ${price}`,
      html: `🔴 <b>${sym}</b> הגיע לסטופ לפני כניסה\n${dir} · סטופ ${escapeHtml(p.stopLoss ?? '')} · מחיר ${escapeHtml(price)}${p.invalidation.trim() ? `\nנקודת ביטול: ${escapeHtml(p.invalidation.trim().slice(0, 300))}` : ''}\nשקול לבטל את התוכנית.${linkHtml}`,
    },
  };
  const m = M[fire];
  return { ...planBase(p), price, kind: m.kind, title: m.title, body: m.body, html: m.html };
}
