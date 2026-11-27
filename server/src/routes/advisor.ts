import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import {
  ADVISOR_SYSTEM,
  ADVISOR_TIMEFRAMES,
  advisorFollowUpSchema,
  advisorStartSchema,
  candleFacts,
  candleTable,
  dec,
  DIRECTION_LABELS,
  nowUtcIso,
  tradeStats,
  type AdvisorSessionView,
  type AdvisorStart,
  type AdvisorTurn,
} from '@trading/shared';
import type { CandleHub } from '../candles';
import { HttpError, notFound, parse } from '../http';
import type { QuoteHub } from '../quotes';
import type { SpecHub } from '../specs';
import type { Store } from '../store/types';

export const ADVISOR_MODEL = 'claude-opus-5-5';

// ---------- model ----------
export interface AdvisorReply {
  /** The full assistant content, replayed unchanged on follow-ups (thinking / fallback blocks included). */
  content: Anthropic.Beta.BetaContentBlockParam[];
  text: string;
  stopReason: string | null;
}
/** One answer for the conversation so far; streams text through onText. Injectable for tests. */
export type AdvisorModel = (req: { system: string; messages: Anthropic.Beta.BetaMessageParam[] }, onText: (t: string) => void) => Promise<AdvisorReply>;

export function claudeAdvisorModel(apiKey: string): AdvisorModel {
  const client = new Anthropic({ apiKey });
  return async ({ system, messages }, onText) => {
    const stream = client.beta.messages.stream({
      model: ADVISOR_MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      // A declined request is re-run on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The instructions are frozen → cached; the conversation prefix is cached too.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      messages,
    });
    stream.on('text', (t) => onText(t));
    const msg = await stream.finalMessage();
    const u = msg.usage;
    console.log(`advisor: in ${u.input_tokens} (cache read ${u.cache_read_input_tokens ?? 0}, write ${u.cache_creation_input_tokens ?? 0}) out ${u.output_tokens} · ${msg.stop_reason}`);
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { content: msg.content as Anthropic.Beta.BetaContentBlockParam[], text, stopReason: msg.stop_reason };
  };
}

function modelError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'מפתח ה-API של Anthropic לא תקין (ANTHROPIC_API_KEY)';
  if (e instanceof Anthropic.PermissionDeniedError) return 'למפתח של Anthropic אין הרשאה למודל';
  if (e instanceof Anthropic.RateLimitError) return 'יותר מדי בקשות ל-Anthropic — נסה שוב בעוד דקה';
  if (e instanceof Anthropic.APIConnectionError) return 'אין חיבור ל-Anthropic';
  if (e instanceof Anthropic.APIError) return `שגיאה מ-Anthropic (${e.status ?? '?'})`;
  return e instanceof Error ? e.message : 'שגיאה לא צפויה';
}

// ---------- context ----------
export interface AdvisorDeps {
  quoteHub: QuoteHub;
  candles: CandleHub;
  specs: SpecHub;
}

const CANDLES_FETCH = 120;
const CANDLES_SHOWN: Record<string, number> = { D1: 60, H4: 60, H1: 72 };

/** The DATA block for the first question: only numbers the system actually has. */
export async function buildAdvisorContext(store: Store, deps: AdvisorDeps, input: AdvisorStart): Promise<{ text: string; included: string[] }> {
  const { symbol } = input;
  const lines: string[] = [`DATA (from the trading system, generated ${nowUtcIso().slice(0, 16).replace('T', ' ')} UTC)`, `Symbol: ${symbol}`];
  const included: string[] = [];

  // Live price
  try {
    const q = (await deps.quoteHub.get([symbol]))[symbol];
    if (q) {
      const src = q.source === 'fxcmgr' ? 'FXCM' : 'TradingView';
      const state = q.delayedMin ? `delayed ${q.delayedMin} min` : deps.quoteHub.isLive(symbol) ? 'live' : 'not updating';
      lines.push(`Current price: ${q.price} (${src}, ${state}, at ${q.at.slice(0, 19)}Z)`);
      included.push(`מחיר נוכחי (${src}${q.delayedMin ? `, מאוחר ${q.delayedMin} דק׳` : ''})`);
    } else lines.push('Current price: not available');
  } catch {
    lines.push('Current price: not available');
  }

  // Contract spec (CFDs)
  const spec = await deps.specs.get(symbol).catch(() => null);
  if (spec) lines.push(`Instrument: CFD at FXCM (${spec.offer}); a 1.0 price move is worth ${spec.pointValue} ${spec.currency} per unit; minimum ${spec.minQuantity} units.`);

  // Candles
  const sets = await Promise.all(ADVISOR_TIMEFRAMES.map((tf) => deps.candles.get(symbol, tf, CANDLES_FETCH).catch(() => null)));
  const got: string[] = [];
  ADVISOR_TIMEFRAMES.forEach((tf, i) => {
    const set = sets[i];
    const facts = set ? candleFacts(set.candles) : null;
    if (!set || !facts) return;
    got.push(tf);
    const shown = set.candles.slice(-(CANDLES_SHOWN[tf] ?? 60));
    lines.push(
      '',
      `Candles ${tf} (FXCM ${set.offer}, bid, ${facts.count} candles ${facts.from.slice(0, 16)} → ${facts.to.slice(0, 16)} UTC; the last one may still be forming)`,
      `Facts ${tf}: last close ${facts.lastClose}; ATR(14) ${facts.atr14 ?? 'n/a'}; 20-candle high ${facts.high20.price} (${facts.high20.t.slice(0, 16)}), low ${facts.low20.price} (${facts.low20.t.slice(0, 16)}); ` +
        `${facts.count}-candle high ${facts.highAll.price} (${facts.highAll.t.slice(0, 16)}), low ${facts.lowAll.price} (${facts.lowAll.t.slice(0, 16)}); ` +
        `change over 20 candles ${facts.change20Pct ?? 'n/a'}%; SMA20 ${facts.sma20 ?? 'n/a'}; SMA50 ${facts.sma50 ?? 'n/a'}`,
      `Last ${shown.length} candles ${tf} (time open high low close volume):`,
      candleTable(shown),
    );
  });
  if (got.length) included.push(`נרות ${got.join(' · ')} מ-FXCM`);
  else {
    lines.push('', `Candles: none — ${symbol} has no candle data from FXCM. Judge structure from the screenshot only and say so.`);
    included.push('אין נרות לנכס הזה (לא מ-FXCM) — הניתוח לפי הצילום והמחיר');
  }

  // Plan
  const plan = input.planId ? await store.plans.get(input.planId) : null;
  if (input.planId && !plan) throw notFound('התוכנית');
  if (plan) {
    const targets = plan.targets.map((t) => `${t.price} (${t.sizePct}%)`).join(', ') || 'none';
    lines.push(
      '',
      `User's plan (status ${plan.status}): ${plan.direction === 'long' ? 'LONG' : 'SHORT'}; timeframe ${plan.timeframe || 'n/a'}; order ${plan.orderType}; ` +
        `entry ${plan.entryLow ?? '?'}${plan.entryHigh && plan.entryHigh !== plan.entryLow ? `–${plan.entryHigh}` : ''}; stop ${plan.stopLoss ?? '?'}; targets ${targets}; risk ${plan.riskPct}% of the account.`,
    );
    if (plan.entryConditions.trim()) lines.push(`Entry conditions (user's words): ${plan.entryConditions.trim()}`);
    if (plan.invalidation.trim()) lines.push(`Invalidation (user's words): ${plan.invalidation.trim()}`);
    included.push(`התוכנית (${DIRECTION_LABELS[plan.direction]})`);
  }

  // Account + trades
  // No account chosen ("all accounts"): the real account linked to FXCM.
  const accountId = input.accountId ?? plan?.accountId ?? null;
  const account = accountId
    ? await store.accounts.get(accountId)
    : ((await store.accounts.list()).find((a) => !a.isArchived && a.kind !== 'demo' && a.integration?.kind === 'fxcmgr' && a.integration.enabled) ?? null);
  if (account) {
    const riskAmt = plan ? dec(account.balance).times(plan.riskPct).div(100).toDecimalPlaces(2).toString() : null;
    lines.push('', `Account: "${account.name}" (${account.kind === 'demo' ? 'demo' : 'real'}), balance ${account.balance} ${account.baseCurrency}${riskAmt ? `; the plan's risk = ${riskAmt} ${account.baseCurrency}` : ''}.`);
    included.push(`חשבון: ${account.name}`);
    const open = (await store.trades.list({ field: 'accountId', value: account.id })).filter((t) => t.status === 'open');
    if (open.length) {
      lines.push('Open trades in this account:');
      for (const t of open) {
        const s = tradeStats(t);
        lines.push(`- ${t.symbol} ${t.direction === 'long' ? 'LONG' : 'SHORT'} ${s.openQty} units, avg entry ${s.avgEntry ?? '?'}, stop ${t.currentStop ?? t.initialStop}`);
      }
      included.push(`${open.length} עסקאות פתוחות`);
    } else lines.push('Open trades in this account: none');
  }

  const past = (await store.trades.list({ field: 'symbol', value: symbol }))
    .filter((t) => t.status === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    .slice(0, 10);
  if (past.length) {
    lines.push('', `User's past trades on ${symbol} (newest first):`);
    for (const t of past) {
      const lesson = t.lesson.trim() ? `; lesson: ${t.lesson.trim().slice(0, 200)}` : '';
      lines.push(`- ${t.closedAt?.slice(0, 10)} ${t.direction === 'long' ? 'LONG' : 'SHORT'}: ${t.r ?? '?'}R, net ${t.netPnl ?? '?'} ${t.currency}; followed plan: ${t.followedPlan ?? 'n/a'}${lesson}`);
    }
    included.push(`${past.length} עסקאות קודמות בנכס`);
  }

  if (input.image) included.push('צילום הגרף');
  return { text: lines.join('\n'), included };
}

// ---------- sessions ----------
interface Session {
  id: string;
  symbol: string;
  planId: string | null;
  messages: Anthropic.Beta.BetaMessageParam[];
  turns: AdvisorTurn[];
  status: AdvisorSessionView['status'];
  partial: string;
  error: string | null;
  included: string[];
  lastUsed: number;
}

const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_SESSIONS = 30;

export function advisorRouter(store: Store, deps: AdvisorDeps, model: AdvisorModel | null) {
  const r = Router();
  const sessions = new Map<string, Session>();

  const view = (s: Session): AdvisorSessionView => ({
    id: s.id,
    symbol: s.symbol,
    planId: s.planId,
    status: s.status,
    turns: s.turns,
    partial: s.partial,
    error: s.error,
    included: s.included,
    model: ADVISOR_MODEL,
  });

  function prune() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS && s.status !== 'thinking') sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].filter((s) => s.status !== 'thinking').sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      sessions.delete(oldest.id);
    }
  }

  /** Answer the last user message in the background; the client polls the session. */
  async function answer(s: Session) {
    s.status = 'thinking';
    s.partial = '';
    s.error = null;
    try {
      const reply = await model!({ system: ADVISOR_SYSTEM, messages: s.messages }, (t) => {
        s.partial += t;
      });
      if (reply.stopReason === 'refusal') throw new Error('המודל סירב לענות על השאלה הזאת');
      if (!reply.text.trim()) throw new Error('התקבלה תשובה ריקה');
      s.messages.push({ role: 'assistant', content: reply.content });
      s.turns.push({ role: 'assistant', text: reply.text, at: nowUtcIso() });
      s.status = 'ready';
    } catch (e) {
      // Drop the unanswered question so it can be asked again.
      s.messages.pop();
      s.turns.pop();
      s.status = 'error';
      s.error = modelError(e);
    } finally {
      s.partial = '';
      s.lastUsed = Date.now();
    }
  }

  const requireModel = () => {
    if (!model) throw new HttpError(503, 'היועץ לא מוגדר: חסר ANTHROPIC_API_KEY ב-server/.env');
  };
  const getSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, 'השיחה פגה — התחל שיחה חדשה');
    return s;
  };

  r.get('/status', (_req, res) => {
    res.json({ enabled: !!model, model: ADVISOR_MODEL });
  });

  r.post('/sessions', async (req, res) => {
    requireModel();
    const input = parse(advisorStartSchema, req.body);
    const ctx = await buildAdvisorContext(store, deps, input);
    prune();
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.image) content.push({ type: 'image', source: { type: 'base64', media_type: input.image.mediaType, data: input.image.data } });
    content.push({ type: 'text', text: ctx.text }, { type: 'text', text: `My question:\n${input.question}` });
    const s: Session = {
      id: randomUUID(),
      symbol: input.symbol,
      planId: input.planId,
      messages: [{ role: 'user', content }],
      turns: [{ role: 'user', text: input.question, at: nowUtcIso() }],
      status: 'thinking',
      partial: '',
      error: null,
      included: ctx.included,
      lastUsed: Date.now(),
    };
    sessions.set(s.id, s);
    void answer(s);
    res.status(201).json(view(s));
  });

  r.get('/sessions/:id', (req, res) => {
    const s = getSession(req.params.id);
    s.lastUsed = Date.now();
    res.json(view(s));
  });

  r.post('/sessions/:id/messages', (req, res) => {
    requireModel();
    const s = getSession(req.params.id);
    if (s.status === 'thinking') throw new HttpError(409, 'היועץ עדיין עונה על השאלה הקודמת');
    const { question } = parse(advisorFollowUpSchema, req.body);
    s.messages.push({ role: 'user', content: question });
    s.turns.push({ role: 'user', text: question, at: nowUtcIso() });
    s.status = 'thinking';
    void answer(s);
    res.json(view(s));
  });

  return r;
}
