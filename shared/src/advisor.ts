import { z } from 'zod';
import { symbolString } from './planning';

// ---------- candles ----------
export interface Candle {
  /** Candle open time, UTC ISO. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Timeframes the advisor reads, FXCM names. */
export const ADVISOR_TIMEFRAMES = ['D1', 'H4', 'H1'] as const;
export type AdvisorTimeframe = (typeof ADVISOR_TIMEFRAMES)[number];

export interface CandleFacts {
  count: number;
  from: string;
  to: string;
  lastClose: number;
  /** Average true range over the last 14 candles (simple mean). */
  atr14: number | null;
  /** Highest high / lowest low of the last 20 candles, with the candle time. */
  high20: { price: number; t: string };
  low20: { price: number; t: string };
  /** Same over all candles given. */
  highAll: { price: number; t: string };
  lowAll: { price: number; t: string };
  /** Close vs. the close 20 candles earlier, %. */
  change20Pct: number | null;
  /** Simple moving averages of the close. */
  sma20: number | null;
  sma50: number | null;
}

const round = (x: number, digits = 6) => Number(x.toFixed(digits));

function extreme(cs: Candle[], key: 'h' | 'l') {
  let best = cs[0]!;
  for (const c of cs) if (key === 'h' ? c.h > best.h : c.l < best.l) best = c;
  return { price: best[key], t: best.t };
}

const sma = (cs: Candle[], n: number) => (cs.length >= n ? round(cs.slice(-n).reduce((s, c) => s + c.c, 0) / n) : null);

/** Plain facts computed from candles (oldest first), so the model never has to estimate them. */
export function candleFacts(cs: Candle[]): CandleFacts | null {
  if (!cs.length) return null;
  const last = cs[cs.length - 1]!;
  let atr14: number | null = null;
  if (cs.length >= 15) {
    const tr = cs.slice(-14).map((c, i, arr) => {
      const prevClose = (i === 0 ? cs[cs.length - 15]! : arr[i - 1]!).c;
      return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
    });
    atr14 = round(tr.reduce((s, x) => s + x, 0) / tr.length);
  }
  const last20 = cs.slice(-20);
  const ref = cs.length > 20 ? cs[cs.length - 21]!.c : null;
  return {
    count: cs.length,
    from: cs[0]!.t,
    to: last.t,
    lastClose: last.c,
    atr14,
    high20: extreme(last20, 'h'),
    low20: extreme(last20, 'l'),
    highAll: extreme(cs, 'h'),
    lowAll: extreme(cs, 'l'),
    change20Pct: ref ? round(((last.c - ref) / ref) * 100, 2) : null,
    sma20: sma(cs, 20),
    sma50: sma(cs, 50),
  };
}

/** Compact one-line-per-candle table: "time open high low close volume". */
export function candleTable(cs: Candle[]): string {
  return cs.map((c) => `${c.t.slice(0, 16).replace('T', ' ')} ${c.o} ${c.h} ${c.l} ${c.c} ${c.v}`).join('\n');
}

// ---------- requests ----------
const imageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** Base64 without the data: prefix. ~5 MB of image at most. */
  data: z
    .string()
    .max(7_000_000, 'התמונה גדולה מדי')
    .regex(/^[A-Za-z0-9+/=]+$/, 'תמונה לא תקינה'),
});
export type AdvisorImage = z.infer<typeof imageSchema>;

const question = z.string().trim().min(1, 'כתוב שאלה').max(8000);

export const advisorStartSchema = z.object({
  symbol: symbolString,
  planId: z.string().min(1).nullable().default(null),
  accountId: z.string().min(1).nullable().default(null),
  image: imageSchema.nullable().default(null),
  question,
});
export type AdvisorStart = z.output<typeof advisorStartSchema>;

export const advisorFollowUpSchema = z.object({ question });

// ---------- session view (server → client) ----------
export interface AdvisorTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface AdvisorSessionView {
  id: string;
  symbol: string;
  planId: string | null;
  /** 'thinking' while the model works on the last question. */
  status: 'thinking' | 'ready' | 'error';
  turns: AdvisorTurn[];
  /** Text streamed so far for the answer in progress. */
  partial: string;
  error: string | null;
  /** What was attached to the first question, in Hebrew, for the UI. */
  included: string[];
  model: string;
}

// ---------- prompt ----------
/** Frozen (cached) instructions. Keep free of dates or per-request values. */
export const ADVISOR_SYSTEM = `You are a seasoned discretionary trader sitting next to the user at their trading desk. The user trades forex and CFDs (gold, oil, US indices) at FXCM, by hand, and asks for your view on a specific chart before deciding whether to place orders.

Language and tone
- Always answer in Hebrew. Keep tickers, prices and timeframe names (H1, H4, D1) as they are.
- Talk like an experienced colleague: direct, concrete, no filler, no generic trading education.
- It's fine — often right — to say "לא עכשיו" (not now) or "אין כאן עסקה". Don't push the user into a trade.

What you receive
- A DATA block from the trading system: live price, real FXCM candles (bid) for D1/H4/H1 with computed facts (ATR, recent highs/lows, moving averages), the user's plan if one exists, the account, open trades, and past trades on this symbol. These numbers are exact.
- Possibly a screenshot of the user's chart, showing their drawings (lines, zones). Prices you read off an image are approximate: whenever a number matters, take it from DATA, not from the image. Use the image to understand what the user marked and which structure they see.
- Times in DATA are UTC.

Hard rules
- Use only the numbers in DATA (or that the user states). Never invent prices, levels, news, economic events or indicator values. If something you'd need is missing (e.g. no candles for this symbol, no calendar data), say so plainly and reason without it.
- You can't see news or the economic calendar; if a known recurring event could matter, tell the user to check it rather than asserting it.
- You don't place or manage orders. The decision is the user's; you give a reasoned opinion, not a signal.

Answer structure for the first answer (use these Hebrew headings, short paragraphs or bullets):
## קריאת המצב
Trend and structure per timeframe (D1 → H4 → H1), key levels with exact prices from DATA, where price is now relative to them, volatility (ATR).
## הכיוון המועדף
Long, short, or "לא עכשיו" — with the reasons. If you'd wait, say for what (a level, a candle close, a retest).
## מה מבטל את הרעיון
The concrete price/condition that proves this view wrong.
## בדיקת התוכנית
If the user has a plan or stated an idea: is the stop beyond real structure and not inside normal noise (compare with ATR)? Are the targets realistic given the levels? Reward-to-risk in R. Concrete suggestions with prices. If there is no plan, give the levels a sensible plan would use.
## סיכונים
Overlap with open trades (correlated exposure), spread/volatility, the user's own history on this symbol if relevant, anything in DATA that argues against the trade.

Follow-up answers: answer the question directly, without repeating the whole structure; keep using DATA from the first message.`;
